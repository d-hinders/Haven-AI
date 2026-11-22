/**
 * #4872 part 2: checkout details on the HOSTED paid paths
 * (`docs/architecture/13-checkout-details.md` §4–§6).
 *
 * The hosted server is keyless, and on the MCP-merchant completion it sends
 * the paid request itself. Every refusal lands BEFORE anything is spent
 * wherever that is possible:
 *
 * - **Pay tools** (`haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`):
 *   before any funding intent or settlement child (`refuseUnshareableCheckoutDetails`).
 * - **Settle, EIP-3009**: the agent's payment header is already in hand, so
 *   availability AND the real header block are decided before the funding
 *   signature is relayed (`checkoutDetailsBeforeSpend` with the header).
 * - **Settle, erc7710**: availability before the settlement child is submitted;
 *   only the block, which needs the header Haven assembles, is checked after
 *   (`checkoutDetailsAfterSubmit`) — a refusal there sends nothing, so nothing
 *   can be redeemed (`unsent`).
 * - **Complete** (`haven_complete_mcp_tool`): the payment is already funded;
 *   decided after the funding wait (`funded`).
 * - **Plain HTTP, state-direct** (`haven_pay_x402_quote`, then `haven_submit`,
 *   part 2b): the pay tool refuses before any intent, as above. `haven_submit`
 *   reads the merchant's request back from the stored challenge and decides
 *   BEFORE it relays: on EIP-3009 availability and the estimated block before
 *   the funding relay (`checkoutDetailsBeforeSubmit`), on erc7710 availability
 *   before the settlement child is submitted and the real block right after
 *   it (`checkoutDetailsAfterSubmit`). The agent sends this paid request
 *   itself, so the answer rides the tool result's retry headers. When the
 *   stored-challenge read itself fails, the submit fails closed ONLY for a
 *   payment whose challenge asked for a required detail — the intent records
 *   that at authorize (#5030, owner decision 2026-11-22 option b) — and every
 *   other payment proceeds as today.
 *
 * The values pass through this server only in memory. They are never stored,
 * logged or merged into the echoed `extensions`. On the MCP-merchant paths
 * they ride ONLY the paid request (`completeX402MerchantCall`'s
 * `paidRequestHeaders`), never the MCP handshake, and never a tool result. On
 * the plain-HTTP state-direct path the agent sends the paid request, so the
 * answer is in `haven_submit`'s retry headers and nowhere else in the result. Every decision is built from
 * the SDK's own functions, so local and hosted answer the same request alike.
 */
import {
  actualPaidHeaderBlockBytes,
  checkoutDetailsChallengeUnreadableError,
  checkoutDetailsRefusalError,
  CheckoutDetailsUnavailableError,
  checkoutDetailsRequestOf,
  decideCheckoutDetails,
  estimatePaidHeaderBlockBytes,
  HavenApiError,
  isErc7710Option,
  parseCheckoutDetailsRequest,
  selectStandardPaymentOption,
  withinHeaderBlock,
  x402PaymentHeaderNamesFor,
  CHECKOUT_DETAILS_EXTENSION,
  type CheckoutDetailField,
  type CheckoutDetailsAvailability,
  type CheckoutDetailsRequest,
  type HavenClient,
  type X402PaymentOption,
  type X402PaymentRequired,
} from '@haven_ai/sdk'

type CheckoutReader = Pick<HavenClient, 'readCheckoutDetails'>

/** The SDK keeps a challenge on the intent only up to this size (#1355); a larger one is never stored. */
const STORED_CHALLENGE_MAX_BYTES = 65536

/**
 * Pay tools: refuse before any intent when a required field cannot be shared,
 * sized for the option that will actually be paid. A challenge that asks for
 * nothing reads nothing. A required request whose challenge is too large to be
 * stored is refused too: settle could never read it back to answer it.
 *
 * `requestHeaders` are the caller's own headers on the paid request (the
 * plain-HTTP pay tool has them; the catalog tools do not). They ride that
 * request too, so the SDK's estimate counts them (#5030) — without them a
 * 14.5 KB `Cookie` plus a required answer could pass this check and then
 * answer 431 at the merchant.
 */
