/**
 * #4872 part 2: checkout details on the HOSTED paid paths
 * (`docs/architecture/13-checkout-details.md` §4–§6).
 *
 * The hosted server is keyless, and on the MCP-merchant completion it sends
 * the paid request itself. Two moments matter:
 *
 * - **Before any intent** (`haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`):
 *   a required field the agent cannot share refuses the purchase with
 *   `CHECKOUT_DETAILS_UNAVAILABLE`. No funding intent and no settlement child
 *   exist yet, so nothing moved and nothing can be redeemed.
 * - **At settle** (`paid-mcp-completion`): the merchant's request comes back
 *   from the challenge stored at authorize (merchant-call-context), the
 *   agent's details are read again, and the answer rides the paid request the
 *   server sends. The block is measured on the ACTUAL payment header. A
 *   required field that can no longer be shared, or no longer fits, refuses
 *   delivery: on erc7710 the merchant has not redeemed anything, so nothing
 *   moved; on EIP-3009 the payment is funded and is not delivered.
 *
 * The values pass through this server only in memory. They are never stored,
 * never logged, never put in a tool result and never merged into the echoed
 * `extensions`. Every decision is built from the SDK's own functions, so the
 * local and hosted surfaces answer the same request the same way.
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
  type CheckoutDetailsDecision,
  type HavenClient,
  type X402PaymentOption,
  type X402PaymentRequired,
} from '@haven_ai/sdk'

type CheckoutReader = Pick<HavenClient, 'readCheckoutDetails'>

/**
 * Before the intent: throw the refusal when a required field cannot be
 * shared, sized for the option that will actually be paid. A challenge that
 * asks for nothing reads nothing.
 */
export async function refuseUnshareableCheckoutDetails(
  haven: CheckoutReader,
  paymentRequired: X402PaymentRequired,
  paidOption: X402PaymentOption,
): Promise<void> {
  const request = checkoutDetailsRequestOf(paymentRequired)
  if (request === null) return
  const availability = await haven.readCheckoutDetails()
  const decided = withinHeaderBlock(decideCheckoutDetails(request, availability), request, (answerHeader) =>
    estimatePaidHeaderBlockBytes({
      paymentRequired,
      accepted: paidOption,
      isErc7710: isErc7710Option(paidOption),
      answerHeader,
    }),
  )
  if (decided.kind === 'refuse') throw checkoutDetailsRefusalError(decided.missingFields, decided.reason)
}

/**
 * At settle: the answer header for the paid request the server is about to
 * send, or `undefined`. `storedRequest` is the merchant-call-context's
 * verbatim `checkout_details_request` (untrusted). Throws the refusal — with
 * the funded wording on EIP-3009 — when a required field cannot be shared or
 * does not fit the real block.
 */
export async function checkoutDetailsHeaderForSettle(
  haven: CheckoutReader,
  input: {
    storedRequest: unknown
    paymentHeader: string
    requestHeaders: HeadersInit | undefined
    noFundingLeg: boolean
    paymentId: string
  },
): Promise<string | undefined> {
  if (input.storedRequest === undefined) return undefined
  const request = parseCheckoutDetailsRequest({ [CHECKOUT_DETAILS_EXTENSION]: input.storedRequest })
  if (request === null) return undefined
  const availability = await haven.readCheckoutDetails()
  const headers = new Headers(input.requestHeaders)
  const names = x402PaymentHeaderNamesFor(input.paymentHeader)
  const decided: CheckoutDetailsDecision = withinHeaderBlock(decideCheckoutDetails(request, availability), request, (answerHeader) =>
    actualPaidHeaderBlockBytes({ headers, paymentHeader: input.paymentHeader, paymentHeaderNames: names, answerHeader }),
  )
  if (decided.kind === 'refuse') {
    const err = input.noFundingLeg
      ? checkoutDetailsRefusalError(decided.missingFields, decided.reason, { unsent: true })
      : checkoutDetailsRefusalError(decided.missingFields, decided.reason, { funded: true })
    Object.defineProperty(err, 'paymentId', { value: input.paymentId })
    throw err
  }
  return decided.kind === 'answer' ? decided.header : undefined
}
