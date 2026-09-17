/**
 * The optional seller fields on `POST /catalog/submit` (#3078, epic #3077):
 * `merchant_name` (≤ MAX_MERCHANT_NAME_LENGTH chars, whitespace-collapsed,
 * empty → null) and `merchant_website` (an https URL, shown as a link on the
 * merchant page; empty → null). A wrong type or shape is a named 400 from the
 * route. This is the domain rule, so it lives with the catalog module rather
 * than as a hand-rolled ladder in the route file (the request-validation
 * rollout, #3028, shrinks those; the spec declares the same bounds and will
 * refuse them first once `/catalog` is enforced).
 */
export const MAX_MERCHANT_NAME_LENGTH = 120

export interface MerchantSubmitFields {
  merchant_name?: unknown
  merchant_website?: unknown
}

export function normalizeMerchantFields(
  body: MerchantSubmitFields | undefined,
  maxUrlLength: number,
): { merchant_name: string | null; merchant_website: string | null } | { error: string } {
  let merchant_name: string | null = null
  let merchant_website: string | null = null
  if (body?.merchant_name !== undefined) {
    if (typeof body.merchant_name !== 'string') return { error: 'merchant_name must be a string' }
    const name = body.merchant_name.trim().replace(/\s+/g, ' ')
    if (name.length > MAX_MERCHANT_NAME_LENGTH) {
      return { error: `merchant_name must be ${MAX_MERCHANT_NAME_LENGTH} characters or fewer` }
    }
    merchant_name = name || null
  }
  if (body?.merchant_website !== undefined) {
    if (typeof body.merchant_website !== 'string') return { error: 'merchant_website must be a string' }
    const site = body.merchant_website.trim()
    if (site) {
      if (site.length > maxUrlLength) return { error: 'merchant_website is too long' }
      let parsed: URL
      try {
        parsed = new URL(site)
      } catch {
        return { error: 'merchant_website must be an https URL' }
      }
      if (parsed.protocol !== 'https:') return { error: 'merchant_website must be an https URL' }
      merchant_website = parsed.toString()
    }
  }
  return { merchant_name, merchant_website }
}
