/**
 * Shared hosted-MCP support — quote-response construction, payment-status
 * predicates, wrong-tool failures, and resume-state resolution.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * `buildMcpToolQuoteResponse` serves both quote tools and the generic x402
 * quote (#2054 same-field contract); `isPendingApproval` is the retained
 * fail-closed predicate (#2101) read from handler bodies in every planned
 * capability slice (#2809–#2812); `resolveResumeState` validates an
 * explicitly-passed resume_state's rail instead of trusting it. All live in
 * shared support — never copied.
 *
 * One-direction dependencies: imports the SDK, the #2807 contract seam, and
 * the sibling transport serializer. Never imports a capability module.
 */
import {
  AgentPaymentNextAction,
  AgentPaymentWarningCode,
  HavenApiError,
  HavenClient,
  selectErc7710PaymentOption,
  selectX402SettlementScheme,
  type AgentPaymentWarning,
  type HavenAgent,
  type HavenCatalogEntry,
  type X402McpTransport,
  type X402PaymentOption,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import type { ToolFailure } from '../contracts.js'
import { serializeMcpTransport } from './mcp-context.js'

/**
 * #2991 — predict the settlement scheme `haven_prepare_catalog_purchase` /
 * `haven_pay_mcp_tool` will ACTUALLY select for this account, using the
 * IDENTICAL `selectX402SettlementScheme` call those tools run at prepare/pay
 * time (`catalog-purchase.ts` steps 3-4 / the pay tool's #1456 selection) —
 * so a quote can never disagree with what prepare does next. `agent` is
 * `undefined` exactly when the `getAgent` prefetch failed (same non-throwing
 * `.then(a => a, () => undefined)` convention prepare/pay use), and this
 * returns `null` rather than guess a rail it could not read.
 *
 * A `null` selection from the selector itself (an erc7710-ONLY merchant next
 * to an account whose rail does not qualify) is NOT "unknown" — the scheme
 * that merchant will settle with, if it settles at all, is still erc7710;
 * the rail mismatch is what `requireSettleableSelection` refuses at
 * prepare/pay, not the existence of a predictable scheme. This mirrors
 * `buildX402Quote`'s own `acceptedScheme`, which already reports 'erc7710'
 * for such a merchant regardless of the (unknown, at quote time) rail.
 */
function predictSettlementScheme(
  accepts: X402PaymentOption[],
  agent: HavenAgent | undefined,
): { scheme: 'erc7710' | 'eip3009'; fundingLeg: boolean; settleable?: false } | null {
  if (!agent) return null
  const selection = selectX402SettlementScheme(accepts, {
    delegationRail: agent.executionRail === 'delegation',
  })
  if (selection) return { scheme: selection.scheme, fundingLeg: selection.scheme === 'eip3009' }
  // No settleable option for THIS agent's rail: an erc7710-only merchant and
  // an agent not on the delegation rail. Prepare/pay will refuse this with
  // ERC7710_RAIL_REQUIRED (`requireSettleableSelection`), so the honest
  // prediction is the scheme the merchant demands plus `settleable: false`
  // — not a bare 'erc7710' that reads as "prepare will settle it".
  return selectErc7710PaymentOption(accepts)
    ? { scheme: 'erc7710', fundingLeg: false, settleable: false }
    : null
}

/**
 * Build the compact, non-authorizing response shared by the generic and
 * catalog MCP quote tools. Deliberately omit payment_required, idempotency,
 * and every signing/funding field: callers must start a fresh paid flow after
 * the user chooses a cap, and that flow obtains its own live quote.
 */
export function buildMcpToolQuoteResponse(input: {
  quote: X402Quote
  merchantUrl: string
  requestedMerchantUrl: string
  toolName: string
  toolArguments: Record<string, unknown>
  catalog?: HavenCatalogEntry
  // #2991: the prefetched agent (undefined when the read failed) — used ONLY
  // to predict expected_settlement_scheme/expected_funding_leg below, never
  // to change accepted_scheme/erc7710_only, which describe the MERCHANT's
  // offer and stay exactly as `buildX402Quote` computed them.
  agent: HavenAgent | undefined
}) {
  const { quote, merchantUrl, requestedMerchantUrl, toolName, toolArguments, catalog, agent } = input
  const prediction = predictSettlementScheme(quote.paymentRequired.accepts, agent)
  const warnings: AgentPaymentWarning[] = []
  if (prediction === null) {
    warnings.push({
      code: AgentPaymentWarningCode.X402SchemeUnknown,
      message:
        "This agent's account rail could not be read from Haven, so the settlement scheme " +
        'haven_prepare_catalog_purchase / haven_pay_mcp_tool will select cannot be predicted ' +
        'here. Retry when haven_get_agent succeeds, or proceed to prepare/pay directly — that ' +
        'step reads the rail fresh regardless.',
    })
  }
  return {
    rail: quote.rail,
    merchant_url: merchantUrl,
    merchant_url_was_discovered: merchantUrl !== requestedMerchantUrl,
    tool_name: toolName,
    arguments: toolArguments,
    resource_url: quote.resourceUrl,
    description: quote.description,
    mime_type: quote.mimeType,
    amount_atomic: quote.amountAtomic,
    amount: quote.amount,
    token: quote.token,
    decimals: quote.decimals,
    asset: quote.asset,
    network: quote.network,
    chain_id: quote.chainId,
    merchant_address: quote.merchantAddress,
    max_timeout_seconds: quote.maxTimeoutSeconds,
    // #2054: which accepts[] entry the amounts above describe. 'erc7710'
    // means the merchant advertises NO standard entry — the purchase tools
    // can settle it only from a delegation-rail account, so an agent can
    // tell the user BEFORE calling them.
    accepted_scheme: quote.acceptedScheme,
    ...(quote.acceptedScheme === 'erc7710' ? { erc7710_only: true } : {}),
    // #2991: what prepare/pay will ACTUALLY do for this account, computed by
    // the identical selector — never derived from accepted_scheme, which
    // describes the merchant's offer and can legitimately disagree (a
    // delegation-rail account is quoted accepted_scheme: 'standard' at a
    // merchant advertising both, but prepare/pay still PREFER erc7710).
    expected_settlement_scheme: prediction?.scheme ?? null,
    expected_funding_leg: prediction ? prediction.fundingLeg : null,
    // #2991 review: false when prepare/pay will REFUSE for this agent's rail
    // (ERC7710_RAIL_REQUIRED) — the scheme above is then what the merchant
    // demands, not what Haven will do. Omitted when the rail is unknown.
    ...(prediction ? { expected_settleable: prediction.settleable !== false } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(quote.mcpTransport ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) } : {}),
    ...(catalog
      ? {
          catalog_id: catalog.id,
          catalog_name: catalog.name,
          catalog_price_atomic: catalog.priceAtomic,
          catalog_price_display: catalog.priceDisplay,
          catalog_price_is_indicative: true,
          catalog_price_differs: catalog.priceAtomic !== null && catalog.priceAtomic !== quote.amountAtomic,
        }
      : {}),
    quote_is_informational: true,
  }
}

