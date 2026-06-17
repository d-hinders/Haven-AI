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

  /**
   * Extra headers to attach to every request to the Haven API.
   *
   * Used by the MCP server to tag requests with `X-Haven-MCP-Tool: <name>`
   * so the backend can record an audit-log entry per tool invocation. Has
   * no effect on outbound merchant requests (x402 / MPP) — those are
   * standard HTTP and never carry Haven-internal headers.
   */
  defaultHeaders?: Record<string, string>

  /**
   * JSON-RPC RPC URLs keyed by EIP-155 chain ID.
   *
   * When provided for a chain, the SDK waits for ≥1 on-chain confirmation of
   * the AllowanceModule funding tx before retrying the merchant. This prevents
   * the race where the merchant's `balanceOf(delegate)` call runs before the
   * funding block has propagated to the merchant's RPC node.
   *
   * Without this option the SDK proceeds as soon as Haven's backend confirms
   * submission (backward-compatible default). Set it to a reliable RPC
   * endpoint (e.g. Alchemy / Infura) for production usage.
   *
   * @example { 8453: 'https://mainnet.base.org' }
   */
  chainRpcs?: Record<number, string>
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
  extensions?: Record<string, unknown>
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

/**
 * Keyless x402 construct result.
 *
 * Returned by `createX402Intent` — the non-custodial half of an x402 payment.
 * It carries the unsigned funding hash (`signData.hash`, Safe → delegate EOA)
 * plus everything the *edge* needs to build and sign the EIP-3009 merchant
 * header itself. The construct path never signs; both delegate signatures
 * (funding hash + merchant header) happen on the machine that holds the key.
 */
export interface X402Intent {
  /** Haven payment id for the funding transfer. */
  paymentId: string
  /** Stable key used to create or refresh this x402 funding intent. */
  idempotencyKey: string
  status: 'pending_signature'
  /** ISO 8601 expiry of the funding intent, if returned. */
  expiresAt?: string
  /** The unsigned funding hash to sign with the delegate key (Safe → delegate EOA). */
  signData: SignData
  /** The selected x402 option — the edge needs this to build the EIP-3009 header. */
  accepted: X402PaymentOption
  /** Resource URL the 402 came from. */
  resourceUrl: string
  /** Merchant payTo address (the final recipient of the EIP-3009 transfer). */
  merchantTo: string
  /** Atomic amount the edge signer must authorize in the merchant header. */
  amountAtomic: string
  /** Token contract the merchant header must pay. */
  asset: string
  /** x402 network the merchant header must use. */
  network: string
  /** Haven-authenticated binding over the x402 expected context. */
  expectedAuth: X402ExpectedAuth
  /** Delegate EOA the funding transfer tops up (the x402 payer). */
  fundingTo: string
}

export interface X402ExpectedContext {
  paymentId: string
  payloadHash: string
  resourceUrl: string
  merchantTo: string
  amount: string
  asset: string
  network: string
  /** Optional ISO expiry for the funding/quote window. When present, it is bound into the Haven-authenticated context. */
  expiresAt?: string
}

export interface X402ExpectedAuth {
  version: 1
  message: string
  signature: string
  signer: string
}

/** Serializable HTTP request state for retrying the same x402 merchant request. */
export interface X402RequestSnapshot {
  url: string
  method: string
  headers: [string, string][]
  body?: string
}

export interface X402McpTransport {
  handshakeRequired: boolean
  source: 'path' | 'bazaar'
}