export async function refuseUnshareableCheckoutDetails(
  haven: CheckoutReader,
  paymentRequired: X402PaymentRequired,
  paidOption: X402PaymentOption,
  { idempotencyKey, requestHeaders }: { idempotencyKey?: string; requestHeaders?: HeadersInit } = {},
): Promise<void> {
  const request = checkoutDetailsRequestOf(paymentRequired)
  if (request === null) return
  const priorPaymentPossible = typeof idempotencyKey === 'string' && idempotencyKey.length > 0
  const requiredFields = request.fields.filter((f) => f.required).map((f) => f.name)
  if (requiredFields.length > 0 && new TextEncoder().encode(JSON.stringify(paymentRequired)).length > STORED_CHALLENGE_MAX_BYTES) {
    throw checkoutDetailsRefusalError(requiredFields, 'over_budget', { priorPaymentPossible })
  }
  const availability = await haven.readCheckoutDetails()
  const decided = withinHeaderBlock(decideCheckoutDetails(request, availability), request, (answerHeader) =>
    estimatePaidHeaderBlockBytes({ paymentRequired, accepted: paidOption, isErc7710: isErc7710Option(paidOption), answerHeader, requestHeaders }),
  )
  if (decided.kind === 'refuse') throw checkoutDetailsRefusalError(decided.missingFields, decided.reason, { priorPaymentPossible })
}

/** The settle leg's state between the before-spend check and the paid request. */
export interface SettleCheckoutDetails {
  request: CheckoutDetailsRequest | null
  availability: CheckoutDetailsAvailability | null
  /** The answer, when the header block was already measured (EIP-3009). */
  header: string | undefined
}

/** The stored request as the settle leg reads it, plus whether the merchant URL matched. */
export interface StoredCheckoutRequest {
  value: unknown
  /** The explicit merchant_url differs from the one the payment was quoted for: never answer. */
  merchantMismatch?: boolean
}

function requestOf(stored: StoredCheckoutRequest | undefined): CheckoutDetailsRequest | null {
  if (!stored || stored.value === undefined) return null
  return parseCheckoutDetailsRequest({ [CHECKOUT_DETAILS_EXTENSION]: stored.value })
}

function blockFor(paymentHeader: string, requestHeaders: HeadersInit | undefined) {
  const headers = new Headers(requestHeaders)
  const names = x402PaymentHeaderNamesFor(paymentHeader)
  return (answerHeader: string | undefined) =>
    actualPaidHeaderBlockBytes({ headers, paymentHeader, paymentHeaderNames: names, answerHeader })
}

/**
 * Settle, BEFORE anything is spent. Reads the details once. With the payment
 * header (EIP-3009) the real block is measured too; without it (erc7710, whose
 * header Haven assembles at submit) only availability is decided. Refuses as
 * `before_payment` — nothing was funded, submitted or sent.
 */
export async function checkoutDetailsBeforeSpend(
  haven: CheckoutReader,
  input: { stored: StoredCheckoutRequest | undefined; paymentHeader: string | undefined; requestHeaders: HeadersInit | undefined; paymentId: string },
): Promise<SettleCheckoutDetails> {
  const request = requestOf(input.stored)
  if (request === null) return { request: null, availability: null, header: undefined }
  const availability: CheckoutDetailsAvailability = input.stored?.merchantMismatch
    ? { available: false, reason: 'merchant_mismatch' }
    : await haven.readCheckoutDetails()
  const base = decideCheckoutDetails(request, availability)
  const decided = input.paymentHeader ? withinHeaderBlock(base, request, blockFor(input.paymentHeader, input.requestHeaders)) : base
  if (decided.kind === 'refuse') {
    throw checkoutDetailsRefusalError(decided.missingFields, decided.reason, { intentExists: true, paymentId: input.paymentId })
  }
  return { request, availability, header: decided.kind === 'answer' ? decided.header : undefined }
}

