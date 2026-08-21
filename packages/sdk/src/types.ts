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
  /** Timeout (ms) for MERCHANT-facing requests — x402/MPP probes, MCP
   *  handshakes, paid retries. Separate from requestTimeout (Haven API):
   *  merchants may settle on-chain synchronously, so the default is
   *  deliberately generous. #1300. */
  merchantTimeout?: number

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

  /**
   * Optional dedupe key (#1207): a retried request with the same key returns
   * the FIRST request's result instead of minting a second transfer or a
   * second approval. Same contract as /machine-payments/send. Max 128 chars.
   */
  idempotencyKey?: string
}

export interface SignData {
  /** The hash to sign (keccak256, 0x-prefixed) */
  hash: string

  /**
   * Delegation rail: 'eip712_userop' (funding redemption) or
   * 'eip712_delegation' (erc7710 settlement child). Absent = legacy
   * AllowanceModule (raw ECDSA over `hash`). The session rail's
   * 'eip191_userop' is retired (#834).
   *
   * When present, `hash` is NOT what gets signed — `typed_data` is (#1138).
   */
  signature_scheme?: 'eip712_userop' | 'eip712_delegation'

  /**
   * EIP-712 payload the account validates, signed VERBATIM (#829). Present
   * whenever `signature_scheme` is — never reconstruct it from `components`.
   */
  typed_data?: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }

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

  /**
   * Platform fee surfaced on the result so it's never silently collected. Dark
   * today (`amount` "0", `applied` false); always present so it's visible the
   * moment fees go live.
   */
  fee?: PaymentFee | null
}

/** The Haven platform fee applied to a payment (#386). */
export interface PaymentFee {
  /** Human-readable fee amount ("0" while the fee module is dark). */
  amount: string
  /** Token the fee is denominated in. */
  token: string
  /** Fee as basis points of gross (0 while dark). */
  basisPoints: number
  /** True when a non-zero fee was actually applied. */
  applied: boolean
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
  /**
   * Merchant-supplied scheme metadata. Two keys are load-bearing for Haven
   * (#1453), both from MetaMask's erc7710 x402 shape:
   *
   *   assetTransferMethod  — 'erc7710' marks this entry as settleable by
   *                          redeeming a delegation chain. Absent/other means
   *                          the standard EIP-3009 authorization.
   *   facilitatorAddresses — who may redeem it, pinned into the settlement
   *                          child's redeemer caveat (#1058).
   *
   * Left as an open record on purpose: the field is the merchant's, and
   * narrowing it to Haven's two keys would silently drop everything else a
   * merchant sends. Read it through `x402AssetTransferMethod` /
   * `x402FacilitatorAddresses` rather than indexing it raw.
   */
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
  /**
   * #1307: the merchant MCP-tool call context this quote was made against
   * (merchant_url, tool_name, arguments, mcp_transport). Persisted on the
   * intent so `getX402MerchantCallContext` can rehydrate it by payment_id at
   * settle/complete time instead of the caller re-threading it. Optional —
   * omit for a non-MCP-tool x402 merchant (plain HTTP resource).
   */
  mcpCallContext?: X402McpCallContext
  /**
   * #1348: the agent's delegate address, when the caller already resolved it
   * from `getAgent()` in this same flow — skips `createX402Intent`'s internal
   * agent fetch (one full round trip on every guided purchase). Staleness
   * caveat (#1358 review): the backend derives the funding shape by comparing
   * `payTo` to the CURRENT delegate address, so a value made stale by a
   * delegate rotation mid-flow is not always a clean failure — a pinned-budget
   * agent gets a 403, but an open-budget delegation agent would route to the
   * settlement shape with the stale address. The window is one tool call
   * (previously sub-millisecond, now the merchant-quote duration), never
   * externally suppliable; server-truth hardening is tracked in #1360. Only
   * pass an address fetched in THIS flow; omit to keep the self-contained
   * fetch.
   */
  delegateAddress?: string
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
  /**
   * #1690: the payer identity Haven bound into the expected context (v3),
   * relayed VERBATIM to the signer's wire shape. Absent until the backend
   * flips X402_EMIT_PAYER_CONTEXT.
   */
  payerDelegate?: string
  payerAgentId?: string
  /**
   * EIP-712 digest of `signData.typed_data`, present on the delegation rail
   * (#1138). The edge signer needs it to reconstruct the v2 expected-context
   * message that Haven signed.
   */
  expectedTypedDataHash?: string
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
  /**
   * EIP-712 digest of the typed data the account actually validates
   * (delegation rail, #1138). Present ⇒ the context is **version 2** and the
   * signer must sign that typed data, never `payloadHash`.
   *
   * On the delegation rail `payloadHash` is the bare ERC-4337 UserOp hash,
   * which is NOT what the account validates — binding it alone would leave the
   * edge signer unable to verify the payload it is being asked to sign. Binding
   * this digest makes Haven's declaration cover the real payload.
   */
  typedDataHash?: string
  /**
   * The DELEGATE ADDRESS this quote was created for (#1690). Present ⇒ the
   * context is **version 3** and the signer refuses to sign when this is not
   * its own delegate — the guard that turns "quote as agent A, sign as agent
   * B" from an on-chain revert three layers later into a named refusal.
   * Inside the Haven-signed message on purpose: outside it, it is forgeable.
   */
  payerDelegate?: string
  /** The paying agent's id, for the refusal message's diagnosis (#1690). */
  payerAgentId?: string
}

