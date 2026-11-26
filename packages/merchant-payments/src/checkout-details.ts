/**
 * #4873: the checkout-details extension a merchant asks for in its x402
 * challenge, and the `X-Checkout-Details` header a paid request answers with.
 *
 * The wire shape is `docs/architecture/13-checkout-details.md` §2 (the
 * merchant's request) and §3 (Haven's answer). This module owns the field
 * names, the address shape and the reader; the demo merchant is the first
 * merchant that uses it, and the paywall proxy can adopt the same reader
 * without a second copy of the shape.
 *
 * The reader is deliberately forgiving, for the same reason the tax
 * declaration's is: checkout details are display data on a receipt, and a
 * malformed or oversized header must never turn a settled purchase into an
 * error. Every failure is "no details", and the purchase is served exactly as
 * it would have been without the header.
 *
 * The values are personal data. Nothing here logs them, and nothing here
 * stores them: the reader returns what the request carried, and the caller
 * puts it on the response.
 */

/** The challenge extension key, following `haven-passport` (§2). */
export const CHECKOUT_DETAILS_EXTENSION = 'haven-checkout-details'

/** The only version this reader understands (§2). */
export const CHECKOUT_DETAILS_VERSION = 1

/** The header a paid request answers with (§3). */
export const X_CHECKOUT_DETAILS_HEADER = 'X-Checkout-Details'

/**
 * The answer's budget, measured as the encoded header value (§3). A header
 * longer than this is treated as absent rather than parsed: the largest answer
 * the shape allows is 1,426 bytes encoded, so anything past the budget is not
 * an answer this shape produced.
 */
export const CHECKOUT_DETAILS_BUDGET_BYTES = 1536

/** The three field names §2 fixes. No slice renames them. */
export const CHECKOUT_DETAILS_FIELDS = ['receipt_email', 'billing_address', 'shipping_address'] as const
export type CheckoutDetailsField = (typeof CHECKOUT_DETAILS_FIELDS)[number]

export function isCheckoutDetailsField(value: unknown): value is CheckoutDetailsField {
  return typeof value === 'string' && (CHECKOUT_DETAILS_FIELDS as readonly string[]).includes(value)
}

/**
 * The address shape §2 owns: the `buyer.address` shape of the unmerged
 * compliance-fields extension (x402 PR #2853), which aligns with EN 16931 BG-8.
 * An absent optional member is omitted, never sent as `null` or an empty
 * string.
 */
export interface CheckoutAddress {
  /** Street address, first line. Required, max 70. */
  line1: string
  /** Second line. Optional, max 70. */
  line2?: string
  /** Third line. Optional, max 70. */
  line3?: string
  /** City or locality. Required, max 50. */
  city: string
  /** Postal code, as the owner writes it. Optional, max 16. */
  postCode?: string
  /** ISO 3166-2 subdivision code, e.g. `SE-AB`. Optional, max 6. */
  subdivision?: string
  /** ISO 3166-1 alpha-2, uppercase. Required, exactly 2. */
  country: string
}

/** What a paid request's header carried, once read. */
export interface AcceptedCheckoutDetails {
  /** The receipt email, in full. */
  receiptEmail?: string
  /** The billing address, in full. */
  billingAddress?: CheckoutAddress
  /** The shipping address, in full. */
  shippingAddress?: CheckoutAddress
}

/** The merchant's request: which fields it wants, and whether each is required. */
export interface CheckoutDetailsRequest {
  fields: Partial<Record<CheckoutDetailsField, { required: boolean }>>
}

/**
 * The challenge entry for `request`, in the shape §2 decided: an object with
 * `info` and `schema`. Haven reads `info` and ignores `schema`; the schema is
 * there for a generic client.
 */
export function checkoutDetailsExtensionEntry(request: CheckoutDetailsRequest): Record<string, unknown> {
  return {
    info: {
      version: CHECKOUT_DETAILS_VERSION,
      fields: request.fields,
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['version', 'fields'],
      properties: {
        version: { const: CHECKOUT_DETAILS_VERSION },
        fields: {
          type: 'object',
          additionalProperties: false,
          properties: {
            receipt_email: {
              type: 'object',
              required: ['required'],
              properties: { required: { type: 'boolean' } },
            },
            billing_address: {
              type: 'object',
              required: ['required'],
              properties: { required: { type: 'boolean' } },
            },
            shipping_address: {
              type: 'object',
              required: ['required'],
              properties: { required: { type: 'boolean' } },
            },
          },
        },
      },
    },
  }
}

