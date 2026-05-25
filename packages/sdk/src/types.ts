// ── Client Configuration ─────────────────────────────────────────

export interface HavenClientConfig {
  /** Haven API key (sk_agent_xxx) */
  apiKey: string

  /** Agent's delegate EOA private key. If provided, the SDK handles signing automatically. */
  delegateKey?: string

  /** Haven API base URL (default: http://localhost:3001) */
  baseUrl?: string

  /** Optional wallet identity to send as the x402-wallet header. */
  x402Wallet?: string

  /** Timeout in ms for individual HTTP requests (default: 30000) */
  requestTimeout?: number

  /** Timeout in ms when polling for tx confirmation (default: 90000) */
  confirmationTimeout?: number

  /** Polling interval in ms when waiting for confirmation (default: 3000) */
  pollingInterval?: number
}

// ── Payment Types ────────────────────────────────────────────────

export interface PaymentRequest {
  /** Token symbol: "EURe", "USDC.e", or "xDAI" */
  token: string

  /** Amount as a decimal string, e.g. "5.00" */
  amount: string

  /** Recipient Ethereum address (0x...) */
  to: string
}

export interface SignData {
  /** The hash to sign (keccak256, 0x-prefixed) */
  hash: string

  /** Breakdown of values that were hashed — useful for debugging */
  components: {
    safe: string
    token: string
    to: string
    amount: string
    payment_token: string
    payment: string
    nonce: number
  }

  /** Human-readable signing instructions */
  instructions: string
}

export interface PaymentIntent {
  /** Unique payment ID */
  paymentId: string

  /** Current status */
  status: 'pending_signature'

  /** ISO 8601 expiry timestamp */
  expiresAt: string

  /** Data needed to sign the payment */
  signData: SignData
}

export type PaymentStatus =
  | 'pending_signature'
  | 'submitted'
  | 'confirmed'
  | 'pending_approval'
  | 'approved'
  | 'proposed'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'failed'

export interface PaymentResult {
  /** Unique payment ID */
  paymentId: string

  /** Final status */
  status: PaymentStatus

  /** Token that was sent */
  token: string

  /** Amount that was sent (human-readable) */
  amount: string

  /** Recipient address */
  to: string

  /** On-chain transaction hash (present when confirmed) */
  txHash: string | null

  /** Error message (present when failed) */
  errorMessage: string | null

  /** Block explorer URL for the transaction (chain-dependent) */
  explorerUrl: string | null

  /** ISO 8601 timestamps */
  createdAt: string
  signedAt: string | null
  submittedAt: string | null
  confirmedAt: string | null
  expiresAt: string
}

// ── x402 Types ──────────────────────────────────────────────────

/** Payment requirements from an HTTP 402 response (x402 protocol). */
export interface X402PaymentRequired {
  x402Version: number
  resource: {
    url: string
    description?: string
    mimeType?: string
  }
  accepts: X402PaymentOption[]
  error?: string
}

