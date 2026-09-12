/**
 * #2812 — the PAID-MCP COMPLETION capability of the hosted MCP surface, carved
 * out of `tools.ts` (which stays the compatibility facade `index.ts`,
 * `server.ts`, tests and embedders import).
 *
 * Two tools, one owner:
 *
 *   complete   haven_complete_mcp_tool   (decomposed flow: deliver a signed header)
 *   settle     haven_settle_mcp_tool     (fast flow: fund AND deliver in one call)
 *
 * This is the FINAL capability slice of the #2806 chain. It moves the two
 * handlers AND their merchant delivery / context-rehydration helpers —
 * `resolveMerchantCallContext` (+ the `ResolvedMerchantCallContext` shape),
 * `deliverMerchantPayment` and `preflightMcpPaymentHeader` — out of shared
 * support into this module. Those four were the last single-slice (`s2812`)
 * support exports the #2808 ownership map retained "until #2812 moves them";
 * they now live with the only capability that calls them. The cross-slice
 * helpers they depend on (`parseMcpTransport`, `serializeMcpTransport`,
 * `submitSignatureWithExpiryMapping`, `buildAgentGuidance`,
 * `buildPurchaseSummary`, `isPendingApproval`, `runTool`, `HostedToolError`,
 * `paymentWindowExpiredError`) stay in shared support — they are called from
 * more than one capability slice and are imported from here, never copied.
 *
 * The handler bodies moved VERBATIM: names, schemas (`tools/contracts.ts`),
 * success/failure shapes, request-context behaviour and agent guidance are
 * unchanged, and so are the load-bearing behaviours this slice carries — the
 * #2282 fail-closed ordering (merchant-call context resolved BEFORE any
 * funding relay, on both schemes), the #1456 erc7710 sequence inversion
 * (the signature IS the settlement child, no funding leg, no preflight), the
 * #1508 no-funding-leg flag, the #1307 context rehydration, the #1300
 * verify-then-sweep timeout guidance, and the #1310 rail-aware post-purchase
 * summary.
 *
 * This module NEVER SIGNS: no key material, no signer call site, and no
 * EIP-712/EIP-3009 header construction lives here. The funding signature and
 * the X-PAYMENT header are both signed by the local edge signer — Haven
 * relays them but never holds the key.
 *
 * DEPENDENCY RULE (epic #2806): this module imports the #2807 contract and
 * parsing seams and the #2808 shared support, and NEVER another capability
 * module. The permanent tool-ownership and module-boundary guard that makes
 * that rule executable lives in `tools/module-boundaries.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
  HavenClient,
  MerchantTimeoutError,
  X402PaymentHeaderValidationError,
  validateStandardX402PaymentHeader,
  type X402McpTransport,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { parseStrict } from './parsing.js'
import { HostedToolError, paymentWindowExpiredError, runTool } from './support/errors.js'
import { buildAgentGuidance, buildPurchaseSummary } from './support/guidance.js'
import {
  parseMcpTransport,
  serializeMcpTransport,
  submitSignatureWithExpiryMapping,
} from './support/mcp-context.js'
import { isPendingApproval } from './support/quote-response.js'

/**
 * #1307: resolve merchant_url/tool_name/arguments/mcp_transport for
 * haven_complete_mcp_tool / haven_settle_mcp_tool. Explicit args are the
 * version-skew fallback and win OUTRIGHT when BOTH merchant_url and
 * tool_name are present — never merged with a rehydrated value, so a partial
 * caller-supplied context can't silently combine with stored state for the
 * same call. Omitting either one rehydrates the FULL stored context by
 * payment_id (the #1263 sign-context precedent, applied to the settle leg).
 */
export interface ResolvedMerchantCallContext {
  merchantUrl: string
  toolName: string
  toolArguments: Record<string, unknown>
  mcpTransport: X402McpTransport | undefined
}

