/**
 * #5084: the resource-address check, moved before any money moves.
 *
 * The hosted MCP completion compares the payment's STORED resource address
 * with the MCP endpoint it is about to call, string for string, and refuses a
 * mismatch with a 409 (`resolveCompletionContext`,
 * `packages/sdk/src/merchant-completion.ts`, "x402 merchant completion does
 * not match the approved resource URL"). On EIP-3009 that comparison ran
 * after the funding relay, so a merchant whose challenge named
 * `mcp://tool/<name>` while its tool lived at `https://<host>/mcp` got a
 * funded, undeliverable payment: the money sat on the delegate until it was
 * swept back.
 *
 * The two schemes store different addresses (#3527): EIP-3009's
 * `createX402Intent` stores the challenge's `resource.url`, ERC-7710 stores
 * the endpoint the caller passes. So:
 *
 * - **At pay / prepare** (`haven_pay_mcp_tool`, `haven_prepare_catalog_purchase`,
 *   EIP-3009 branch only): the address that will be stored is the challenge's
 *   `resource.url`, and the endpoint it will be completed against is the
 *   DISCOVERED merchant URL. A mismatch is refused before the intent exists.
 * - **At settle** (`haven_settle_mcp_tool`, both schemes): an explicit
 *   `merchant_url` is taken verbatim, so the stored address is read from the
 *   payment status (the same `resource_url` completion reads) and compared
 *   before the funding relay or the ERC-7710 submit.
 *
 * The rule is completion's own: strict `!==` (never the normalising
 * `sameUrl`), and no check when there is no address to compare (completion
 * skips a null stored address). So no payment completion refuses gets through.
 * The pay-time check compares with the DISCOVERED endpoint, so it also refuses
 * a purchase that could only have completed by passing the challenge's own
 * address as an explicit `merchant_url` at settle — before any money moves.
 *
 * Residual, not closed here: an intent created before this check, or by
 * `haven_pay_x402_quote` with an MCP challenge (no stored call context),
 * funded through `haven_submit` and then completed with a different explicit
 * `merchant_url`, still reaches completion's 409 after funding.
 * `docs/architecture/04-x402-payment-sequence.md` states the same.
 */
import { AgentPaymentNextAction, type HavenClient, type X402PaymentRequired } from '@haven_ai/sdk'
import { HostedToolError } from './errors.js'
import { paymentStatusHandoff, refusalNextStep } from './guidance.js'

/** The typed code both refusals carry: the payment's address and its endpoint differ. */
export const MERCHANT_RESOURCE_MISMATCH = 'MERCHANT_RESOURCE_MISMATCH'

/** Completion's rule: a non-empty approved address that is not the endpoint, string for string. */
export function resourceAddressMismatch(approved: string | null | undefined, endpoint: string): boolean {
  return typeof approved === 'string' && approved !== '' && approved !== endpoint
}

/**
 * Pay-time check (EIP-3009 branch): refuse before the intent is created when
 * the challenge's `resource.url` — the address `createX402Intent` will store —
 * is not the endpoint the payment will be completed against.
 */
export function assertChallengeAddressMatchesEndpoint(
  paymentRequired: X402PaymentRequired,
  endpoint: string,
): void {
  const challengeAddress = (paymentRequired as { resource?: { url?: unknown } }).resource?.url
  if (typeof challengeAddress !== 'string' || !resourceAddressMismatch(challengeAddress, endpoint)) return
  throw new HostedToolError({
    code: MERCHANT_RESOURCE_MISMATCH,
    message:
      `This merchant's x402 challenge names ${challengeAddress} as its address, but the tool lives at ` +
      `${endpoint}; Haven cannot complete a payment for it. Nothing was created, funded or signed. ` +
      'The merchant must use its own https endpoint as resource.url in the challenge.',
    statusCode: 409,
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason:
        "the merchant's challenge names a different address than its tool endpoint, so Haven cannot complete a payment for it; nothing was created — tell the user",
    }),
  })
}

/**
 * Settle-time check (both schemes): read the payment's stored address and
 * compare it with the endpoint this settle will deliver to, before anything is
 * spent. Applies only while the payment is still `pending_signature`: a
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
    throw new HostedToolError({
      code: 'PAYMENT_STATE_UNAVAILABLE',
      message:
        `Haven could not read payment ${paymentId} to check its approved resource address before spending ` +
        `(${err instanceof Error ? err.message : String(err)}). This call sent nothing: no funding was ` +
        'relayed and nothing was submitted. Check the payment status, then call the same tool again.',
      statusCode: 503,
      paymentId,
      rail: 'x402',
      nextStep: refusalNextStep({
        nextAction: AgentPaymentNextAction.CheckStatusLater,
        ...paymentStatusHandoff(paymentId),
      }),
    })
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
