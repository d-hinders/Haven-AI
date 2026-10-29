/**
 * #4534 — the purchase correlation key.
 *
 * The feed files one `underlag` per settled payment, and that shape is right:
 * a pushed document is immutable, so an aggregate would go stale the moment a
 * member is refunded, fails delivery or settles late. What it left missing is
 * the LINK between documents: one BikBok gift-card purchase through
 * Bitrefill's x402 route settled three payments (`invoice/create` 0.002 USDC,
 * `invoice/pay` 0.010, `invoice/status` 0.001) and produced three documents
 * that nothing said belonged together.
 *
 * This module derives the two fields that make grouping a view in the
 * accounting tool rather than a merge in Haven:
 *
 * - `purchase_group_id` — a stable identifier for the purchase a payment
 *   belongs to.
 * - `parent_payment_id` — for a fee call, the purchase payment it paid for.
 *   Null for the purchase itself and for ungrouped payments.
 *
 * ## Derivation, in the issue's order of preference
 *
 * 1. **The merchant's own invoice/order id**, when the response body carries
 *    one. This is a small, EXPLICIT per-merchant map — never a generic JSON
 *    scrape. A merchant that is not in the map contributes nothing, and a
 *    body that does not carry the mapped field contributes nothing. The map
 *    also names which route verb is the purchase leg, because the merchant's
 *    own route is the only fact that distinguishes `invoice/pay` from
 *    `invoice/create` and `invoice/status`.
 * 2. **An agent-supplied group key**, as an explicit optional field on the
 *    payment tools. It is its own field, never overloaded onto
 *    `idempotency_key`: a retry key answers "is this the same attempt?", a
 *    purchase group answers "is this the same purchase?".
 * 3. **Never a time-window heuristic.** Two purchases from the same merchant
 *    minutes apart, or parallel catalogue searches, would mix — and there is
 *    no way to tell afterwards. Nothing here reads a clock.
 *
 * ## What this module does NOT do
 *
 * It changes no payment, no settlement, no amount and no custody fact. It
 * classifies a document the feed already produces, and an ungrouped payment
 * is fed exactly as before with both fields null — never withheld because its
 * group could not be resolved.
 */

/** Which leg of a purchase a payment is. */
export type PurchaseGroupRole = 'purchase' | 'fee'

/** Where the group id came from — recorded so the feed's audit trail can say. */
export type PurchaseGroupBasis = 'merchant_response' | 'agent_supplied'

/** The longest group id the evidence column accepts (`VARCHAR(128)`). */
export const PURCHASE_GROUP_ID_MAX_LENGTH = 128

/**
 * One merchant's correlation rules. Both halves are explicit: the field the
 * merchant's own document carries, and the route verb that names the leg
 * which actually bought the thing.
 */
export interface MerchantPurchaseGroupExtractor {
  /** The merchant's own invoice/order id, from the paid response body. */
  groupId(body: Record<string, unknown>): string | null
  /** Which leg of the purchase this call is, from the route verb. */
  role(routeVerb: string | null): PurchaseGroupRole | null
}

