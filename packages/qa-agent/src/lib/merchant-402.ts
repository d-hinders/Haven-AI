/**
 * Read the merchant's OWN reason out of a 402 response (#1516).
 *
 * WHY THIS EXISTS. Every x402 leg used to fail a retry-still-402 with a fixed
 * string — "still HTTP 402 after payment" — and return before touching the
 * body. That string names the symptom and nothing else: it reads identically
 * whether the merchant ran out of gas, lost its RPC, rejected the signature,
 * or forgot the payment across a restart. Four separate wrong diagnoses on
 * 2026-08-17 were all paid for by that missing sentence.
 *
 * The merchant does explain itself. On a `PaymentError` it re-issues the
 * challenge with the reason attached (`demo-merchant-mcp/src/http.ts`):
 *
 *     writePaymentRequired(res, options, { ...paymentRequired, error: err.message })
 *
 * so the body is the ordinary `paymentRequired` object plus an `error` field.
 * A 402 WITHOUT that field is a different animal and worth distinguishing: it
 * is the plain "no payment presented" challenge, which on a retry that DID
 * carry `X-PAYMENT` means the merchant never associated the header with the
 * request — a lost session, not a rejected payment.
 *
 * Returns a short suffix meant to be appended to a leg's failure message, so
 * a caller reads `fail(\`still 402 ...\${await merchant402Reason(res)}\`)`.
 * Never throws: a diagnostic that can fail the leg it is explaining is worse
 * than no diagnostic. An unreadable or unparseable body is reported as such
 * rather than swallowed.
 */

/** The 402 body shape the merchant sends. Only `error` is load-bearing here. */
interface PaymentRequired402Body {
  error?: unknown
  [key: string]: unknown
}

const MAX_REASON = 300

/**
 * The x402 `PaymentRequired` shape ALWAYS carries an `error`, and an untouched
 * challenge carries this exact default (`demo-merchant-mcp/src/x402.ts`
 * `buildPaymentRequired`). So "no payment was presented" is signalled by this
 * literal, NOT by the key being absent (#1517).
 *
 * The first cut of this helper tested for an absent key, which no merchant
 * response ever has — the bare-challenge branch was unreachable and a lost
 * session would have been reported as an ordinary rejection reading "merchant
 * said: Payment required".
 */
const BARE_CHALLENGE_ERROR = 'Payment required'

/**
 * Extract the merchant's stated reason from a 402 response.
 *
 * Consumes the response body, so call it once and only on a response no other
 * code will read.
 */
export async function merchant402Reason(res: Response): Promise<string> {
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    return ` — merchant 402 body unreadable (${err instanceof Error ? err.message : String(err)})`
  }

  if (!text.trim()) return ' — merchant 402 carried an empty body'

  let body: PaymentRequired402Body
  try {
    body = JSON.parse(text) as PaymentRequired402Body
  } catch {
    return ` — merchant 402 body (unparseable): ${text.slice(0, MAX_REASON)}`
  }

  // The untouched default, or no reason at all: the plain challenge. On a retry
  // that carried X-PAYMENT this is the interesting case — the merchant did not
  // reject the payment, it never saw one, which points at lost session/payment
  // state rather than at policy.
  if (body.error === undefined || body.error === BARE_CHALLENGE_ERROR) {
    return (
      ' — merchant re-issued a bare challenge, so it did not reject the payment; it never ' +
      'associated the X-PAYMENT header with the request (lost session or payment state)'
    )
  }

  if (typeof body.error === 'string' && body.error.trim()) {
    // A merchant-side FAULT says so in its own text (#1517) — an RPC failure or
    // a bug, not a policy decision. Call that out rather than letting it read
    // like a refusal the payment earned.
    const fault = body.error.includes('merchant-side fault')
      ? ' [merchant FAULT, not a policy rejection — check the merchant logs]'
      : ''
    return ` — merchant said: ${body.error.slice(0, MAX_REASON)}${fault}`
  }
  return ` — merchant said: ${JSON.stringify(body.error).slice(0, MAX_REASON)}`
}
