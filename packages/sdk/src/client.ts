import { AsyncLocalStorage } from 'node:async_hooks'
import { exact } from 'x402/schemes'
import { privateKeyToAccount } from 'viem/accounts'
import { signHash, addressFromKey, verifySignature } from './signer.js'
import type {
  HavenClientConfig,
  PaymentRequest,
  PaymentIntent,
  PaymentResult,
  PaymentStatus,
  PaymentPhase,
  PaymentNextAction,
  PaymentStatusResult,
  PaymentResumeState,
  SignData,
  SweepResult,
  X402AuthorizationOptions,
  RawCreateResponse,
  RawSignResponse,
  RawStatusResponse,
  RawPaymentStatusResult,
  X402PaymentRequired,
  X402PaymentOption,
  X402Intent,
  X402Quote,
  X402Receipt,
  X402RequestSnapshot,
  X402ResumeState,
  ResumeAuthorizedX402Input,
  ResumeX402PaymentInput,
  MppAuthorizationOptions,
  MppQuote,
  MppResumeState,
  ResumeAuthorizedMppInput,
  ResumeMppPaymentInput,
  RawX402AuthorizeResponse,
  MachinePaymentChallenge,
  MachinePaymentReceipt,
  RawMachinePaymentAuthorizeResponse,
  HavenAgent,
  HavenAllowanceSummary,
  HavenPaymentReceipt,
  RawHavenAgent,
  RawHavenAllowanceSummary,
  RawHavenPaymentReceiptsResponse,
  RawHavenPaymentReceipt,
} from './types.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  HavenApiError,
  HavenPaymentStateError,
  HavenSigningError,
  HavenTimeoutError,
} from './types.js'
import {
  buildX402IdempotencyKey,
  parsePaymentRequiredResponse,
  resolveTokenFromAddress,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
} from './x402.js'
import {
  buildMachinePaymentIdempotencyKey,
  encodeMachinePaymentProof,
  parseMachinePaymentChallengeResponse,
} from './mpp.js'
import { createJsonRpcProvider, createWallet, createErc20Contract } from './provider.js'
import { decodeBase64Json, encodeBase64Json } from './base64.js'

const DEFAULT_BASE_URL = 'http://localhost:3001'

const CHAIN_EXPLORER_TX: Record<number, string> = {
  100:  'https://gnosisscan.io/tx',
  8453: 'https://basescan.org/tx',
}


function buildExplorerUrl(chainId: number | undefined, txHash: string): string {
  const base = CHAIN_EXPLORER_TX[chainId ?? 8453] ?? CHAIN_EXPLORER_TX[8453]
  return `${base}/${txHash}`
}

function explorerUrlOrEmpty(chainId: number | undefined, txHash: string | null | undefined): string {
  return txHash ? buildExplorerUrl(chainId, txHash) : ''
}

const DEFAULT_REQUEST_TIMEOUT = 30_000
const DEFAULT_CONFIRMATION_TIMEOUT = 90_000
const DEFAULT_POLLING_INTERVAL = 3_000

function formatAtomicAmount(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, s.length - decimals) || '0'
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, '') || '0'
  return `${intPart}.${fracPart}`
}

// ── MCP-over-x402 transport (issue #315) ──────────────────────────
// MCP merchants (Soundside, the Coinbase reference) speak the Streamable
// HTTP transport: an `initialize` handshake hands back an `mcp-session-id`
// that must ride on every subsequent request, and responses arrive as SSE.
const MCP_PROTOCOL_VERSION = '2025-06-18'
const MCP_ACCEPT = 'application/json, text/event-stream'
const MCP_CLIENT_INFO = { name: 'haven-sdk', version: '1' }

/** Cap the merchant body persisted to the reconciliation event (the full body is kept on the thrown error). */
const MERCHANT_BODY_SNIPPET_LIMIT = 1000

/** A failed merchant retry response, captured verbatim for debugging and surfaced on the structured error. */
interface CapturedMerchantResponse {
  merchant_status: number
  merchant_status_text: string
  merchant_headers: Record<string, string>
  merchant_body: string
}

const PAYMENT_STATE_STATUS_CODES: Record<string, number> = {
  pending: 202,
  pending_approval: 202,
  approved: 202,
  proposed: 202,
  executed: 200,
  pending_signature: 409,
  submitted: 409,
  expired: 410,
  failed: 502,
  rejected: 409,
}

function chainIdFromNetwork(network: string | undefined): number | undefined {
  if (network === 'base') return 8453
  if (!network?.startsWith('eip155:')) return undefined
  const chainId = Number(network.slice('eip155:'.length))
  return Number.isFinite(chainId) ? chainId : undefined
}

function chainIdOrNull(network: string | undefined): number | null {
  return chainIdFromNetwork(network) ?? null
}

function phaseForStatus(status: string): PaymentPhase | null {
  if (status === 'pending_signature') return AgentPaymentPhase.AgentSignatureRequired
  if (status === 'submitted') return AgentPaymentPhase.PaymentSubmitted
  if (status === 'confirmed') return AgentPaymentPhase.PaymentConfirmed
  if (status === 'pending' || status === 'pending_approval') return AgentPaymentPhase.UserApprovalRequired
  if (status === 'approved') return AgentPaymentPhase.UserExecutionRequired
  if (status === 'proposed') return AgentPaymentPhase.WaitingForAdditionalApprovals
  if (status === 'executed') return AgentPaymentPhase.FundingSent
  if (status === 'rejected') return AgentPaymentPhase.Rejected
  if (status === 'expired') return AgentPaymentPhase.Expired
  if (status === 'failed') return AgentPaymentPhase.Failed
  return null
}

function nextActionForStatus(status: string): PaymentNextAction | null {
  if (status === 'pending_signature') return AgentPaymentNextAction.SignAndSubmitPayment
  if (status === 'submitted') return AgentPaymentNextAction.CheckStatusLater
  if (status === 'confirmed') return AgentPaymentNextAction.None
  if (status === 'pending' || status === 'pending_approval') return AgentPaymentNextAction.WaitForUserApproval
  if (status === 'approved') return AgentPaymentNextAction.WaitForUserToCompletePayment
  if (status === 'proposed') return AgentPaymentNextAction.WaitForUserApproval
  if (status === 'executed') return AgentPaymentNextAction.RetryOriginalX402Request
  if (status === 'rejected') return AgentPaymentNextAction.StopAndTellUser
  if (status === 'expired') return AgentPaymentNextAction.RequestAgainIfUserStillWantsIt
  if (status === 'failed') return AgentPaymentNextAction.StopAndTellUser
  return null
}

function messageForState(
  label: string,
  status: string,
  paymentId: string,
  nextAction: PaymentNextAction,
): string {
  if (status === 'pending' || status === 'pending_approval') {
    return `${label} is above the remaining agent budget and is waiting for user approval in Haven (payment_id: ${paymentId}).`
  }
  if (status === 'executed') {
    return 'The user completed the funding payment. Retry the original x402 request.'
  }
  if (status === 'rejected') {
    return `The user rejected this payment request (payment_id: ${paymentId}).`
  }
  if (status === 'expired') {
    return `This payment request expired (payment_id: ${paymentId}).`
  }
  return `${label} is ${status}; next_action=${nextAction} (payment_id: ${paymentId}).`
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

function isMppRail(rail: string | null | undefined): boolean {
  return rail === 'mpp' || Boolean(rail?.startsWith('mpp_'))
}

function decimalFromUsdcAtomic(value: string): string {
  const amount = BigInt(value)
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value.replace(/^0+(?=\d)/, '') || '0'
  const [whole, fraction = ''] = value.split('.')
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0'
  const normalizedFraction = fraction.replace(/0+$/, '')
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole
}

function parseMerchantSettlement(header: string | null): {
  settlementTxHash?: string | null
} {
  if (!header) return {}
  const parsed = parseProtocolReceiptHeader(header)
  const tx =
    typeof parsed?.transaction === 'string'
      ? parsed.transaction
      : typeof parsed?.txHash === 'string'
        ? parsed.txHash
        : typeof parsed?.tx_hash === 'string'
          ? parsed.tx_hash
          : null
  return { settlementTxHash: tx }
}

/**
 * MCP-over-HTTP merchants expose their endpoint at a path ending in `/mcp`
 * (Soundside, the Coinbase reference — the convention). That path is the
 * primary auto-handshake signal. Trailing slashes and query/hash suffixes
 * are tolerated so `/mcp/`, `/mcp?x=1`, and `/foo/mcp` all match.
 */
function isMcpUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/mcp')
  } catch {
    return /\/mcp(?:[/?#]|$)/.test(url)
  }
}

/**
 * Coinbase Bazaar's published-discovery extension. Its presence in a 402 body
 * marks an MCP-discoverable resource even when the URL doesn't end in `/mcp`,
 * so it is the second auto-handshake signal.
 */
async function responseHasBazaarExtension(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { extensions?: { bazaar?: unknown } } | null
    return body?.extensions?.bazaar != null
  } catch {
    return false
  }
}

/**
 * Parse the `data:` frames of an MCP Streamable-HTTP SSE stream into the
 * JSON-RPC messages they carry. Multiple `data:` lines before a blank line are
 * concatenated into one payload per the SSE spec; non-JSON frames (keep-alives)
 * are skipped.
 */
function parseSseJsonRpcMessages(text: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  let dataLines: string[] = []

  const flush = (): void => {
    if (dataLines.length === 0) return
    try {
      messages.push(JSON.parse(dataLines.join('\n')) as Record<string, unknown>)
    } catch {
      // Ignore keep-alives and non-JSON data frames.
    }
    dataLines = []
  }

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  flush()

  return messages
}

/** Pick the JSON-RPC response (result/error) from a set of SSE messages. */
function selectJsonRpcResult(
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return messages.find((m) => 'result' in m || 'error' in m) ?? messages[messages.length - 1]
}

export class HavenClient {
  private readonly apiKey: string
  private readonly delegateKey: string | undefined
  private readonly baseUrl: string
  private readonly x402Wallet: string | undefined
  private readonly requestTimeout: number
  private readonly confirmationTimeout: number
  private readonly pollingInterval: number
  private readonly chainRpcs: Record<number, string>
  private readonly inFlightX402 = new Map<string, Promise<X402Receipt>>()
  private readonly x402ReceiptCache = new Map<string, { expiresAt: number; receipt: X402Receipt }>()
  private readonly inFlightMachinePayments = new Map<string, Promise<MachinePaymentReceipt>>()
  /**
   * Setup-time headers configured via `HavenClientConfig.defaultHeaders`.
   * Read-only after construction — use `withRequestContext` for per-call
   * scoping so concurrent requests don't race on shared mutable state.
   */
  private readonly defaultHeaders: Record<string, string>
  /**
   * Async-local store for per-request context (currently: extra headers).
   * Each `withRequestContext` invocation produces an isolated store, so
   * overlapping async work — like two MCP tool dispatches in flight at
   * the same time — see their own headers without stepping on each other.
   */
  private readonly requestContext = new AsyncLocalStorage<{ headers: Record<string, string> }>()

  /** Monotonic JSON-RPC id source for the MCP `initialize` handshake. */
  private mcpRequestId = 0

  /** Delegate address derived from the private key (if provided) */
  readonly delegateAddress: string | undefined