/** A single payment option from x402 PaymentRequired. */
export interface X402PaymentOption {
  scheme: string             // "exact"
  network: string            // CAIP-2 chain ID or x402 network, e.g. "eip155:8453" or "base"
  amount: string             // Atomic units
  maxAmountRequired?: string // Atomic units (official x402 field)
  resource?: string
  description?: string
  mimeType?: string
  asset: string              // Token contract address
  payTo: string              // Recipient address
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

/** Receipt returned after a successful x402 payment. */
export interface X402Receipt {
  success: boolean
  paymentId: string
  txHash: string
  token: string
  amount: string
  to: string
  resourceUrl: string
  explorerUrl: string
  accepted?: X402PaymentOption
  paymentHeader?: string
  merchantTo?: string | null
  payer?: string
  chainId?: number
  haven?: {
    paymentId: string
    fundingTxHash: string
    fundingExplorerUrl: string
  }
  merchant?: {
    payTo: string | null
    settlementTxHash?: string | null
    settlementExplorerUrl?: string | null
  }
  x402?: {
    amount: string
    token: string
    network: string
    asset: string
    resource: string
  }
}

export interface X402AuthorizationOptions {
  /** Stable caller-supplied key for this user intent. Prevents duplicate approvals across fresh 402 quotes. */
  idempotencyKey?: string
}

/** Serializable HTTP request state for retrying the same x402 merchant request. */
export interface X402RequestSnapshot {
  url: string
  method: string
  headers: [string, string][]
  body?: string
}

/** Quote parsed from an HTTP 402 response without creating a Haven payment. */
export interface X402Quote {
  rail: 'x402'
  idempotencyKey: string
  paymentRequired: X402PaymentRequired
  accepted: X402PaymentOption
  request: X402RequestSnapshot
  resourceUrl: string
  description: string | null
  mimeType: string | null
  amountAtomic: string
  amount: string
  token: string
  asset: string
  network: string
  chainId: number | null
  merchantAddress: string
  maxTimeoutSeconds: number
}

/** State bundle an agent can persist while waiting for manual x402 approval. */
export interface X402ResumeState {
  rail: 'x402'
  paymentId: string
  idempotencyKey: string
  paymentRequired: X402PaymentRequired
  accepted: X402PaymentOption
  url: string
  request?: X402RequestSnapshot
  resourceUrl: string
  description: string | null
  amountAtomic: string
  amount: string
  token: string
  asset: string
  network: string
  chainId: number | null
  merchantAddress: string
}

export interface MppAuthorizationOptions {
  /** Stable caller-supplied key for this user intent. Prevents duplicate approvals across retries. */
  idempotencyKey?: string
}

/** Quote parsed from an MPP challenge without creating a Haven payment. */
export interface MppQuote {
  rail: 'mpp'
  paymentRail: MachinePaymentRail
  idempotencyKey: string
  challenge: MachinePaymentChallenge
  request: X402RequestSnapshot
  resourceUrl: string
  description: string | null
  amountAtomic: string
  amount: string
  token: string
  asset: string
  network: string
  chainId: number
  merchantAddress: string
  expiresAt: string
}

/** State bundle an agent can persist while waiting for manual MPP approval. */
export interface MppResumeState {
  rail: 'mpp'
  paymentRail: MachinePaymentRail
  paymentId: string
  idempotencyKey: string
  challenge: MachinePaymentChallenge
  url: string
  request?: X402RequestSnapshot
  resourceUrl: string
  description: string | null
  amountAtomic: string
  amount: string
  token: string
  asset: string
  network: string
  chainId: number
  merchantAddress: string
  expiresAt: string
}

export type PaymentResumeState = X402ResumeState | MppResumeState

export interface ResumeAuthorizedX402Input extends X402AuthorizationOptions {
  /** Payment or approval request ID returned by authorizeX402 / haven.fetch. */
  paymentId: string

  /** Original or freshly parsed x402 requirements for the merchant retry. */
  paymentRequired: X402PaymentRequired
}

export interface ResumeX402PaymentInput extends X402AuthorizationOptions {
  /** Payment or approval request ID returned by authorizeX402 / haven.fetch. */
  paymentId: string

  /** Original paid URL. If paymentRequired is omitted, Haven will call it once to re-read the 402 challenge. */
  url: string

  /** Original fetch options. Reused for the 402 probe and final merchant retry. */
  init?: RequestInit

  /** Serializable original request captured by quoteX402() / pending approval errors. */
  request?: X402RequestSnapshot

  /** Original or freshly parsed x402 requirements. Supplying this avoids an extra merchant 402 probe. */
  paymentRequired?: X402PaymentRequired
}

export interface ResumeAuthorizedMppInput extends MppAuthorizationOptions {
  /** Payment or approval request ID returned by authorizeMachinePayment / haven.fetch. */
  paymentId: string

  /** Original MPP challenge returned by the paid resource. */
  challenge: MachinePaymentChallenge
}

export interface ResumeMppPaymentInput extends MppAuthorizationOptions {
  /** Payment or approval request ID returned by authorizeMachinePayment / haven.fetch. */
  paymentId: string

  /** Original paid URL. If challenge is omitted, Haven will call it once to re-read the MPP challenge. */
  url: string

  /** Original fetch options. Reused for the 402 probe and final merchant retry. */
  init?: RequestInit

  /** Serializable original request captured by quoteMpp() / pending approval errors. */
  request?: X402RequestSnapshot

