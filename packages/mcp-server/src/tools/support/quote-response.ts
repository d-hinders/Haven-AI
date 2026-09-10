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
  HavenApiError,
  HavenClient,
  type HavenCatalogEntry,
  type X402McpTransport,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import type { ToolFailure } from '../contracts.js'
import { serializeMcpTransport } from './mcp-context.js'

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
}) {
  const { quote, merchantUrl, requestedMerchantUrl, toolName, toolArguments, catalog } = input
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