/**
 * Settle, erc7710, AFTER the settlement child was submitted: only the real
 * header block is left to check. Over the ceiling with a required field, the
 * settlement is never sent — nothing can be redeemed (`unsent`).
 */
export function checkoutDetailsAfterSubmit(
  before: SettleCheckoutDetails,
  input: { paymentHeader: string; requestHeaders: HeadersInit | undefined; paymentId: string },
): string | undefined {
  if (before.request === null || before.availability === null) return undefined
  const decided = withinHeaderBlock(
    decideCheckoutDetails(before.request, before.availability),
    before.request,
    blockFor(input.paymentHeader, input.requestHeaders),
  )
  if (decided.kind === 'refuse') throw checkoutDetailsRefusalError(decided.missingFields, decided.reason, { unsent: true, paymentId: input.paymentId })
  return decided.kind === 'answer' ? decided.header : undefined
}

/**
 * Complete (the payment is already funded): read, decide and measure, after
 * the funding wait. A refusal is `funded` — the payment is not delivered.
 */
export async function checkoutDetailsForFundedDelivery(
  haven: CheckoutReader,
  input: { stored: StoredCheckoutRequest | undefined; paymentHeader: string; requestHeaders: HeadersInit | undefined; paymentId: string; noFundingLeg: boolean },
): Promise<string | undefined> {
  const request = requestOf(input.stored)
  if (request === null) return undefined
  const availability: CheckoutDetailsAvailability = input.stored?.merchantMismatch
    ? { available: false, reason: 'merchant_mismatch' }
    : await haven.readCheckoutDetails()
  const decided = withinHeaderBlock(decideCheckoutDetails(request, availability), request, blockFor(input.paymentHeader, input.requestHeaders))
  if (decided.kind === 'refuse') {
    throw checkoutDetailsRefusalError(
      decided.missingFields,
      decided.reason,
      input.noFundingLeg ? { unsent: true, paymentId: input.paymentId } : { funded: true, paymentId: input.paymentId },
    )
  }
  return decided.kind === 'answer' ? decided.header : undefined
}

/**
 * A settle or submit leg's before-spend refusal stands only while the intent
 * is still `pending_signature`. A REPEATED call (the #3423 crash recovery)
 * reaches a payment that already moved: there the submit or relay must give
 * its own answer (the settled replay on erc7710, the state error or the
 * relay's 409 on EIP-3009), and delivery, if any, decides checkout details
 * itself. Telling that agent "nothing moved" could make it pay twice.
 *
 * Returns `undefined` when the check is skipped. An unreadable state still
 * refuses (fail closed: skipping would burn the erc7710 child or fund
 * EIP-3009 first), as `state_unknown`, which never claims nothing moved.
 */
export async function checkoutDetailsWhilePending(
  haven: Pick<HavenClient, 'getPaymentStatus'>,
  paymentId: string,
  decide: () => Promise<SettleCheckoutDetails>,
): Promise<SettleCheckoutDetails | undefined> {
  try {
    return await decide()
  } catch (err) {
    if (!(err instanceof CheckoutDetailsUnavailableError)) throw err
    const status = await haven.getPaymentStatus(paymentId).catch(() => null)
    if (status?.status === 'pending_signature') throw err
    if (status === null) {
      throw checkoutDetailsRefusalError(err.missingFields as CheckoutDetailField[], err.reason, { stateUnknown: true, paymentId })
    }
    return undefined
  }
}

