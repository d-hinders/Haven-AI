/**
 * What an x402 payment bought, in the merchant's own words (#3610).
 *
 * The 402 challenge carries a human description of the resource
 * (`PaymentRequired.resource.description`, x402 v2). Agents read it back on
 * the payment status (`GET /machine-payments/:id/status`, `GET /payments/:id`
 * and x402 authorize's status branch: `description`, `x402.description`) to
 * say what was bought after the fact. It is UNTRUSTED merchant text: display
 * data only, trimmed and bounded here, never parsed or acted on.
 *
 * Sources, in order:
 * 1. the `description` the caller sent on `POST /x402` (the SDK's 3009 legs
 *    send `paymentRequired.resource.description` there);
 * 2. the stored verbatim 402 (`paymentRequired`, #1355) — the erc7710 leg
 *    sends only that, and it is also what makes rows authorized before #3610
 *    (which never persisted a description) answer correctly on read.
 */

/** Code points kept. Long enough for any real product line, short enough for a status card. */
export const MAX_X402_DESCRIPTION_CODE_POINTS = 300

function bounded(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const codePoints = [...trimmed]
  if (codePoints.length <= MAX_X402_DESCRIPTION_CODE_POINTS) return trimmed
  return `${codePoints.slice(0, MAX_X402_DESCRIPTION_CODE_POINTS).join('')}…`
}

/** `paymentRequired.resource.description`, when the stored 402 carries one. */
export function descriptionFromPaymentRequired(paymentRequired: unknown): string | null {
  if (!paymentRequired || typeof paymentRequired !== 'object' || Array.isArray(paymentRequired)) return null
  const resource = (paymentRequired as Record<string, unknown>).resource
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null
  return bounded((resource as Record<string, unknown>).description)
}

/** The description to persist on (or report for) an x402 intent, or null. */
export function x402Description(description: unknown, paymentRequired: unknown): string | null {
  return bounded(description) ?? descriptionFromPaymentRequired(paymentRequired)
}
