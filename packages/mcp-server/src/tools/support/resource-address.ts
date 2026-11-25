/**
 * #5084 / #5086: where a paid MCP payment may be delivered, decided before
 * the money moves.
 *
 * The hosted MCP completion checks that the URL it delivers the signed payment
 * header to is the one the payment was approved for (`resolveCompletionContext`,
 * `packages/sdk/src/merchant-completion.ts`). What "approved" means:
 *
 * - **An MCP payment with a stored call context (#5086):** the MCP endpoint
 *   Haven itself called and stored at quote time — read from the SERVER
 *   (`GET /x402/:id/merchant-call-context`), never from the resolved call
 *   context, which on the explicit-arguments path is the agent's own
 *   `merchant_url` and would be compared with itself. The payment's stored
 *   address keeps the merchant's DECLARED `resource.url` (on EIP-3009 that is
 *   what `createX402Intent` stores, what the signer binds and what the
 *   funding evidence report carries), so an `mcp://tool/<name>` address is payable.
 * - **No stored call context** (`haven_pay_x402_quote` with an MCP challenge,
 *   a 409 from the context read): the payment's stored address, as before —
 *   read from the payment status (#5084).
 *
 * Both checks run on `haven_settle_mcp_tool` before the funding relay or the
 * erc7710 submit, and on `haven_complete_mcp_tool` before delivery. A failed
 * read refuses (fail closed). Same comparison as completion: strict `!==`,
 * never the normalising `sameUrl`.
 *
 * Residual: a payment with no stored call context, funded through
 * `haven_submit` and completed with a different explicit `merchant_url`, still
 * meets completion's refusal after funding (but before delivery).
 * `docs/architecture/04-x402-payment-sequence.md` states the same.
 */
import { AgentPaymentNextAction, HavenApiError, type HavenClient, type X402MerchantCallContext } from '@haven_ai/sdk'
import { HostedToolError, paymentWindowExpiredError } from './errors.js'
import { paymentStatusHandoff, refusalNextStep } from './guidance.js'

/** The typed code every mismatch refusal carries: the payment's approved target and the delivery URL differ. */
export const MERCHANT_RESOURCE_MISMATCH = 'MERCHANT_RESOURCE_MISMATCH'

/** Which tool is asking: settle refuses before spending; complete refuses a funded payment before delivery. */
export type DeliveryCheckPhase = 'settle' | 'complete'

/** Completion's rule: a non-empty approved value that is not the endpoint, string for string. */
export function resourceAddressMismatch(approved: string | null | undefined, endpoint: string): boolean {
  return typeof approved === 'string' && approved !== '' && approved !== endpoint
}

const NOTHING_SENT: Record<DeliveryCheckPhase, string> = {
  settle: 'This call sent nothing: no funding was relayed and nothing was submitted.',
  complete: 'This call delivered nothing: the payment header was not sent to any merchant.',
}

/**
 * A failed read needed for the delivery check refuses. A deterministic answer
 * (an unknown or foreign payment_id, an auth refusal) stops: a later read
 * answers the same. Anything else — no answer, a 5xx, a 408/429 — may clear:
 * hand the status read.
 */
function readRefusal(err: unknown, paymentId: string, phase: DeliveryCheckPhase): HostedToolError {
  const code = err instanceof HavenApiError ? err.statusCode : undefined
  if (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429) {
    return new HostedToolError({
      code: 'PAYMENT_STATE_UNAVAILABLE',
      message:
        `Haven refused the read of payment ${paymentId} needed to check where it may be delivered ` +
        `(HTTP ${code}: ${(err as Error).message}). ${NOTHING_SENT[phase]} Check that payment_id belongs to this agent.`,
      statusCode: code,
      paymentId,
      rail: 'x402',
      nextStep: refusalNextStep({
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason:
          phase === 'settle'
            ? 'Haven refused to read this payment (an unknown or foreign payment_id, or an auth refusal), so reading it again answers the same; this call funded and submitted nothing — tell the user'
            : 'Haven refused to read this payment (an unknown or foreign payment_id, or an auth refusal), so reading it again answers the same; the payment header was not delivered — tell the user',
      }),
    })
  }
  return new HostedToolError({
    code: 'PAYMENT_STATE_UNAVAILABLE',
    message:
      `Haven could not read payment ${paymentId} to check where it may be delivered ` +
      `(${err instanceof Error ? err.message : String(err)}). ${NOTHING_SENT[phase]} ` +
      'Check the payment status, then call the same tool again.',
    statusCode: 503,
    paymentId,
    rail: 'x402',
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.CheckStatusLater,
      ...paymentStatusHandoff(paymentId),
    }),
  })
}

