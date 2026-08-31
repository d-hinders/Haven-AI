/**
 * Backend mirror of the agent payment taxonomy exported from `@haven_ai/sdk`.
 *
 * The SDK is the source of truth for these enums; this file is a hand-mirror
 * so backend code can typecheck without depending on a built SDK artifact in
 * the workspace. A parity test
 * (`agent-payment-taxonomy.parity.test.ts`) fails CI if the two go out of
 * sync — see that test for the contract.
 */

export const AgentPaymentPhase = {
  AgentSignatureRequired: 'agent_signature_required',
  PaymentSubmitted: 'payment_submitted',
  PaymentConfirmed: 'payment_confirmed',
  UserApprovalRequired: 'user_approval_required',
  UserExecutionRequired: 'user_execution_required',
  WaitingForAdditionalApprovals: 'waiting_for_additional_approvals',
  FundingSent: 'funding_sent',
  Rejected: 'rejected',
  Expired: 'expired',
  Failed: 'failed',
  InsufficientFunds: 'insufficient_funds',
  FundedButUnsettled: 'funded_but_unsettled',
} as const

export type AgentPaymentPhase = (typeof AgentPaymentPhase)[keyof typeof AgentPaymentPhase]

export const AgentPaymentNextAction = {
  SignAndSubmitPayment: 'sign_and_submit_payment',
  CheckStatusLater: 'check_status_later',
  None: 'none',
  WaitForUserApproval: 'wait_for_user_approval',
  WaitForUserToCompletePayment: 'wait_for_user_to_complete_payment',
  RetryOriginalX402Request: 'retry_original_x402_request',
  StopAndTellUser: 'stop_and_tell_user',
  RequestAgainIfUserStillWantsIt: 'request_again_if_user_still_wants_it',
  /** #1307: retry the SAME tool call with explicit context fields the server could not rehydrate. */
  RetryWithExplicitContext: 'retry_with_explicit_context',
  PaymentWindowExpired: 'payment_window_expired',
  FundSafeOrRaiseAllowance: 'fund_safe_or_raise_allowance',
  SweepStrandedFunds: 'sweep_stranded_funds',
} as const

export type AgentPaymentNextAction = (typeof AgentPaymentNextAction)[keyof typeof AgentPaymentNextAction]

/**
 * #2262: the per-value prose the SDK ships to its own users, mirrored here so
 * the SERVED spec can carry it too.
 *
 * `x-enumDescriptions` appeared zero times in `/openapi.json` before this: the
 * SDK's `AgentPaymentPhaseSchema` / `AgentPaymentNextActionSchema` carry these
 * strings, but `openapi/spec.ts` hand-wrote bare `enum:` lists, so an SDK user
 * was warned that five approval values are retired and a raw-API integrator
 * reading the spec was not.
 *
 * Mirrored, not re-authored: `agent-payment-taxonomy.parity.test.ts` asserts
 * these objects are deep-equal to the SDK's, so a reworded description on
 * either side fails CI rather than forking into a second copy.
 */
