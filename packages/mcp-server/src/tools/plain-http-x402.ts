/**
 * #2811 — the PLAIN-HTTP X402 capability of the hosted MCP surface, carved
 * out of `tools.ts` (which stays the compatibility facade `index.ts`,
 * `server.ts`, tests and embedders import).
 *
 * Four tools, one owner:
 *
 *   quote    haven_quote_x402
 *   pay      haven_pay_x402_quote
 *   resume   haven_resume_x402_payment
 *   report   haven_report_x402_outcome
 *
 * The handler bodies moved VERBATIM: names, schemas (`tools/contracts.ts`),
 * success/failure shapes, request-context behaviour and agent guidance are
 * unchanged, and so are the behaviours this slice carries — the pre-`runTool`
 * strict-parse failure envelope (#2348/#2349), the ONE cap assertion after
 * scheme selection against the option actually authorized (#2041/#2051), the
 * #1450 scheme-preference rule on the generic path, the resume gate on the
 * backend's live `retry_original_x402_request` trigger (#2145), and the
 * report-then-re-read reconciliation shape (#2292).
 *
 * This module NEVER SIGNS: no key material, no signer call site, and no
 * EIP-712/EIP-3009 header construction lives here. Signing context is BUILT
 * (`buildX402SigningContext`, shared support) and the signing itself stays
 * with the local edge signer through `haven_sign_x402` / `haven_sign` — true
 * at the call graph, not just at the import list.
 *
 * DEPENDENCY RULE (epic #2806): this module imports the #2807 contract and
 * parsing seams and the #2808 shared support, and NEVER another capability
 * module. Of the six helpers the #2806 epic review note names as shared with
 * #2810 — `buildMcpToolQuoteResponse`, `quoteWarnings`, `buildX402SigningContext`,
 * `readMaxAmountCap`, `priceSelectedOption`, `HostedToolError` — five have call
 * sites in these bodies and are imported from support below;
 * `buildMcpToolQuoteResponse` appears only inside a comment on the quote path
 * (#2054) and is deliberately NOT imported — importing an unused helper would
 * be a fake edge, not an owned one. Helpers only this slice calls
 * (`coerceJsonField`, `wrongTool`, `resolveResumeState`) stay in shared
 * support per the retained set in
 * `tools/support/shared-helper-ownership.test.ts` — importing them from here
 * keeps the ownership map's single-slice declarations true.
 *
 * #2999 adds a seventh cross-slice import: `settlementPredictionFields`, the
 * #2991 `expected_settlement_scheme` / `expected_funding_leg` /
 * `expected_settleable` / `warnings` field set, now carried by ALL THREE
 * hosted quote tools rather than the two MCP ones. `haven_quote_x402` prefetches
 * the agent the same non-throwing way `haven_pay_x402_quote` already does and
 * feeds it to the shared helper, so this quote can never predict a scheme its
 * own sibling handler would select differently.
 *
 * #3476 adds the `allowance` block to `haven_pay_x402_quote`'s successful
 * results — the budget visibility `haven_prepare_catalog_purchase`'s preflight
 * already provides, for the plain-HTTP sibling. The read is capability-local
 * (`delegationAllowanceBlock`, then in this file): on current dev the catalog
 * tool no longer runs a client-side budget read at all (the #3054 compare
 * moved server-side into `POST /machine-payments/budget-precheck`), so there
 * was no shared helper left to extract and the ownership map stayed untouched.
 */
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenClient,
  HavenPaymentStateError,
  selectErc7710PaymentOption,
  selectStandardPaymentOption,
  selectX402SettlementScheme,
  normalizePaymentRequired,
  resolveX402RetryTarget,
  isSecureX402RetryTarget,
  isZeroSettlementTxHash,
  parseMerchantSettlement,
  type EvidenceReportOutcome,
  type X402RetryTarget,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import { delegationAllowanceBlock } from './support/allowance-block.js'
import {
  CAP_WARNING_TEXT,
  priceSelectedOption,
  quoteWarnings,
  readMaxAmountCap,
} from './support/cap-price.js'
import { HostedToolError, egressRefusalBeforeIntent, normalizeError, runTool } from './support/errors.js'
import {
  buildAgentGuidance,
  catchSettledReplay,
  paymentStatusHandoff,
  type HostedHandoff,
  refusalNextStep,
} from './support/guidance.js'
import { buildX402SigningContext, coerceJsonField } from './support/mcp-context.js'
import {
  isPendingApproval,
  resolveResumeState,
  settlementPredictionFields,
  wrongTool,
} from './support/quote-response.js'

// #3097: `resource_url_differs_from_request` is emitted only when a request
// URL existed to compare against. On the pay-from-declaration path nothing was
// compared, and a literal `false` there read as "the merchant agrees with what
// you quoted" (haven-reviewer on #3112).
/**
 * #3101: the handoff after a reported outcome — sweep on a rejection; on
 * acceptance, nothing follows UNLESS `offerSettlementEvidence` is true.
 *
 * #3475 follow-up (owner decision, 2026-09-30): an `accepted` eip3009
 * plain-HTTP payment with no merchant settlement recorded yet names
 * `haven_report_settlement_evidence` as the next tool, `payment_id` prefilled
 * — the schema's `settlement_tx_hash` is optional for exactly this reason
 * (see `contracts.ts`'s `haven_report_settlement_evidence` shape), so this is
 * a genuinely callable next step even though the agent may have nothing to
 * add. Rejected outcomes, erc7710 payments, a non-eip3009/unknown scheme, and
 * a payment whose settlement is already recorded all keep the old answer.
 */
