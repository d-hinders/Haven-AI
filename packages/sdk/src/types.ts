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

/** @internal */
export interface RawMachinePaymentAuthorizeResponse {
  success?: boolean
  payment_id: string
  status: string
  tx_hash?: string
  chain_id?: number
  safe_address?: string
  payer?: string
  token?: string
  amount?: string
  to?: string
  merchant_to?: string | null
  resource_url?: string
  rail?: string
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
  status: string
  tx_hash?: string
  chain_id?: number
  safe_address?: string
  payer?: string
  token?: string
  amount?: string
  to?: string
  merchant_to?: string | null
  resource_url?: string
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
  explorer_url?: string
  chain_id?: number
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
