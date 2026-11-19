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
 *
 * The values pass through this server only in memory. They are never stored,
 * logged, put in a tool result or merged into the echoed `extensions`, and
 * they ride ONLY the paid request (`completeX402MerchantCall`'s
 * `paidRequestHeaders`), never the MCP handshake. Every decision is built from
 * the SDK's own functions, so local and hosted answer the same request alike.
 */
import {
  actualPaidHeaderBlockBytes,
  checkoutDetailsRefusalError,
  checkoutDetailsRequestOf,
  decideCheckoutDetails,
  estimatePaidHeaderBlockBytes,
  isErc7710Option,
  parseCheckoutDetailsRequest,
  withinHeaderBlock,
  x402PaymentHeaderNamesFor,
  CHECKOUT_DETAILS_EXTENSION,
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
 */
export async function refuseUnshareableCheckoutDetails(
  haven: CheckoutReader,
  paymentRequired: X402PaymentRequired,
  paidOption: X402PaymentOption,
  { idempotencyKey }: { idempotencyKey?: string } = {},
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
    estimatePaidHeaderBlockBytes({ paymentRequired, accepted: paidOption, isErc7710: isErc7710Option(paidOption), answerHeader }),
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
  if (decided.kind === 'refuse') throw checkoutDetailsRefusalError(decided.missingFields, decided.reason, { paymentId: input.paymentId })
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