function reportOutcomeHandoff(
  outcome: 'accepted' | 'rejected',
  offerSettlementEvidence: boolean,
  paymentId: string,
  // #3727: the folded evidence's result, when the caller supplied evidence.
  // Its answer REPLACES the status re-read's offer — a confirmed record is
  // "no tool follows" even if the re-read somehow lagged, a retryable one
  // re-names the evidence tool with the hash prefilled, and a refused one
  // names NO tool (re-reporting the same hash re-refuses).
  settlementEvidence?: ReportedSettlementEvidence | null,
): HostedHandoff {
  if (outcome === 'rejected') {
    return { nextTool: 'haven_sweep_delegate', nextArguments: {} }
  }
  if (settlementEvidence) return evidenceHandoff(settlementEvidence, paymentId)
  if (offerSettlementEvidence) {
    return { nextTool: 'haven_report_settlement_evidence', nextArguments: { payment_id: paymentId } }
  }
  return { nextTool: null, nextToolOmittedReason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows' }
}

/**
 * #3727: the settlement evidence a caller may fold INTO the outcome report —
 * the raw base64 `PAYMENT-RESPONSE` header the merchant returned and/or an
 * explicit `settlement_tx_hash`. Resolved and validated BEFORE anything is
 * written, so a malformed or self-contradictory call refuses the same way the
 * strict input contract does and leaves no partial record behind.
 *
 * What the decoder contributes: `parseMerchantSettlement` reads the header
 * for its `transaction` field (and the `txHash`/`tx_hash` spellings some
 * merchants use) and nothing else — a `payer` inside is the merchant's claim
 * about who paid, is NOT Haven's record, and is never written (#3125).
 *
 * Refusals, each before any write:
 * - `PAYMENT_EVIDENCE_UNREADABLE` — `payment_response` decoded to no
 *   transaction field, or to a value that is not a 0x-prefixed 64-hex hash.
 * - `ZERO_SETTLEMENT_HASH` — the decoded (or supplied) hash is the demo
 *   merchant's `0x00…00` "delivered, not settled" marker. Same recognizer
 *   `haven_report_settlement_evidence` refuses with, applied here before the
 *   outcome write so the two tools refuse identically.
 * - `SETTLEMENT_EVIDENCE_CONFLICT` — both inputs supplied and they name
 *   DIFFERENT hashes (hex is case-insensitive: matching case-insensitively is
 *   the honest comparison, since a checksummed copy of the same hash must not
 *   read as a conflict). One hash, asserted twice in agreement, is accepted —
 *   the explicit `settlement_tx_hash` wins for the echo.
 */
type FoldedSettlementEvidence = {
  /** The single hash the evidence names, after decoding and conflict-checking. */
  readonly settlementTxHash: string
  /** Which argument named it — echoed on the response for reconciliation. */
  readonly source: 'settlement_tx_hash' | 'payment_response' | 'both'
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

function resolveSettlementEvidence(args: {
  settlement_tx_hash?: string
  payment_response?: string
}): FoldedSettlementEvidence | null {
  const explicit = args.settlement_tx_hash
  const header = args.payment_response
  if (!explicit && !header) return null

  let decoded: string | undefined
  if (header) {
    const parsed = parseMerchantSettlement(header).settlementTxHash
    if (typeof parsed !== 'string' || parsed.length === 0) {
      throw new HostedToolError({
        code: 'PAYMENT_EVIDENCE_UNREADABLE',
        statusCode: 400,
        message:
          'payment_response did not decode to a settlement transaction: the PAYMENT-RESPONSE header must be ' +
          'the base64 value the merchant returned and carry a `transaction` field. Nothing was written — ' +
          're-report with settlement_tx_hash, or without evidence.',
      })
    }
    if (!TX_HASH_PATTERN.test(parsed)) {
      throw new HostedToolError({
        code: 'PAYMENT_EVIDENCE_UNREADABLE',
        statusCode: 400,
        message:
          'payment_response decoded to a `transaction` that is not a 0x-prefixed 64-hex transaction hash. ' +
          'Nothing was written — re-report with settlement_tx_hash, or without evidence.',
      })
    }
    if (isZeroSettlementTxHash(parsed)) {
      throw new HostedToolError({
        code: 'ZERO_SETTLEMENT_HASH',
        statusCode: 400,
        message:
          'payment_response decoded to the zero hash (0x00…00) — the "delivered, not settled" marker, not a ' +
          'transaction. Nothing was written, and nothing would verify on-chain.',
      })
    }
    decoded = parsed
  }

  if (explicit && decoded && explicit.toLowerCase() !== decoded.toLowerCase()) {
    throw new HostedToolError({
      code: 'SETTLEMENT_EVIDENCE_CONFLICT',
      statusCode: 409,
      message:
        'settlement_tx_hash and the transaction inside payment_response name DIFFERENT hashes. Nothing was ' +
        'written: supply the one hash you hold, or both copies of the same hash.',
    })
  }
  if (explicit && isZeroSettlementTxHash(explicit)) {
    throw new HostedToolError({
      code: 'ZERO_SETTLEMENT_HASH',
      statusCode: 400,
      message:
        'settlement_tx_hash is the zero hash (0x00…00) — the "delivered, not settled" marker, not a ' +
        'transaction. Nothing was written, and nothing would verify on-chain.',
    })
  }

  return {
    settlementTxHash: explicit ?? decoded!,
    source: explicit && decoded ? 'both' : explicit ? 'settlement_tx_hash' : 'payment_response',
  }
}

/**
 * #3727: the `settlement_evidence` block the outcome report carries when the
 * caller supplied evidence — the result of the ONE `reportSettlementEvidence`
 * call it replaced (the same seam `haven_report_settlement_evidence` uses, so
 * the on-chain verification and every refusal are exactly that tool's). Absent
 * entirely when no evidence was supplied: calls without evidence answer the
 * pre-existing shape, byte for byte.
 */
type ReportedSettlementEvidence = {
  readonly settlement_tx_hash: string
  readonly source: FoldedSettlementEvidence['source']
  readonly recorded: boolean
  readonly outcome: EvidenceReportOutcome['outcome'] | 'not_attempted'
  readonly status_code?: number
  readonly refusal_reason?: string
  readonly note?: string
}

const EVIDENCE_RECORDED_OMITTED_REASON =
  'the merchant accepted the paid retry and the settlement is verified and recorded; the purchase is complete and no Haven tool follows'

function evidenceHandoff(
  reported: ReportedSettlementEvidence,
  paymentId: string,
): HostedHandoff {
  if (reported.recorded) {
    return { nextTool: null, nextToolOmittedReason: EVIDENCE_RECORDED_OMITTED_REASON }
  }
  if (reported.outcome === 'retryable') {
    return {
      nextTool: 'haven_report_settlement_evidence',
      nextArguments: { payment_id: paymentId, settlement_tx_hash: reported.settlement_tx_hash },
    }
  }
  if (reported.outcome === 'refused') {
    return {
      nextTool: null,
      nextToolOmittedReason:
        'the settlement hash was refused: it does not match this payment on-chain — do not re-report the same hash',
    }
  }
  // Unreachable for an accepted outcome (not_attempted only rides a rejection,
  // which keeps the sweep handoff), but typed honestly rather than asserted.
  return { nextTool: 'haven_get_payment_status', nextArguments: { payment_id: paymentId } }
}

function evidenceReason(reported: ReportedSettlementEvidence): string {
  if (reported.recorded) {
    return (
      'Recorded. The merchant settlement was verified on-chain and recorded beside the funding ' +
      'transaction; the purchase is complete and no further Haven tool is needed.'
    )
  }
  if (reported.outcome === 'retryable') {
    return (
      'Recorded. The settlement hash could not be verified yet (the chain read failed, or the ' +
      'transaction is not mined); retry haven_report_settlement_evidence with the same hash.'
    )
  }
  return (
    'Recorded, but the settlement evidence was refused: the hash does not match this payment ' +
    'on-chain. Do not re-report the same hash — check the PAYMENT-RESPONSE you relayed.'
  )
}

function differsFromRequest(target: X402RetryTarget): { resource_url_differs_from_request?: boolean } {
  return target.resourceUrlDiffersFromRequest === undefined
    ? {}
    : { resource_url_differs_from_request: target.resourceUrlDiffersFromRequest }
}

// #3497: the block itself moved to `support/allowance-block.ts` — #3476 built
// it here and declared it capability-local because nothing else called it;
// #3497 item 4 wires the same block into `haven_pay_mcp_tool`, which made it
// a two-slice helper. Imported from support (never deep, per the barrel rule)
// — the moved helper's own doc comment carries the data-source and degradation
// reasoning verbatim, and the plain-HTTP call sites are unchanged.

/**
 * The tools this capability owns, as a tuple so the set is data rather than a
 * comment. `satisfies` pins every entry to a real `HostedToolName`, and
 * `createToolHandlers`' `HostedToolHandlers` annotation refuses a surface
 * where a tool ends up with NO owner (TS2741 names the missing one). The
 * disjointness of this tuple against the facade's own literal is asserted in
 * `tools/support/shared-helper-ownership.test.ts` (the shadow check — a
 * duplicate key in the facade's literal would win silently).
 */
export const PLAIN_HTTP_X402_TOOLS = [
  'haven_quote_x402',
  'haven_pay_x402_quote',
  'haven_resume_x402_payment',
  'haven_report_x402_outcome',
] as const satisfies readonly HostedToolName[]

export type PlainHttpX402ToolName = (typeof PLAIN_HTTP_X402_TOOLS)[number]

/**
 * This capability's handler contribution to `createToolHandlers`.
 *
 * The return type is keyed on the tuple above, so adding a name there without
 * a handler (or a handler without a name) is a compile error here rather than
 * a runtime registry issue discovered at server boot.
 */
export function createPlainHttpX402Handlers(
  haven: HavenClient,
): HostedToolHandlers<PlainHttpX402ToolName> {
  return {
    haven_quote_x402: async (input) => {
      // #2348: parsed INSIDE a failure envelope. Unlike batch 1's three, this
      // handler and haven_pay_x402_quote below parse before their `runTool`,
      // so a validation error escaped the direct-embedder path as a raw throw
      // rather than a ToolFailure. That was already true of the permissive
      // `parse` (a missing `url` threw a ZodError), but strictness makes the
      // path reachable often enough that leaving it would be a real defect.
      let args: Record<string, any>
      try {
        args = parseStrict('haven_quote_x402', input)
      } catch (err) {
        return normalizeError(err)
      }
      const init: RequestInit = {}
      if (args.method) init.method = args.method
      if (args.headers) init.headers = args.headers
      // `!== undefined`, not truthiness, matching the local surface's
      // `requestInit`: an empty-string body is a body, and a paywall that
      // varies on `POST` with no payload is a different request from one with
      // no body at all. Conflating them is the same class of error this tool
      // was refusing rather than committing. No Content-Type is inferred —
      // the caller sends `headers` for that, exactly as locally.
      if (args.body !== undefined) init.body = args.body
      // #2999: started BEFORE the quote fetch, same non-throwing
      // `.then(a => a, () => undefined)` convention as haven_pay_x402_quote's
      // own prefetch below — `undefined` means the read failed, not that the
      // agent has no rail. This is one read-only GET per quote (the plain-HTTP
      // quote made none before #2999); a `haven_pay_x402_quote` that follows
      // as a separate tool call makes its own read — the SDK's in-flight
      // dedupe (`AccountReads.agentInFlight`) only collapses reads issued
      // within the same tick. The "exactly ONE agent fetch" pin on this file
      // measures the pay tool alone and is unaffected. Through the hosted
      // server the dispatch identity gate (`identity-gate.ts`) adds one more
      // agent read before this handler runs.
      const agentPromise = haven.getAgent().then(
        (a) => a,
        () => undefined,
      )
      try {
        const quote: X402Quote = await haven.quoteX402(args.url, init)
        const agent = await agentPromise
        // #2999: the same #2991 prediction the two MCP quote tools carry,
        // built from the identical selector via the shared support helper —
        // never derived here, so this can never disagree with what
        // haven_pay_x402_quote actually selects next.
        const prediction = settlementPredictionFields(
          quote.paymentRequired.accepts,
          agent,
          'haven_pay_x402_quote',
        )
        // Return the full quote — the agent passes paymentRequired to haven_pay_x402_quote.
        // Omit the captured request snapshot (it's server-side context, not useful at the agent).
        return {
          success: true,
          data: {
            rail: quote.rail,
            idempotency_key: quote.idempotencyKey,
            payment_required: quote.paymentRequired,
            accepted: quote.accepted,
            // #2054: see buildMcpToolQuoteResponse — same field, same meaning.
            accepted_scheme: quote.acceptedScheme,
            ...(quote.acceptedScheme === 'erc7710' ? { erc7710_only: true } : {}),
            resource_url: quote.resourceUrl,
            // #3097: the URL the agent quoted is the URL the paid retry goes
            // to; the merchant's `resource_url` is its declaration about
            // itself. Pass `request_url` back as `url` to haven_pay_x402_quote.
            request_url: quote.request.url,
            retry_url: quote.request.url,
            resource_url_differs_from_request: quote.resourceUrlDiffersFromRequest,
            description: quote.description,
            mime_type: quote.mimeType,
            amount_atomic: quote.amountAtomic,
            amount: quote.amount,
            token: quote.token,
            asset: quote.asset,
            network: quote.network,
            chain_id: quote.chainId,
            merchant_address: quote.merchantAddress,
            max_timeout_seconds: quote.maxTimeoutSeconds,
            ...prediction,
          },
        }
      } catch (err) {
        // #1328: quoteX402's defensive MACHINE-PAYMENT-CHALLENGE guard stays,
        // but nothing in Haven produces that header anymore (the mpp_demo
        // route it identified is retired) — fall through to the generic
        // error rather than suggesting the now-deleted haven_quote_mpp.
        return normalizeError(err)
      }
    },

    haven_pay_x402_quote: async (input) => {
      // #2348: see haven_quote_x402 above — same pre-`runTool` parse, same
      // normalisation, same reason.
      let args: Record<string, any>
      try {
        args = parseStrict('haven_pay_x402_quote', coerceJsonField(input, 'payment_required'))
      } catch (err) {
        return normalizeError(err)
      }
      // #1469: agent-supplied shape, sanitized through the SAME normalizer the
      // parsed-Response path uses — it drops null/non-object accepts[] entries
      // and validates the envelope. The raw cast this replaced let a null hole
      // reach the selectors and 500 where every other caller gets a clean
      // refusal; the Zod schema only guarantees a string-keyed record.
      const payReq = normalizePaymentRequired(args.payment_required)
      if (!payReq) {
        return wrongTool(
          'WRONG_TOOL',
          'The payment_required argument is missing or is not a valid x402 PaymentRequired object. Call haven_quote_x402 first to obtain the payment_required, or use haven_pay_mcp_tool for a full round trip.',
          'haven_quote_x402',
        )
      }
      return runTool(async () => {
        // #3097: where the paid retry will go, decided BEFORE any intent exists.
        // The caller's `url` (the one it quoted) wins; the merchant-declared
        // `resource.url` is the fallback. A public http:// target is refused
        // here — this tool never retries the merchant itself, so this is the
        // last point before a signed header is handed to the agent.
        const retryTarget = resolveX402RetryTarget({
          requestUrl: args.url,
          resourceUrl: payReq.resource.url,
        })
        if (!isSecureX402RetryTarget(retryTarget.url)) {
          throw new HostedToolError({
            code: 'INSECURE_RETRY_TARGET',
            message:
              `Refusing to prepare a payment whose paid retry would go to ${retryTarget.url}: ` +
              'the retry must target an https URL. The merchant\'s challenge declared this ' +
              'resource URL; re-call with the https URL you quoted as `url` (haven_quote_x402 ' +
              'returns it as request_url), and treat a merchant whose challenge downgrades the ' +
              'scheme as suspect. Nothing was funded or signed.',
            statusCode: 400,
            nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-call with the https URL you quoted as url; nothing was funded or signed' }),
          })
        }
        // #3747: the hosted egress policy also runs HERE, at the last point
        // before an intent exists — an https:// IP literal or internal name
        // passes the scheme check above but is refused before funding, so it
        // can never surface only as a funded-but-undeliverable payment.
        if (haven.merchantEgress) {
          try {
            haven.merchantEgress.assertUrl(retryTarget.url)
          } catch (err) {
            throw egressRefusalBeforeIntent(err)
          }
        }
        // #1351: shape-check the cap before the funding intent — this tool has
        // no merchant probe of its own, so this is the first thing that runs.
        const cap = readMaxAmountCap(args, { required: false })
        try {
          // ── #2041: ONE cap assertion, against the option actually selected ──
          // This tool used to assert the cap HERE, pre-network, against
          // `selectStandardPaymentOption`. #1453 made that selector and
          // `selectErc7710PaymentOption` mutually exclusive, so a cap checked
          // before selection is a cap checked against an option that may not be
          // the one authorized — and that is wrong in BOTH directions:
          //
          //   cheap standard + expensive erc7710 -> the cap UNDER-binds, and a
          //     merchant-controlled payment_required walks straight through a
          //     stated spending limit (measured at 900 USDC against a 1 USDC
          //     cap on the sibling tools, #2051);
          //   expensive standard + cheap erc7710 -> the cap OVER-binds and
          //     refuses a purchase that was never going to cost that much,
          //     citing an amount nothing would have authorized.
          //
          // Two cap checks guarding two selectors is how that happened twice —
          // once in each direction. So the scheme is selected FIRST and the cap
          // is asserted exactly ONCE, after selection, against
          // `selection.option`. The reordering costs one read-only agent GET
          // ahead of a refusal that used to be pure; no authorize is created on
          // either path, which is the property that actually protects money.
          //
          // What still runs pre-network is the honest precondition: a cap
          // cannot be enforced against a payment_required that carries no
          // payable option of EITHER kind, because then there is no
          // merchant-authoritative amount to compare it against. That test is
          // rail-independent, so it does not need the agent.
          if (
            cap.kind !== 'none' &&
            !selectStandardPaymentOption(payReq.accepts) &&
            !selectErc7710PaymentOption(payReq.accepts)
          ) {
            const capField = cap.kind === 'human' ? 'max_amount_human' : 'max_amount'
            throw new HostedToolError({
              code: AgentPaymentFailureCode.MaxAmountUnconvertible,
              message:
                `${capField} ("${cap.value}") could not be enforced: this payment_required ` +
                'carries no payment option Haven can settle, so there is no merchant-authoritative ' +
                'amount to compare it against. Haven refuses rather than proceed on an unchecked ' +
                'cap. No funding intent was created and no funds were moved. Re-quote the ' +
                'merchant with haven_quote_x402.',
              statusCode: 400,
              nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the user has to decide before anything is called again; suggested_tool names the tool for after that' }),
              suggestedTool: 'haven_quote_x402',
            })
          }
          // ── #2041: the #1450 preference rule reaches the GENERIC path ──
          // #1456 plumbed scheme selection through haven_pay_mcp_tool and
          // haven_prepare_catalog_purchase and said so in its own scope. This
          // third entry point — plain-HTTP merchants, where the catalog's real
          // merchants actually are — was never covered and hard-routed to the
          // EIP-3009 bridge. That made the merchant TRANSPORT decide the
          // settlement SCHEME, which are independent concerns, and it did so
          // invisibly to the agent.
          //
          // Both halves of the rule come from #1453's SINGLE selector — the
          // preference lives in one place and is not re-derived here: the
          // merchant must advertise extra.assetTransferMethod: 'erc7710' AND
          // the account must be on the delegation rail.
          //
          // A prefetch FAILURE deliberately yields the 3009 path. Guessing
          // 'delegation' would build a request the backend refuses, and 3009
          // is this tool's pre-#2041 behaviour anyway. The prefetch doubles as
          // createX402Intent's delegateAddress hint (#1348), so the 3009 branch
          // still makes exactly ONE agent round-trip rather than two (in this
          // handler; the hosted dispatch identity gate makes its own first).
          const prefetchedAgent = await haven.getAgent().then(
            (a) => a,
            () => undefined,
          )
          const selection = selectX402SettlementScheme(payReq.accepts, {
            delegationRail: prefetchedAgent?.executionRail === 'delegation',
          })

          // THE cap assertion — one, here, against whichever option the
          // selector actually chose, using that option's OWN asset/decimals
          // (#1351: a human cap converts with the decimals of the asset being
          // paid, never a different entry's). `selection` is null only when
          // nothing payable was selected at all, in which case
          // createX402Intent below raises the pre-existing
          // no-compatible-option refusal and there is nothing to cap.
          //
          // #2051 extracted the body of this check into `priceSelectedOption`
          if (selection) {
            priceSelectedOption(cap, selection.option)
          }

          if (selection?.scheme === 'erc7710') {
            const prepared = await haven.prepareX402Erc7710(payReq, {
              delegationRail: true,
              // #2041 (haven-reviewer, BLOCKING): the 3009 fallback below has
              // always passed this. Without it a retried call minted a SECOND
              // independently-signable settlement child instead of replaying
              // the first — and on this scheme the signed artifact IS spend
              // authority, not a funding step. The backend's dedup existed all
              // along (`findX402IntentByIdempotencyKey` runs before the
              // funding-shape branch; the erc7710 insert carries
              // `conflictTarget: 'x402_idempotency_key'`); it was simply never
              // invoked from here.
              ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
              // #3378: build the settlement child under the task budget the
              // caller named (#3329) — this handler used to drop it.
              ...(args.task_budget_id ? { taskBudgetId: args.task_budget_id } : {}),
              // #3617: no sub_budget_id here — haven_pay_x402_quote never
              // declared it, so parseStrict refused it before this line and the
              // forwarding #3330 added was dead. Sub-budgets pay x402 through
              // the local MCP only.
            }).catch(catchSettledReplay)
            // #3417: a replayed key whose payment already settled is a done state,
            // not the transient 500 it used to surface as — answer with the original.
            if ('settledReplay' in prepared) return prepared.settledReplay
            // #3476: same block on the erc7710 branch, built from the settlement
            // child's own asset/amount — the entry the selector actually chose.
            const allowance = await delegationAllowanceBlock(
              haven,
              prefetchedAgent,
              prepared.settlement.amountAtomic,
              prepared.settlement.asset,
            )
            return {
              payment_id: prepared.paymentId,
              status: 'pending_signature',
              // Same vocabulary haven_pay_mcp_tool already returns (#1456), not
              // a parallel one — an agent reads one shape across both entry
              // points.
              settlement_scheme: 'erc7710',
              settlement: {
                scheme: 'erc7710',
                funding_leg: false,
                merchant_pay_to: prepared.settlement.merchantPayTo,
                facilitator_addresses: prepared.settlement.facilitatorAddresses,
              },
              amount_atomic: prepared.settlement.amountAtomic,
              asset: prepared.settlement.asset,
              network: prepared.settlement.network,
              resource_url: payReq.resource?.url,
              // #3097: the URL to send the paid retry to — the caller's, not the
              // merchant's declaration.
              retry_url: retryTarget.url,
              ...differsFromRequest(retryTarget),
              ...(allowance.allowance ? { allowance: allowance.allowance } : {}),
              // #1275/#1351: the optional-cap nudge applies on both schemes.
              ...(cap.kind === 'none' ? { cap_warning: CAP_WARNING_TEXT } : {}),
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
                nextTool: 'haven_sign',
                nextArguments: { payment_id: prepared.paymentId },
                safeToContinue: true,
                reason:
                  'Sign locally: call next_tool with next_arguments EXACTLY as given — the signer ' +
                  "fetches the settlement child itself and verifies its caveats against Haven's " +
                  'signed context before signing. Then call haven_submit with ' +
                  "settlement_scheme: 'erc7710' to receive the merchant payment_header, and retry " +
                  'the original merchant request yourself, setting PAYMENT-SIGNATURE ' +
                  '(x402 v2) to it and ONLY that name on this scheme. Do NOT call ' +
                  'haven_x402_sign_header: on this scheme Haven assembles the header and there is ' +
                  'no funding transaction to wait for.',
                summary: {
                  payment_id: prepared.paymentId,
                  status: 'pending_signature',
                  amount_atomic: prepared.settlement.amountAtomic,
                  network: prepared.settlement.network,
                  // The child's own short expiry is the binding window on this
                  // scheme, not the intent's — no quote-expiry warning applies.
                  expires_at: undefined,
                },
                warnings: [
                  ...allowance.warnings,
                  ...quoteWarnings({
                    capped: cap.kind !== 'none',
                    expiresAt: undefined,
                  }),
                ],
              }),
            }
          }

          const intent = await haven.createX402Intent(payReq, {
            idempotencyKey: args.idempotency_key,
            // #3378: fund the leg under the task budget the caller named (#3329).
            ...(args.task_budget_id ? { taskBudgetId: args.task_budget_id } : {}),
            // #3617: no sub_budget_id — see the erc7710 branch above.
            ...(prefetchedAgent?.delegateAddress
              ? { delegateAddress: prefetchedAgent.delegateAddress }
              : {}),
          })
          // #3476: the budget block rides the 3009 shape too — the plain-HTTP
          // sibling must answer with the same visibility the catalog preflight
          // gives its agents on the delegation rail. The amount/token compared
          // are `createX402Intent`'s OWN authorization facts
          // (x402AuthorizationAmount(option) over the selected entry's asset),
          // so the figure can never describe a different option than the one
          // this intent funds.
          const allowance = await delegationAllowanceBlock(
            haven,
            prefetchedAgent,
            intent.amountAtomic,
            intent.asset,
          )
          return {
            ...buildX402SigningContext(intent, args.include_signing_payload === true),
            // #3097: see the erc7710 branch — the retry goes to the caller's URL.
            retry_url: retryTarget.url,
            ...differsFromRequest(retryTarget),
            ...(allowance.allowance ? { allowance: allowance.allowance } : {}),
            // #1275: optional-cap soft nudge for this generic x402 flow.
            // #1351: either spelling of the cap clears it.
            ...(cap.kind === 'none' ? { cap_warning: CAP_WARNING_TEXT } : {}),
            // #1308: decomposed-path next step.
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
              nextTool: 'haven_sign_x402',
              nextArguments: { payment_id: intent.paymentId },
              safeToContinue: true,
              // #2291: this said "relay via haven_submit and finish with
              // haven_x402_sign_header", which next_tool made impossible —
              // haven_sign_x402 is a one-shot that spends its own binding
              // building the header, so the named successor could only refuse.
              // One contract now, and it is the one the tool already implements.
              reason:
                'Sign locally: call next_tool with next_arguments EXACTLY as given — the ' +
                'signer fetches payment_required itself; only if it reports the context carried ' +
                'none, re-call with the payment_required you passed to this tool added VERBATIM. ' +
                'It returns BOTH signature and payment_header. Relay signature via haven_submit, ' +
                'then retry retry_url yourself with payment_header. Do NOT call ' +
                'haven_x402_sign_header: haven_sign_x402 already spent its binding building that ' +
                'header, so that call can only refuse. The header is signed before funding ' +
                'confirms, so retry promptly.',
              summary: {
                payment_id: intent.paymentId,
                status: intent.status,
                amount_atomic: intent.amountAtomic,
                network: intent.network,
                expires_at: intent.expiresAt,
              },
              warnings: [
                ...allowance.warnings,
                ...quoteWarnings({
                  capped: cap.kind !== 'none',
                  expiresAt: intent.expiresAt,
                }),
              ],
            }),
          }
        } catch (err) {
          if (err instanceof HavenPaymentStateError && isPendingApproval(err.status)) {
            return {
              payment_id: err.paymentId,
              status: 'pending_approval',
              payload_hash: null,
              // #1308 review: the decomposed twin gets the SAME unsafe-to-continue
              // signal as the one-call tool — this is the state the contract
              // exists for.
              // #2101: this is a DECLINE, not a queue. next_action is the field the
              // agent contract says to follow FIRST, so it must say stop — prose
              // saying "do not wait" beside a next_action of wait_for_user_approval
              // is a payload that contradicts itself, and the field wins.
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.StopAndTellUser,
                // #3101: omitted + reason when the id is unknown (decision 3).
                ...paymentStatusHandoff(err.paymentId),
                safeToContinue: false,
                reason:
                  'The amount exceeds the remaining budget, so the payment was declined. ' +
                  'Nothing is queued and no approval will arrive: tell the user, and ask the ' +
                  'wallet owner to raise the budget in Haven. Do NOT re-quote, re-pay, or poll.',
                summary: { payment_id: err.paymentId ?? 'unknown', status: 'pending_approval' },
              }),
            }
          }
          throw err
        }
      })
    },

    haven_resume_x402_payment: async (input) => {
      // #2145 AMENDS #2131/#2041: the gate below requires
      // nextAction === 'retry_original_x402_request', and it now has exactly
      // one producer — the backend's status projection
      // (agent-payment-status.ts, `intentStateFor`), which emits it for a
      // confirmed eip3009 intent whose merchant leg was never reported
      // (funded-but-undelivered, the crash shape). The SDK's dead `executed`
      // → retry fallback is resolved fail-closed, so the value cannot be
      // minted client-side; this gate reads the backend's verdict verbatim.
      //
      // The #2041 reasoning below is retained because it is still true and is
      // the narrower case — it explains why erc7710 could not reach the gate
      // even while the legacy producer existed:
      //
      // #2041: its gate required a state the backend then emitted for exactly
      // one status — 'executed', meaning "the funding payment completed"
      // (agent-payment-status.ts, before #2055). erc7710 has no
      // funding payment, a successful settle leaves the intent at 'submitted'
      // (#1508), and an over-budget erc7710 authorize now refuses HTTP 403
      // delegation_budget_exceeded before an intent row is even created
      // (#2098/#2082, tightening #2023's finding — it used to return
      // pending_signature and enter no approval lifecycle) — so a fortiori no
      // erc7710 intent reaches 'executed'. Note also that the
      // resume state's `accepted` is SYNTHESIZED as a plain exact option with
      // no extra.assetTransferMethod, so a resumed quote would select 3009 by
      // construction. Left unchanged deliberately: the 3009 path through here
      // is byte-identical, and inventing an erc7710 resume would be inventing
      // a flow no state machine produces.
      // #1328: the mpp-rail redirect (haven_resume_mpp_payment) is retired —
      // a non-x402 resume_state now falls through to resolveResumeState's own
      // rail mismatch, not a "use this other tool" suggestion.
      return runTool(async () => {
        // #2349: parsed INSIDE the failure envelope. This handler parsed before
        // its `runTool`, the same embedder-path defect #2348 fixed on
        // haven_quote_x402 and haven_pay_x402_quote: a validation error
        // escaped `createToolHandlers` as a raw throw instead of a ToolFailure.
        const args = parseStrict('haven_resume_x402_payment', input)
        const state = await resolveResumeState(haven, args, 'x402') as X402ResumeState

        // Verify the payment is ready to retry before returning signing context.
        const status = await haven.getPaymentStatus(state.paymentId)
        if (status.nextAction !== 'retry_original_x402_request') {
          throw new HavenPaymentStateError(
            status.message ??
              `Payment ${state.paymentId} is not ready to resume (nextAction=${status.nextAction}).`,
            409,
            status,
          )
        }

        // #3097: same rule as haven_pay_x402_quote — the caller's `url`, else
        // the captured request, else `state.url` (the SDK builder's "original
        // paid URL", which survives when `request` was never captured); the
        // merchant's `resourceUrl` is the last fallback. A public http:// target
        // is refused before the signing context is handed out — AFTER the
        // readiness gate above, so a payment that needs no retry is never
        // refused for a retry it will not make (haven-reviewer on #3112).
        // A resume from a bare payment_id reads the backend's resume_state,
        // whose `url` IS the merchant declaration; for an http-declaring
        // merchant that resume is refused every time unless the agent
        // supplies `url`, which is why the message names the exits.
        const retryTarget = resolveX402RetryTarget({
          requestUrl: args.url ?? state.request?.url ?? state.url,
          resourceUrl: state.resourceUrl,
        })
        if (!isSecureX402RetryTarget(retryTarget.url)) {
          throw new HostedToolError({
            code: 'INSECURE_RETRY_TARGET',
            message:
              `Refusing to hand out a signing context whose paid retry would go to ${retryTarget.url}: ` +
              'the retry must target an https URL. Re-call with the https URL you originally quoted ' +
              'as `url`. If that URL is gone, the funding leg is already confirmed for this payment: ' +
              'check haven_get_payment_status, and if no settlement appears within the payment ' +
              'window, recover the delegate balance with haven_sweep_delegate. Do not pay again.',
            statusCode: 400,
            nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-call with the https URL you originally quoted as url; the status and sweep exits are in the message' }),
            paymentId: state.paymentId,
            phase: 'funded_but_unsettled',
            suggestedTool: 'haven_get_payment_status',
          })
        }

        // Return the same signing context shape as haven_pay_x402_quote so the
        // signer can rebuild the merchant header from payment_id alone.
        // #2291: this comment used to name haven_x402_sign_header here, which
        // is the fourth place the pre-#2291 contract was written down. On this
        // path the header comes from haven_sign_x402's own result — that
        // one-shot spends its binding building it — and the description
        // constant above (RESUME_X402_DESCRIPTION) is the agent-facing
        // statement of the same thing.
        return {
          payment_id: state.paymentId,
          status: status.status,
          tx_hash: status.txHash ?? null,
          payment_required: state.paymentRequired,
          x402: {
            accepted: state.accepted,
            resource_url: state.resourceUrl,
            retry_url: retryTarget.url,
            amount: state.amount,
            amount_atomic: state.amountAtomic,
            token: state.token,
            asset: state.asset,
            network: state.network,
          },
        }
      })
    },

    // #1328: haven_quote_mpp / haven_pay_mpp_challenge / haven_resume_mpp_payment
    // (the mpp_demo challenge/quote/resume/authorize tools) are retired —
    // haven_pay_mpp_challenge in particular called POST /machine-payments/authorize
    // directly, which now refuses unconditionally on the backend. Use the x402
    // tools for agent-to-merchant payments.

    haven_report_x402_outcome: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_report_x402_outcome', input)
        // #3727: resolve and validate the optional folded evidence BEFORE
        // anything is written — a malformed or self-contradictory call
        // refuses here and leaves no partial record.
        const evidence = resolveSettlementEvidence(args)
        const report = await haven.reportX402MerchantOutcome({
          paymentId: args.payment_id,
          outcome: args.outcome,
          merchantStatus: args.merchant_status,
          ...(args.merchant_body ? { merchantBody: args.merchant_body } : {}),
        })
        // #3727: on an accepted outcome, record the folded evidence through
        // the SAME seam `haven_report_settlement_evidence` uses — one call
        // replaces the follow-up. Deliberately BEFORE the status re-read
        // below, so the re-read reflects the write: a confirmed evidence
        // report shows up as `merchant_settlement_recorded: true` on the
        // very read this response is reconciled against. On a REJECTED
        // outcome the evidence is ignored with a warning (the report's own
        // handoff to haven_sweep_delegate is unchanged) — there is no
        // merchant settlement to verify when the merchant refused the retry,
        // and the caller can re-send the same evidence once it holds a real
        // acceptance. The three-outcome contract (`confirmed` / `retryable`
        // / `refused`) is that tool's; a refused hash names the same
        // on-chain mismatch it always did.
        let settlementEvidence: ReportedSettlementEvidence | null = null
        if (evidence && report.outcome === 'accepted') {
          const evidenceOutcome = await haven.reportSettlementEvidence(
            report.paymentId,
            evidence.settlementTxHash,
          )
          settlementEvidence = {
            settlement_tx_hash: evidence.settlementTxHash,
            source: evidence.source,
            recorded: evidenceOutcome.outcome === 'confirmed',
            outcome: evidenceOutcome.outcome,
            ...(evidenceOutcome.outcome !== 'confirmed' && evidenceOutcome.statusCode !== undefined
              ? { status_code: evidenceOutcome.statusCode }
              : {}),
            ...(evidenceOutcome.outcome === 'refused' && evidenceOutcome.reason
              ? { refusal_reason: evidenceOutcome.reason }
              : {}),
          }
        } else if (evidence) {
          settlementEvidence = {
            settlement_tx_hash: evidence.settlementTxHash,
            source: evidence.source,
            recorded: false,
            outcome: 'not_attempted',
            note:
              'Evidence is only recorded with outcome "accepted"; the rejection was recorded as reported, ' +
              'and no settlement was verified or written.',
          }
        }
        // Re-read rather than predict. The status this returns is the one the
        // agent would get from haven_get_payment_status on its next call, so
        // "reflected on the NEXT call" is demonstrated in the report's own
        // response instead of being asserted by the description. A status read
        // that fails must not turn a RECORDED report into a reported failure —
        // the write already happened and is not undone by a failed read.
        let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null = null
        try {
          status = await haven.getPaymentStatus(report.paymentId)
        } catch {
          status = null
        }
        // #3475 follow-up (owner decision, 2026-09-30): an `accepted` outcome
        // on an eip3009 plain-HTTP payment with no merchant settlement
        // recorded yet offers haven_report_settlement_evidence as the next
        // step. `settlementScheme`/`merchantSettlementRecorded` are read from
        // the SAME re-read above — no second call — and default to "do not
        // offer" when the read failed or the fields are absent (an older
        // backend, or genuinely unknown), which is the safe side: erc7710,
        // a non-x402 rail, and an already-recorded settlement all keep the
        // pre-existing "no tool follows" answer, unchanged.
        const offerSettlementEvidence =
          report.outcome === 'accepted' &&
          status?.settlementScheme === 'eip3009' &&
          status?.merchantSettlementRecorded !== true
        return {
          payment_id: report.paymentId,
          outcome: report.outcome,
          recorded: report.recorded,
          // Echoed so a reconciling human can see WHICH transaction the report
          // was anchored to — and see that the agent did not choose it.
          tx_hash: report.txHash,
          resource_url: report.resourceUrl,
          // #3727: present only when the caller supplied evidence — calls
          // without evidence answer the pre-existing shape, byte for byte.
          ...(settlementEvidence ? { settlement_evidence: settlementEvidence } : {}),
          ...buildAgentGuidance({
            // #3475 follow-up review round 1 (S1): next_action is UNCHANGED
            // by the settlement-evidence offer — it stays the status re-read's
            // own answer (or the pre-existing per-outcome default), exactly as
            // before this follow-up. The offer rides next_tool /
            // next_arguments / reason only, so
            // AgentPaymentNextAction.AwaitingSettlementEvidence's published
            // meaning (an erc7710 payment past its settlement window with no
            // verified evidence) is never reused for a different fact.
            nextAction:
              status?.nextAction ??
              (report.outcome === 'rejected'
                ? AgentPaymentNextAction.SweepStrandedFunds
                : AgentPaymentNextAction.None),
            // #3727: the handoff comes from the outcome + folded-evidence
            // result — a confirmed record names no tool, a retryable one
            // re-names the evidence tool with the hash prefilled, and a
            // refused one names no tool (re-reporting the same hash
            // re-refuses). Without evidence this is the #3475 offer logic,
            // unchanged.
            ...reportOutcomeHandoff(
              report.outcome,
              offerSettlementEvidence,
              report.paymentId,
              settlementEvidence,
            ),
            safeToContinue: true,
            reason:
              report.outcome === 'rejected'
                ? settlementEvidence
                  ? 'Recorded. The merchant refused the paid retry, so the funding may be stranded on ' +
                    'the delegate wallet — recover it with haven_sweep_delegate. Do NOT pay again for ' +
                    'the same purchase. The settlement evidence you attached was not used: it is only ' +
                    'recorded with an accepted outcome.'
                  : 'Recorded. The merchant refused the paid retry, so the funding may be stranded on ' +
                    'the delegate wallet — recover it with haven_sweep_delegate. Do NOT pay again for ' +
                    'the same purchase.'
                : settlementEvidence
                  ? evidenceReason(settlementEvidence)
                  : offerSettlementEvidence
                    ? "Recorded. If the merchant's response carried a settlement transaction " +
                      '(PAYMENT-RESPONSE.transaction), pass it as settlement_tx_hash to ' +
                      'haven_report_settlement_evidence so Haven can verify and record it. If it did ' +
                      'not, the purchase is already complete and no further Haven tool is needed.'
                    : 'Recorded. The purchase is complete and no longer reads as undelivered; no further ' +
                      'Haven tool is needed.',
            summary: {
              payment_id: report.paymentId,
              status: status?.status ?? 'confirmed',
            },
          }),
          phase: status?.phase ?? null,
        }
      }),
  }
}