export const AgentPaymentPhaseDescriptions: Record<AgentPaymentPhase, string> = {
  [AgentPaymentPhase.AgentSignatureRequired]: 'The agent must sign and submit the prepared payment before Haven can relay it.',
  [AgentPaymentPhase.PaymentSubmitted]: 'Haven has received the signed payment and the agent should poll for confirmation.',
  [AgentPaymentPhase.PaymentConfirmed]: 'The direct payment is confirmed; the agent does not need to do more for this payment id.',
  [AgentPaymentPhase.UserApprovalRequired]: 'Retired wire value: no live rail produces it. It described the Safe rail\'s approval queue, which no longer exists — an out-of-policy payment is declined before any money moves. If it is ever seen, stop and tell the user; no approval is pending.',
  [AgentPaymentPhase.UserExecutionRequired]: 'Retired wire value: no live rail produces it. Stop and tell the user.',
  [AgentPaymentPhase.WaitingForAdditionalApprovals]: 'Retired wire value: no live rail produces it. Stop and tell the user.',
  [AgentPaymentPhase.FundingSent]: 'The Haven funding leg was sent; the agent can continue the merchant/protocol leg.',
  [AgentPaymentPhase.Rejected]: 'The payment was rejected and cannot proceed; the agent should stop and tell the user.',
  [AgentPaymentPhase.Expired]: 'The payment expired before completion.',
  [AgentPaymentPhase.Failed]: 'Haven could not complete the payment; the agent should stop and surface the failure.',
  [AgentPaymentPhase.InsufficientFunds]:
    'Pre-flight check determined the delegate balance plus the remaining on-chain budget cannot cover the requested amount, so no payment was created. The account must be funded or the agent budget raised before retrying.',
  [AgentPaymentPhase.FundedButUnsettled]:
    "Haven's funding leg confirmed on-chain but the merchant rejected the x402 retry. The delegate wallet may hold stranded funds. The agent should stop and wait for the wallet owner to sweep the stranded funds back to the account.",
}

export const AgentPaymentNextActionDescriptions: Record<AgentPaymentNextAction, string> = {
  [AgentPaymentNextAction.SignAndSubmitPayment]: 'Sign with the delegate key and submit the payment to Haven.',
  [AgentPaymentNextAction.CheckStatusLater]: 'Poll getPaymentStatus later using this payment id.',
  [AgentPaymentNextAction.None]: 'No further agent action is required for this payment id.',
  [AgentPaymentNextAction.WaitForUserApproval]: 'Retired wire value: no live rail produces it, and nothing maps to it. It described a per-payment approval queue that no longer exists. If it is ever seen, stop and tell the user rather than polling — no approval will arrive.',
  [AgentPaymentNextAction.WaitForUserToCompletePayment]: 'Retired wire value: no live rail produces it. Stop and tell the user rather than polling.',
  [AgentPaymentNextAction.RetryOriginalX402Request]: 'Resume this payment id and retry the original x402 request with the merchant payment header.',
  [AgentPaymentNextAction.StopAndTellUser]: 'Stop retrying this payment and tell the user what happened.',
  [AgentPaymentNextAction.RequestAgainIfUserStillWantsIt]: 'Ask again only if the user still wants the payment after expiry.',
  [AgentPaymentNextAction.PaymentWindowExpired]:
    'The x402 funding/quote window expired. Re-quote with the same idempotency key before asking the signer to build a merchant payment header again.',
  [AgentPaymentNextAction.FundSafeOrRaiseAllowance]:
    'Stop and tell the user that the account needs to be funded or the agent budget raised before the payment can succeed.',
  [AgentPaymentNextAction.RetryWithExplicitContext]:
    'Retry the same tool call, this time passing merchant_url, tool_name, arguments, and mcp_transport explicitly — the server had no stored context to rehydrate for this payment id.',
  [AgentPaymentNextAction.SweepStrandedFunds]:
    'Tell the user that funds may be stranded in the delegate wallet and prompt them to initiate a sweep in Haven to return them to the originating account.',
}

/**
 * See the SDK's `AgentPaymentRail` doc comment for the categorical vs granular
 * vocabulary explanation. Both layers reach the wire — the categorical values
 * (`direct`, `x402`, `mpp`) are resume-state discriminators; the granular
 * `mpp_*` / `stripe_deposit` / `spt` values are what response bodies carry.
 */
export const AgentPaymentRail = {
  Direct: 'direct',
  X402: 'x402',
  Mpp: 'mpp',
  MppDemo: 'mpp_demo',
  MppCrypto: 'mpp_crypto',
  StripeDeposit: 'stripe_deposit',
  Spt: 'spt',
} as const

export type AgentPaymentRail = (typeof AgentPaymentRail)[keyof typeof AgentPaymentRail]
