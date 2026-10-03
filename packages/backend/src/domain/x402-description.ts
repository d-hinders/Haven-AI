/**
 * What an x402 payment bought, as the caller relayed it from the merchant's
 * 402 (#3610) — both sources below are caller-supplied, so this is display
 * text, never authority.
 *
 * The 402 challenge carries a human description of the resource
 * (`PaymentRequired.resource.description`, x402 v2). Agents read it back on
 * the payment status (`GET /machine-payments/:id/status`, `GET /payments/:id`
 * and x402 authorize's status branch: `description`, `x402.description`) to
 * say what was bought after the fact. It is UNTRUSTED merchant text: display
 * data only — control and bidi characters stripped, trimmed and bounded
 * here — never parsed or acted on.
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

/**
 * Control and bidi characters in untrusted display text (#3610 review). C0
 * (incl. NUL), DEL, C1 and the bidi override/isolate controls — the set
 * `modules/owner-profile/service.ts` refuses in a legal name: they can make
 * displayed text lie about its reading order or hide characters. A NUL also
 * cannot be stored at all: Postgres refuses `\u0000` in jsonb, which turned a
 * description carrying one into a failed authorize.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g
/** Tab / newline / carriage return read as spacing, so they become a space rather than vanish. */
const SPACING_CONTROLS_RE = /[\t\n\r]+/g

/** Drop lone UTF-16 surrogates — Postgres refuses them in jsonb, like a NUL. */
function withoutLoneSurrogates(text: string): string {
  return [...text].filter((ch) => !(ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff)).join('')
}

function bounded(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = withoutLoneSurrogates(value.replace(SPACING_CONTROLS_RE, ' ').replace(CONTROL_CHARS_RE, ''))
  const trimmed = cleaned.trim()
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
