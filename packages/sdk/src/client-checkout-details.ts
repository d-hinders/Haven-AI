import {
  CHECKOUT_DETAILS_EXTENSION,
  checkoutDetailsRequestOf,
  decideCheckoutDetails,
  estimatePaidHeaderBlockBytes,
  withinHeaderBlock,
  type CheckoutDetailField,
  type CheckoutDetailsAvailability,
  type CheckoutDetailsDecision,
  type CheckoutDetailsRefusalReason,
  type CheckoutDetailsValues,
} from './checkout-details.js'
import { isErc7710Option, selectStandardPaymentOption } from './x402.js'
import { CheckoutDetailsUnavailableError, HavenApiError } from './types.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

/**
 * Checkout details on the paid x402 request (#4872): the wire half. Sibling of
 * `client-tax-declaration.ts`, kept out of `client.ts`.
 *
 * 1. Read the merchant's request from the challenge. No readable request:
 *    nothing is read from Haven and the paid request is today's.
 * 2. Otherwise read the agent's own details (`GET /agents/:id/checkout-details`,
 *    #4871, agent-key auth) and map every failure to a NAMED state: the
 *    endpoint's `feature_disabled` / `disabled` / `no_details`, a 404 (a
 *    backend older than #4871) and any other failure (unreadable) are each
 *    distinct, because a required field needs to say which one it hit.
 * 3. Decide the answer within the budget and the 16 KB block.
 *
 * Unlike the tax declaration, a failed read is not always "proceed": it is
 * for optional fields only. A REQUIRED field the read could not answer is a
 * refusal before payment, with its own reason.
 *
 * Values are never logged. The one stderr line names the fields, the answer's
 * size, the outcome and the merchant's host.
 */

/** The endpoint's own "not available" reasons (#4871). */
type ReadUnavailableReason = 'feature_disabled' | 'disabled' | 'no_details'

/**
 * Read the agent's details and resolve them into the state the decision needs.
 * Never throws: every failure is a named unavailable state.
 */
export async function readCheckoutDetailsAvailability(client: {
  getAgent: () => Promise<{ id: string }>
  get: <T>(path: string) => Promise<T>
}): Promise<CheckoutDetailsAvailability> {
  let body: { available?: unknown; reason?: unknown; checkout_details?: unknown } | null
  let agentId: string
  try {
    agentId = (await client.getAgent()).id
  } catch {
    // The agent's own identity read failing says nothing about the backend's
    // age: unreadable, never `backend_unsupported`.
    return { available: false, reason: 'unreadable' }
  }
  try {
    body = await client.get(`/agents/${agentId}/checkout-details`)
  } catch (err) {
    if (err instanceof HavenApiError && err.statusCode === 404) return { available: false, reason: 'backend_unsupported' }
    return { available: false, reason: 'unreadable' }
  }
  if (body && body.available === true && body.checkout_details && typeof body.checkout_details === 'object') {
    return { available: true, values: body.checkout_details as CheckoutDetailsValues }
  }
  const reason = body && typeof body.reason === 'string' ? (body.reason as ReadUnavailableReason) : undefined
  if (reason === 'feature_disabled') return { available: false, reason: 'feature_disabled' }
  if (reason === 'disabled') return { available: false, reason: 'not_shared' }
  // Sharing on, nothing saved: every asked field is "not stored".
  if (reason === 'no_details') return { available: true, values: {} }
  // Off-contract: neither details nor a named reason. Refused, not guessed at.
  return { available: false, reason: 'unreadable' }
}

const FIELD_WORDS: Record<CheckoutDetailField, string> = {
  receipt_email: 'receipt email',
  billing_address: 'billing address',
  shipping_address: 'shipping address',
}

const REASON_WORDS: Record<CheckoutDetailsRefusalReason, string> = {
  not_shared: 'checkout-details sharing is off for this agent; the owner can turn it on in the agent’s settings',
  feature_disabled: 'checkout details are not available on this Haven deployment',
  not_stored: 'the owner has not saved it in business details',
  over_budget: 'it does not fit in the paid request',
  unreadable: 'Haven could not read the owner’s checkout details right now; try again',
  backend_unsupported: 'this Haven backend does not support checkout details yet',
  merchant_mismatch: 'the merchant URL given is not the one this payment was quoted for, so the owner\u2019s details are not sent to it',
}

/** The refusal, as the error the SDK throws. Field names only, never values. */
export function checkoutDetailsRefusalError(
  missingFields: CheckoutDetailField[],
  reason: CheckoutDetailsRefusalReason,
  {
    funded = false,
    unsent = false,
    priorPaymentPossible = false,
    paymentId,
  }: {
    /** The payment is funded (EIP-3009 after the funding leg): it is not delivered. */
    funded?: boolean
    /** A settlement exists but was never sent to the merchant (erc7710 at settle): nothing moved. */
    unsent?: boolean
    /**
     * The call carried an idempotency key an earlier call may already have
     * paid under: "nothing moved" is true of THIS call only.
     */
    priorPaymentPossible?: boolean
    paymentId?: string
  } = {},
): CheckoutDetailsUnavailableError {
  const names = missingFields.map((f) => FIELD_WORDS[f]).join(', ')
  const outcome = funded
    ? 'The payment is funded but was not delivered: finish it once the owner has fixed this.'
    : unsent
      ? 'The payment was not sent to the merchant, so nothing was redeemed and no funds moved; start a new purchase once the owner has fixed this.'
      : priorPaymentPossible
        ? 'This call created no payment and moved no funds; if an earlier call with the same idempotency key already paid, check its payment status.'
        : 'No payment was created and no funds moved.'
  return new CheckoutDetailsUnavailableError(
    missingFields,
    reason,
    `The merchant requires the ${names}, which this agent cannot share: ${REASON_WORDS[reason]}. ${outcome}`,
    funded ? 'funded' : unsent ? 'unsent' : 'before_payment',
    paymentId,
  )
}

function merchantHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

/** The single log line. Names, size and outcome — never a value. */
export function logCheckoutDetailsOutcome(decision: CheckoutDetailsDecision, url: string): void {
  if (decision.kind === 'none') return
  const host = merchantHost(url)
  if (decision.kind === 'refuse') {
    process.stderr.write(
      `[haven-sdk] checkout details: outcome=refused_missing_required fields=${decision.missingFields.join(',')} reason=${decision.reason} host=${host}\n`,
    )
    return
  }
  const outcome = decision.header ? 'sent' : decision.omitted.some((o) => o.reason === 'over_budget') ? 'dropped_over_budget' : 'none_shared'
  process.stderr.write(
    `[haven-sdk] checkout details: outcome=${outcome} fields=${decision.sentFields.join(',') || '-'} bytes=${decision.header?.length ?? 0} host=${host}\n`,
  )
}

/**
 * The decision for one challenge, BEFORE the payment is authorised: read the
 * request, read the details only when something was asked, build the answer
 * and check the header block. `{ kind: 'none' }` makes no Haven call.
 */
export async function resolveCheckoutDetails(
  client: { getAgent: () => Promise<{ id: string }>; get: <T>(path: string) => Promise<T> },
  paymentRequired: X402PaymentRequired,
  /** The paid request's own headers, counted in the block estimate. */
  requestHeaders?: HeadersInit,
  /**
   * The option that will actually be paid, when the caller selected it (the
   * hosted pay tools choose erc7710 or EIP-3009 themselves). Omitted, the
   * SDK paths' own selection is used: the standard (EIP-3009) option.
   */
  paidOption?: X402PaymentOption,
): Promise<CheckoutDetailsDecision> {
  const request = checkoutDetailsRequestOf(paymentRequired)
  if (request === null) {
    // §2: a malformed entry is no request, and the shape failure is logged
    // (its presence, never its content).
    const extensions = paymentRequired.extensions as Record<string, unknown> | undefined
    if (extensions && extensions[CHECKOUT_DETAILS_EXTENSION] !== undefined) {
      process.stderr.write('[haven-sdk] checkout details: outcome=unreadable_request (no answer sent)\n')
    }
    return { kind: 'none' }
  }
  // The option the SDK will pay with. None compatible: the authorization
  // refuses with its own "no compatible option" answer, which must not be
  // masked by a checkout-details read or refusal.
  const accepted = paidOption ?? selectStandardPaymentOption(paymentRequired.accepts)
  if (!accepted) return { kind: 'none' }
  // A request that asks only for optional fields never needs the read to
  // succeed, but it still reads: an optional field is sent when it can be.
  const availability = await readCheckoutDetailsAvailability(client)
  const decided = decideCheckoutDetails(request, availability)
  // The block is estimated for the scheme actually paid: the SDK paths pay
  // the selected standard (EIP-3009) option, never erc7710.
  const isErc7710 = isErc7710Option(accepted)
  return withinHeaderBlock(decided, request, (answerHeader) =>
    estimatePaidHeaderBlockBytes({ paymentRequired, accepted, isErc7710, answerHeader, requestHeaders }),
  )
}

/**
 * The checkout-details answer for one challenge, decided BEFORE the payment is
 * authorised (`docs/architecture/13-checkout-details.md` §5). Returns the
 * header value to attach to the paid request, or `undefined` (no request, or
 * nothing could be shared for optional fields). Throws
 * `CheckoutDetailsUnavailableError` when a required field cannot be shared;
 * `funded` says so in the message on a resume, where the payment already
 * exists. A challenge that asks for nothing makes no Haven call.
 */
export async function checkoutDetailsHeaderFor(
  client: { getAgent: () => Promise<{ id: string }>; get: <T>(path: string) => Promise<T> },
  paymentRequired: X402PaymentRequired,
  url: string,
  { funded = false, requestHeaders }: { funded?: boolean; requestHeaders?: HeadersInit } = {},
): Promise<string | undefined> {
  const decision = await resolveCheckoutDetails(client, paymentRequired, requestHeaders)
  logCheckoutDetailsOutcome(decision, url)
  if (decision.kind === 'refuse') throw checkoutDetailsRefusalError(decision.missingFields, decision.reason, { funded })
  return decision.kind === 'answer' ? decision.header : undefined
}

/** Re-exported so `HavenClient` reads the type through its one checkout-details import. */
export type { CheckoutDetailsAvailability } from './checkout-details.js'
