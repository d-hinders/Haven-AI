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
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import {
  CAP_WARNING_TEXT,
  priceSelectedOption,
  quoteWarnings,
  readMaxAmountCap,
} from './support/cap-price.js'
import { HostedToolError, normalizeError, runTool } from './support/errors.js'
import { buildAgentGuidance } from './support/guidance.js'
import { buildX402SigningContext, coerceJsonField } from './support/mcp-context.js'
import { isPendingApproval, resolveResumeState, wrongTool } from './support/quote-response.js'

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
      try {
        const quote: X402Quote = await haven.quoteX402(args.url, init)
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
              nextAction: AgentPaymentNextAction.StopAndTellUser,
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
          // still makes exactly ONE agent round-trip rather than two.
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
            })
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
              // #1275/#1351: the optional-cap nudge applies on both schemes.
              ...(cap.kind === 'none' ? { cap_warning: CAP_WARNING_TEXT } : {}),
              ...buildAgentGuidance({
                nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
                nextTool: 'mcp__haven-signer__haven_sign',
                nextArguments: { payment_id: prepared.paymentId },
                safeToContinue: true,
                reason:
                  'Sign locally: call next_tool with next_arguments EXACTLY as given — the signer ' +
                  "fetches the settlement child itself and verifies its caveats against Haven's " +
                  'signed context (#1455) before signing. Then call haven_submit with ' +
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
                warnings: quoteWarnings({
                  capped: cap.kind !== 'none',
                  expiresAt: undefined,
                }),
              }),
            }
          }

          const intent = await haven.createX402Intent(payReq, {
            idempotencyKey: args.idempotency_key,
            ...(prefetchedAgent?.delegateAddress
              ? { delegateAddress: prefetchedAgent.delegateAddress }
              : {}),
          })
          return {
            ...buildX402SigningContext(intent, args.include_signing_payload === true),
            // #1275: optional-cap soft nudge for this generic x402 flow.
            // #1351: either spelling of the cap clears it.
            ...(cap.kind === 'none' ? { cap_warning: CAP_WARNING_TEXT } : {}),
            // #1308: decomposed-path next step.
            ...buildAgentGuidance({
              nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
              nextTool: 'mcp__haven-signer__haven_sign_x402',
              nextArguments: { payment_id: intent.paymentId },
              safeToContinue: true,
              // #2291: this said "relay via haven_submit and finish with
              // haven_x402_sign_header", which next_tool made impossible —
              // haven_sign_x402 is a one-shot that spends its own binding
              // building the header, so the named successor could only refuse.
              // One contract now, and it is the one the tool already implements.
              reason:
                'Sign locally: call next_tool with next_arguments EXACTLY as given (#1355: the ' +
                'signer fetches payment_required itself; only if it reports the context carried ' +
                'none, re-call with the payment_required you passed to this tool added VERBATIM). ' +
                'It returns BOTH signature and payment_header. Relay signature via haven_submit, ' +
                'then retry the original merchant URL yourself with payment_header. Do NOT call ' +
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
              warnings: quoteWarnings({
                capped: cap.kind !== 'none',
                expiresAt: intent.expiresAt,
              }),
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
                nextTool: 'mcp__haven__haven_get_payment_status',
                nextArguments: { payment_id: err.paymentId ?? null },
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
        const report = await haven.reportX402MerchantOutcome({
          paymentId: args.payment_id,
          outcome: args.outcome,
          merchantStatus: args.merchant_status,
          ...(args.merchant_body ? { merchantBody: args.merchant_body } : {}),
        })
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
        return {
          payment_id: report.paymentId,
          outcome: report.outcome,
          recorded: report.recorded,
          // Echoed so a reconciling human can see WHICH transaction the report
          // was anchored to — and see that the agent did not choose it.
          tx_hash: report.txHash,
          resource_url: report.resourceUrl,
          ...buildAgentGuidance({
            nextAction:
              status?.nextAction ??
              (report.outcome === 'rejected'
                ? AgentPaymentNextAction.SweepStrandedFunds
                : AgentPaymentNextAction.None),
            ...(report.outcome === 'rejected'
              ? { nextTool: 'mcp__haven__haven_sweep_delegate' as const, nextArguments: {} }
              : {}),
            safeToContinue: true,
            reason:
              report.outcome === 'rejected'
                ? 'Recorded. The merchant refused the paid retry, so the funding may be stranded on ' +
                  'the delegate wallet — recover it with haven_sweep_delegate. Do NOT pay again for ' +
                  'the same purchase.'
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