/** Read a non-empty string field, trimmed. Anything else is null. */
function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The explicit per-merchant map. Keyed by the merchant's hostname, lowercased.
 *
 * Bitrefill (#4497): `invoice/create` returns `invoice_id`; `invoice/pay` and
 * `invoice/status` reference the same id. `pay` is the leg that buys the
 * gift card; `create` and `status` are the merchant's per-call API fees. The
 * id is read from the top level, or from a `data` wrapper — the two shapes
 * the merchant's own document uses — and from nowhere else.
 */
const MERCHANT_PURCHASE_GROUP_EXTRACTORS: Record<string, MerchantPurchaseGroupExtractor> = {
  'api.bitrefill.com': {
    groupId: (body) => {
      const direct = stringField(body, 'invoice_id')
      if (direct) return direct
      const data = body.data
      if (data != null && typeof data === 'object' && !Array.isArray(data)) {
        return stringField(data as Record<string, unknown>, 'invoice_id')
      }
      return null
    },
    role: (verb) => {
      if (verb === 'pay') return 'purchase'
      if (verb === 'create' || verb === 'status') return 'fee'
      return null
    },
  },
}

/** The merchant's hostname, lowercased; null when the URL will not parse. */
export function merchantHost(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The last non-empty path segment of a resource URL, lowercased — the call
 * verb the merchant's own route names (`invoice/pay` → `pay`). Null when the
 * URL will not parse or carries no segment.
 */
export function routeVerb(url: string | null): string | null {
  if (!url) return null
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0)
  const last = segments[segments.length - 1]
  return last ? last.toLowerCase() : null
}

/**
 * Normalize an agent-supplied group key: a non-empty string, trimmed, capped
 * at the column's width. Anything else (a number, an object, an empty string,
 * an over-long value) is refused rather than truncated — a silently shortened
 * key would group the wrong documents.
 */
export function normalizePurchaseGroupId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > PURCHASE_GROUP_ID_MAX_LENGTH) return null
  return trimmed
}

export interface PurchaseGroupVerdict {
  purchaseGroupId: string
  role: PurchaseGroupRole | null
  basis: PurchaseGroupBasis
}

/**
 * Derivation #1: the merchant's own id, from the paid response body.
 *
 * Returns null when the merchant is not in the map, when the body carries no
 * mapped field, or when the value is not a usable id. The role is read from
 * the payment's own route verb, so a merchant whose response carries the id
 * but whose route is unrecognised still groups (role null) — grouping is
 * never withheld because the leg could not be classified.
 */
export function purchaseGroupFromMerchantResponse(
  merchantUrl: string | null,
  responseBody: unknown,
): PurchaseGroupVerdict | null {
  const host = merchantHost(merchantUrl)
  if (!host) return null
  const extractor = MERCHANT_PURCHASE_GROUP_EXTRACTORS[host]
  if (!extractor) return null
  if (responseBody == null || typeof responseBody !== 'object' || Array.isArray(responseBody)) return null
  const groupId = normalizePurchaseGroupId(extractor.groupId(responseBody as Record<string, unknown>))
  if (!groupId) return null
  return {
    purchaseGroupId: groupId,
    role: extractor.role(routeVerb(merchantUrl)),
    basis: 'merchant_response',
  }
}

/**
 * The full resolution, in the issue's order: the merchant's own id first, the
 * agent-supplied key second, nothing third. The merchant's id wins because it
 * is the merchant's own fact; the agent's key is the fallback for a merchant
 * Haven has no extractor for.
 *
 * `role` is only ever known from the merchant's route, so an agent-supplied
 * group carries `role: null` — the parent link is then resolved from the
 * group's members once one of them is known to be the purchase.
 */
export function resolvePurchaseGroup(input: {
  merchantUrl: string | null
  merchantResponse?: unknown
  agentGroupId?: unknown
}): PurchaseGroupVerdict | null {
  const fromMerchant = purchaseGroupFromMerchantResponse(input.merchantUrl, input.merchantResponse)
  if (fromMerchant) return fromMerchant
  const agentGroupId = normalizePurchaseGroupId(input.agentGroupId)
  if (!agentGroupId) return null
  return { purchaseGroupId: agentGroupId, role: null, basis: 'agent_supplied' }
}

/**
 * The role of an EXISTING group member, read from its own stored resource URL
 * — used to find the purchase leg when a fee row is written after it. Null
 * when the member's merchant is not in the map or its route is unrecognised.
 */
export function purchaseGroupRoleForResourceUrl(resourceUrl: string | null): PurchaseGroupRole | null {
  const host = merchantHost(resourceUrl)
  if (!host) return null
  const extractor = MERCHANT_PURCHASE_GROUP_EXTRACTORS[host]
  if (!extractor) return null
  return extractor.role(routeVerb(resourceUrl))
}