export interface X402ExpectedAuth {
  /**
   * 1 = hash-only (legacy rail). 2 = carries `typedDataHash` (delegation rail,
   * #1138).
   *
   * Deliberately `number`, not a literal union (#1143). This is an **inbound**
   * value: a signer parses a context Haven produced, and a signer older than the
   * backend will legitimately receive a version it does not know. A closed union
   * makes that state unrepresentable, which pushed the rejection down to the
   * schema boundary and produced a raw validation error naming neither the cause
   * nor the fix. The supported set lives in the signer
   * (`SUPPORTED_X402_EXPECTED_VERSIONS`), which fails closed on anything outside
   * it with an actionable message.
   */
  version: number
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

/**
 * #1307: the merchant MCP-tool call an x402 quote was made against — carried
 * through `createX402Intent`'s options so Haven can persist it for the
 * settle-leg rehydration handoff (`getX402MerchantCallContext`). Convenience
 * metadata for retrying the merchant's OWN JSON-RPC call, never payment
 * authority.
 */
export interface X402McpCallContext {
  merchantUrl: string
  toolName: string
  arguments?: Record<string, unknown>
  mcpTransport?: X402McpTransport
}

/**
 * Response shape of `getX402MerchantCallContext` — the stored merchant call
 * context for a payment_id, rehydrated instead of re-threaded (#1307).
 */
export interface X402MerchantCallContext {
  paymentId: string
  merchantUrl: string
  toolName: string
  arguments: Record<string, unknown>
  mcpTransport?: X402McpTransport
}

/** @internal */
export interface RawX402MerchantCallContext {
  payment_id: string
  merchant_url: string
  tool_name: string
  arguments?: Record<string, unknown>
  mcp_transport?: { handshake_required: boolean; source: 'path' | 'bazaar' }
  error?: string
  error_code?: string
  status?: string
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
  /**
   * #1351: decimals for `asset` on `network`, resolved from the SAME
   * address→token binding that produced `token` — the quote's own authority on
   * how many atomic units one human unit is. `null` when the merchant's asset
   * is not a token Haven recognises on that network, in which case `token` is
   * an unverified fallback label and NO human→atomic conversion is safe.
   * Consumers converting a human-denominated figure (a user-intent spending
   * cap) MUST fail closed on `null` rather than assume 6.
   */
  decimals: number | null
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

// #1328: MppAuthorizationOptions / MppQuote / MppResumeState / ResumeAuthorizedMppInput
// / ResumeMppPaymentInput / MachinePaymentChallenge / MachinePaymentReceipt were
// the wire types for the retired mpp_demo challenge/quote/resume client surface
// (`quoteMpp` / `payMppChallenge` / `resumeMppPayment` / `authorizeMachinePayment`,
// all removed from client.ts). `MachinePaymentRail` stays — it is still the read-path
// vocabulary for historical payment/evidence/status rows (mpp_demo, mpp_crypto,
// stripe_deposit, spt all remain valid values there).

export type PaymentResumeState = X402ResumeState

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
//
// The wire-shape TYPES for the retired mpp_demo challenge/quote/resume
// client surface (MachinePaymentChallenge, MachinePaymentReceipt,
// MppAuthorizationOptions, ResumeAuthorizedMppInput, ResumeMppPaymentInput)
// were removed with it (#1328). MachinePaymentRail stays: it is still the
// read-path vocabulary on historical payment/evidence/status responses.

export type MachinePaymentRail =
  | 'x402'
  | 'mpp_demo'
  | 'mpp_crypto'
  | 'stripe_deposit'
  | 'spt'

export interface HavenAgent {
  id: string
  name: string
  status: string
  safeAddress: string
  delegateAddress: string
  chainId: number
  /**
   * Which on-chain policy primitive gates this agent's spend (#1306): the
   * legacy Safe AllowanceModule (import-only accounts) or the delegation
   * rail's active budget delegations (#1090). Read-only reporting — the
   * on-chain state is the actual gate either way, this only says which
   * mechanism a caller should read/derive from.
   */
  executionRail: 'legacy' | 'delegation'
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
    /**
     * Delegation rail only (#1319, provenance for #1145's fallback): true
     * when `remaining` came from a live on-chain enforcer read, false when
     * the read failed and `remaining` is the fallback full configured
     * budget. Undefined on the legacy AllowanceModule rail, which has no
     * fallback concept. Reporting only — the on-chain policy remains the
     * actual spend gate either way.
     */
    remainingIsFromChain?: boolean
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
 * Post-purchase allowance/budget summary attached to a settled x402 payment
 * (#1310). Read-only reporting — the on-chain policy remains the actual
 * spend gate either way, this only says what is left after the purchase.
 *
 * Deliberately the SAME rail-labeled field spelling as #1306's
 * catalog-purchase preflight `allowance` block (never a new spelling),
 * minus the preflight-only `sufficient` field: post-purchase reporting
 * answers "what is left", not "was this purchase covered". Read through the
 * exact same source as {@link HavenAllowanceSummary} / `haven_get_allowances`
 * (`GET /machine-payments/allowances`; delegation-rail values are the #1090
 * `deriveDelegationBudgets`-backed enforcer read, never `agent_allowances`),
 * so this can never disagree with `haven_get_allowances` for the same
 * fixture.
 */
export interface PostPurchaseAllowanceSummary {
  /** Which on-chain policy primitive gates this agent's spend (#1306 labeling). */
  rail: 'legacy' | 'delegation'
  /** Remaining atomic units, read through the same source as {@link HavenAllowance.onchain.remaining}. */
  remaining_atomic: string
  /** Human-readable remaining, e.g. "4.96 USDC". Omitted when the token's decimals are unknown. */
  remaining_display?: string
  token_symbol?: string
  token_address?: string
  /** Minutes — mirrors {@link HavenAllowance.resetPeriodMin} / the delegation's period. */
  reset_period?: number
  source: 'allowance_module' | 'active_delegations'
}

/**
 * Affirmative spend-readiness for the authenticated agent, derived from the raw
 * agent status plus the remaining spend authority the backend reports per rail
 * (the on-chain AllowanceModule on the legacy rail; the active budget
 * delegation on the delegation rail — #1135):
 * - `ready`         — active and at least one token has remaining spend authority.
 * - `needs_approval`— active but no remaining spend authority to auto-spend.
 *                     The over-budget outcome differs by rail: on the legacy
 *                     AllowanceModule rail the payment is queued for the wallet
 *                     owner to approve in Haven; on the delegation rail there is
 *                     NO approval queue — an over-budget redemption reverts
 *                     on-chain, so the owner must grant or raise the budget in
 *                     Haven before the agent can pay.
 * - `revoked`       — the agent's status is not `active`; nothing auto-executes.
 *
 * Note: a hard-paused/disabled credential is rejected by the API before this
 * call returns, so it surfaces as an API error rather than `revoked`. `revoked`
 * is reached when the request authenticates but the agent status is non-active.
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
  /**
   * @deprecated Use {@link HavenAgentSummary.spend_authority_readiness} —
   * same value, honest name. This signal covers hosted identity + on-chain
   * spend authority ONLY; it says nothing about the LOCAL signer, which the
   * hosted side cannot see (verify via a signer tool or connect --doctor).
   * Kept as an alias; removal earliest after the next release train (#1590).
   */
  readiness: HavenAgentReadiness
  /**
   * Spend-authority readiness: hosted identity + on-chain remaining spend
   * authority. Deliberately named for what it covers — the LOCAL signer's
   * availability is NOT included and must be verified separately (a signer
   * tool call, or `npx @haven_ai/connect@alpha --doctor`).
   */
  spend_authority_readiness: HavenAgentReadiness
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

/**
 * How long this SDK waits for an on-chain confirmation before it stops
 * waiting (#1756).
 *
 * Lives here rather than in `client.ts` so the payment-confirmation poller
 * and the delegate sweep share ONE number instead of forking it. The SDK's
 * other chain waits are already bounded (`waitForFundingTx` at 30 s), so a
 * fourth independently chosen literal is exactly the drift this constant
 * exists to prevent.
 */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 90_000

/**
 * Whether a sweep transfer was observed to confirm (#1756).
 *
 * The distinction is the point: `unconfirmed` means the transfer was
 * BROADCAST and may still land, which is neither success nor failure. It must
 * never be collapsed into either — reporting a still-pending transaction as
 * done, or as failed, are the same defect in opposite directions.
 */
export type SweepConfirmation =
  /** A receipt was observed. The funds are in the Safe. */
  | 'confirmed'
  /**
   * Broadcast, but no receipt within `DEFAULT_CONFIRMATION_TIMEOUT_MS` (or the
   * node returned no receipt). The transaction is still in the mempool and may
   * mine at any time. `txHash` is the broadcast hash — check it on the
   * explorer before re-running the sweep, and expect a re-run to find nothing
   * stranded if it has since landed.
   */
  | 'unconfirmed'

/** One transferred asset in a delegate sweep. */
export interface SweepEntry {
  /** 'USDC' or 'ETH' */
  asset: string
  /** Human-readable amount swept (e.g. "0.12") */
  amount: string
  /** Atomic amount swept */
  amountAtomic: string
  /**
   * Transaction hash of the sweep transfer.
   *
   * The RECEIPT hash when `confirmation` is `confirmed`; the BROADCAST hash
   * when it is `unconfirmed` — which is the whole reason the sweep returns
   * instead of throwing on a deadline, since this hash is the only thing that
   * lets a user recover the transfer by hand (#1756).
   */
  txHash: string
  /** Block explorer URL for the tx */
  explorerUrl: string
  /**
   * Did this transfer confirm on-chain within the deadline? (#1756)
   *
   * `unconfirmed` entries have MOVED NOTHING YET and may still move. Do not
   * report a sweep as complete without checking this on every entry.
   */
  confirmation: SweepConfirmation
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
  /**
   * True when ANY entry is `unconfirmed` — i.e. the sweep broadcast something
   * it could not confirm within the deadline (#1756).
   *
   * Derived from `transfers`, and present anyway because the consumer most
   * likely to misread this result is an LLM reading the JSON of the
   * `haven_sweep_delegate` tool, which will otherwise see a populated
   * `transfers` array and report the money as recovered.
   */
  unconfirmed: boolean
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
  /** #1307: retry the SAME tool call, supplying the explicit context fields the server could not rehydrate. */
  RetryWithExplicitContext: 'retry_with_explicit_context',
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
  /** #1300 review: funding is on-chain but the merchant never ANSWERED the
   *  paid retry within the timeout. NOT proof of rejection — the merchant
   *  holds a valid EIP-3009 authorization and may still settle late, so the
   *  guidance is verify-then-sweep, never blind sweep. */
  MerchantUnresponsiveAfterFunding: 'MERCHANT_UNRESPONSIVE_AFTER_FUNDING',
  /**
   * #1307: the caller omitted merchant_url/tool_name (asking Haven to
   * rehydrate the stored MCP merchant-call context by payment_id), but no
   * usable context was stored for this intent — either it was never an
   * MCP-tool quote, or the stored context is incomplete. The fallback is
   * mechanical: re-send merchant_url, tool_name, arguments, and
   * mcp_transport explicitly (the version-skew path).
   */
  MerchantCallContextUnavailable: 'MERCHANT_CALL_CONTEXT_UNAVAILABLE',
  /**
   * #1351: the caller supplied BOTH the atomic `max_amount` and the
   * human-denominated `max_amount_human` cap for one purchase. Haven refuses
   * to guess which the user meant — the two differ by a factor of 10^decimals,
   * so picking wrong is exactly the silent-overspend this cap exists to
   * prevent. Rejected before any merchant probe, funding intent, or signature.
   */
  AmbiguousMaxAmount: 'AMBIGUOUS_MAX_AMOUNT',
  /**
   * #1351: a human-denominated cap was supplied, but it cannot be converted to
   * atomic units against THIS quote — either the quote's asset has no known
   * decimals on its network, or the cap carries more fraction digits than the
   * asset can represent (truncating it would silently change the user's cap).
   * The fallback is the exact atomic `max_amount`.
   */
  MaxAmountUnconvertible: 'MAX_AMOUNT_UNCONVERTIBLE',
} as const

export type AgentPaymentFailureCode = (typeof AgentPaymentFailureCode)[keyof typeof AgentPaymentFailureCode]

/**
 * Stable rail identifier carried on Haven agent payment responses and resume
 * state.
 *
 * Two layers of vocabulary share this enum because both reach the wire:
 *
 *   - **Categorical rails** identify the rail family and are used as the
 *     `PaymentResumeState` discriminator: `direct`, `x402` (`mpp` remains a
 *     valid categorical VALUE on historical status reads, but #1328 retired
 *     the `MppResumeState` variant that used to carry it — the mpp_demo
 *     client resume flow no longer exists).
 *   - **Granular rails** identify the specific protocol the backend persists
 *     and returns on response bodies: `mpp_demo`, `mpp_crypto`,
 *     `stripe_deposit`, `spt`. `x402` doubles as both categorical and
 *     granular.
 *
 * Consumers reading the top-level `rail` field on a payment status response
 * should treat any `mpp*` value as the MPP family — this still applies to
 * historical `mpp_demo` rows, which remain readable.
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
  [AgentPaymentNextAction.RetryWithExplicitContext]:
    'Retry the same tool call, this time passing merchant_url, tool_name, arguments, and mcp_transport explicitly — the server had no stored context to rehydrate for this payment id.',
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
  [AgentPaymentFailureCode.MerchantUnresponsiveAfterFunding]:
    'The Haven funding leg succeeded, but the merchant did not answer the paid retry before the timeout. The merchant may still settle late — check haven_get_payment_status (and retry haven_complete_mcp_tool once) BEFORE sweeping; sweep only if no settlement appears.',
  [AgentPaymentFailureCode.MerchantCallContextUnavailable]:
    'merchant_url/tool_name were omitted and no stored merchant call context is available for this payment_id. Re-send merchant_url, tool_name, arguments, and mcp_transport explicitly.',
  [AgentPaymentFailureCode.AmbiguousMaxAmount]:
    'Both max_amount (atomic units) and max_amount_human (whole tokens) were supplied for one purchase. Nothing was contacted and nothing was spent. Re-send with exactly ONE: max_amount_human for a cap the user stated in tokens, max_amount for an exact atomic figure.',
  [AgentPaymentFailureCode.MaxAmountUnconvertible]:
    "max_amount_human could not be converted to atomic units against this quote's asset — either its decimals are unknown to Haven or the cap has more decimal places than the asset supports. Nothing was spent. Round the cap, or re-send it as an exact atomic max_amount.",
}

/**
 * #1308: machine-readable warning codes carried in the `warnings` array on
 * x402 MCP tool responses. Warnings are ADVISORY — they never replace a
 * refusal, and existing failure codes stay authoritative for errors. The
 * legacy `cap_warning` string field is kept for compatibility; the structured
 * entry carries the same message under MISSING_MAX_AMOUNT.
 */
export const AgentPaymentWarningCode = {
  /** No max_amount cap was supplied — the live quoted price was accepted as-is. */
  MissingMaxAmount: 'MISSING_MAX_AMOUNT',
  /** The signing window closes soon; sign promptly or re-quote with the same idempotency key. */
  QuoteExpiresSoon: 'QUOTE_EXPIRES_SOON',
  /** The merchant URL was resolved via discovery — pass the RESOLVED url forward. */
  MerchantUrlDiscovered: 'MERCHANT_URL_DISCOVERED',
  /**
   * #1306: the catalog's last-verified price_atomic differs from the LIVE
   * merchant quote for a guided catalog purchase. The catalog price is only
   * ever indicative; the live quote in the same response is authoritative.
   */
  CatalogPriceDiffers: 'CATALOG_PRICE_DIFFERS',
  /**
   * #1306: the rail-aware allowance/budget pre-check could not be read (RPC
   * failure, etc). `sufficient` is reported as null rather than a fabricated
   * true/false — the on-chain policy remains the actual gate either way.
   */
  AllowanceCheckUnavailable: 'ALLOWANCE_CHECK_UNAVAILABLE',
  /**
   * #1319: the delegation-rail read itself SUCCEEDED, but the remaining
   * figure it returned is the #1145 fallback (the full configured budget)
   * rather than a live ERC20PeriodTransferEnforcer read — `sufficient` is a
   * real true/false, just computed from an optimistic number. Distinct from
   * {@link AgentPaymentWarningCode.AllowanceCheckUnavailable}, which fires
   * when the read failed outright and `sufficient` degrades to null. The
   * on-chain policy re-checks at redemption either way; this only says the
   * guidance shown here may be optimistic.
   */
  AllowanceReadOptimistic: 'ALLOWANCE_READ_OPTIMISTIC',
} as const

export type AgentPaymentWarningCode =
  (typeof AgentPaymentWarningCode)[keyof typeof AgentPaymentWarningCode]

export interface AgentPaymentWarning {
  code: AgentPaymentWarningCode
  message: string
}

/**
 * #1308: the structured next-step contract on x402 MCP tool responses. It
 * EXTENDS the existing taxonomy — `next_action` values come from
 * AgentPaymentNextAction, never a parallel vocabulary. `next_arguments`
 * carries the small, literally-usable arguments; bulky pass-through fields
 * (payment_required) are named in `reason` and taken from the SAME response.
 */
export interface AgentNextStep {
  next_action: AgentPaymentNextAction
  /** Fully-qualified tool name for the next call, when one exists. */
  next_tool?: string
  /** Small literal arguments for next_tool. Bulky fields are referenced by reason. */
  next_arguments?: Record<string, unknown>
  /** False when the agent should stop and involve the user before continuing. */
  safe_to_continue: boolean
  reason: string
}

/**
 * #1349: compact, Haven-generated reporting evidence for a completed x402
 * merchant purchase. `status`, money fields, merchant endpoint/address, and
 * funding transaction come from Haven payment state; `product` and
 * `invoice_id` are optional merchant-supplied display metadata. The raw
 * merchant result remains separate evidence and MUST NOT be used to infer
 * settlement status.
 */
export interface AgentPurchaseSummary {
  /** Set only after Haven has completed the funding and merchant-settlement flow. */
  status: 'settled'
  product: string | null
  amount: string | null
  amount_atomic: string | null
  asset: string | null
  network: string | null
  merchant: {
    address: string | null
    resource_url: string | null
  }
  /** Merchant-supplied identifier, or null when the merchant did not supply one. */
  invoice_id: string | null
  funding_tx_hash: string | null
  /** Optional merchant receipt reference parsed from PAYMENT-RESPONSE; not Haven settlement proof. */
  settlement_tx_hash: string | null
  /** Same read-only allowance block returned at the top level, or null when unavailable. */
  allowance: PostPurchaseAllowanceSummary | null
}

/** #1308: compact reporting summary — what the agent tells the user. */
export interface AgentPaymentSummary {
  payment_id: string
  status: string
  amount?: string
  amount_atomic?: string
  token?: string
  network?: string
  expires_at?: string
  product?: string
  /**
   * Default reporting contract for a successful `haven_settle_mcp_tool` call.
   * The merchant's raw `result` remains available separately as advanced
   * evidence; do not parse it to determine whether a payment settled.
   */
  purchase_summary?: AgentPurchaseSummary
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
  /** Delegate EOA captured on the payment intent when it was created. */
  payerAddress?: string | null
  txHash: string | null
  expiresAt: string
  chainId: number
  message: string
  /** Platform fee surfaced so it's never silently collected (#386). */
  fee?: PaymentFee | null
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
  sign_data?: SignData
  error?: string
}

/** @internal Response of `POST /x402/:id/settle` (erc7710 direct settlement). */
export interface RawX402SettleResponse {
  success?: boolean
  payment_id?: string
  /** The backend-assembled MetaMask erc7710 X-PAYMENT header. */
  payment_header?: string
  status?: string
  error?: string
}

/**
 * Result of an erc7710 direct settlement (#1454).
 *
 * Deliberately NOT an `X402Receipt`. A 3009 receipt describes a completed
 * two-leg payment — funding tx included — whereas here nothing has settled yet
 * when this returns: the merchant redeems the delegation chain when the caller
 * retries with the header. Reusing the receipt type would let a caller read
 * `txHash` as "paid" on a payment that has not moved a cent.
 */
export interface X402Erc7710Settlement {
  paymentId: string
  /** Pass verbatim as the `X-PAYMENT` header on the merchant retry. */
  paymentHeader: string
  /** The merchant address the child delegation is pinned to. */
  merchantPayTo: string
  amountAtomic: string
  asset: string
  network: string
  /** Facilitators the child is redeemable by, when the merchant advertised any. */
  facilitatorAddresses: string[] | null
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
    /** 'eip712_userop' = delegation rail; absent = legacy AllowanceModule (raw ECDSA). The session rail's 'eip191_userop' is retired (#834). */
    signature_scheme?: 'eip712_userop'
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
  fee?: { amount: string; token: string; basis_points: number; applied: boolean } | null
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
  payer_address?: string | null
  tx_hash: string | null
  expires_at: string
  chain_id: number
  message: string
  fee?: { amount: string; token: string; basis_points: number; applied: boolean } | null
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
  execution_rail: string
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
    /** #1319 — see {@link HavenAllowance.onchain.remainingIsFromChain}. */
    remaining_is_from_chain?: boolean
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
  toolArguments: Record<string, unknown> | null
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
  tool_arguments: Record<string, unknown> | null
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

/**
 * #1300: quoteX402 hit a URL that answered something other than 402 — the
 * typed form of "this is not the x402 endpoint". Exists so consumers (the
 * hosted MCP's #1271 discovery trigger) can key on a class instead of
 * message text.
 */
/**
 * #1300: a merchant-facing fetch hit the client-side merchantTimeout. Typed
 * so consumers can distinguish "merchant never answered" from a real HTTP
 * error response — the funded-retry path routes this to verify-then-sweep
 * guidance instead of a bare 504.
 */
export class MerchantTimeoutError extends HavenApiError {
  readonly merchantErrorCode = 'merchant_timeout' as const
  constructor(message: string) {
    super(message, 504)
    this.name = 'MerchantTimeoutError'
  }
}

export class X402UnexpectedStatusError extends HavenApiError {
  readonly x402ErrorCode = 'unexpected_non_402_status' as const
  constructor(message: string, statusCode: number) {
    super(message, statusCode)
    this.name = 'X402UnexpectedStatusError'
  }
}

/**
 * #1521: the idempotency key resolved to a payment that has already settled,
 * and the delegate can no longer fund a fresh authorization for it.
 *
 * This is the typed form of "you already bought this". It exists because the
 * alternative was indefensible: the SDK used to mint a new EIP-3009
 * authorization against the spent delegate and hand it back paired with the
 * ORIGINAL payment's `txHash`, so the caller learned what had happened only
 * from a merchant-side balance error that reads identically to a broken
 * payment rail.
 *
 * `receipt` is the ORIGINAL payment — a real receipt for real settled funds,
 * deliberately carrying no `paymentHeader`, because any header minted here
 * would be exactly the unfundable artifact this error replaces.
 */
export class X402AlreadySettledError extends HavenApiError {
  readonly x402ErrorCode = 'already_settled' as const
  constructor(
    message: string,
    public readonly receipt: X402Receipt,
    /**
     * `settled` — the delegate was checked on-chain and cannot fund a fresh
     * authorization, so this payment demonstrably completed.
     * `unverifiable` — no `chainRpcs` entry for the chain, so fundability
     * could not be established either way. Same refusal, weaker claim; say
     * which, rather than assert what was not checked.
     */
    public readonly basis: 'settled' | 'unverifiable',
  ) {
    super(message, 409, undefined, receipt.paymentId)
    this.name = 'X402AlreadySettledError'
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

/**
 * Refusal codes the local signer returns when it does not recognise the
 * VERSION of a Haven-signed binding it was asked to sign (#1309). Distinct
 * from `AgentPaymentFailureCode`: these describe a **signer capability**
 * problem (this install cannot evaluate what Haven sent), not a payment-domain
 * outcome, and they never reach the backend's REST/OpenAPI surface — only the
 * local signer's own MCP tool responses (`haven_sign` / `haven_sign_x402` /
 * `haven_sign_sweep_delegate`). That is also why this pair does not go through
 * the `AgentPaymentFailureCode` four-gate (sdk → backend mirror → spec →
 * api-types): there is no backend mirror to keep in sync with.
 */
export const SignerRefusalCode = {
  /** `SUPPORTED_X402_EXPECTED_VERSIONS` in `@haven_ai/signer` does not include the received version. */
  UnsupportedExpectedContextVersion: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION',
  /** `SUPPORTED_SWEEP_BINDING_VERSIONS` in `@haven_ai/signer` does not include the received version. */
  UnsupportedSweepBindingVersion: 'UNSUPPORTED_SWEEP_BINDING_VERSION',
} as const

export type SignerRefusalCode = (typeof SignerRefusalCode)[keyof typeof SignerRefusalCode]

/**
 * Canonical recovery guidance for a stale local signer (#1309) — the ONE
 * string both the signer's structured refusal (`fallback` field, carried by
 * `HavenUnsupportedSignerVersionError`) and the hosted quote's advisory
 * `signer_compatibility.fallback` (#1155) render, so an agent that meets
 * either surface is told the identical fix. A second hand-maintained copy of
 * this sentence is exactly how the two surfaces could start disagreeing about
 * what to do.
 */
export const SIGNER_UPDATE_FALLBACK =
  'Update @haven_ai/signer by rerunning `npx @haven_ai/connect@alpha`, which reinstalls the ' +
  'pinned MCP runtime, then retry the same signing call. Nothing was signed or spent — the ' +
  'quote or payment this version came from is unaffected and does not need to be re-quoted.'

/**
 * Thrown by the local signer when a Haven-signed binding (x402 expected
 * context or sweep authorization) carries a version outside what this signer
 * install enforces (#1143, structured as #1309). Machine-readable: `code`,
 * `supportedVersions`, and `receivedVersion` are DERIVED from the signer's own
 * `SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS`
 * constants at the throw site, never a second literal — see
 * `assertSupportedBindingVersion` in `@haven_ai/signer`.
 *
 * This narrows HOW the refusal is reported. It does not weaken it: nothing is
 * signed either way, and the version stays inside the Haven-signed binding
 * message (callers must not "fix" a mismatch by rewriting it).
 */
export class HavenUnsupportedSignerVersionError extends HavenError {
  constructor(
    message: string,
    code: SignerRefusalCode,
    public readonly supportedVersions: readonly number[],
    public readonly receivedVersion: number,
    public readonly fallback: string,
  ) {
    super(message, code)
    this.name = 'HavenUnsupportedSignerVersionError'
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