/** The address member bounds §2 fixes. */
const ADDRESS_MAX_LENGTH = {
  line1: 70,
  line2: 70,
  line3: 70,
  city: 50,
  postCode: 16,
  subdivision: 6,
} as const

/** RFC 5321 §4.5.3.1.3's forward-path limit, less the angle brackets (§2). */
const EMAIL_MAX_LENGTH = 254

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string within `max`, or `null`. */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  return value
}

/**
 * The receipt email, or `null`. One address, no display name, no CR or LF —
 * a shape check, not a validity check (§2).
 */
function asReceiptEmail(value: unknown): string | null {
  const email = boundedString(value, EMAIL_MAX_LENGTH)
  if (!email) return null
  if (/[\r\n]/.test(email)) return null
  if (email.includes('<') || email.includes('>')) return null
  const at = email.indexOf('@')
  if (at <= 0 || at === email.length - 1) return null
  return email
}

/**
 * The address, or `null`. `line1`, `city` and `country` are required; an
 * optional member that is absent, blank or over its bound is omitted rather
 * than failing the whole address. `country` must be two uppercase letters.
 */
function asAddress(value: unknown): CheckoutAddress | null {
  if (!isPlainRecord(value)) return null
  const line1 = boundedString(value.line1, ADDRESS_MAX_LENGTH.line1)
  const city = boundedString(value.city, ADDRESS_MAX_LENGTH.city)
  const country = typeof value.country === 'string' && /^[A-Z]{2}$/.test(value.country) ? value.country : null
  if (!line1 || !city || !country) return null

  const line2 = boundedString(value.line2, ADDRESS_MAX_LENGTH.line2)
  const line3 = boundedString(value.line3, ADDRESS_MAX_LENGTH.line3)
  const postCode = boundedString(value.postCode, ADDRESS_MAX_LENGTH.postCode)
  const subdivision = boundedString(value.subdivision, ADDRESS_MAX_LENGTH.subdivision)
  // The member order §2 documents: line1, line2, line3, city, postCode,
  // subdivision, country.
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    ...(line3 ? { line3 } : {}),
    city,
    ...(postCode ? { postCode } : {}),
    ...(subdivision ? { subdivision } : {}),
    country,
  }
}

/** Decode the header value. `null` for anything that is not base64url(JSON). */
function decodeHeader(header: string): unknown {
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Read the checkout details a paid request carried.
 *
 * Returns `null` — "no details" — when the header is absent, longer than the
 * budget, not base64url(JSON), not an object, or not version 1. A field that
 * does not have the shape §2 fixes is dropped; when nothing valid remains the
 * answer is `null` too.
 *
 * `fields` is the set the merchant asked for. A field the merchant did not ask
 * for is never read, so a client cannot put a value on a receipt for a product
 * that never requested it. Absent, every field is read (the reader's own
 * tests, and a merchant that wants the whole answer).
 *
 * Never throws: a malformed header must not turn a settled purchase into an
 * error. The caller serves the purchase either way.
 */
export function acceptCheckoutDetails(params: {
  header: string | undefined
  fields?: readonly CheckoutDetailsField[]
}): AcceptedCheckoutDetails | null {
  const header = params.header
  if (!header) return null
  if (header.length > CHECKOUT_DETAILS_BUDGET_BYTES) return null
  const asked = params.fields ? new Set(params.fields) : null
  const wants = (field: CheckoutDetailsField) => asked === null || asked.has(field)
  try {
    const value = decodeHeader(header)
    if (!isPlainRecord(value)) return null
    // A version other than 1 is unreadable rather than read as version 1: a
    // future shape read as v1 could turn an optional field into a required one.
    if (value.version !== CHECKOUT_DETAILS_VERSION) return null

    const details: AcceptedCheckoutDetails = {}
    const receiptEmail = wants('receipt_email') ? asReceiptEmail(value.receipt_email) : null
    const billingAddress = wants('billing_address') ? asAddress(value.billing_address) : null
    const shippingAddress = wants('shipping_address') ? asAddress(value.shipping_address) : null
    if (receiptEmail) details.receiptEmail = receiptEmail
    if (billingAddress) details.billingAddress = billingAddress
    if (shippingAddress) details.shippingAddress = shippingAddress
    return Object.keys(details).length > 0 ? details : null
  } catch {
    return null
  }
}
