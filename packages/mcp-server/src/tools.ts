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
 * #2811 is the third: the plain-HTTP x402 handlers live in
 * `tools/plain-http-x402.ts`. All three are composed into
 * `createToolHandlers` as typed contributions.
 *
 * What is left here is the paid-MCP completion handler that #2812 takes next,
 * plus the re-export surface.
 */
import { AgentPaymentNextAction, HavenClient } from '@haven_ai/sdk'
import {
  type HostedToolHandlers,
} from './tools/contracts.js'
import { parseStrict, setStrictRefusalThrower } from './tools/parsing.js'
import { createCatalogPurchaseHandlers } from './tools/catalog-purchase.js'
import { createPlainHttpX402Handlers } from './tools/plain-http-x402.js'
import { createStateDirectRecoveryHandlers } from './tools/state-direct-recovery.js'
import { HostedToolError, runTool } from './tools/support/errors.js'
import { buildAgentGuidance, buildPurchaseSummary } from './tools/support/guidance.js'
import {
  deliverMerchantPayment,
  preflightMcpPaymentHeader,
  resolveMerchantCallContext,
  submitSignatureWithExpiryMapping,
} from './tools/support/mcp-context.js'
import { isPendingApproval } from './tools/support/quote-response.js'

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
export {
  createPlainHttpX402Handlers,
  PLAIN_HTTP_X402_TOOLS,
  type PlainHttpX402ToolName,
} from './tools/plain-http-x402.js'

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

    // #2811: the plain-HTTP x402 lifecycle — haven_quote_x402,
    // haven_pay_x402_quote, haven_resume_x402_payment,
    // haven_report_x402_outcome — are owned by the capability module and
    // composed in here. Same one-directional guarantee as the spreads above.
    ...createPlainHttpX402Handlers(haven),

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

  }
}