/**
 * RETAINED DELIBERATELY, and unreachable from any live rail (#2101).
 *
 * No Haven rail mints a payment-level `pending` / `pending_approval` any more:
 * the legacy AllowanceModule rail answers 410 at every agent-payment entry
 * point (#1986, `rails/execution-rail.ts`), the delegation rail refuses an
 * out-of-policy payment during prepare with 403/502 and nothing written
 * (`routes/payments.ts`), and #2055 dropped the `approval_requests` table the
 * status was read back from. `pending_approval` appears in no migration, so no
 * `payment_intents` row can carry it either.
 *
 * The branches guarded by this helper are kept because they are fail-CLOSED —
 * they stop the agent and hand the payment_id back instead of delivering a
 * merchant header for funding that did not confirm. Deleting them would trade
 * a defined stop for an undefined fall-through on a stored row from before the
 * retirement, which is strictly worse on a money surface. What was removed is
 * the agent-visible PROMISE: no description or instruction tells a model to
 * expect this status or to wait for an approval, so a model that ever meets it
 * follows the general "a status you do not recognise → stop and tell the user"
 * rule in the server instructions. The wire-type question (whether the status
 * union itself should shrink) belongs with the OpenAPI schema decision in
 * #2105, not with a prose fix.
 */
export function isPendingApproval(status: string | undefined): boolean {
  return status === 'pending' || status === 'pending_approval'
}

export function wrongTool(code: string, message: string, suggested_tool?: string): ToolFailure {
  return { success: false, code, message, suggested_tool }
}

// #1328: the 'mpp' rail branch (and its haven_resume_mpp_payment caller) is
// retired — this now only ever resolves x402 resume state. Still validates
// an explicitly-passed resume_state's rail rather than trusting it blindly:
// a caller holding a pre-retirement 'mpp' resume_state gets a clear mismatch
// error instead of silently proceeding against the wrong protocol context.
export async function resolveResumeState(
  haven: HavenClient,
  args: { payment_id?: string; resume_state?: unknown },
  rail: 'x402',
): Promise<X402ResumeState> {
  if (args.resume_state && typeof args.resume_state === 'object') {
    const stateRail = (args.resume_state as { rail?: unknown }).rail
    if (stateRail !== undefined && stateRail !== rail) {
      throw new HavenApiError(`Resume state is not for the ${rail} rail.`, 409, args.resume_state)
    }
    return args.resume_state as X402ResumeState
  }
  if (args.payment_id) {
    return haven.getResumeState(args.payment_id) as Promise<X402ResumeState>
  }
  throw new HavenApiError(
    `haven_resume_${rail}_payment requires resume_state or payment_id.`,
    400,
  )
}
