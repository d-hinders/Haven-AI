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

// ── Agent Payment State Types ────────────────────────────────────

export type PaymentStateKind = 'payment_intent' | 'approval_request'

export type PaymentPhase =
  | 'agent_signature_required'
  | 'payment_submitted'
  | 'payment_confirmed'
  | 'user_approval_required'
  | 'user_execution_required'
  | 'waiting_for_additional_approvals'
  | 'funding_sent'
  | 'rejected'
  | 'expired'
  | 'failed'

export type PaymentNextAction =
  | 'sign_and_submit_payment'
  | 'check_status_later'
  | 'none'
  | 'wait_for_user_approval'
  | 'wait_for_user_to_complete_payment'
  | 'retry_original_x402_request'
  | 'stop_and_tell_user'
  | 'request_again_if_user_still_wants_it'

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
}

export interface PendingApproval extends PaymentStatusResult {
  kind: 'approval_request'
  status: 'pending_approval' | 'pending' | string
  phase: 'user_approval_required'
  nextAction: 'wait_for_user_approval'
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
  resumeState?: X402ResumeState

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
