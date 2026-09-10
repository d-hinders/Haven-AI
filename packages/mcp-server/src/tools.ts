/**
 * Hosted MCP tool HANDLERS — the #2807 compatibility facade, post-#2808.
 *
 * The tool contracts (names, schemas, input-policy decisions, descriptions,
 * payload types) live in `tools/contracts.ts`; the registration seam in
 * `tools/registry.ts`; argument parsing in `tools/parsing.ts`. The cross-tool
 * SAFETY SUPPORT (error normalization + `HostedToolError`, agent guidance and
 * purchase summaries, cap/price selection, MCP transport serialization and
 * merchant-context validation, the expiry-aware signing context, quote
 * responses and status predicates) moved to `tools/support/*` in #2808 — the
 * derived helper-to-capability mapping that justifies each placement lives in
 * `tools/support/shared-helper-ownership.test.ts`. This module keeps the
 * handler behaviour (`createToolHandlers`) and re-exports the contract
 * surface unchanged — `index.ts`, `server.ts`, tests and embedders import it
 * exactly as before, and later capability slices (#2809–#2812) move the
 * handlers OUT while this facade stays stable.
 *
 * #2809 was the first such slice: the state / direct-payment / recovery
 * handlers live in `tools/state-direct-recovery.ts`. #2810 is the second: the
 * catalog / quote / prepare handlers live in `tools/catalog-purchase.ts`.
 * Both are composed into `createToolHandlers` as typed contributions.
 *
 * What is left here is the plain-HTTP x402 and paid-MCP completion handlers
 * that #2811 and #2812 take next, plus the re-export surface.
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
import {
  type HostedToolHandlers,
} from './tools/contracts.js'
import { parseStrict, setStrictRefusalThrower } from './tools/parsing.js'
import { createCatalogPurchaseHandlers } from './tools/catalog-purchase.js'
import { createStateDirectRecoveryHandlers } from './tools/state-direct-recovery.js'
import {
  CAP_WARNING_TEXT,
  priceSelectedOption,
  quoteWarnings,
  readMaxAmountCap,
} from './tools/support/cap-price.js'
import {
  HostedToolError,
  normalizeError,
  runTool,
} from './tools/support/errors.js'
import { buildAgentGuidance, buildPurchaseSummary } from './tools/support/guidance.js'
import {
  buildX402SigningContext,
  coerceJsonField,
  deliverMerchantPayment,
  preflightMcpPaymentHeader,
  resolveMerchantCallContext,
  submitSignatureWithExpiryMapping,
} from './tools/support/mcp-context.js'
import {
  buildMcpToolQuoteResponse,
  isPendingApproval,
  resolveResumeState,
  wrongTool,
} from './tools/support/quote-response.js'

// #2807: the parsing seam throws through the SUPPORT module's HostedToolError
// so `normalizeError` keeps a single instanceof branch. The wiring stays HERE
// (this module is the composition root every entry imports); the class moved
// to `tools/support/errors.ts` in #2808. Set at module load; the arrow only
// reads the class when invoked, long after declaration.
setStrictRefusalThrower((details) => {
  throw new HostedToolError(details)
})

export {
  toolSchemas,
  toolDescriptions,
  STRICT_INPUT_TOOLS,
  PERMISSIVE_INPUT_TOOLS,
  MCP_TRANSPORT_CASE_HINT,
  type HostedToolName,
  type StrictInputToolName,
  type PermissiveInputToolName,
  type ToolSuccess,
  type ToolFailure,
  type ToolPayload,
  type HostedToolHandler,
  type HostedToolHandlers,
} from './tools/contracts.js'
export {
  toolInputSchema,
  strictRefusalMessage,
  findHostedToolRegistryIssues,
  findHostedToolRegistryIssuesFor,
  assertHostedToolRegistry,
  type HostedToolRegistryIssue,
  type HostedToolRegistryIssueKind,
  type HostedToolRegistryInputs,
} from './tools/registry.js'
export {
  parse,
  parseStrict,
  setStrictRefusalThrower,
  type StrictRefusalThrower,
  type HostedStrictRefusalDetails,
} from './tools/parsing.js'
export { HostedToolError, ResolvedMerchantCallContext, signerCompatibilityNotice } from './tools/support/index.js'
export {
  createStateDirectRecoveryHandlers,
  STATE_DIRECT_RECOVERY_TOOLS,
  type StateDirectRecoveryToolName,
} from './tools/state-direct-recovery.js'

export function createToolHandlers(haven: HavenClient): HostedToolHandlers {
  return {
    // #2809: state, direct payment and recovery — haven_get_agent,
    // haven_get_allowances, haven_sweep_delegate, haven_send, haven_pay,
    // haven_submit, haven_get_payment_status, haven_get_resume_state,
    // haven_list_receipts, haven_verify_receipt — are owned by the capability
    // module and composed in here. The `HostedToolHandlers` annotation on this
    // function is what keeps the spread honest in ONE direction: a tool the
    // capability stops contributing and this literal does not re-add is a
    // compile error (TS2741 names the missing one), not a boot-time registry
    // issue. The other direction is NOT compile-checked — a key written below
    // that the spread already provides shadows it silently — so do not add a
    // handler here for a tool a capability owns; the disjointness assertion in
    // tools/support/shared-helper-ownership.test.ts is what catches it.
    ...createStateDirectRecoveryHandlers(haven),

    // #2810: catalog discovery/submission and the quote/prepare/pay path —
    // haven_discover_tools, haven_submit_catalog_entry, haven_quote_mcp_tool,
    // haven_pay_mcp_tool, haven_quote_catalog_purchase,
    // haven_prepare_catalog_purchase — are owned by the capability module and
    // composed in here. Same one-directional guarantee as the spread above: a
    // tool the capability stops contributing is a compile error, a tool
    // re-declared BELOW is a silent shadow, so do not add a handler here for a
    // tool this capability owns.
    ...createCatalogPurchaseHandlers(haven),

    haven_complete_mcp_tool: async (input) =>
      runTool(async () => {
        // #2353's switch: parseStrict, like every other strict tool's handler —
        // the transport-level registration refuses an undeclared key for MCP
        // callers, and this is the second line for an embedder that imports
        // `createToolHandlers` directly, where no MCP SDK validation runs.
        // Both layers read their refusal text from STRICT_INPUT_TOOLS.
        const args = parseStrict('haven_complete_mcp_tool', input)
        return deliverMerchantPayment(haven, args)
      }),

    haven_settle_mcp_tool: async (input) =>
      runTool(async () => {
        const args = parseStrict('haven_settle_mcp_tool', input)
        // ── #2282: the merchant-call context is resolved BEFORE anything is
        // submitted, on BOTH schemes. ──
        //
        // This tool's whole purpose is "fund AND deliver in one call", so it
        // relays the funding signature itself. The context needed for the
        // delivery half used to be resolved inside `deliverMerchantPayment`,
        // i.e. after that relay: an intent created by `haven_pay_x402_quote`
        // has no stored context (that tool receives only the raw 402 — a
        // PaymentRequired carries a resource URL but no MCP tool name and no
        // arguments, so there is nothing to store), and the caller learned so
        // only once the funding was confirmed on-chain. The check was correct
        // and it ran after the thing it would have prevented, leaving a
        // `funded_but_unsettled` intent that this tool can no longer finish —
        // a settle retry with explicit context relays funding again and gets
        // `expected pending_signature`, which reads like "your context was
        // fine". Recovery meant switching to `haven_complete_mcp_tool`.
        //
        // Resolved here, the same refusal lands while the intent is still
        // `pending_signature` and nothing has been spent, so the caller retries
        // THIS tool with explicit merchant_url/tool_name/arguments and it
        // simply works. The failure stops stranding value instead of being
        // reported sooner. Same reasoning as the erc7710 branch below: there
        // the submit burns the settlement child, which is not recoverable by
        // re-signing either.
        const merchantContext = await resolveMerchantCallContext(haven, args)
        // Fast path: fund (relay the signature) then deliver the merchant header
        // in one hosted call. The signature and X-PAYMENT header are both signed
        // by the local edge signer — Haven relays them but never holds the key.
        //
        // This MUST precede submitSignature: a malformed or substituted merchant
        // header is never a reason to fund the delegate balance. It is an
        // integrity preflight, not a merchant/facilitator verification or a
        // replacement for the local signer's expected-context binding.
        // #1456: erc7710 direct settlement inverts this whole sequence, so it
        // branches HERE rather than deeper — an earlier attempt put the branch
        // inside deliverMerchantPayment and the signature had already been
        // relayed as a FUNDING signature by then.
        //
        // On this scheme the signature IS the settlement child, not a funding
        // authorization: it goes to POST /x402/:id/settle, which returns the
        // merchant header Haven assembles. There is no funding leg to relay and
        // no agent-supplied header to preflight — the absence of
        // `payment_header` is what tells the two schemes apart, because the
        // 3009 path always carries one built by the local signer.
        if (!args.payment_header) {
          const paymentHeader = await haven.submitX402Erc7710(args.payment_id, args.signature)
          const merchant7710 = await deliverMerchantPayment(
            haven,
            { ...args, payment_header: paymentHeader },
            // No funding tx to confirm — passing one would make the delivery
            // helper wait for a transaction that will never exist.
            undefined,
            // #1508: and `undefined` alone is NOT enough. The helper still read
            // the payment status unconditionally, which is a 409 here because
            // the settle above already moved the intent to 'submitted'. Say
            // "there is no funding leg" explicitly instead of implying it.
            { noFundingLeg: true, context: merchantContext },
          )
          const summary7710 = await haven.getPostPurchaseAllowanceSummary(args.payment_id)
          return {
            payment_id: args.payment_id,
            settlement_scheme: 'erc7710',
            funding_tx_hash: null,
            settled: merchant7710.ok,
            settlement_tx_hash: merchant7710.settlement_tx_hash,
            result: merchant7710.result,
            allowance: summary7710.allowance,
            ...buildAgentGuidance({
              // Same terminal value the 3009 success path uses (#1308) — one
              // vocabulary, not a parallel one per scheme.
              nextAction: AgentPaymentNextAction.None,
              safeToContinue: true,
              reason:
                'Settled directly from the treasury through the budget delegation — no funding ' +
                'leg, so the delegate wallet never held these funds and there is nothing to sweep.',
              summary: {
                payment_id: args.payment_id,
                status: summary7710.payment?.status ?? 'settled',
                product: args.tool_name,
              },
              warnings: summary7710.warnings,
            }),
          }
        }

        await preflightMcpPaymentHeader(haven, args)
        const funding = await submitSignatureWithExpiryMapping(haven, args.payment_id, args.signature)
        if (funding.status !== 'confirmed') {
          // Funding did not confirm. Do not deliver the merchant header —
          // return the funding status so the agent can act. Echo payment_id so
          // the agent can cross-reference the payment
          // (haven_get_payment_status / haven_list_receipts) without re-deriving it.
          const fundingPending = isPendingApproval(funding.status)
          return {
            payment_id: args.payment_id,
            funding_status: funding.status,
            funding_tx_hash: funding.txHash ?? null,
            settled: false,
            // #1308 review: the two non-confirmed states have DIFFERENT next
            // actions. `fundingPending` is the retained fail-closed branch for
            // a status no live rail emits any more (see `isPendingApproval`) —
            // it stops the agent; a transient funding state is a poll.
            ...buildAgentGuidance({
              nextAction: fundingPending
                ? AgentPaymentNextAction.StopAndTellUser
                : AgentPaymentNextAction.CheckStatusLater,
              nextTool: 'mcp__haven__haven_get_payment_status',
              nextArguments: { payment_id: args.payment_id },
              safeToContinue: !fundingPending,
              reason: fundingPending
                ? 'Funding did not complete and is not payable. Tell the user; do not re-sign or re-settle, and do not wait for an approval — none is queued.'
                : 'Funding is not confirmed yet. Poll next_tool, then finish settlement with haven_complete_mcp_tool once confirmed.',
              summary: { payment_id: args.payment_id, status: funding.status },
            }),
          }
        }
        const merchant = await deliverMerchantPayment(haven, args, funding.txHash, {
          context: merchantContext,
        })
        // #1310: rail-aware remaining-budget summary so the agent can report
        // spend without a separate haven_get_agent/haven_get_allowances round
        // trip. A failed read NEVER converts this settled success into a
        // failure — it degrades to a null block plus a warning, folded into
        // the SAME warnings[] buildAgentGuidance already emits.
        // Reuse the payment-status read the allowance helper already performs;
        // reporting must not add a second status round trip or race it.
        const { allowance, warnings, payment } = await haven.getPostPurchaseAllowanceSummary(args.payment_id)
        const purchaseSummary = buildPurchaseSummary({
          payment,
          merchantResult: merchant.result,
          fundingTxHash: funding.txHash ?? null,
          settlementTxHash: merchant.settlement_tx_hash,
          allowance,
        })
        // Pick explicit fields — don't spread the raw HTTP status/ok, which would
        // collide with the funding/payment-status meaning an agent expects here.
        // Echo payment_id so the agent can reconcile this settled payment against
        // haven_list_receipts / haven_get_payment_status without retaining it from
        // the haven_pay_mcp_tool step.
        return {
          payment_id: args.payment_id,
          funding_tx_hash: funding.txHash ?? null,
          settled: true,
          result: merchant.result,
          settlement_tx_hash: merchant.settlement_tx_hash,
          allowance,
          // #1308: done — nothing left but reporting.
          ...buildAgentGuidance({
            nextAction: AgentPaymentNextAction.None,
            safeToContinue: true,
            reason:
              'Funding and merchant settlement both succeeded. Report the result to the user ' +
              'from agent_summary.purchase_summary; `result` is optional raw merchant evidence, ' +
              'not Haven payment truth. The summary includes remaining allowance/budget when available.',
            summary: {
              payment_id: args.payment_id,
              status: 'settled',
              purchase_summary: purchaseSummary,
            },
            warnings,
          }),
        }
      }),

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
