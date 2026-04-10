// ── Client Configuration ─────────────────────────────────────────

export interface HavenClientConfig {
  /** Haven API key (sk_agent_xxx) */
  apiKey: string

  /** Agent's delegate EOA private key. If provided, the SDK handles signing automatically. */
  delegateKey?: string

  /** Haven API base URL (default: http://localhost:3001) */
  baseUrl?: string

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

  /** Gnosisscan URL for the transaction */
  explorerUrl: string | null

  /** ISO 8601 timestamps */
  createdAt: string
  signedAt: string | null
  submittedAt: string | null
  confirmedAt: string | null
  expiresAt: string
}

// ── API Response Shapes (raw, snake_case from server) ────────────

/** @internal */
export interface RawCreateResponse {
  payment_id: string
  status: string
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
  status: string
  tx_hash?: string
  token?: string
  amount?: string
  to?: string
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
  error_message: string | null
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
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
  ) {
    super(message, 'API_ERROR', statusCode)
    this.name = 'HavenApiError'
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