/**
 * #5086: the delivery target for a paid MCP payment, decided before anything
 * moves. `approvedEndpoint` is what to hand `completeX402MerchantCall`;
 * `undefined` when the payment has no stored call context and completion
 * keeps the stored-address comparison. `stored` is the context read on the
 * explicit path, returned so the caller does not read it a second time.
 *
 * - `explicit: false` (the context was rehydrated from the server): the
 *   context's `merchantUrl` IS the stored endpoint.
 * - `explicit: true`: the agent's `merchant_url` is compared with the stored
 *   endpoint read from the server. A 409 (no stored context) falls back to the
 *   stored address (`assertStoredAddressMatchesBeforeSpend` on settle;
 *   completion's own comparison on complete, which runs before delivery). A
 *   410 is the expired-payment answer; any other failure refuses.
 */
export async function approvedDeliveryTarget(
  haven: Pick<HavenClient, 'getX402MerchantCallContext' | 'getPaymentStatus'>,
  paymentId: string,
  deliveryUrl: string,
  options: { explicit: boolean; phase: DeliveryCheckPhase },
): Promise<{ approvedEndpoint?: string; stored?: X402MerchantCallContext; noStoredContext?: boolean }> {
  if (!options.explicit) return { approvedEndpoint: deliveryUrl }
  let stored: X402MerchantCallContext
  try {
    stored = await haven.getX402MerchantCallContext(paymentId)
  } catch (err) {
    if (err instanceof HavenApiError && err.statusCode === 409) {
      if (options.phase === 'settle') await assertStoredAddressMatchesBeforeSpend(haven, paymentId, deliveryUrl)
      return { noStoredContext: true }
    }
    if (err instanceof HavenApiError && err.statusCode === 410) {
      throw paymentWindowExpiredError({ paymentId, status: 'expired', phase: 'expired', rail: 'x402' })
    }
    throw readRefusal(err, paymentId, options.phase)
  }
  const storedEndpoint = stored.merchantUrl
  if (storedEndpoint !== deliveryUrl) {
    throw new HostedToolError({
      code: MERCHANT_RESOURCE_MISMATCH,
      message:
        `Payment ${paymentId} was approved for the MCP endpoint ${storedEndpoint}, but this call would deliver it ` +
        `to ${deliveryUrl}; Haven delivers a payment only to the endpoint it was approved for. ${NOTHING_SENT[options.phase]} ` +
        'Call again without merchant_url and tool_name so Haven uses the stored call context, or with ' +
        `merchant_url set to ${storedEndpoint}.`,
      statusCode: 409,
      paymentId,
      rail: 'x402',
      nextStep: refusalNextStep({
        nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
        nextTool: null,
        nextToolOmittedReason:
          options.phase === 'settle'
            ? 're-call the same tool without merchant_url (Haven rehydrates the stored context) or with merchant_url set to the approved endpoint the message names; this call funded and submitted nothing'
            : 're-call the same tool without merchant_url (Haven rehydrates the stored context) or with merchant_url set to the approved endpoint the message names; the payment header was not delivered',
      }),
    })
  }
  return { approvedEndpoint: storedEndpoint, stored }
}

/**
 * Settle-time check for a payment with NO stored call context (#5084): read
 * the payment's stored address and compare it with the endpoint this settle
 * will deliver to, before anything is spent. Applies only while the payment is still `pending_signature`: a
 * repeated settle of a payment that already moved gets the relay's or the
 * submit's own answer, as the #4872 checkout-details decision does. A failed
 * read refuses (fail closed): nothing has been spent by this call, and the
 * agent can retry the same tool.
 */
export async function assertStoredAddressMatchesBeforeSpend(
  haven: Pick<HavenClient, 'getPaymentStatus'>,
  paymentId: string,
  endpoint: string,
): Promise<void> {
  let status: Awaited<ReturnType<HavenClient['getPaymentStatus']>>
  try {
    status = await haven.getPaymentStatus(paymentId)
  } catch (err) {
    throw readRefusal(err, paymentId, 'settle')
  }
  if (status.status !== 'pending_signature') return
  const approved = status.resourceUrl ?? status.x402?.resourceUrl ?? null
  if (!resourceAddressMismatch(approved, endpoint)) return
  throw new HostedToolError({
    code: MERCHANT_RESOURCE_MISMATCH,
    message:
      `Payment ${paymentId} was approved for ${approved}, but this call would deliver it to ${endpoint}; ` +
      'Haven completes a payment only at the address it was approved for. Nothing was funded or submitted. ' +
      `Call again without merchant_url and tool_name so Haven uses the stored call context, or with ` +
      `merchant_url set to ${approved}.`,
    statusCode: 409,
    paymentId,
    status: 'pending_signature',
    phase: 'not_started',
    rail: 'x402',
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
      nextTool: null,
      nextToolOmittedReason:
        're-call the same tool without merchant_url (Haven rehydrates the stored context) or with merchant_url set to the approved address the message names; nothing was funded or submitted',
    }),
  })
}