  /** Original MPP challenge. Supplying this avoids an extra paid-resource 402 probe. */
  challenge?: MachinePaymentChallenge
}

// ── Machine Payment Types ───────────────────────────────────────

export type MachinePaymentRail =
  | 'x402'
  | 'mpp_demo'
  | 'mpp_crypto'
  | 'stripe_deposit'
  | 'spt'

export interface MachinePaymentChallenge {
  rail: MachinePaymentRail
  version: string
  challengeId: string
  resource: string
  description: string
  network: {
    chainId: number
    name: 'base'
  }
  asset: {
    symbol: 'USDC'
    address: string
    decimals: 6
  }
  amount: {
    display: string
    atomic: string
  }
  recipient: string
  expiresAt: string
  metadata?: Record<string, unknown>
}

export interface MachinePaymentReceipt {
  success: boolean
  rail: MachinePaymentRail
  paymentId: string
  challengeId: string
  txHash: string
  token: string
  amount: string
  to: string
  resourceUrl: string
  explorerUrl: string
  payer?: string
  chainId?: number
  proofHeader: string
}

export interface HavenAgent {
  id: string
  name: string
  status: string
  safeAddress: string
  delegateAddress: string
  chainId: number
}

export interface HavenAllowance {
  id: string
  tokenAddress: string
  tokenSymbol: string
  configuredAmount: string
  resetPeriodMin: number
  onchain: {
    amount: string
    spent: string
    remaining: string
    effectiveSpent: string
    resetTimeMin: number
    lastResetMin: number
    nonce: number
    isResetPending: boolean
  }
}

export interface HavenAllowanceSummary {
  agentId: string
  safeAddress: string
  delegateAddress: string
  chainId: number
  allowances: HavenAllowance[]
}

export interface HavenPaymentReceipt {
  id: string
  paymentId: string
  rail: string
  proofStatus: string
  txHash: string
  chainId: number
  resourceUrl: string
  merchantAddress: string | null
  payerAddress: string
  settlementAddress: string
  tokenSymbol: string
  tokenAddress: string
  amountRaw: string
  amount: string
  challengeId: string | null
  idempotencyKey: string | null
  challengePayload?: Record<string, unknown> | null
  selectedPayment?: Record<string, unknown> | null
  paymentProofHeaderName: string | null
  protocolReceiptHeaderName: string | null
  protocolReceiptPayload?: Record<string, unknown> | null
  merchantStatus: number | null
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
}

// ── Agent Payment State Types ────────────────────────────────────

export type PaymentStateKind = 'payment_intent' | 'approval_request'

export interface AgentPaymentEnumSchema {
  type: 'string'
  enum: readonly string[]
  description: string
  'x-enumDescriptions': Record<string, string>
}

export const AgentPaymentPhase = {
  /** The agent must sign and submit the prepared payment before Haven can relay it. */
  AgentSignatureRequired: 'agent_signature_required',
  /** Haven has received the signed payment and the agent should poll for confirmation. */
  PaymentSubmitted: 'payment_submitted',
  /** The direct payment is confirmed; the agent does not need to do more for this payment id. */
  PaymentConfirmed: 'payment_confirmed',
  /** The payment needs wallet owner approval in Haven before it can continue. */
  UserApprovalRequired: 'user_approval_required',
  /** The wallet owner approved the request and still needs to complete the funding payment. */
  UserExecutionRequired: 'user_execution_required',
  /** The funding payment was proposed and is waiting for the remaining account approvals. */
  WaitingForAdditionalApprovals: 'waiting_for_additional_approvals',
  /** The Haven funding leg was sent; the agent can continue the merchant/protocol leg. */
  FundingSent: 'funding_sent',
  /** The wallet owner rejected the request; the agent should stop and tell the user. */
  Rejected: 'rejected',
  /** The payment or approval request expired before completion. */
  Expired: 'expired',
  /** Haven could not complete the payment; the agent should stop and surface the failure. */
  Failed: 'failed',
} as const

export type AgentPaymentPhase = (typeof AgentPaymentPhase)[keyof typeof AgentPaymentPhase]

export const AgentPaymentNextAction = {
  /** Sign with the delegate key and submit the payment to Haven. */
  SignAndSubmitPayment: 'sign_and_submit_payment',
  /** Poll getPaymentStatus later using this payment id. */
  CheckStatusLater: 'check_status_later',
  /** No further agent action is required for this payment id. */
  None: 'none',
  /** Wait for the wallet owner to approve or reject the request in Haven. */
  WaitForUserApproval: 'wait_for_user_approval',
  /** Wait for the wallet owner to finish sending the approved funding payment. */
  WaitForUserToCompletePayment: 'wait_for_user_to_complete_payment',
  /** Resume this payment id and retry the original x402 request with the merchant payment header. */
  RetryOriginalX402Request: 'retry_original_x402_request',
  /** Stop retrying this payment and tell the user what happened. */
  StopAndTellUser: 'stop_and_tell_user',
  /** Ask again only if the user still wants the payment after expiry. */
  RequestAgainIfUserStillWantsIt: 'request_again_if_user_still_wants_it',
} as const

export type AgentPaymentNextAction = (typeof AgentPaymentNextAction)[keyof typeof AgentPaymentNextAction]

export const AgentPaymentRail = {
  /** Standard Haven payment from the user's Safe through an approved delegate allowance. */
  Direct: 'direct',
  /** x402 HTTP 402 payment flow with a Haven funding leg and merchant retry leg. */
  X402: 'x402',
  /** Machine Payment Protocol flow. */
  Mpp: 'mpp',
} as const

export type AgentPaymentRail = (typeof AgentPaymentRail)[keyof typeof AgentPaymentRail]

export type PaymentPhase = AgentPaymentPhase

export type PaymentNextAction = AgentPaymentNextAction

export const AGENT_PAYMENT_PHASE_VALUES = Object.values(AgentPaymentPhase)

export const AGENT_PAYMENT_NEXT_ACTION_VALUES = Object.values(AgentPaymentNextAction)

export const AGENT_PAYMENT_RAIL_VALUES = Object.values(AgentPaymentRail)

export const AgentPaymentPhaseDescriptions: Record<AgentPaymentPhase, string> = {
  [AgentPaymentPhase.AgentSignatureRequired]: 'The agent must sign and submit the prepared payment before Haven can relay it.',
  [AgentPaymentPhase.PaymentSubmitted]: 'Haven has received the signed payment and the agent should poll for confirmation.',
  [AgentPaymentPhase.PaymentConfirmed]: 'The direct payment is confirmed; the agent does not need to do more for this payment id.',
  [AgentPaymentPhase.UserApprovalRequired]: 'The payment needs wallet owner approval in Haven before it can continue.',
  [AgentPaymentPhase.UserExecutionRequired]: 'The wallet owner approved the request and still needs to complete the funding payment.',
  [AgentPaymentPhase.WaitingForAdditionalApprovals]: 'The funding payment was proposed and is waiting for the remaining account approvals.',
  [AgentPaymentPhase.FundingSent]: 'The Haven funding leg was sent; the agent can continue the merchant/protocol leg.',
  [AgentPaymentPhase.Rejected]: 'The wallet owner rejected the request; the agent should stop and tell the user.',
  [AgentPaymentPhase.Expired]: 'The payment or approval request expired before completion.',
  [AgentPaymentPhase.Failed]: 'Haven could not complete the payment; the agent should stop and surface the failure.',
}

export const AgentPaymentNextActionDescriptions: Record<AgentPaymentNextAction, string> = {
  [AgentPaymentNextAction.SignAndSubmitPayment]: 'Sign with the delegate key and submit the payment to Haven.',
  [AgentPaymentNextAction.CheckStatusLater]: 'Poll getPaymentStatus later using this payment id.',
  [AgentPaymentNextAction.None]: 'No further agent action is required for this payment id.',
  [AgentPaymentNextAction.WaitForUserApproval]: 'Wait for the wallet owner to approve or reject the request in Haven.',
  [AgentPaymentNextAction.WaitForUserToCompletePayment]: 'Wait for the wallet owner to finish sending the approved funding payment.',
  [AgentPaymentNextAction.RetryOriginalX402Request]: 'Resume this payment id and retry the original x402 request with the merchant payment header.',
  [AgentPaymentNextAction.StopAndTellUser]: 'Stop retrying this payment and tell the user what happened.',
  [AgentPaymentNextAction.RequestAgainIfUserStillWantsIt]: 'Ask again only if the user still wants the payment after expiry.',
}

export const AgentPaymentRailDescriptions: Record<AgentPaymentRail, string> = {
  [AgentPaymentRail.Direct]: 'Standard Haven payment from the user-controlled Safe through an approved delegate allowance.',
  [AgentPaymentRail.X402]: 'x402 HTTP 402 payment flow with a Haven funding leg and merchant retry leg.',
  [AgentPaymentRail.Mpp]: 'Machine Payment Protocol flow.',
}

export const AgentPaymentPhaseSchema: AgentPaymentEnumSchema = {
  type: 'string',
  enum: AGENT_PAYMENT_PHASE_VALUES,
  description: 'Stable Haven agent payment state phase.',
  'x-enumDescriptions': AgentPaymentPhaseDescriptions,
}

export const AgentPaymentNextActionSchema: AgentPaymentEnumSchema = {
  type: 'string',
  enum: AGENT_PAYMENT_NEXT_ACTION_VALUES,
  description: 'Stable next action an agent should take for a Haven payment state.',
  'x-enumDescriptions': AgentPaymentNextActionDescriptions,
}

export const AgentPaymentRailSchema: AgentPaymentEnumSchema = {
  type: 'string',
  enum: AGENT_PAYMENT_RAIL_VALUES,
  description: 'Stable rail identifier for Haven agent payment states.',
  'x-enumDescriptions': AgentPaymentRailDescriptions,
}

export interface PaymentStatusResult {
  paymentId: string
  kind: PaymentStateKind
  rail: string
  status: PaymentStatus | string
  phase: PaymentPhase
  nextAction: PaymentNextAction
  amount: string
  token: string
  resourceUrl: string | null
  merchantAddress: string | null
  txHash: string | null
  expiresAt: string
  chainId: number
  message: string
  amountAtomic?: string | null
  asset?: string | null
  network?: string | null
  description?: string | null
  idempotencyKey?: string | null
  x402?: {
    amountAtomic: string | null
    asset: string | null
    network: string | null
    resourceUrl: string | null
    merchantAddress: string | null
    description: string | null
    idempotencyKey: string | null
  }
  mpp?: {
    amountAtomic: string | null
    asset: string | null
    network: string | null
    resourceUrl: string | null
    merchantAddress: string | null
    description: string | null
    idempotencyKey: string | null
    challengeId: string | null
  }
}

export interface PendingApproval extends PaymentStatusResult {
  kind: 'approval_request'
  status: 'pending_approval' | 'pending' | string
  phase: typeof AgentPaymentPhase.UserApprovalRequired
  nextAction: typeof AgentPaymentNextAction.WaitForUserApproval
  requested?: string
  remaining?: string | null
}

/** @internal */
export interface RawMachinePaymentAuthorizeResponse {
  success?: boolean
  payment_id: string
  kind?: string
  status: string
  phase?: string
  next_action?: string
  message?: string
  remaining?: string | null
  requested?: string
  tx_hash?: string
  chain_id?: number
  safe_address?: string
  payer?: string
  token?: string
  amount?: string
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  description?: string | null
  idempotency_key?: string | null
  to?: string
  merchant_to?: string | null
  merchant_address?: string | null
  resource_url?: string
  rail?: string
  x402?: RawX402StateContext
  mpp?: RawMppStateContext
  challenge_id?: string
  explorer_url?: string
  expires_at?: string
  sign_data?: {
    hash: string
    components: {
      safe: string
      token: string
      to: string
      amount: string
      payment_token: string
      payment: string
      nonce: number
    }
    instructions: string
  }
  error?: string
}

/** @internal */
export interface RawX402AuthorizeResponse {
  success?: boolean
  payment_id: string
  kind?: string
  rail?: string
  status: string
  phase?: string
  next_action?: string
  message?: string
  remaining?: string | null
  requested?: string
  tx_hash?: string
  chain_id?: number
  safe_address?: string
  payer?: string
  token?: string
  amount?: string
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  description?: string | null
  idempotency_key?: string | null
  to?: string
  merchant_to?: string | null
  merchant_address?: string | null
  resource_url?: string
  explorer_url?: string
  x402?: RawX402StateContext
  mpp?: RawMppStateContext
  challenge_id?: string
  expires_at?: string
  sign_data?: {
    hash: string
    components: {
      safe: string
      token: string
      to: string
      amount: string
      payment_token: string
      payment: string
      nonce: number
    }
    instructions: string
  }
  error?: string
}

// ── API Response Shapes (raw, snake_case from server) ────────────

/** @internal */
export interface RawCreateResponse {
  payment_id: string
  kind?: string
  status: string
  phase?: string
  next_action?: string
  message?: string
  remaining?: string | null
  requested?: string
  expires_at: string
  sign_data: {
    hash: string
    components: {
      safe: string
      token: string
      to: string
      amount: string
      payment_token: string
      payment: string
      nonce: number
    }
    instructions: string
  }
  error?: string
  supported?: string[]
}

/** @internal */
export interface RawSignResponse {
  payment_id: string
  kind?: string
  status: string
  phase?: string
  next_action?: string
  message?: string
  remaining?: string | null
  requested?: string
  tx_hash?: string
  token?: string
  amount?: string
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  description?: string | null
  idempotency_key?: string | null
  to?: string
  merchant_to?: string | null
  merchant_address?: string | null
  resource_url?: string
  rail?: string
  x402?: RawX402StateContext
  mpp?: RawMppStateContext
  challenge_id?: string
  explorer_url?: string
  chain_id?: number
  expires_at?: string
  error?: string
  details?: string
}

/** @internal */
export interface RawStatusResponse {
  payment_id: string
  status: string
  token: string
  amount: string
  to: string
  tx_hash: string | null
  explorer_url?: string | null
  chain_id?: number
  error_message: string | null
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
}

/** @internal */
export interface RawPaymentStatusResult {
  payment_id: string
  kind: PaymentStateKind
  rail: string
  status: string
  phase: PaymentPhase
  next_action: PaymentNextAction
  amount: string
  token: string
  resource_url: string | null
  merchant_address: string | null
  tx_hash: string | null
  expires_at: string
  chain_id: number
  message: string
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  description?: string | null
  idempotency_key?: string | null
  x402?: RawX402StateContext
  mpp?: RawMppStateContext
}

/** @internal */
export interface RawHavenAgent {
  id: string
  name: string
  status: string
  safe_address: string
  delegate_address: string
  chain_id: number
}

/** @internal */
export interface RawHavenAllowance {
  id: string
  token_address: string
  token_symbol: string
  configured_amount: string
  reset_period_min: number
  onchain: {
    amount: string
    spent: string
    remaining: string
    effective_spent: string
    reset_time_min: number
    last_reset_min: number
    nonce: number
    is_reset_pending: boolean
  }
}

/** @internal */
export interface RawHavenAllowanceSummary {
  agent_id: string
  safe_address: string
  delegate_address: string
  chain_id: number
  allowances: RawHavenAllowance[]
}

/** @internal */
export interface RawHavenPaymentReceipt {
  id: string
  payment_id: string
  rail: string
  proof_status: string
  tx_hash: string
  chain_id: number
  resource_url: string
  merchant_address: string | null
  payer_address: string
  settlement_address: string
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  challenge_id: string | null
  idempotency_key: string | null
  challenge_payload?: Record<string, unknown> | null
  selected_payment?: Record<string, unknown> | null
  payment_proof_header_name: string | null
  protocol_receipt_header_name: string | null
  protocol_receipt_payload?: Record<string, unknown> | null
  merchant_status: number | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

/** @internal */
export interface RawHavenPaymentReceiptsResponse {
  receipts: RawHavenPaymentReceipt[]
}

/** @internal */
export interface RawX402StateContext {
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  resource_url?: string | null
  merchant_address?: string | null
  description?: string | null
  idempotency_key?: string | null
}

/** @internal */
export interface RawMppStateContext {
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  resource_url?: string | null
  merchant_address?: string | null
  description?: string | null
  idempotency_key?: string | null
  challenge_id?: string | null
}

// ── Error Types ──────────────────────────────────────────────────

export class HavenError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly paymentId?: string,
  ) {
    super(message)
    this.name = 'HavenError'
  }
}

export class HavenApiError extends HavenError {
  constructor(
    message: string,
    statusCode: number,
    public readonly body?: unknown,
    paymentId?: string,
  ) {
    super(message, 'API_ERROR', statusCode, paymentId)
    this.name = 'HavenApiError'
  }
}

export class HavenPaymentStateError extends HavenApiError {
  resumeState?: X402ResumeState | MppResumeState

  constructor(
    message: string,
    statusCode: number,
    public readonly state: PaymentStatusResult,
    body?: unknown,
  ) {
    super(message, statusCode, body, state.paymentId)
    this.name = 'HavenPaymentStateError'
  }

  get status(): string {
    return this.state.status
  }

  get phase(): PaymentPhase {
    return this.state.phase
  }

  get nextAction(): PaymentNextAction {
    return this.state.nextAction
  }
}

export class HavenSigningError extends HavenError {
  constructor(message: string) {
    super(message, 'SIGNING_ERROR')
    this.name = 'HavenSigningError'
  }
}

export class HavenTimeoutError extends HavenError {
  constructor(paymentId: string) {
    super(
      `Timed out waiting for payment ${paymentId} to confirm`,
      'TIMEOUT',
      undefined,
      paymentId,
    )
    this.name = 'HavenTimeoutError'
  }
}