export async function resolveMerchantCallContext(
  haven: HavenClient,
  args: Record<string, any>,
): Promise<ResolvedMerchantCallContext> {
  const hasUrl = typeof args.merchant_url === 'string'
  const hasTool = typeof args.tool_name === 'string'
  if (hasUrl && hasTool) {
    return {
      merchantUrl: args.merchant_url,
      toolName: args.tool_name,
      toolArguments: (args.arguments as Record<string, unknown> | undefined) ?? {},
      // #2282: parse the transport HERE, where the caller can still act on a
      // refusal, rather than deep inside the merchant call after funding.
      mcpTransport: parseMcpTransport(args.mcp_transport),
    }
  }
  // #1307 review: exactly ONE of the pair present is refused, not silently
  // overridden — an agent that supplied merchant_url expects it to be used,
  // and half-explicit input must never be combined with stored state.
  if (hasUrl !== hasTool) {
    throw new HostedToolError({
      code: 'INVALID_INPUT',
      message:
        'merchant_url and tool_name must be supplied TOGETHER (explicit context) or both ' +
        'omitted (rehydrated from payment_id). Passing only one is refused rather than ' +
        'silently overridden by stored state.',
      statusCode: 400,
      paymentId: args.payment_id,
      status: 'invalid_input',
      phase: 'not_started',
      nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
      rail: 'x402',
    })
  }
  try {
    const ctx = await haven.getX402MerchantCallContext(args.payment_id)
    return {
      merchantUrl: ctx.merchantUrl,
      toolName: ctx.toolName,
      toolArguments: ctx.arguments,
      mcpTransport: parseMcpTransport(
        ctx.mcpTransport ? serializeMcpTransport(ctx.mcpTransport) : undefined,
      ),
    }
  } catch (err) {
    if (err instanceof HavenApiError) {
      if (err.statusCode === 410) {
        throw paymentWindowExpiredError({
          paymentId: args.payment_id,
          status: 'expired',
          phase: 'expired',
          nextAction: AgentPaymentNextAction.PaymentWindowExpired,
          rail: 'x402',
        })
      }
      // 404 (unknown/foreign payment_id) and 409 (no stored context, or not
      // an x402 intent) both land here: the fix is the same either way —
      // re-send the fields explicitly.
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantCallContextUnavailable,
        message:
          `merchant_url/tool_name were omitted and Haven could not rehydrate a stored merchant ` +
          `call context for payment ${args.payment_id} (${err.message}). Re-send merchant_url, ` +
          'tool_name, arguments, and mcp_transport explicitly.',
        statusCode: err.statusCode,
        nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
        paymentId: args.payment_id,
        rail: 'x402',
      })
    }
    throw err
  }
}

/**
 * Deliver the signed X-PAYMENT header to the merchant and shape the result.
 * Shared by haven_complete_mcp_tool (decomposed flow) and haven_settle_mcp_tool
 * (fast flow). Funding has already confirmed before this runs, so a non-2xx
 * merchant response means the delegate holds stranded funds — surface a typed
 * MERCHANT_REJECTED_AFTER_FUNDING (not a soft ok:false) so the agent reconciles
 * via haven_sweep_delegate. The X-PAYMENT header is a signed authorization the
 * edge signer produced — Haven relays it but never holds the key.
 */
export async function deliverMerchantPayment(
  haven: HavenClient,
  // Parsed haven_complete_mcp_tool / haven_settle_mcp_tool args (Zod-validated).
  args: Record<string, any>,
  // Funding tx hash from haven_submit when known (settle path); the wait falls
  // back to the payment status when omitted (complete path).
  fundingTxHash?: string,
  // #1508: a scheme with NO funding leg (erc7710) must skip the funding wait
  // ENTIRELY. Omitting fundingTxHash above does NOT achieve that — see below.
  options?: { noFundingLeg?: boolean; context?: ResolvedMerchantCallContext },
): Promise<{ status: number; ok: boolean; result: unknown; settlement_tx_hash: string | null }> {
  // #1307: resolve merchant_url/tool_name/arguments/mcp_transport BEFORE
  // waiting on funding confirmation — a version-skew refusal (no stored
  // context) should surface immediately, not after a pointless wait.
  //
  // #2282: on the settle fast path that is no longer early enough — funding is
  // already relayed by the time this runs — so `haven_settle_mcp_tool` resolves
  // the context itself, pre-funding, and hands the result in. Resolving once
  // and passing it through also keeps the two calls from diverging (the stored
  // context could change, and a second GET is a second chance to disagree).
  const context = options?.context ?? (await resolveMerchantCallContext(haven, args))

  // Wait for ≥1 on-chain confirmation of the funding tx BEFORE the merchant
  // verifies the X-PAYMENT header — otherwise its balanceOf(delegate) check
  // races the not-yet-mined funding tx and returns "Payment verification
  // failed". No-op if BASE_RPC_URL isn't configured (chainRpcs unset).
  //
  // #1508: on a no-funding-leg scheme this must not run AT ALL, and passing
  // `undefined` for fundingTxHash is not the same thing — the bug this fixes.
  // `ensureFundingConfirmed` reads GET /payments/:id UNCONDITIONALLY before it
  // ever looks at the hash, and by this point an erc7710 settle has already
  // flipped the intent to 'submitted', which the backend maps to HTTP 409
  // (`agentPaymentStatusHttpCode`). The SDK turns that into a throw, so a
  // payment whose settlement SUCCEEDED was reported to the agent as a failure —
  // deterministically, on every hosted erc7710 call, with the merchant never
  // contacted.
  if (!options?.noFundingLeg) {
    await haven.ensureFundingConfirmed(args.payment_id, fundingTxHash)
  }

  const envelope = {
    jsonrpc: '2.0',
    id: `haven-mcp-${randomUUID()}`,
    method: 'tools/call',
    params: { name: context.toolName, arguments: context.toolArguments },
  }
  let result: Awaited<ReturnType<HavenClient['completeX402MerchantCall']>>
  try {
    result = await haven.completeX402MerchantCall({
      url: context.merchantUrl,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      },
      paymentId: args.payment_id,
      paymentHeader: args.payment_header,
      mcpTransport: context.mcpTransport,
      // #1508: the same flag that skips the funding wait above also has to
      // reach the SDK's completion gate, which is where the real refusal was.
      noFundingLeg: options?.noFundingLeg === true,
    })
  } catch (err) {
    // #1300 review finding: at this point funding is CONFIRMED on-chain, so a
    // merchant that never answers leaves the same money-at-risk state as one
    // that rejects — but a timeout is NOT proof of rejection: the merchant
    // holds a valid EIP-3009 authorization and may settle late. Route it to
    // its own guidance (verify-then-sweep), never the bare 504 and never a
    // blind sweep that could race a late settlement.
    if (err instanceof MerchantTimeoutError) {
      throw new HostedToolError({
        code: AgentPaymentFailureCode.MerchantUnresponsiveAfterFunding,
        message:
          `The funding leg is confirmed on-chain, but the merchant did not answer the paid ` +
          `retry before the timeout. The merchant may still settle late. Check ` +
          `haven_get_payment_status and retry haven_complete_mcp_tool ONCE before considering ` +
          `a sweep — sweep only if no settlement appears. ${err.message}`,
        statusCode: 504,
        paymentId: args.payment_id,
        status: 'merchant_unresponsive_after_funding',
        phase: 'funded_but_unsettled',
        nextAction: AgentPaymentNextAction.SweepStrandedFunds,
        rail: 'x402',
        suggestedTool: 'haven_get_payment_status',
      })
    }
    throw err
  }
  if (!result.ok) {
    let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>> | null = null
    try {
      status = await haven.getPaymentStatus(args.payment_id)
    } catch {
      // Preserve the merchant rejection even if status lookup is unavailable.
    }
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MerchantRejectedAfterFunding,
      message:
        `Merchant rejected the payment after funding (HTTP ${result.status}). ` +
        `The delegate wallet may hold stranded funds — reconcile with haven_sweep_delegate. ` +
        `Merchant response: ${JSON.stringify(result.body).slice(0, 500)}`,
      statusCode: result.status,
      paymentId: args.payment_id,
      status: status?.status ?? 'merchant_rejected_after_funding',
      phase: status?.phase ?? 'funded_but_unsettled',
      nextAction: status?.nextAction ?? AgentPaymentNextAction.SweepStrandedFunds,
      rail: status?.rail ?? 'x402',
      idempotencyKey: status?.idempotencyKey,
      suggestedTool: 'haven_sweep_delegate',
    })
  }
  return {
    status: result.status,
    ok: result.ok,
    result: result.body,
    settlement_tx_hash: result.settlementTxHash ?? null,
  }
}