/** Quote parsed from an HTTP 402 response without creating a Haven payment. */
export interface X402Quote {
  rail: 'x402'
  idempotencyKey: string
  paymentRequired: X402PaymentRequired
  accepted: X402PaymentOption
  request: X402RequestSnapshot
  mcpTransport?: X402McpTransport
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

/**
 * Affirmative spend-readiness for the authenticated agent, derived from the raw
 * agent status plus the on-chain remaining allowance:
 * - `ready`         — active and at least one token has remaining on-chain allowance.
 * - `needs_approval`— active but no remaining allowance to auto-spend; payments
 *                     will be queued for the wallet owner to approve in Haven.
 * - `revoked`       — the credential is not active (revoked/paused); nothing executes.
 *
 * Wallet token balance is intentionally NOT folded in here: the on-chain
 * remaining allowance is the gate Haven enforces, and insufficient wallet
 * funding surfaces at pay time as INSUFFICIENT_FUNDS.
 */
export type HavenAgentReadiness = 'ready' | 'needs_approval' | 'revoked'

/** Compact, agent-facing per-token spend authority for the bootstrap summary. */
export interface HavenAgentAllowanceSummary {
  tokenSymbol: string
  /** Live on-chain remaining allowance in atomic units. */
  remainingAtomic: string
  /** Human-readable remaining, e.g. "4.96 USDC". */
  remainingDisplay: string
  /** Configured allowance amount (atomic) the owner granted. */
  configuredAmount: string
  resetPeriodMin: number
  isResetPending: boolean
}

/**
 * One-shot "am I ready?" bootstrap: identity + live spend authority + a
 * readiness signal, so an agent can answer "who am I and can I pay right now"
 * from a single call at session start. Superset of {@link HavenAgent}.
 */
export interface HavenAgentSummary extends HavenAgent {
  readiness: HavenAgentReadiness
  allowances: HavenAgentAllowanceSummary[]
}

export interface HavenPaymentReceipt {
  id: string
  paymentId: string
  paymentIntentId?: string | null
  approvalRequestId?: string | null
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

// ── Delegate Sweep Types ─────────────────────────────────────────

/** One transferred asset in a delegate sweep. */
export interface SweepEntry {
  /** 'USDC' or 'ETH' */
  asset: string
  /** Human-readable amount swept (e.g. "0.12") */
  amount: string
  /** Atomic amount swept */
  amountAtomic: string
  /** Transaction hash of the sweep transfer */
  txHash: string
  /** Block explorer URL for the tx */
  explorerUrl: string
}

/** Result of a `sweepDelegate()` call. */
export interface SweepResult {
  /** Address funds were swept FROM */
  fromAddress: string
  /** Address funds were swept TO (always the originating Safe) */
  toAddress: string
  /** Chain the sweep occurred on */
  chainId: number
  /** One entry per transferred asset. Empty when nothing was stranded. */
  transfers: SweepEntry[]
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
  /**
   * Pre-flight check determined the delegate's existing balance plus the
   * remaining on-chain allowance cannot cover the requested amount, so no
   * payment intent was created. Distinct from `UserApprovalRequired`: there
   * is no approval that would fix this — the originating Safe needs more
   * funds or the agent's per-token allowance needs to be raised first.
   */
  InsufficientFunds: 'insufficient_funds',
  /**
   * Haven's funding leg (Safe → delegate) confirmed on-chain, but the
   * merchant rejected the x402 retry. The delegate wallet may hold stranded
   * USDC that was never settled to the merchant. The agent should stop, tell
   * the user, and wait for the sweep flow to reclaim the funds.
   */
  FundedButUnsettled: 'funded_but_unsettled',
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
  /**
   * The x402 funding/quote window expired. Re-quote the same logical merchant
   * operation with the same idempotency key to stay double-charge-safe.
   */
  PaymentWindowExpired: 'payment_window_expired',
  /**
   * Stop and tell the user that the originating Safe needs to be funded or
   * the agent's per-token allowance needs to be raised before the payment
   * can succeed. A user approval will not fix this state on its own.
   */
  FundSafeOrRaiseAllowance: 'fund_safe_or_raise_allowance',
  /**
   * The delegate wallet may hold funds that were sent from the Safe but never
   * settled to the merchant. The wallet owner should initiate a sweep to
   * return those funds to the originating Safe.
   */
  SweepStrandedFunds: 'sweep_stranded_funds',
} as const

export type AgentPaymentNextAction = (typeof AgentPaymentNextAction)[keyof typeof AgentPaymentNextAction]

export const AgentPaymentFailureCode = {
  /** A merchant-authoritative x402 price exceeds the caller's pre-funding max_amount cap. */
  PriceExceedsMax: 'PRICE_EXCEEDS_MAX',
  /** The x402 funding/quote window expired before the signer or hosted settle step could finish. */
  PaymentWindowExpired: 'PAYMENT_WINDOW_EXPIRED',
  /** The Haven funding leg succeeded, but the merchant rejected the paid retry. */
  MerchantRejectedAfterFunding: 'MERCHANT_REJECTED_AFTER_FUNDING',
} as const

export type AgentPaymentFailureCode = (typeof AgentPaymentFailureCode)[keyof typeof AgentPaymentFailureCode]

/**
 * Stable rail identifier carried on Haven agent payment responses and resume
 * state.
 *
 * Two layers of vocabulary share this enum because both reach the wire:
 *
 *   - **Categorical rails** identify the rail family and are used as
 *     discriminators on `PaymentResumeState`: `direct`, `x402`, `mpp`.
 *   - **Granular rails** identify the specific protocol the backend persists
 *     and returns on response bodies: `mpp_demo`, `mpp_crypto`,
 *     `stripe_deposit`, `spt`. `x402` doubles as both categorical and
 *     granular.
 *
 * Consumers reading the top-level `rail` field on a payment status response
 * should treat any `mpp*` value as the MPP family; consumers reading the
 * `rail` field on a `MppResumeState` will always see the categorical `mpp`,
 * with the granular value on `paymentRail`.
 */
export const AgentPaymentRail = {
  /** Standard Haven payment from the user's Safe through an approved delegate allowance. */
  Direct: 'direct',
  /** x402 HTTP 402 payment flow with a Haven funding leg and merchant retry leg. */
  X402: 'x402',
  /** Machine Payment Protocol family — categorical value used as a resume-state discriminator. */
  Mpp: 'mpp',
  /** Haven internal MPP demo rail. Not for production traffic. */
  MppDemo: 'mpp_demo',
  /** Crypto-settled MPP rail. */
  MppCrypto: 'mpp_crypto',
  /** Stripe-deposit-backed MPP rail. */
  StripeDeposit: 'stripe_deposit',
  /** Stripe Payment Token MPP rail. */
  Spt: 'spt',
} as const

export type AgentPaymentRail = (typeof AgentPaymentRail)[keyof typeof AgentPaymentRail]

export type PaymentPhase = AgentPaymentPhase

export type PaymentNextAction = AgentPaymentNextAction

export const AGENT_PAYMENT_PHASE_VALUES = Object.values(AgentPaymentPhase)

export const AGENT_PAYMENT_NEXT_ACTION_VALUES = Object.values(AgentPaymentNextAction)

export const AGENT_PAYMENT_FAILURE_CODE_VALUES = Object.values(AgentPaymentFailureCode)

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
  [AgentPaymentPhase.InsufficientFunds]:
    'Pre-flight check determined the delegate balance plus the remaining on-chain allowance cannot cover the requested amount, so no payment was created. The originating Safe must be funded or the agent allowance raised before retrying.',
  [AgentPaymentPhase.FundedButUnsettled]:
    "Haven's funding leg confirmed on-chain but the merchant rejected the x402 retry. The delegate wallet may hold stranded funds. The agent should stop and wait for the wallet owner to sweep the stranded funds back to the Safe.",
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
  [AgentPaymentNextAction.PaymentWindowExpired]:
    'The x402 funding/quote window expired. Re-quote with the same idempotency key before asking the signer to build a merchant payment header again.',
  [AgentPaymentNextAction.FundSafeOrRaiseAllowance]:
    'Stop and tell the user that the originating Safe needs to be funded or the agent allowance raised before the payment can succeed.',
  [AgentPaymentNextAction.SweepStrandedFunds]:
    'Tell the user that funds may be stranded in the delegate wallet and prompt them to initiate a sweep in Haven to return them to the originating Safe.',
}

export const AgentPaymentFailureCodeDescriptions: Record<AgentPaymentFailureCode, string> = {
  [AgentPaymentFailureCode.PriceExceedsMax]:
    "The merchant-authoritative x402 amount exceeds the caller's max_amount cap. No funding transfer was created; ask the user before retrying with a larger cap.",
  [AgentPaymentFailureCode.PaymentWindowExpired]:
    'The x402 funding/quote window expired before the signer or hosted settle step could finish. Re-quote via haven_pay_mcp_tool with the same idempotency key to avoid duplicate funding.',
  [AgentPaymentFailureCode.MerchantRejectedAfterFunding]:
    'The Haven funding leg succeeded, but the merchant rejected the paid retry. Stop retrying the merchant and reconcile stranded delegate funds with haven_sweep_delegate.',
}

export const AgentPaymentRailDescriptions: Record<AgentPaymentRail, string> = {
  [AgentPaymentRail.Direct]: 'Standard Haven payment from the user-controlled Safe through an approved delegate allowance.',
  [AgentPaymentRail.X402]: 'x402 HTTP 402 payment flow with a Haven funding leg and merchant retry leg.',
  [AgentPaymentRail.Mpp]: 'Categorical MPP rail value used as a resume-state discriminator. Response bodies carry a granular mpp_* value instead.',
  [AgentPaymentRail.MppDemo]: 'Haven internal MPP demo rail. Not for production traffic.',
  [AgentPaymentRail.MppCrypto]: 'Crypto-settled MPP rail.',
  [AgentPaymentRail.StripeDeposit]: 'Stripe-deposit-backed MPP rail.',
  [AgentPaymentRail.Spt]: 'Stripe Payment Token MPP rail.',
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

export const AgentPaymentFailureCodeSchema: AgentPaymentEnumSchema = {
  type: 'string',
  enum: AGENT_PAYMENT_FAILURE_CODE_VALUES,
  description: 'Stable machine-readable failure codes for Haven agent payment recovery paths.',
  'x-enumDescriptions': AgentPaymentFailureCodeDescriptions,
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
  x402_expected_auth?: X402ExpectedAuth
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
  payment_intent_id?: string | null
  approval_request_id?: string | null
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
/** One payable service in Haven's curated merchant catalog. */
export interface HavenCatalogEntry {
  id: string
  name: string
  description: string
  category: string
  resourceUrl: string
  rail: 'x402' | 'mpp'
  protocol: 'http' | 'mcp'
  toolName: string | null
  priceDisplay: string | null
  priceAtomic: string | null
  asset: string | null
  network: string | null
  status: 'active' | 'degraded' | 'delisted'
  verifiedAt: string | null
}

/** @internal */
export interface RawCatalogEntry {
  id: string
  name: string
  description: string
  category: string
  resource_url: string
  rail: 'x402' | 'mpp'
  protocol: 'http' | 'mcp'
  tool_name: string | null
  price_display: string | null
  price_atomic: string | null
  asset: string | null
  network: string | null
  status: 'active' | 'degraded' | 'delisted'
  verified_at: string | null
}

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
