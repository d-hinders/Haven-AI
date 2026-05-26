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
} as const

export type AgentPaymentNextAction = (typeof AgentPaymentNextAction)[keyof typeof AgentPaymentNextAction]

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