  constructor(config: HavenClientConfig) {
    this.apiKey = config.apiKey
    this.delegateKey = config.delegateKey
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.x402Wallet = config.x402Wallet
    this.requestTimeout = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
    this.confirmationTimeout = config.confirmationTimeout ?? DEFAULT_CONFIRMATION_TIMEOUT
    this.pollingInterval = config.pollingInterval ?? DEFAULT_POLLING_INTERVAL
    this.chainRpcs = config.chainRpcs ?? {}
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) }

    if (this.delegateKey) {
      this.delegateAddress = addressFromKey(this.delegateKey)
    }
  }

  /**
   * Run `fn` with extra Haven-API headers scoped to the async work it
   * performs. Used by the MCP server to tag every Haven API request that
   * a single tool dispatch makes with `X-Haven-MCP-Tool: <name>` so the
   * backend can write an audit-log row attributing the call.
   *
   * The headers are held in an `AsyncLocalStorage` so overlapping
   * dispatches do not leak headers into each other's requests. The store
   * inherits across `await` boundaries, so any Haven API call made while
   * `fn` is awaiting will pick up the right headers.
   *
   * Has no effect on outbound merchant requests (x402 / MPP) — those
   * never go through the internal `request<T>` path that reads the
   * context.
   */
  withRequestContext<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    return this.requestContext.run({ headers: { ...headers } }, fn)
  }

  // ── High-Level API ───────────────────────────────────────────────

  /**
   * Send a payment in one call.
   *
   * Creates the intent, signs the hash, submits the signature,
   * and polls until confirmed (or throws on failure/timeout).
   *
   * Requires `delegateKey` to be set in the client config.
   */
  async pay(request: PaymentRequest): Promise<PaymentResult> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'Cannot use pay() without a delegateKey. Use createIntent() + submitSignature() for manual signing.',
      )
    }

    // Step 1: Create intent
    const intent = await this.createIntent(request)

    // Step 2: Sign
    const signature = this.sign(intent.signData.hash)

    // Step 3: Submit
    await this.submitSignature(intent.paymentId, signature)

    // Step 4: Wait for confirmation
    return this.waitForConfirmation(intent.paymentId)
  }

  // ── Step-by-Step API ─────────────────────────────────────────────

  /**
   * Step 1: Create a payment intent.
   *
   * Returns the intent with the hash to sign.
   */
  async createIntent(request: PaymentRequest): Promise<PaymentIntent> {
    const raw = await this.post<RawCreateResponse>('/payments', {
      token: request.token,
      amount: request.amount,
      to: request.to,
    })

    // Haven returns HTTP 202 with this status when the requested amount
    // exceeds the on-chain allowance. The payment is parked for the owner
    // to approve in the dashboard — there's nothing to sign yet, so the SDK
    // surfaces it as an explicit error rather than returning a malformed
    // intent with no signData.
    if (raw.status === 'pending_approval') {
      this.throwPaymentStateError('Payment', raw)
    }

    return {
      paymentId: raw.payment_id,
      status: 'pending_signature',
      expiresAt: raw.expires_at,
      signData: raw.sign_data,
    }
  }

  /**
   * Keyless x402 construct.
   *
   * The non-custodial half of an x402 payment: posts the funding request to
   * `/x402` and returns the unsigned funding hash plus the data the caller
   * needs to build and sign the EIP-3009 merchant header itself. Crucially it
   * does **not** sign — neither the funding hash nor the merchant header — so
   * it works without a `delegateKey`. Both delegate signatures happen on the
   * machine that holds the key (the edge); the hosted MCP server relays only.
   *
   * Use this from the hosted, keyless server. The all-in-one `authorizeX402`
   * remains for local clients that hold the key.
   *
   * Throws (via the shared payment-state path) when the amount exceeds the
   * on-chain allowance — there is nothing to sign until the user approves.
   */
  async createX402Intent(
    paymentRequired: X402PaymentRequired,
    options: X402AuthorizationOptions = {},
  ): Promise<X402Intent> {
    const option = selectStandardPaymentOption(paymentRequired.accepts)
    if (!option) {
      throw new HavenApiError(
        'No compatible payment option found in x402 requirements. ' +
          'Haven supports standard x402 exact payments on Base USDC.',
        400,
      )
    }

    // The funding transfer tops up the agent's delegate EOA. With no local key
    // we resolve that address from the authenticated agent record rather than
    // deriving it from a private key.
    const agent = await this.getAgent()
    const fundingTo = agent.delegateAddress
    if (!fundingTo) {
      throw new HavenApiError('Authenticated agent has no delegate address registered.', 502)
    }

    const idempotencyKey = options.idempotencyKey ?? buildX402IdempotencyKey(paymentRequired, option)
    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: paymentRequired.resource.url,
      payTo: fundingTo,
      merchantPayTo: option.payTo,
      amount: x402AuthorizationAmount(option),
      asset: option.asset,
      network: option.network,
      description: paymentRequired.resource.description,
      idempotencyKey,
    })

    // Anything other than a signable funding intent (pending_approval,
    // expired, already-executed, error) is surfaced through the shared path.
    if (raw.status !== 'pending_signature') {
      this.throwPaymentStateError('x402 payment', raw)
    }
    if (!raw.sign_data?.hash) {
      throw new HavenApiError('No sign_hash returned from x402/authorize', 500, raw)
    }
    if (!raw.x402_expected_auth) {
      throw new HavenApiError('No x402 expected-context binding returned from x402/authorize', 500, raw)
    }

    return {
      paymentId: raw.payment_id,
      status: 'pending_signature',
      expiresAt: raw.expires_at,
      signData: raw.sign_data,
      accepted: option,
      resourceUrl: paymentRequired.resource.url,
      merchantTo: raw.merchant_to ?? option.payTo,
      amountAtomic: x402AuthorizationAmount(option),
      asset: option.asset,
      network: option.network,
      expectedAuth: raw.x402_expected_auth,
      fundingTo,
    }
  }

  /**
   * Step 2: Sign a hash with the delegate key.
   *
   * Returns the 65-byte signature (0x-prefixed).
   * Requires `delegateKey` to be set in the client config.
   */
  sign(hash: string): string {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'Cannot sign without a delegateKey. Pass the private key in HavenClient config, or sign externally.',
      )
    }

    const signature = signHash(this.delegateKey, hash)

    // Verify the signature locally before submitting
    if (!verifySignature(hash, signature, this.delegateAddress!)) {
      throw new HavenSigningError(
        'Local signature verification failed — recovered address does not match delegate key.',
      )
    }

    return signature
  }

  /**
   * Step 3: Submit a signature to execute the payment.
   *
   * The signature can come from `client.sign()` or from external signing.
   */
  async submitSignature(
    paymentId: string,
    signature: string,
  ): Promise<{ status: string; txHash?: string }> {
    const raw = await this.post<RawSignResponse>(
      `/payments/${paymentId}/sign`,
      { signature },
    )

    return {
      status: raw.status,
      txHash: raw.tx_hash,
    }
  }

  /**
   * Get the current status of a payment.
   */
  async getPayment(paymentId: string): Promise<PaymentResult> {
    const raw = await this.get<RawStatusResponse>(`/payments/${paymentId}`)
    return this.mapPaymentResult(raw)
  }

  /**
   * Get agent-actionable status for a payment intent or approval request.
   *
   * Use this for IDs returned by agent tools and machine-payment/x402 flows.
   * `getPayment()` remains available for payment-intent-only integrations.
   */
  async getPaymentStatus(paymentId: string): Promise<PaymentStatusResult> {
    const raw = await this.get<RawPaymentStatusResult>(`/machine-payments/${paymentId}/status`)
    return this.mapPaymentStatusResult(raw)
  }

  /**
   * Get the agent identity tied to this API key.
   */
  async getAgent(): Promise<HavenAgent> {
    const raw = await this.get<RawHavenAgent>('/machine-payments/agent')
    return {
      id: raw.id,
      name: raw.name,
      status: raw.status,
      safeAddress: raw.safe_address,
      delegateAddress: raw.delegate_address,
      chainId: raw.chain_id,
    }
  }

  /**
   * Sweep stranded USDC and ETH from the delegate EOA back to the originating Safe.
   *
   * The delegate key held by this client signs and submits the transfer transactions
   * directly — Haven's backend never handles the key or constructs signed txs
   * (CASP/MiCA Red Line #2). Funds always go to the Safe linked to this agent.
   *
   * Requires `chainRpcs` to be set for the agent's chain in `HavenClientConfig`.
   */
  async sweepDelegate(): Promise<SweepResult> {
    if (!this.delegateKey) {
      throw new HavenSigningError('delegateKey is required for sweepDelegate.')
    }

    const agent = await this.getAgent()
    const { safeAddress, delegateAddress, chainId } = agent

    if (!delegateAddress) {
      throw new HavenApiError('Agent has no delegate address.', 422)
    }

    const rpcUrl = this.chainRpcs[chainId]
    if (!rpcUrl) {
      throw new HavenApiError(
        `chainRpcs[${chainId}] must be configured to sweep the delegate wallet.`,
        422,
      )
    }

    const provider = createJsonRpcProvider(rpcUrl)
    const wallet = createWallet(this.delegateKey, provider)

    const ERC20_TRANSFER_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'] as const

    // USDC contract address indexed by chain ID.
    const USDC_BY_CHAIN: Record<number, string> = {
      8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    }

    const explorerByChain: Record<number, string> = {
      8453: 'https://basescan.org/tx',
      100:  'https://gnosisscan.io/tx',
    }
    const explorerBase = explorerByChain[chainId] ?? 'https://basescan.org/tx'

    const transfers: SweepResult['transfers'] = []

    // ── 1. Sweep ERC-20 USDC ────────────────────────────────────────
    const usdcAddress = USDC_BY_CHAIN[chainId]
    if (usdcAddress) {
      const usdcContract = createErc20Contract(usdcAddress, ERC20_TRANSFER_ABI, wallet)
      const usdcBalance: bigint = await usdcContract.balanceOf(delegateAddress)
      if (usdcBalance > 0n) {
        const tx = await usdcContract.transfer(safeAddress, usdcBalance)
        const receipt = await (tx as { wait: (n: number) => Promise<{ hash: string } | null> }).wait(1)
        const txHash: string = (receipt as { hash: string } | null)?.hash ?? (tx as { hash: string }).hash
        transfers.push({
          asset: 'USDC',
          amount: formatAtomicAmount(usdcBalance, 6),
          amountAtomic: usdcBalance.toString(),
          txHash,
          explorerUrl: `${explorerBase}/${txHash}`,
        })
      }
    }

    // ── 2. Sweep native ETH ─────────────────────────────────────────
    const ethBalance = await provider.getBalance(delegateAddress)
    if (ethBalance > 0n) {
      // Reserve gas for the native transfer itself.
      const gasPrice = (await provider.getFeeData()).gasPrice ?? 1_000_000n
      const gasLimit = 21_000n
      const gasCost = gasPrice * gasLimit
      const ethToSend = ethBalance > gasCost ? ethBalance - gasCost : 0n
      if (ethToSend > 0n) {
        const tx = await wallet.sendTransaction({ to: safeAddress, value: ethToSend })
        const receipt = await tx.wait(1)
        const txHash: string = receipt?.hash ?? tx.hash
        transfers.push({
          asset: 'ETH',
          amount: formatAtomicAmount(ethToSend, 18),
          amountAtomic: ethToSend.toString(),
          txHash,
          explorerUrl: `${explorerBase}/${txHash}`,
        })
      }
    }

    return {
      fromAddress: delegateAddress,
      toAddress: safeAddress,
      chainId,
      transfers,
    }
  }

  /**
   * Get configured and on-chain allowances for the authenticated agent.
   */
  async getAllowances(): Promise<HavenAllowanceSummary> {
    const raw = await this.get<RawHavenAllowanceSummary>('/machine-payments/allowances')
    return {
      agentId: raw.agent_id,
      safeAddress: raw.safe_address,
      delegateAddress: raw.delegate_address,
      chainId: raw.chain_id,
      allowances: raw.allowances.map((allowance) => ({
        id: allowance.id,
        tokenAddress: allowance.token_address,
        tokenSymbol: allowance.token_symbol,
        configuredAmount: allowance.configured_amount,
        resetPeriodMin: allowance.reset_period_min,
        onchain: {
          amount: allowance.onchain.amount,
          spent: allowance.onchain.spent,
          remaining: allowance.onchain.remaining,
          effectiveSpent: allowance.onchain.effective_spent,
          resetTimeMin: allowance.onchain.reset_time_min,
          lastResetMin: allowance.onchain.last_reset_min,
          nonce: allowance.onchain.nonce,
          isResetPending: allowance.onchain.is_reset_pending,
        },
      })),
    }
  }

  /**
   * List recent machine-payment receipts/evidence for bookkeeping.
   */
  async listReceipts(options: { limit?: number } = {}): Promise<HavenPaymentReceipt[]> {
    const query = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : ''
    const raw = await this.get<RawHavenPaymentReceiptsResponse>(`/machine-payments/receipts${query}`)
    return raw.receipts.map((receipt) => this.mapPaymentReceipt(receipt))
  }

  /**
   * Rehydrate the x402/MPP resume-state bundle for a payment id.
   *
   * The server returns stored protocol context only. The client still signs the
   * merchant proof locally when resumeX402Payment() or resumeMppPayment() runs.
   */
  async getResumeState(paymentId: string): Promise<PaymentResumeState> {
    return this.get<PaymentResumeState>(`/payments/${paymentId}/resume_state`)
  }

  /**
   * Poll until a payment reaches a terminal status (confirmed, failed, expired).
   */
  async waitForConfirmation(paymentId: string): Promise<PaymentResult> {
    const deadline = Date.now() + this.confirmationTimeout

    while (Date.now() < deadline) {
      const result = await this.getPayment(paymentId)

      if (result.status === 'confirmed' || result.status === 'failed' || result.status === 'expired') {
        return result
      }

      await sleep(this.pollingInterval)
    }

    throw new HavenTimeoutError(paymentId)
  }

  // ── x402 Protocol Support ────────────────────────────────────────

  /**
   * Authorize an x402 payment.
   *
   * Takes the parsed PaymentRequired from a 402 response, selects a compatible
   * option, funds the delegate wallet through Haven, and returns the standard
   * x402 header that the merchant can verify and settle.
   *
   * Requires `delegateKey` to be set in the client config.
   */
  async authorizeX402(
    paymentRequired: X402PaymentRequired,
    options: X402AuthorizationOptions = {},
  ): Promise<X402Receipt> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for x402 payments. Pass it in the HavenClient config.',
      )
    }
    if (!this.delegateAddress) {
      throw new HavenSigningError('delegateAddress could not be derived from delegateKey.')
    }

    // 1. Select best payment option
    const option = selectStandardPaymentOption(paymentRequired.accepts)
    if (!option) {
      throw new HavenApiError(
        'No compatible payment option found in x402 requirements. ' +
        'Haven supports standard x402 exact payments on Base USDC.',
        400,
      )
    }

    const idempotencyKey = options.idempotencyKey ?? buildX402IdempotencyKey(paymentRequired, option)
    const cached = this.x402ReceiptCache.get(idempotencyKey)
    if (cached && cached.expiresAt > Date.now()) return cached.receipt

    const inFlight = this.inFlightX402.get(idempotencyKey)
    if (inFlight) return inFlight

    const promise = this.authorizeStandardX402(paymentRequired, option, idempotencyKey)
    this.inFlightX402.set(idempotencyKey, promise)

    try {
      return await promise
    } catch (err) {
      this.attachResumeState(err, {
        rail: 'x402',
        paymentRequired,
        accepted: option,
        idempotencyKey,
      })
      throw err
    } finally {
      this.inFlightX402.delete(idempotencyKey)
    }
  }

  /**
   * Probe a paid endpoint and return its x402 quote without creating a Haven
   * payment or approval request.
   */
  async quoteX402(
    url: string,
    init?: RequestInit,
    options: X402AuthorizationOptions = {},
  ): Promise<X402Quote> {
    const initialInit = this.withX402Wallet(init, this.x402PayerAddress())
    const request = this.snapshotX402Request(url, initialInit)
    const response = await globalThis.fetch(url, initialInit)

    if (response.status !== 402) {
      throw new HavenApiError(
        `Expected an x402 quote response with HTTP 402, got HTTP ${response.status}.`,
        response.status || 400,
      )
    }

    if (response.headers.get('MACHINE-PAYMENT-CHALLENGE')) {
      throw new HavenApiError('quoteX402 only supports standard x402 Payment Required responses.', 400)
    }

    const paymentRequired = await parsePaymentRequiredResponse(response)
    return this.buildX402Quote(paymentRequired, request, options.idempotencyKey)
  }

  /**
   * Pay a previously inspected x402 quote and retry the exact captured request.
   */
  async payX402Quote(
    quote: X402Quote,
    options: X402AuthorizationOptions = {},
  ): Promise<Response> {
    const idempotencyKey = options.idempotencyKey ?? quote.idempotencyKey

    try {
      const receipt = await this.authorizeX402(quote.paymentRequired, { idempotencyKey })
      return this.retryX402Request(
        quote.request.url,
        this.requestInitFromSnapshot(quote.request),
        quote.paymentRequired,
        receipt,
      )
    } catch (err) {
      this.attachResumeState(err, {
        rail: 'x402',
        paymentRequired: quote.paymentRequired,
        accepted: quote.accepted,
        idempotencyKey,
        request: quote.request,
      })
      throw err
    }
  }

  private async authorizeStandardX402(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    idempotencyKey: string,
  ): Promise<X402Receipt> {
    // 2. Standard x402 settles from an EOA, so the SDK uses the agent-owned
    // delegate EOA for the merchant-facing EIP-3009 authorization. Haven does
    // not control this EOA or its private key.
    //
    // The only automated funding path is a separate Safe AllowanceModule
    // transfer signed by the agent key and constrained by the user's on-chain
    // allowance. Haven's backend relays that signed top-up; it is not the source
    // of payment authority.
    // Sign before funding so retries reuse one EIP-3009 nonce. If funding fails,
    // the unused authorization simply expires via validBefore.
    const paymentHeader = await this.createStandardX402Header(paymentRequired, option)
    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: paymentRequired.resource.url,
      payTo: this.delegateAddress,
      merchantPayTo: option.payTo,
      amount: x402AuthorizationAmount(option),
      asset: option.asset,
      network: option.network,
      description: paymentRequired.resource.description,
      idempotencyKey,
    })

    // If the backend already executed (shouldn't happen without sig), return
    if (raw.success && raw.tx_hash) {
      const receipt = this.mapX402ReceiptFromAuthorization(paymentRequired, option, paymentHeader, raw)
      this.cacheX402Receipt(idempotencyKey, paymentHeader, receipt)
      return receipt
    }

    const state = this.paymentStateFromRaw('x402 payment', raw)
    if (state?.nextAction === AgentPaymentNextAction.RetryOriginalX402Request) {
      const receipt = this.mapX402ReceiptFromStatus(paymentRequired, option, paymentHeader, state)
      this.cacheX402Receipt(idempotencyKey, paymentHeader, receipt)
      return receipt
    }

    this.throwIfNonSignableAuthorizationState('x402 payment', raw)

    // 3. Sign the hash
    if (!raw.sign_data?.hash) {
      throw new HavenApiError('No sign_hash returned from x402/authorize', 500, raw)
    }
    const sig = signHash(this.delegateKey!, raw.sign_data.hash)

    // 4. Submit signature (reuse existing payments/:id/sign endpoint)
    const execResult = await this.post<RawSignResponse>(
      `/payments/${raw.payment_id}/sign`,
      { signature: sig },
    )

    if (execResult.status !== 'confirmed') {
      this.throwPaymentStateError('x402 payment', execResult)
    }

    // Wait for ≥1 on-chain confirmation before retrying the merchant so the
    // merchant's balanceOf(delegate) check sees the funded balance.
    await this.waitForFundingTx(
      execResult.tx_hash,
      execResult.chain_id ?? chainIdFromNetwork(option.network),
    )

    const receipt = this.mapX402ReceiptFromAuthorization(paymentRequired, option, paymentHeader, raw, execResult)
    this.cacheX402Receipt(idempotencyKey, paymentHeader, receipt)
    return receipt
  }

  async resumeAuthorizedX402(input: ResumeAuthorizedX402Input): Promise<X402Receipt> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for x402 payments. Pass it in the HavenClient config.',
      )
    }
    if (!this.delegateAddress) {
      throw new HavenSigningError('delegateAddress could not be derived from delegateKey.')
    }

    const option = selectStandardPaymentOption(input.paymentRequired.accepts)
    if (!option) {
      throw new HavenApiError(
        'No compatible payment option found in x402 requirements. ' +
        'Haven supports standard x402 exact payments on Base USDC.',
        400,
      )
    }

    const idempotencyKey = input.idempotencyKey ?? buildX402IdempotencyKey(input.paymentRequired, option)
    const cached = this.x402ReceiptCache.get(idempotencyKey)
    if (cached && cached.expiresAt > Date.now()) return cached.receipt

    const status = await this.getPaymentStatus(input.paymentId)
    this.assertCanResumeX402(status, input.paymentRequired, option)

    const paymentHeader = await this.createStandardX402Header(input.paymentRequired, option)
    const receipt = this.mapX402ReceiptFromStatus(input.paymentRequired, option, paymentHeader, status)
    this.cacheX402Receipt(idempotencyKey, paymentHeader, receipt)
    return receipt
  }

  async resumeX402Payment(input: ResumeX402PaymentInput | X402ResumeState): Promise<Response> {
    const inputInit = 'init' in input ? input.init : undefined
    const initialInit = this.withX402Wallet(
      inputInit ?? (input.request ? this.requestInitFromSnapshot(input.request) : undefined),
      this.x402PayerAddress(),
    )
    let paymentRequired = input.paymentRequired
    const url = input.url ?? input.request?.url

    if (!paymentRequired) {
      if (!url) {
        throw new HavenApiError('x402 resume requires the original URL or a captured request snapshot.', 400)
      }
      const response = await globalThis.fetch(url, initialInit)
      if (response.status !== 402) {
        throw new HavenApiError('Expected the original x402 request to return HTTP 402 before resuming.', 400)
      }
      paymentRequired = await parsePaymentRequiredResponse(response)
    }

    const receipt = await this.resumeAuthorizedX402({
      paymentId: input.paymentId,
      paymentRequired,
      idempotencyKey: input.idempotencyKey,
    })

    return this.retryX402Request(url ?? paymentRequired.resource.url, initialInit, paymentRequired, receipt)
  }

  /**
   * Fetch wrapper that automatically handles HTTP 402 responses.
   *
   * Works like the standard `fetch()` but intercepts 402 responses,
   * pays via x402 through Haven, and retries the request.
   *
   * ```ts
   * const response = await haven.fetch('https://paid-api.com/data')
   * const data = await response.json()
   * ```
   *
   * **MCP-over-x402 auto-handshake (issue #315):** when the endpoint is
   * MCP-shaped — the URL path ends in `/mcp`, or the 402 body carries a
   * Coinbase Bazaar `extensions.bazaar` block — the SDK runs the MCP
   * `initialize` handshake, threads the resulting `mcp-session-id`,
   * `Accept: application/json, text/event-stream`, and `x402-wallet` headers
   * through every request, and collapses SSE responses to the JSON-RPC
   * `result`. The caller just passes `(url, { body })` and never sees the
   * protocol plumbing. A non-MCP server (handshake error / no session id)
   * falls back to standard x402 behaviour.
   *
   * Requires `delegateKey` to be set in the client config.
   */
  async fetch(
    url: string,
    init?: RequestInit,
    options: X402AuthorizationOptions = {},
  ): Promise<Response> {
    // Signal A: a `/mcp` path is the MCP-over-HTTP convention, so handshake
    // up front — before the probe — so the session id rides on the probe and
    // the retry alike. A non-MCP server yields `undefined` and we fall back.
    let mcpSessionId: string | undefined
    if (isMcpUrl(url)) {
      mcpSessionId = await this.mcpInitialize(url, init)
    }

    let requestInit = this.withX402Wallet(init, this.x402PayerAddress())
    if (mcpSessionId) requestInit = this.withMcpHeaders(requestInit, mcpSessionId)

    // 1. Make the original request
    const response = await globalThis.fetch(url, requestInit)

    // 2. Not a 402 — return as-is (collapsing SSE for MCP sessions)
    if (response.status !== 402) {
      return mcpSessionId ? this.surfaceMcpResult(response) : response
    }

    const machineChallengeHeader = response.headers.get('MACHINE-PAYMENT-CHALLENGE')
    if (machineChallengeHeader) {
      const challenge = await parseMachinePaymentChallengeResponse(response)
      return this.fetchWithMachinePayment(url, requestInit, challenge)
    }

    // 3. Parse x402 payment requirements
    let paymentRequired: X402PaymentRequired
    try {
      paymentRequired = await parsePaymentRequiredResponse(response)
    } catch {
      let challenge: MachinePaymentChallenge
      try {
        challenge = await parseMachinePaymentChallengeResponse(response)
      } catch {
        // Not a Haven machine-payment 402 — return original response
        return response
      }
      return this.fetchWithMachinePayment(url, requestInit, challenge)
    }

    // Signal B: a Bazaar `extensions.bazaar` block marks an MCP-discoverable
    // resource even without the `/mcp` convention. Handshake now (if we
    // haven't already) so the paid retry carries the session id.
    if (!mcpSessionId && (await responseHasBazaarExtension(response))) {
      mcpSessionId = await this.mcpInitialize(url, init)
      if (mcpSessionId) requestInit = this.withMcpHeaders(requestInit, mcpSessionId)
    }

    // 4. Pay through Haven
    const request = this.snapshotX402Request(url, requestInit)
    const option = selectStandardPaymentOption(paymentRequired.accepts)
    const idempotencyKey = options.idempotencyKey ?? (option ? buildX402IdempotencyKey(paymentRequired, option) : undefined)
    let receipt: X402Receipt
    try {
      receipt = await this.authorizeX402(paymentRequired, options)
    } catch (err) {
      if (option && idempotencyKey) {
        this.attachResumeState(err, {
          rail: 'x402',
          paymentRequired,
          accepted: option,
          idempotencyKey,
          request,
        })
      }
      throw err
    }
    const retryResponse = await this.retryX402Request(url, requestInit, paymentRequired, receipt)
    return mcpSessionId ? this.surfaceMcpResult(retryResponse) : retryResponse
  }

  // ── MCP-over-x402 transport helpers (issue #315) ─────────────────

  /**
   * Run the MCP `initialize` handshake against a Streamable-HTTP endpoint and
   * return the `mcp-session-id` the server assigns.
   *
   * Returns `undefined` whenever the endpoint is not actually an MCP server —
   * a transport/HTTP error, a missing session id, or a JSON-RPC error in the
   * handshake response — so the caller can fall back to plain x402.
   */
  private async mcpInitialize(url: string, init?: RequestInit): Promise<string | undefined> {
    try {
      const headers = new Headers(init?.headers)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', MCP_ACCEPT)
      const wallet = this.x402PayerAddress()
      if (wallet && !headers.has('x402-wallet')) headers.set('x402-wallet', wallet)

      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.mcpRequestId,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO,
          },
        }),
      })

      if (!response.ok) return undefined

      const sessionId = response.headers.get('mcp-session-id')
      if (!sessionId) return undefined

      // A JSON-RPC error means the server spoke MCP but rejected the
      // handshake — treat it as non-MCP and fall back to standard x402.
      const message = await this.readMcpMessage(response)
      if (message && 'error' in message) return undefined

      // Per the MCP lifecycle, the client confirms initialization with a
      // `notifications/initialized` notification. Servers that gate tool
      // calls on it would otherwise reject every subsequent request.
      await this.mcpNotifyInitialized(url, init, sessionId)

      return sessionId
    } catch {
      return undefined
    }
  }

  /**
   * Send the MCP `notifications/initialized` notification that completes the
   * lifecycle handshake. Best-effort: the session is already established, so a
   * failed notification must not abort the payment.
   */
  private async mcpNotifyInitialized(
    url: string,
    init: RequestInit | undefined,
    sessionId: string,
  ): Promise<void> {
    try {
      const headers = new Headers(init?.headers)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', MCP_ACCEPT)
      headers.set('mcp-session-id', sessionId)
      const wallet = this.x402PayerAddress()
      if (wallet && !headers.has('x402-wallet')) headers.set('x402-wallet', wallet)

      await globalThis.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      })
    } catch {
      // Best-effort — see doc comment.
    }
  }

  /** Read a single JSON-RPC message from an MCP response (JSON or SSE body). */
  private async readMcpMessage(response: Response): Promise<Record<string, unknown> | undefined> {
    let text: string
    try {
      text = await response.clone().text()
    } catch {
      return undefined
    }

    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return selectJsonRpcResult(parseSseJsonRpcMessages(text))
    }

    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /** Add the MCP transport headers (session id + SSE Accept) to a request. */
  private withMcpHeaders(init: RequestInit | undefined, sessionId: string): RequestInit {
    const headers = new Headers(init?.headers)
    headers.set('mcp-session-id', sessionId)
    headers.set('Accept', MCP_ACCEPT)
    return { ...init, headers }
  }

  /**
   * Collapse an MCP SSE response into a plain JSON response carrying the
   * JSON-RPC `result`, so callers of `fetch()` never see raw SSE framing.
   * Non-SSE responses pass through untouched.
   */
  private async surfaceMcpResult(response: Response): Promise<Response> {
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return response
    }

    let text: string
    try {
      text = await response.clone().text()
    } catch {
      return response
    }

    const message = selectJsonRpcResult(parseSseJsonRpcMessages(text))
    if (!message) return response

    const body = 'result' in message ? message.result : message
    const headers = new Headers(response.headers)
    headers.set('content-type', 'application/json')
    headers.delete('content-length')
    // Don't leak the transport session id back to the caller — the whole
    // point of the auto-handshake is that the agent never sees MCP plumbing.
    headers.delete('mcp-session-id')

    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  /**
   * Probe a paid MPP endpoint or inspect an existing challenge without creating
   * a Haven payment or approval request.
   */
  async quoteMpp(
    challengeOrUrl: MachinePaymentChallenge | string,
    init?: RequestInit,
    options: MppAuthorizationOptions = {},
  ): Promise<MppQuote> {
    if (typeof challengeOrUrl !== 'string') {
      const request = this.snapshotX402Request(challengeOrUrl.resource, init)
      return this.buildMppQuote(challengeOrUrl, request, options.idempotencyKey)
    }

    const request = this.snapshotX402Request(challengeOrUrl, init)
    const response = await globalThis.fetch(challengeOrUrl, init)

    if (response.status !== 402) {
      throw new HavenApiError(
        `Expected an MPP quote response with HTTP 402, got HTTP ${response.status}.`,
        response.status || 400,
      )
    }

    const challenge = await parseMachinePaymentChallengeResponse(response)
    return this.buildMppQuote(challenge, request, options.idempotencyKey)
  }

  /**
   * Pay a previously inspected MPP quote and retry the exact captured request.
   */
  async payMppChallenge(
    quote: MppQuote,
    options: MppAuthorizationOptions = {},
  ): Promise<Response> {
    const idempotencyKey = options.idempotencyKey ?? quote.idempotencyKey

    try {
      const receipt = await this.authorizeMachinePayment(quote.challenge, { idempotencyKey })
      return this.retryMppRequest(
        quote.request.url,
        this.requestInitFromSnapshot(quote.request),
        quote.challenge,
        receipt,
      )
    } catch (err) {
      this.attachResumeState(err, {
        rail: 'mpp',
        challenge: quote.challenge,
        idempotencyKey,
        request: quote.request,
      })
      throw err
    }
  }

  private async retryX402Request(
    url: string,
    initialInit: RequestInit | undefined,
    paymentRequired: X402PaymentRequired,
    receipt: X402Receipt,
  ): Promise<Response> {
    if (!receipt.accepted) {
      throw new HavenApiError('No accepted x402 option was recorded for payment retry', 500)
    }
    if (!receipt.paymentHeader) {
      throw new HavenApiError('No x402 payment header was returned for payment retry', 500)
    }

    // 5. Retry with a merchant-verifiable x402 EIP-3009 payment header.
    const retryHeaders = new Headers(initialInit?.headers)
    retryHeaders.set('X-PAYMENT', receipt.paymentHeader)

    const retryResponse = await globalThis.fetch(url, {
      ...initialInit,
      headers: retryHeaders,
    })

    if (!retryResponse.ok) {
      const merchant = await captureMerchantResponse(retryResponse)
      await this.recordMerchantRetryRejected({
        rail: 'x402',
        paymentId: receipt.paymentId,
        txHash: receipt.txHash,
        resourceUrl: receipt.resourceUrl,
        merchant,
        details: {
          merchant_to: receipt.merchantTo,
          delegate_to: receipt.to,
        },
      })

      throw new HavenApiError(
        'x402 retry failed after Haven funded the delegate wallet; reconciliation may be required.',
        merchant.merchant_status,
        {
          marker: 'x402_retry_rejected_after_funding',
          payment_id: receipt.paymentId,
          tx_hash: receipt.txHash,
          resource_url: receipt.resourceUrl,
          merchant_to: receipt.merchantTo,
          delegate_to: receipt.to,
          ...merchant,
        },
      )
    }

    const merchantSettlement = parseMerchantSettlement(retryResponse.headers.get('PAYMENT-RESPONSE'))
    if (receipt.merchant && merchantSettlement.settlementTxHash) {
      receipt.merchant.settlementTxHash = merchantSettlement.settlementTxHash
      receipt.merchant.settlementExplorerUrl = buildExplorerUrl(
        receipt.chainId,
        merchantSettlement.settlementTxHash,
      )
    }

    await this.reportMachinePaymentEvidence({
      paymentId: receipt.paymentId,
      rail: 'x402',
      txHash: receipt.txHash,
      resourceUrl: receipt.resourceUrl,
      merchantStatus: retryResponse.status,
      challengePayload: paymentRequired as unknown as Record<string, unknown>,
      selectedPayment: receipt.accepted as unknown as Record<string, unknown>,
      paymentProofHeaderName: 'X-PAYMENT',
      paymentProofHeader: receipt.paymentHeader,
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
      protocolReceiptHeader: retryResponse.headers.get('PAYMENT-RESPONSE') ?? undefined,
    })

    return retryResponse
  }

  async authorizeMachinePayment(
    challenge: MachinePaymentChallenge,
    options: MppAuthorizationOptions = {},
  ): Promise<MachinePaymentReceipt> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for machine payments. Pass it in the HavenClient config.',
      )
    }

    if (challenge.rail !== 'mpp_demo') {
      throw new HavenApiError(`Unsupported machine payment rail: ${challenge.rail}`, 400)
    }

    const idempotencyKey = options.idempotencyKey ?? buildMachinePaymentIdempotencyKey(challenge)
    const inFlight = this.inFlightMachinePayments.get(idempotencyKey)
    if (inFlight) return inFlight

    const promise = this.authorizeMppDemoPayment(challenge, idempotencyKey)
    this.inFlightMachinePayments.set(idempotencyKey, promise)

    try {
      return await promise
    } catch (err) {
      this.attachResumeState(err, {
        rail: 'mpp',
        challenge,
        idempotencyKey,
      })
      throw err
    } finally {
      this.inFlightMachinePayments.delete(idempotencyKey)
    }
  }

  private async authorizeMppDemoPayment(
    challenge: MachinePaymentChallenge,
    idempotencyKey: string,
  ): Promise<MachinePaymentReceipt> {
    const raw = await this.post<RawMachinePaymentAuthorizeResponse>(
      '/machine-payments/authorize',
      { challenge, idempotencyKey },
    )

    if (raw.success && raw.tx_hash) {
      return this.mapMachinePaymentReceipt(challenge, raw, raw.tx_hash)
    }

    this.throwIfNonSignableAuthorizationState('Machine payment', raw)

    if (!raw.sign_data?.hash) {
      throw new HavenApiError('No sign_hash returned from machine payment authorization', 500, raw)
    }

    const sig = signHash(this.delegateKey!, raw.sign_data.hash)
    const execResult = await this.post<RawSignResponse>(
      `/payments/${raw.payment_id}/sign`,
      { signature: sig },
    )

    if (execResult.status !== 'confirmed' || !execResult.tx_hash) {
      this.throwPaymentStateError('Machine payment', execResult)
    }

    return this.mapMachinePaymentReceipt(challenge, raw, execResult.tx_hash, execResult)
  }

  async resumeAuthorizedMpp(input: ResumeAuthorizedMppInput): Promise<MachinePaymentReceipt> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for machine payments. Pass it in the HavenClient config.',
      )
    }

    const status = await this.getPaymentStatus(input.paymentId)
    this.assertCanResumeMpp(status, input.challenge)

    return this.mapMachinePaymentReceiptFromStatus(input.challenge, status)
  }

  async resumeMppPayment(input: ResumeMppPaymentInput | MppResumeState): Promise<Response> {
    const inputInit = 'init' in input ? input.init : undefined
    const initialInit = inputInit ?? (input.request ? this.requestInitFromSnapshot(input.request) : undefined)
    let challenge = input.challenge
    const url = input.url ?? input.request?.url

    if (!challenge) {
      if (!url) {
        throw new HavenApiError('MPP resume requires the original URL or a captured request snapshot.', 400)
      }
      const response = await globalThis.fetch(url, initialInit)
      if (response.status !== 402) {
        throw new HavenApiError('Expected the original MPP request to return HTTP 402 before resuming.', 400)
      }
      challenge = await parseMachinePaymentChallengeResponse(response)
    }

    const receipt = await this.resumeAuthorizedMpp({
      paymentId: input.paymentId,
      challenge,
      idempotencyKey: input.idempotencyKey,
    })

    return this.retryMppRequest(url ?? challenge.resource, initialInit, challenge, receipt)
  }

  private async fetchWithMachinePayment(
    url: string,
    initialInit: RequestInit | undefined,
    challenge: MachinePaymentChallenge,
  ): Promise<Response> {
    const request = this.snapshotX402Request(url, initialInit)
    const idempotencyKey = buildMachinePaymentIdempotencyKey(challenge)
    let receipt: MachinePaymentReceipt
    try {
      receipt = await this.authorizeMachinePayment(challenge, { idempotencyKey })
    } catch (err) {
      this.attachResumeState(err, {
        rail: 'mpp',
        challenge,
        idempotencyKey,
        request,
      })
      throw err
    }

    return this.retryMppRequest(url, initialInit, challenge, receipt)
  }

  private async retryMppRequest(
    url: string,
    initialInit: RequestInit | undefined,
    challenge: MachinePaymentChallenge,
    receipt: MachinePaymentReceipt,
  ): Promise<Response> {
    const retryHeaders = new Headers(initialInit?.headers)
    retryHeaders.set('MACHINE-PAYMENT-PROOF', receipt.proofHeader)

    const retryResponse = await globalThis.fetch(url, {
      ...initialInit,
      headers: retryHeaders,
    })

    if (!retryResponse.ok) {
      const merchant = await captureMerchantResponse(retryResponse)
      await this.recordMerchantRetryRejected({
        rail: receipt.rail,
        paymentId: receipt.paymentId,
        txHash: receipt.txHash,
        resourceUrl: receipt.resourceUrl,
        merchant,
        details: {
          challenge_id: receipt.challengeId,
        },
      })

      throw new HavenApiError(
        'Machine payment retry failed after Haven sent the payment.',
        merchant.merchant_status,
        {
          marker: 'machine_payment_retry_rejected_after_payment',
          payment_id: receipt.paymentId,
          tx_hash: receipt.txHash,
          resource_url: receipt.resourceUrl,
          rail: receipt.rail,
          ...merchant,
        },
      )
    }

    await this.reportMachinePaymentEvidence({
      paymentId: receipt.paymentId,
      rail: receipt.rail,
      txHash: receipt.txHash,
      resourceUrl: receipt.resourceUrl,
      merchantStatus: retryResponse.status,
      challengePayload: challenge as unknown as Record<string, unknown>,
      paymentProofHeaderName: 'MACHINE-PAYMENT-PROOF',
      paymentProofHeader: receipt.proofHeader,
      protocolReceiptHeaderName:
        retryResponse.headers.has('Payment-Receipt')
          ? 'Payment-Receipt'
          : retryResponse.headers.has('MACHINE-PAYMENT-RESPONSE')
            ? 'MACHINE-PAYMENT-RESPONSE'
            : undefined,
      protocolReceiptHeader:
        retryResponse.headers.get('Payment-Receipt') ??
        retryResponse.headers.get('MACHINE-PAYMENT-RESPONSE') ??
        undefined,
    })

    return retryResponse
  }

  private assertCanResumeX402(
    status: PaymentStatusResult,
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
  ): void {
    if (status.rail !== 'x402') {
      throw new HavenPaymentStateError(
        `Payment ${status.paymentId} is ${status.rail}, not x402.`,
        409,
        status,
      )
    }

    if (status.nextAction !== AgentPaymentNextAction.RetryOriginalX402Request) {
      throw new HavenPaymentStateError(status.message, PAYMENT_STATE_STATUS_CODES[status.status] ?? 409, status)
    }

    if (!status.txHash) {
      throw new HavenApiError(
        `x402 payment ${status.paymentId} is ready to retry but has no Haven transaction hash.`,
        502,
        status,
        status.paymentId,
      )
    }

    if (status.resourceUrl && status.resourceUrl !== paymentRequired.resource.url) {
      throw new HavenApiError(
        'x402 resume request does not match the approved resource URL.',
        409,
        { status, paymentRequired },
        status.paymentId,
      )
    }

    if (status.merchantAddress && !sameAddress(status.merchantAddress, option.payTo)) {
      throw new HavenApiError(
        'x402 resume request does not match the approved merchant.',
        409,
        { status, selectedPayment: option },
        status.paymentId,
      )
    }

    const optionChainId = chainIdFromNetwork(option.network)
    if (status.chainId && optionChainId && status.chainId !== optionChainId) {
      throw new HavenApiError(
        'x402 resume request does not match the approved network.',
        409,
        { status, selectedPayment: option },
        status.paymentId,
      )
    }

    if (status.token && status.token !== 'USDC') {
      throw new HavenApiError(
        'x402 resume request does not match the approved token.',
        409,
        { status, selectedPayment: option },
        status.paymentId,
      )
    }

    const approvedAmount = status.amount ? normalizeDecimal(status.amount) : ''
    const requestedAmount = normalizeDecimal(decimalFromUsdcAtomic(x402AuthorizationAmount(option)))
    if (approvedAmount && approvedAmount !== requestedAmount) {
      throw new HavenApiError(
        'x402 resume request does not match the approved amount.',
        409,
        { status, selectedPayment: option },
        status.paymentId,
      )
    }
  }

  private assertCanResumeMpp(
    status: PaymentStatusResult,
    challenge: MachinePaymentChallenge,
  ): void {
    if (!isMppRail(status.rail)) {
      throw new HavenPaymentStateError(
        `Payment ${status.paymentId} is ${status.rail}, not MPP.`,
        409,
        status,
      )
    }

    if (status.nextAction !== AgentPaymentNextAction.RetryOriginalX402Request) {
      throw new HavenPaymentStateError(status.message, PAYMENT_STATE_STATUS_CODES[status.status] ?? 409, status)
    }

    if (!status.txHash) {
      throw new HavenApiError(
        `MPP payment ${status.paymentId} is ready to retry but has no Haven transaction hash.`,
        502,
        status,
        status.paymentId,
      )
    }

    if (status.resourceUrl && status.resourceUrl !== challenge.resource) {
      throw new HavenApiError(
        'MPP resume request does not match the approved resource URL.',
        409,
        { status, challenge },
        status.paymentId,
      )
    }

    if (status.merchantAddress && !sameAddress(status.merchantAddress, challenge.recipient)) {
      throw new HavenApiError(
        'MPP resume request does not match the approved merchant.',
        409,
        { status, challenge },
        status.paymentId,
      )
    }

    if (status.chainId && status.chainId !== challenge.network.chainId) {
      throw new HavenApiError(
        'MPP resume request does not match the approved network.',
        409,
        { status, challenge },
        status.paymentId,
      )
    }

    if (status.token && status.token !== challenge.asset.symbol) {
      throw new HavenApiError(
        'MPP resume request does not match the approved token.',
        409,
        { status, challenge },
        status.paymentId,
      )
    }

    const approvedAmount = status.amount ? normalizeDecimal(status.amount) : ''
    const requestedAmount = normalizeDecimal(challenge.amount.display)
    if (approvedAmount && approvedAmount !== requestedAmount) {
      throw new HavenApiError(
        'MPP resume request does not match the approved amount.',
        409,
        { status, challenge },
        status.paymentId,
      )
    }
  }

  private mapX402ReceiptFromAuthorization(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    paymentHeader: string,
    raw: RawX402AuthorizeResponse,
    execResult?: RawSignResponse,
  ): X402Receipt {
    const txHash = execResult?.tx_hash ?? raw.tx_hash ?? ''
    const chainId = execResult?.chain_id ?? raw.chain_id ?? chainIdFromNetwork(option.network)
    const token = execResult?.token ?? raw.token ?? 'USDC'
    const amount = execResult?.amount ?? raw.amount ?? decimalFromUsdcAtomic(x402AuthorizationAmount(option))
    const to = execResult?.to ?? raw.to ?? this.delegateAddress ?? ''
    const explorerUrl = execResult?.explorer_url ?? raw.explorer_url ?? explorerUrlOrEmpty(chainId, txHash)
    const merchantTo = execResult?.merchant_to ?? raw.merchant_to ?? option.payTo
    const payer = raw.payer ?? raw.safe_address ?? raw.sign_data?.components.safe

    return this.buildX402Receipt({
      paymentId: raw.payment_id,
      txHash,
      token,
      amount,
      to,
      resourceUrl: paymentRequired.resource.url,
      explorerUrl,
      accepted: option,
      paymentHeader,
      merchantTo,
      payer,
      chainId,
    })
  }

  private mapX402ReceiptFromStatus(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    paymentHeader: string,
    status: PaymentStatusResult,
  ): X402Receipt {
    if (!status.txHash) {
      throw new HavenApiError(
        `x402 payment ${status.paymentId} is ready to retry but has no Haven transaction hash.`,
        502,
        status,
        status.paymentId,
      )
    }

    return this.buildX402Receipt({
      paymentId: status.paymentId,
      txHash: status.txHash,
      token: status.token || 'USDC',
      amount: status.amount || decimalFromUsdcAtomic(x402AuthorizationAmount(option)),
      to: this.delegateAddress ?? '',
      resourceUrl: paymentRequired.resource.url,
      explorerUrl: explorerUrlOrEmpty(status.chainId, status.txHash),
      accepted: option,
      paymentHeader,
      merchantTo: status.merchantAddress ?? option.payTo,
      payer: this.x402Wallet,
      chainId: status.chainId || chainIdFromNetwork(option.network),
    })
  }

  private buildX402Receipt(input: {
    paymentId: string
    txHash: string
    token: string
    amount: string
    to: string
    resourceUrl: string
    explorerUrl: string
    accepted: X402PaymentOption
    paymentHeader: string
    merchantTo?: string | null
    payer?: string
    chainId?: number
  }): X402Receipt {
    const fundingExplorerUrl = input.explorerUrl || explorerUrlOrEmpty(input.chainId, input.txHash)

    return {
      success: true,
      paymentId: input.paymentId,
      txHash: input.txHash,
      token: input.token,
      amount: input.amount,
      to: input.to,
      resourceUrl: input.resourceUrl,
      explorerUrl: input.explorerUrl,
      accepted: input.accepted,
      paymentHeader: input.paymentHeader,
      merchantTo: input.merchantTo ?? input.accepted.payTo,
      payer: input.payer,
      chainId: input.chainId,
      haven: {
        paymentId: input.paymentId,
        fundingTxHash: input.txHash,
        fundingExplorerUrl,
      },
      merchant: {
        payTo: input.merchantTo ?? input.accepted.payTo,
      },
      x402: {
        amount: x402AuthorizationAmount(input.accepted),
        token: input.token,
        network: input.accepted.network,
        asset: input.accepted.asset,
        resource: input.accepted.resource ?? input.resourceUrl,
      },
    }
  }

  private async createStandardX402Header(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
  ): Promise<string> {
    if (!this.delegateKey) {
      throw new HavenSigningError('delegateKey is required to sign x402 payment headers.')
    }

    const account = privateKeyToAccount(this.delegateKey as `0x${string}`)
    const requirements = toStandardPaymentRequirements(paymentRequired, option)

    const header = await exact.evm.createPaymentHeader(
      account,
      paymentRequired.x402Version,
      requirements,
    )
    if (paymentRequired.x402Version < 2) return header

    const payment = decodeBase64Json<{ payload: unknown }>(header)
    return encodeBase64Json({
      x402Version: paymentRequired.x402Version,
      accepted: option,
      payload: payment.payload,
    })
  }

  private cacheX402Receipt(
    idempotencyKey: string,
    paymentHeader: string,
    receipt: X402Receipt,
  ): void {
    const expiresAt = getPaymentHeaderValidBefore(paymentHeader)
    if (expiresAt > Date.now()) {
      this.x402ReceiptCache.set(idempotencyKey, { expiresAt, receipt })
    }
  }

  private mapMachinePaymentReceipt(
    challenge: MachinePaymentChallenge,
    raw: RawMachinePaymentAuthorizeResponse,
    txHash: string,
    execResult?: RawSignResponse,
  ): MachinePaymentReceipt {
    const receiptWithoutHeader = {
      success: true,
      rail: challenge.rail,
      paymentId: raw.payment_id,
      challengeId: challenge.challengeId,
      txHash,
      token: execResult?.token ?? raw.token ?? challenge.asset.symbol,
      amount: execResult?.amount ?? raw.amount ?? challenge.amount.display,
      to: execResult?.to ?? raw.to ?? challenge.recipient,
      resourceUrl: raw.resource_url ?? challenge.resource,
      explorerUrl:
        execResult?.explorer_url ??
        raw.explorer_url ??
        buildExplorerUrl(execResult?.chain_id ?? raw.chain_id ?? challenge.network.chainId, txHash),
      payer: raw.payer ?? raw.safe_address,
      chainId: execResult?.chain_id ?? raw.chain_id ?? challenge.network.chainId,
    }

    return {
      ...receiptWithoutHeader,
      proofHeader: encodeMachinePaymentProof(receiptWithoutHeader),
    }
  }

  private mapMachinePaymentReceiptFromStatus(
    challenge: MachinePaymentChallenge,
    status: PaymentStatusResult,
  ): MachinePaymentReceipt {
    if (!status.txHash) {
      throw new HavenApiError(
        `MPP payment ${status.paymentId} is ready to retry but has no Haven transaction hash.`,
        502,
        status,
        status.paymentId,
      )
    }

    const receiptWithoutHeader = {
      success: true,
      rail: challenge.rail,
      paymentId: status.paymentId,
      challengeId: challenge.challengeId,
      txHash: status.txHash,
      token: status.token || challenge.asset.symbol,
      amount: status.amount || challenge.amount.display,
      to: status.merchantAddress ?? challenge.recipient,
      resourceUrl: status.resourceUrl ?? challenge.resource,
      explorerUrl: explorerUrlOrEmpty(status.chainId || challenge.network.chainId, status.txHash),
      chainId: status.chainId || challenge.network.chainId,
    }

    return {
      ...receiptWithoutHeader,
      proofHeader: encodeMachinePaymentProof(receiptWithoutHeader),
    }
  }

  private async recordMerchantRetryRejected(input: {
    rail: string
    paymentId: string
    txHash: string
    resourceUrl: string
    merchant: CapturedMerchantResponse
    details?: Record<string, unknown>
  }): Promise<void> {
    try {
      await this.post('/machine-payments/reconciliation-events', {
        paymentId: input.paymentId,
        rail: input.rail,
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: input.txHash,
        reason: `Merchant returned HTTP ${input.merchant.merchant_status} after Haven payment confirmation`,
        details: {
          resource_url: input.resourceUrl,
          retry_status: input.merchant.merchant_status,
          retry_body: input.merchant.merchant_body.slice(0, MERCHANT_BODY_SNIPPET_LIMIT) || null,
          ...input.details,
        },
      })
    } catch {
      // Best-effort durability: preserve the original retry failure for callers.
    }
  }

  private async reportMachinePaymentEvidence(input: {
    paymentId: string
    rail: string
    txHash: string
    resourceUrl: string
    merchantStatus: number
    challengePayload?: Record<string, unknown>
    selectedPayment?: Record<string, unknown>
    paymentProofHeaderName?: string
    paymentProofHeader?: string
    protocolReceiptHeaderName?: string
    protocolReceiptHeader?: string
  }): Promise<void> {
    try {
      await this.post('/machine-payments/evidence', {
        paymentId: input.paymentId,
        rail: input.rail,
        txHash: input.txHash,
        resourceUrl: input.resourceUrl,
        merchantStatus: input.merchantStatus,
        challengePayload: input.challengePayload,
        selectedPayment: input.selectedPayment,
        paymentProofHeaderName: input.paymentProofHeaderName,
        paymentProofHeader: input.paymentProofHeader,
        protocolReceiptHeaderName: input.protocolReceiptHeaderName,
        protocolReceiptHeader: input.protocolReceiptHeader,
        protocolReceiptPayload: input.protocolReceiptHeader
          ? parseProtocolReceiptHeader(input.protocolReceiptHeader)
          : undefined,
      })
    } catch {
      // Evidence reporting is best-effort. The paid resource response remains
      // the caller-visible result when merchant retry succeeded.
    }
  }

  /**
   * Wait for a funding tx to be mined with ≥1 confirmation before the
   * merchant retry, eliminating the race where the merchant's
   * `balanceOf(delegate)` runs before the funding block propagates.
   *
   * Skipped when `chainRpcs` does not include the chain; in that case Haven's
   * backend has already confirmed on-chain submission and callers accept the
   * small propagation window as a trade-off for not configuring an RPC URL.
   */
  private async waitForFundingTx(
    txHash: string | undefined,
    chainId: number | undefined,
    timeoutMs = 30_000,
  ): Promise<void> {
    if (!txHash || !chainId) return
    const rpcUrl = this.chainRpcs[chainId]
    if (!rpcUrl) return
    const provider = createJsonRpcProvider(rpcUrl)
    const onChainReceipt = await provider.waitForTransaction(txHash, 1, timeoutMs)
    if (!onChainReceipt || onChainReceipt.status !== 1) {
      throw new HavenApiError(
        'Funding tx did not confirm on-chain within the timeout window.',
        500,
        { txHash, chainId },
      )
    }
  }

  private throwIfNonSignableAuthorizationState(
    label: string,
    raw: RawMachinePaymentAuthorizeResponse | RawX402AuthorizeResponse,
  ): void {
    if (raw.status === 'pending_signature') return
    this.throwPaymentStateError(label, raw)
  }

  private throwPaymentStateError(
    label: string,
    raw: RawMachinePaymentAuthorizeResponse | RawX402AuthorizeResponse | RawSignResponse,
  ): never {
    const statusCode = PAYMENT_STATE_STATUS_CODES[raw.status] ?? 502
    const state = this.paymentStateFromRaw(label, raw)

    if (state) {
      throw new HavenPaymentStateError(state.message, statusCode, state, raw)
    }

    if (raw.status === 'pending_approval') {
      throw new HavenApiError(
        `${label} exceeds the on-chain allowance and was queued for owner approval (payment_id: ${raw.payment_id}).`,
        statusCode,
        raw,
      )
    }

    if (raw.status === 'expired') {
      throw new HavenApiError(
        `${label} expired before it could be completed (payment_id: ${raw.payment_id}).`,
        statusCode,
        raw,
      )
    }

    const paymentId = raw.payment_id ? ` (payment_id: ${raw.payment_id})` : ''
    const message = raw.error ?? `${label} ${raw.status}${paymentId}`
    throw new HavenApiError(message, statusCode, raw)
  }

  private paymentStateFromRaw(
    label: string,
    raw: RawMachinePaymentAuthorizeResponse | RawX402AuthorizeResponse | RawSignResponse,
  ): PaymentStatusResult | null {
    if (!raw.payment_id || !raw.status) return null

    const phase = (raw.phase as PaymentPhase | undefined) ?? phaseForStatus(raw.status)
    const nextAction = (raw.next_action as PaymentNextAction | undefined) ?? nextActionForStatus(raw.status)
    if (!phase || !nextAction) return null

    const amount = raw.amount ?? raw.requested ?? ''
    const token = raw.token ?? ''
    const message =
      raw.message ??
      raw.error ??
      messageForState(label, raw.status, raw.payment_id, nextAction)

    return {
      paymentId: raw.payment_id,
      kind: raw.kind === 'payment_intent' ? 'payment_intent' : 'approval_request',
      rail: raw.rail ?? 'direct',
      status: raw.status === 'pending' ? 'pending_approval' : raw.status,
      phase,
      nextAction,
      amount,
      token,
      resourceUrl: raw.resource_url ?? null,
      merchantAddress: raw.merchant_address ?? raw.merchant_to ?? null,
      txHash: raw.tx_hash ?? null,
      expiresAt: raw.expires_at ?? '',
      chainId: raw.chain_id ?? 0,
      message,
      amountAtomic: raw.amount_atomic ?? raw.x402?.amount_atomic ?? raw.mpp?.amount_atomic ?? null,
      asset: raw.asset ?? raw.x402?.asset ?? raw.mpp?.asset ?? null,
      network: raw.network ?? raw.x402?.network ?? raw.mpp?.network ?? null,
      description: raw.description ?? raw.x402?.description ?? raw.mpp?.description ?? null,
      idempotencyKey: raw.idempotency_key ?? raw.x402?.idempotency_key ?? raw.mpp?.idempotency_key ?? null,
      x402: raw.x402
        ? {
            amountAtomic: raw.x402.amount_atomic ?? raw.amount_atomic ?? null,
            asset: raw.x402.asset ?? raw.asset ?? null,
            network: raw.x402.network ?? raw.network ?? null,
            resourceUrl: raw.x402.resource_url ?? raw.resource_url ?? null,
            merchantAddress: raw.x402.merchant_address ?? raw.merchant_address ?? raw.merchant_to ?? null,
            description: raw.x402.description ?? raw.description ?? null,
            idempotencyKey: raw.x402.idempotency_key ?? raw.idempotency_key ?? null,
          }
        : undefined,
      mpp: raw.mpp
        ? {
            amountAtomic: raw.mpp.amount_atomic ?? raw.amount_atomic ?? null,
            asset: raw.mpp.asset ?? raw.asset ?? null,
            network: raw.mpp.network ?? raw.network ?? null,
            resourceUrl: raw.mpp.resource_url ?? raw.resource_url ?? null,
            merchantAddress: raw.mpp.merchant_address ?? raw.merchant_address ?? raw.merchant_to ?? null,
            description: raw.mpp.description ?? raw.description ?? null,
            idempotencyKey: raw.mpp.idempotency_key ?? raw.idempotency_key ?? null,
            challengeId: raw.mpp.challenge_id ?? raw.challenge_id ?? null,
          }
        : undefined,
    }
  }

  private x402PayerAddress(): string | undefined {
    return this.delegateAddress ?? this.x402Wallet
  }

  private snapshotX402Request(url: string, init?: RequestInit): X402RequestSnapshot {
    return {
      url,
      method: init?.method ?? 'GET',
      headers: Array.from(new Headers(init?.headers).entries()),
      body: this.snapshotRequestBody(init?.body),
    }
  }

  private snapshotRequestBody(body: BodyInit | null | undefined): string | undefined {
    if (body == null) return undefined
    if (typeof body === 'string') return body
    if (body instanceof URLSearchParams) return body.toString()

    throw new HavenApiError(
      'Quote helpers can only capture resumable request bodies that are strings or URLSearchParams. ' +
      'For streams, blobs, or binary bodies, preserve the original request yourself and call the matching resume method with fresh init.',
      400,
    )
  }

  private requestInitFromSnapshot(request: X402RequestSnapshot): RequestInit {
    return {
      method: request.method,
      headers: request.headers,
      body: request.body,
    }
  }

  private withX402Wallet(init?: RequestInit, wallet = this.x402PayerAddress()): RequestInit | undefined {
    if (!wallet) return init

    const headers = new Headers(init?.headers)
    if (!headers.has('x402-wallet')) {
      headers.set('x402-wallet', wallet)
    }

    return {
      ...init,
      headers,
    }
  }

  private buildX402Quote(
    paymentRequired: X402PaymentRequired,
    request: X402RequestSnapshot,
    idempotencyKey?: string,
  ): X402Quote {
    const option = selectStandardPaymentOption(paymentRequired.accepts)
    if (!option) {
      throw new HavenApiError(
        'No compatible payment option found in x402 requirements. ' +
        'Haven supports standard x402 exact payments on Base USDC.',
        400,
      )
    }

    const token = resolveTokenFromAddress(option.asset, option.network)
    return {
      rail: 'x402',
      idempotencyKey: idempotencyKey ?? buildX402IdempotencyKey(paymentRequired, option),
      paymentRequired,
      accepted: option,
      request,
      resourceUrl: paymentRequired.resource.url,
      description: paymentRequired.resource.description ?? option.description ?? null,
      mimeType: paymentRequired.resource.mimeType ?? option.mimeType ?? null,
      amountAtomic: x402AuthorizationAmount(option),
      amount: decimalFromUsdcAtomic(x402AuthorizationAmount(option)),
      token: token?.symbol ?? 'USDC',
      asset: option.asset,
      network: option.network,
      chainId: chainIdOrNull(option.network),
      merchantAddress: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
    }
  }

  private buildX402ResumeState(input: {
    paymentId: string
    paymentRequired: X402PaymentRequired
    accepted: X402PaymentOption
    idempotencyKey: string
    request?: X402RequestSnapshot
  }): X402ResumeState {
    const token = resolveTokenFromAddress(input.accepted.asset, input.accepted.network)
    return {
      rail: 'x402',
      paymentId: input.paymentId,
      idempotencyKey: input.idempotencyKey,
      paymentRequired: input.paymentRequired,
      accepted: input.accepted,
      url: input.request?.url ?? input.paymentRequired.resource.url,
      request: input.request,
      resourceUrl: input.paymentRequired.resource.url,
      description: input.paymentRequired.resource.description ?? input.accepted.description ?? null,
      amountAtomic: x402AuthorizationAmount(input.accepted),
      amount: decimalFromUsdcAtomic(x402AuthorizationAmount(input.accepted)),
      token: token?.symbol ?? 'USDC',
      asset: input.accepted.asset,
      network: input.accepted.network,
      chainId: chainIdOrNull(input.accepted.network),
      merchantAddress: input.accepted.payTo,
    }
  }

  private buildMppQuote(
    challenge: MachinePaymentChallenge,
    request: X402RequestSnapshot,
    idempotencyKey?: string,
  ): MppQuote {
    return {
      rail: 'mpp',
      paymentRail: challenge.rail,
      idempotencyKey: idempotencyKey ?? buildMachinePaymentIdempotencyKey(challenge),
      challenge,
      request,
      resourceUrl: challenge.resource,
      description: challenge.description ?? null,
      amountAtomic: challenge.amount.atomic,
      amount: challenge.amount.display,
      token: challenge.asset.symbol,
      asset: challenge.asset.address,
      network: challenge.network.name,
      chainId: challenge.network.chainId,
      merchantAddress: challenge.recipient,
      expiresAt: challenge.expiresAt,
    }
  }

  private buildMppResumeState(input: {
    paymentId: string
    challenge: MachinePaymentChallenge
    idempotencyKey: string
    request?: X402RequestSnapshot
  }): MppResumeState {
    const quote = this.buildMppQuote(
      input.challenge,
      input.request ?? this.snapshotX402Request(input.challenge.resource),
      input.idempotencyKey,
    )

    return {
      rail: 'mpp',
      paymentRail: quote.paymentRail,
      paymentId: input.paymentId,
      idempotencyKey: quote.idempotencyKey,
      challenge: input.challenge,
      url: input.request?.url ?? input.challenge.resource,
      request: input.request,
      resourceUrl: quote.resourceUrl,
      description: quote.description,
      amountAtomic: quote.amountAtomic,
      amount: quote.amount,
      token: quote.token,
      asset: quote.asset,
      network: quote.network,
      chainId: quote.chainId,
      merchantAddress: quote.merchantAddress,
      expiresAt: quote.expiresAt,
    }
  }

  private attachResumeState(
    err: unknown,
    input:
      | {
          rail: 'x402'
          paymentRequired: X402PaymentRequired
          accepted: X402PaymentOption
          idempotencyKey: string
          request?: X402RequestSnapshot
        }
      | {
          rail: 'mpp'
          challenge: MachinePaymentChallenge
          idempotencyKey: string
          request?: X402RequestSnapshot
        },
  ): void {
    if (input.rail === 'x402') {
      this.attachX402ResumeState(
        err,
        input.paymentRequired,
        input.accepted,
        input.idempotencyKey,
        input.request,
      )
      return
    }

    this.attachMppResumeState(err, input.challenge, input.idempotencyKey, input.request)
  }

  private attachX402ResumeState(
    err: unknown,
    paymentRequired: X402PaymentRequired,
    accepted: X402PaymentOption,
    idempotencyKey: string,
    request?: X402RequestSnapshot,
  ): void {
    if (!(err instanceof HavenPaymentStateError)) return
    if (err.state.rail !== 'x402') return

    err.resumeState = this.buildX402ResumeState({
      paymentId: err.state.paymentId,
      paymentRequired,
      accepted,
      idempotencyKey,
      request,
    })
  }

  private attachMppResumeState(
    err: unknown,
    challenge: MachinePaymentChallenge,
    idempotencyKey: string,
    request?: X402RequestSnapshot,
  ): void {
    if (!(err instanceof HavenPaymentStateError)) return
    if (!isMppRail(err.state.rail)) return

    err.resumeState = this.buildMppResumeState({
      paymentId: err.state.paymentId,
      challenge,
      idempotencyKey,
      request,
    })
  }

  // ── Tool Execution (for agent frameworks) ────────────────────────

  /**
   * Execute a tool call by name and input.
   *
   * Designed to plug directly into agent tool-call handlers:
   *
   * ```ts
   * if (block.type === 'tool_use') {
   *   const result = await haven.executeTool(block.name, block.input)
   *   // send result back to the model
   * }
   * ```
   */
  async executeTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (toolName === 'make_payment') {
      const { token, amount, to } = input as {
        token: string
        amount: string
        to: string
      }

      try {
        const result = await this.pay({ token, amount, to })
        return {
          success: result.status === 'confirmed',
          payment_id: result.paymentId,
          status: result.status,
          tx_hash: result.txHash,
          token: result.token,
          amount: result.amount,
          to: result.to,
          explorer_url: result.explorerUrl,
          error: result.errorMessage,
        }
      } catch (err) {
        return this.toolError(err)
      }
    }

    if (toolName === 'authorize_x402_payment') {
      const { url, payTo, amount, asset, network, description, idempotencyKey } = input as {
        url: string
        payTo: string
        amount: string
        asset: string
        network: string
        description?: string
        idempotencyKey?: string
      }

      try {
        const receipt = await this.authorizeX402(
          this.toolX402PaymentRequired({ url, payTo, amount, asset, network, description }),
          { idempotencyKey },
        )
        return this.x402ToolReceipt(receipt)
      } catch (err) {
        return this.toolError(err)
      }
    }

    if (toolName === 'resume_x402_payment') {
      const { payment_id, url, payTo, amount, asset, network, description, idempotencyKey } = input as {
        payment_id: string
        url: string
        payTo: string
        amount: string
        asset: string
        network: string
        description?: string
        idempotencyKey?: string
      }

      try {
        const receipt = await this.resumeAuthorizedX402({
          paymentId: payment_id,
          paymentRequired: this.toolX402PaymentRequired({ url, payTo, amount, asset, network, description }),
          idempotencyKey,
        })
        return this.x402ToolReceipt(receipt)
      } catch (err) {
        return this.toolError(err)
      }
    }

    if (toolName === 'authorize_machine_payment') {
      const { challenge, idempotencyKey } = input as {
        challenge: MachinePaymentChallenge
        idempotencyKey?: string
      }

      try {
        const receipt = await this.authorizeMachinePayment(challenge, { idempotencyKey })
        return {
          success: true,
          payment_id: receipt.paymentId,
          tx_hash: receipt.txHash,
          token: receipt.token,
          amount: receipt.amount,
          to: receipt.to,
          resource_url: receipt.resourceUrl,
          explorer_url: receipt.explorerUrl,
          proof_header: receipt.proofHeader,
          rail: receipt.rail,
          challenge_id: receipt.challengeId,
          payer: receipt.payer,
          chain_id: receipt.chainId,
        }
      } catch (err) {
        return this.toolError(err)
      }
    }

    if (toolName === 'get_payment_status') {
      const { payment_id } = input as { payment_id: string }
      const result = await this.getPaymentStatus(payment_id)
      return {
        payment_id: result.paymentId,
        kind: result.kind,
        rail: result.rail,
        status: result.status,
        phase: result.phase,
        next_action: result.nextAction,
        tx_hash: result.txHash,
        token: result.token,
        amount: result.amount,
        resource_url: result.resourceUrl,
        merchant_address: result.merchantAddress,
        amount_atomic: result.amountAtomic,
        asset: result.asset,
        network: result.network,
        description: result.description,
        idempotency_key: result.idempotencyKey,
        x402: result.x402,
        mpp: result.mpp,
        expires_at: result.expiresAt,
        chain_id: result.chainId,
        message: result.message,
      }
    }

    if (toolName === 'get_allowances') {
      return { ...await this.getAllowances() }
    }

    throw new Error(`Unknown tool: ${toolName}`)
  }

  private toolX402PaymentRequired(input: {
    url: string
    payTo: string
    amount: string
    asset: string
    network: string
    description?: string
  }): X402PaymentRequired {
    return {
      x402Version: 2,
      resource: { url: input.url, description: input.description },
      accepts: [
        {
          scheme: 'exact',
          network: input.network,
          amount: input.amount,
          asset: input.asset,
          payTo: input.payTo,
          maxTimeoutSeconds: 30,
        },
      ],
    }
  }

  private x402ToolReceipt(receipt: X402Receipt): Record<string, unknown> {
    return {
      success: true,
      payment_id: receipt.paymentId,
      tx_hash: receipt.txHash,
      token: receipt.token,
      amount: receipt.amount,
      to: receipt.to,
      resource_url: receipt.resourceUrl,
      explorer_url: receipt.explorerUrl,
      payment_header: receipt.paymentHeader,
      merchant_to: receipt.merchantTo,
      payer: receipt.payer,
      chain_id: receipt.chainId,
      haven: receipt.haven,
      merchant: receipt.merchant,
      x402: receipt.x402,
    }
  }

  private toolError(err: unknown): Record<string, unknown> {
    if (err instanceof HavenPaymentStateError) {
      return {
        success: false,
        payment_id: err.state.paymentId,
        kind: err.state.kind,
        rail: err.state.rail,
        status: err.state.status,
        phase: err.state.phase,
        next_action: err.state.nextAction,
        tx_hash: err.state.txHash,
        token: err.state.token,
        amount: err.state.amount,
        resource_url: err.state.resourceUrl,
        merchant_address: err.state.merchantAddress,
        amount_atomic: err.state.amountAtomic,
        asset: err.state.asset,
        network: err.state.network,
        description: err.state.description,
        idempotency_key: err.state.idempotencyKey,
        x402: err.state.x402
          ? {
              amount_atomic: err.state.x402.amountAtomic,
              asset: err.state.x402.asset,
              network: err.state.x402.network,
              resource_url: err.state.x402.resourceUrl,
              merchant_address: err.state.x402.merchantAddress,
              description: err.state.x402.description,
              idempotency_key: err.state.x402.idempotencyKey,
            }
          : undefined,
        mpp: err.state.mpp
          ? {
              amount_atomic: err.state.mpp.amountAtomic,
              asset: err.state.mpp.asset,
              network: err.state.mpp.network,
              resource_url: err.state.mpp.resourceUrl,
              merchant_address: err.state.mpp.merchantAddress,
              description: err.state.mpp.description,
              idempotency_key: err.state.mpp.idempotencyKey,
              challenge_id: err.state.mpp.challengeId,
            }
          : undefined,
        resume_state: err.resumeState,
        expires_at: err.state.expiresAt,
        chain_id: err.state.chainId,
        message: err.state.message,
        error: err.message,
      }
    }

    if (err instanceof HavenApiError) {
      return {
        success: false,
        status_code: err.statusCode,
        error: err.message,
        body: err.body,
      }
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // ── HTTP Helpers ─────────────────────────────────────────────────

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout)

    try {
      const contextHeaders = this.requestContext.getStore()?.headers ?? {}
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
          ...contextHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      const data = await res.json()

      if (!res.ok) {
        const message =
          (data as Record<string, unknown>).error as string
          ?? (data as Record<string, unknown>).details as string
          ?? `API request failed`
        throw new HavenApiError(message, res.status, data)
      }

      return data as T
    } catch (err) {
      if (err instanceof HavenApiError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HavenApiError(`Request to ${path} timed out`, 408)
      }
      throw new HavenApiError(
        `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  // ── Mapping Helpers ──────────────────────────────────────────────

  private mapPaymentResult(raw: RawStatusResponse): PaymentResult {
    return {
      paymentId: raw.payment_id,
      status: raw.status as PaymentStatus,
      token: raw.token,
      amount: raw.amount,
      to: raw.to,
      txHash: raw.tx_hash,
      errorMessage: raw.error_message,
      explorerUrl: raw.explorer_url ?? (raw.tx_hash ? buildExplorerUrl(raw.chain_id, raw.tx_hash) : null),
      createdAt: raw.created_at,
      signedAt: raw.signed_at,
      submittedAt: raw.submitted_at,
      confirmedAt: raw.confirmed_at,
      expiresAt: raw.expires_at,
    }
  }

  private mapPaymentStatusResult(raw: RawPaymentStatusResult): PaymentStatusResult {
    return {
      paymentId: raw.payment_id,
      kind: raw.kind,
      rail: raw.rail,
      status: raw.status,
      phase: raw.phase,
      nextAction: raw.next_action,
      amount: raw.amount,
      token: raw.token,
      resourceUrl: raw.resource_url,
      merchantAddress: raw.merchant_address,
      txHash: raw.tx_hash,
      expiresAt: raw.expires_at,
      chainId: raw.chain_id,
      message: raw.message,
      amountAtomic: raw.amount_atomic ?? raw.x402?.amount_atomic ?? null,
      asset: raw.asset ?? raw.x402?.asset ?? null,
      network: raw.network ?? raw.x402?.network ?? null,
      description: raw.description ?? raw.x402?.description ?? null,
      idempotencyKey: raw.idempotency_key ?? raw.x402?.idempotency_key ?? null,
      x402: raw.x402
        ? {
            amountAtomic: raw.x402.amount_atomic ?? raw.amount_atomic ?? null,
            asset: raw.x402.asset ?? raw.asset ?? null,
            network: raw.x402.network ?? raw.network ?? null,
            resourceUrl: raw.x402.resource_url ?? raw.resource_url,
            merchantAddress: raw.x402.merchant_address ?? raw.merchant_address,
            description: raw.x402.description ?? raw.description ?? null,
            idempotencyKey: raw.x402.idempotency_key ?? raw.idempotency_key ?? null,
          }
        : undefined,
    }
  }

  private mapPaymentReceipt(raw: RawHavenPaymentReceipt): HavenPaymentReceipt {
    const receipt: HavenPaymentReceipt = {
      id: raw.id,
      paymentId: raw.payment_id,
      rail: raw.rail,
      proofStatus: raw.proof_status,
      txHash: raw.tx_hash,
      chainId: raw.chain_id,
      resourceUrl: raw.resource_url,
      merchantAddress: raw.merchant_address,
      payerAddress: raw.payer_address,
      settlementAddress: raw.settlement_address,
      tokenSymbol: raw.token_symbol,
      tokenAddress: raw.token_address,
      amountRaw: raw.amount_raw,
      amount: raw.amount_human,
      challengeId: raw.challenge_id,
      idempotencyKey: raw.idempotency_key,
      challengePayload: raw.challenge_payload,
      selectedPayment: raw.selected_payment,
      paymentProofHeaderName: raw.payment_proof_header_name,
      protocolReceiptHeaderName: raw.protocol_receipt_header_name,
      protocolReceiptPayload: raw.protocol_receipt_payload,
      merchantStatus: raw.merchant_status,
      confirmedAt: raw.confirmed_at,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }

    if ('payment_intent_id' in raw) {
      receipt.paymentIntentId = raw.payment_intent_id ?? null
    }
    if ('approval_request_id' in raw) {
      receipt.approvalRequestId = raw.approval_request_id ?? null
    }

    return receipt
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getPaymentHeaderValidBefore(paymentHeader: string): number {
  try {
    const payment = decodeBase64Json<{ payload?: { authorization?: { validBefore?: string } } }>(
      paymentHeader,
    )
    const payload = payment.payload as { authorization?: { validBefore?: string } }
    const validBeforeSeconds = Number(payload.authorization?.validBefore)
    if (Number.isFinite(validBeforeSeconds)) return validBeforeSeconds * 1000
  } catch {
    // If the header cannot be decoded, skip caching rather than hiding errors.
  }

  return 0
}

function parseProtocolReceiptHeader(value: string): Record<string, unknown> | undefined {
  try {
    return decodeBase64Json<Record<string, unknown>>(value)
  } catch {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}

/**
 * Captures a failed merchant retry response so callers can debug exactly why the
 * merchant rejected a payment Haven already funded. We preserve the status code,
 * statusText, headers, and full body text verbatim — this is the merchant's
 * response, so it never contains Haven-side secrets (delegate key, agent API key),
 * which only ever live in the outbound request.
 */
async function captureMerchantResponse(response: Response): Promise<CapturedMerchantResponse> {
  const merchant_body = await response.text().catch(() => '')
  return {
    merchant_status: response.status,
    merchant_status_text: response.statusText,
    merchant_headers: Object.fromEntries(response.headers.entries()),
    merchant_body,
  }
}
