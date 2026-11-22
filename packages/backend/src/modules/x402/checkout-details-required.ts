/**
 * #5030: whether the merchant's challenge asked for a REQUIRED checkout
 * detail, recorded on the intent at authorize.
 *
 * `haven_submit` decides the merchant's checkout-details request from the
 * challenge stored at authorize (`GET /x402/:id/payment-required`). That read
 * is rate-limited (`moneyPathRateLimit`), so a 429 is realistic, and any
 * failure used to read as "no request": the submit then relayed the funding
 * with no answer. The owner's decision (2026-11-22, option b) is that only a
 * payment whose challenge asked for a REQUIRED detail stops on a failed read;
 * every other payment proceeds as today.
 *
 * The fact is recorded here, at authorize, so the submit can still learn it
 * when the full challenge cannot be read: the payment status read
 * (`GET /machine-payments/:id/status`) is not rate-limited and serves it as
 * `checkout_details_required_fields` (read back by
 * `domain/machine-metadata.ts`'s `checkoutDetailsRequiredFieldsOf`).
 *
 * Field NAMES only — never the owner's values, which are not known at
 * authorize and are never stored.
 */
import { parseCheckoutDetailsRequest } from '@haven_ai/sdk'

/**
 * The required field names a challenge carried, read by the SDK's own parser
 * (an unreadable request is no request, §2). Empty when it asked for nothing.
 */
export function requiredCheckoutDetailFields(paymentRequired: unknown): string[] {
  if (paymentRequired === null || typeof paymentRequired !== 'object') return []
  const request = parseCheckoutDetailsRequest((paymentRequired as { extensions?: unknown }).extensions)
  if (request === null) return []
  return request.fields.filter((field) => field.required).map((field) => field.name)
}