/**
 * #4872 part 2b / #5030: the merchant's challenge as stored at authorize, read
 * for `haven_submit`.
 *
 * `paymentRequired` is `null` when the payment is not x402 (a direct payment's
 * 409), stored no challenge, or the read failed. `requiredFields` is the
 * required checkout-details field names the intent recorded at authorize
 * (#5030): read from the payment status when the challenge read failed, so a
 * failed read can still fail closed for a payment whose challenge asked for a
 * required detail. `null` when neither read could answer.
 */
export interface StoredChallengeForSubmit {
  paymentRequired: X402PaymentRequired | null
  requiredFields: string[] | null
}

export async function storedChallengeForSubmit(
  haven: Pick<HavenClient, 'getX402StoredPaymentRequired' | 'getPaymentStatus'>,
  paymentId: string,
): Promise<StoredChallengeForSubmit> {
  try {
    return { paymentRequired: await haven.getX402StoredPaymentRequired(paymentId), requiredFields: null }
  } catch (err) {
    // A 404 (unknown or foreign) and a 409 (a direct payment) are answers, not
    // failures: neither can carry a stored checkout-details request.
    if (err instanceof HavenApiError && (err.statusCode === 404 || err.statusCode === 409)) {
      return { paymentRequired: null, requiredFields: null }
    }
    // The read failed — a 429 from the money-path rate limit is realistic. The
    // intent recorded whether the challenge asked for a required detail, and
    // the status read is not rate-limited, so it answers when the challenge
    // read cannot. A failed status read leaves the fact unknown (`null`).
    const requiredFields = await haven.getPaymentStatus(paymentId).then(
      (status) => status.checkoutDetailsRequiredFields ?? [],
      () => null,
    )
    return { paymentRequired: null, requiredFields }
  }
}

/**
 * `haven_submit`, BEFORE anything is spent, from the stored challenge. Reads
 * the details once. On EIP-3009 the agent's payment header never reaches this
 * tool, so the block is ESTIMATED from the challenge and the option it pays
 * (the pay tool's estimate also counted the caller's own request headers); on
 * erc7710 only availability is decided here, and the real block right after
 * the submit (`checkoutDetailsAfterSubmit`). Refuses as `before_payment` —
 * nothing was funded, submitted or sent.
 *
 * #5030: when the stored-challenge read failed and the intent recorded a
 * required checkout detail, this refuses as `challenge_unreadable` — the read
 * gave no field names, so the message names none. A payment whose challenge
 * asked for nothing (or whose record cannot be read either) proceeds as today.
 */
export async function checkoutDetailsBeforeSubmit(
  haven: CheckoutReader,
  input: { stored: StoredChallengeForSubmit; scheme: 'erc7710' | 'eip3009'; paymentId: string },
): Promise<SettleCheckoutDetails> {
  const paymentRequired = input.stored.paymentRequired
  if (paymentRequired === null) {
    if (input.stored.requiredFields !== null && input.stored.requiredFields.length > 0) {
      throw checkoutDetailsChallengeUnreadableError(input.stored.requiredFields, { intentExists: true, paymentId: input.paymentId })
    }
    return { request: null, availability: null, header: undefined }
  }
  const request = checkoutDetailsRequestOf(paymentRequired)
  if (request === null) return { request: null, availability: null, header: undefined }
  const availability = await haven.readCheckoutDetails()
  const base = decideCheckoutDetails(request, availability)
  const option = input.scheme === 'eip3009' ? selectStandardPaymentOption(paymentRequired.accepts) : null
  const decided = option
    ? withinHeaderBlock(base, request, (answerHeader) =>
        estimatePaidHeaderBlockBytes({ paymentRequired, accepted: option, isErc7710: false, answerHeader }),
      )
    : base
  if (decided.kind === 'refuse') {
    throw checkoutDetailsRefusalError(decided.missingFields, decided.reason, { intentExists: true, paymentId: input.paymentId })
  }
  return { request, availability, header: option && decided.kind === 'answer' ? decided.header : undefined }
}