/**
 * Hosted fast-path preflight (#1398). The status read is agent-scoped and
 * exposes the intent's captured delegate, unlike getAgent() which may have
 * changed after the intent was created. Never include an untrusted header in a
 * thrown error: MCP error payloads and observability consumers serialize it.
 */
export async function preflightMcpPaymentHeader(haven: HavenClient, args: Record<string, any>): Promise<void> {
  const status = await haven.getPaymentStatus(args.payment_id)
  try {
    if (
      status.rail !== 'x402' ||
      !status.merchantAddress ||
      !status.amountAtomic ||
      !status.asset ||
      !status.network ||
      !status.resourceUrl ||
      !status.payerAddress
    ) {
      throw new X402PaymentHeaderValidationError()
    }
    await validateStandardX402PaymentHeader(args.payment_header, {
      merchantTo: status.merchantAddress,
      amountAtomic: status.amountAtomic,
      asset: status.asset,
      network: status.network,
      resourceUrl: status.resourceUrl,
      payer: status.payerAddress,
      chainId: status.chainId,
    })
  } catch (err) {
    if (!(err instanceof X402PaymentHeaderValidationError)) throw err
    throw new HostedToolError({
      code: 'INVALID_PAYMENT_HEADER',
      message:
        'The signed payment header did not match the funded x402 intent. No funding was relayed. ' +
        'Recreate the header with the local signer from this payment_id, then retry.',
      statusCode: 400,
      paymentId: args.payment_id,
      status: 'invalid_payment_header',
      phase: 'not_started',
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      rail: 'x402',
      suggestedTool: 'haven_sign_x402',
    })
  }
}

/**
 * The tools this capability owns, as a tuple so the set is data rather than a
 * comment. `satisfies` pins every entry to a real `HostedToolName`, and
 * `createToolHandlers`' `HostedToolHandlers` annotation refuses a surface
 * where a tool ends up with NO owner (TS2741 names the missing one). The
 * disjointness of this tuple against the other capability tuples and the
 * facade's own literal is asserted in `tools/module-boundaries.test.ts`.
 */
export const PAID_MCP_COMPLETION_TOOLS = [
  'haven_complete_mcp_tool',
  'haven_settle_mcp_tool',
] as const satisfies readonly HostedToolName[]

export type PaidMcpCompletionToolName = (typeof PAID_MCP_COMPLETION_TOOLS)[number]

/**
 * This capability's handler contribution to `createToolHandlers`.
 *
 * The return type is keyed on the tuple above, so adding a name there without
 * a handler (or a handler without a name) is a compile error here rather than
 * a runtime registry issue discovered at server boot.
 */
export function createPaidMcpCompletionHandlers(
  haven: HavenClient,
): HostedToolHandlers<PaidMcpCompletionToolName> {
  return {
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
