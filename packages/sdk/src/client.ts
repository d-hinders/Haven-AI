import { exact } from 'x402/schemes'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  signHash,
  signUserOpTypedDataForDelegation,
  signSettlementDelegationTypedData,
  addressFromKey,
  verifySignature,
} from './signer.js'
import type { PaymentReceipt, ReceiptVerification } from './receipt.js'
import type {
  HavenClientConfig,
  PaymentRequest,
  PaymentIntent,
  PaymentResult,
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
  X402McpTransport,
  X402McpCallContext,
  X402MerchantCallContext,
  RawX402MerchantCallContext,
  X402Quote,
  X402Receipt,
  X402RequestSnapshot,
  X402ResumeState,
  ResumeAuthorizedX402Input,
  ResumeX402PaymentInput,
  RawX402AuthorizeResponse,
  X402Erc7710Settlement,
  RawX402SettleResponse,
  HavenAgent,
  HavenAgentSummary,
  HavenAgentAllowanceSummary,
  HavenAllowanceSummary,
  PostPurchaseAllowanceSummary,
  HavenPaymentReceipt,
  HavenCatalogEntry,
  RawCatalogEntry,
  AgentPaymentWarning,
} from './types.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
  HavenApiError,
  HavenPaymentStateError,
  X402UnexpectedStatusError,
  X402AlreadySettledError,
  HavenSigningError,
  HavenTimeoutError,
} from './types.js'
import {
  buildX402IdempotencyKey,
  parsePaymentRequiredResponse,
  resolveTokenFromAddress,
  selectStandardPaymentOption,
  selectX402SettlementScheme,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
} from './x402.js'
import type {
  SweepAuthorization,
  SweepPrepareResponse,
  SweepSubmitResponse,
} from './sweep.js'
import { createJsonRpcProvider, createWallet, createErc20Contract } from './provider.js'
import { decodeBase64Json, encodeBase64Json } from './base64.js'
import { HavenApiTransport } from './haven-api-transport.js'
import {
  mapPaymentResult,
  mapPaymentStatusResult,
} from './payment-mappers.js'
import {
  paymentStateFromRaw,
  paymentStateStatusCode,
  throwPaymentStateError,
} from './payment-state.js'
import {
  captureMerchantResponse,
  McpMerchantTransport,
} from './mcp-merchant-transport.js'
import type { CapturedMerchantResponse } from './mcp-merchant-transport.js'
import { AccountReads } from './account-reads.js'
import { DelegateSweepApi } from './delegate-sweep.js'

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

const DEFAULT_CONFIRMATION_TIMEOUT = 90_000
const DEFAULT_POLLING_INTERVAL = 3_000

/** Cap the merchant body persisted to the reconciliation event (the full body is kept on the thrown error). */
const MERCHANT_BODY_SNIPPET_LIMIT = 1000

function chainIdFromNetwork(network: string | undefined): number | undefined {
  if (network === 'base') return 8453
  // #1471: canonical in the x402 spec's NetworkSchema, and the backend maps
  // it as of the same change — the #1478 pin test enforces that every copy
  // widens together, which is exactly how this line got here.
  if (network === 'base-sepolia') return 84532
  if (!network?.startsWith('eip155:')) return undefined
  const chainId = Number(network.slice('eip155:'.length))
  return Number.isFinite(chainId) ? chainId : undefined
}

function chainIdOrNull(network: string | undefined): number | null {
  return chainIdFromNetwork(network) ?? null
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
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
 * Digest of a delegation-rail signing payload, or `undefined` when there is
 * none (#1138).
 *
 * Guarded because a payload that cannot be hashed is not a recoverable
 * condition to paper over: the edge signer derives this same digest before
 * signing, so an unhashable payload can never be signed by anyone. Surfacing it
 * as a named Haven error beats letting a raw viem type error escape from the
 * middle of intent construction.
 */
function x402TypedDataDigest(typedData: unknown): string | undefined {
  if (!typedData || typeof typedData !== 'object') return undefined
  try {
    return hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
  } catch (err) {
    throw new HavenSigningError(
      'The x402 funding intent carried a sign_data.typed_data that is not a valid EIP-712 ' +
        'payload (needs domain, types, primaryType, message), so its digest cannot be derived ' +
        'and no signer could accept it. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Shared by {@link HavenClient.discoverTools} and {@link HavenClient.getCatalogEntry} (#1306). */
function mapCatalogEntry(entry: RawCatalogEntry): HavenCatalogEntry {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    resourceUrl: entry.resource_url,
    rail: entry.rail,
    protocol: entry.protocol,
    toolName: entry.tool_name,
    toolArguments: entry.tool_arguments ?? null,
    priceDisplay: entry.price_display,
    priceAtomic: entry.price_atomic,
    asset: entry.asset,
    network: entry.network,
    status: entry.status,
    verifiedAt: entry.verified_at,
  }
}

export class HavenClient {
  private readonly delegateKey: string | undefined
  private readonly havenApi: HavenApiTransport
  private readonly accountReads: AccountReads
  private readonly delegateSweep: DelegateSweepApi
  private readonly x402Wallet: string | undefined
  private readonly merchantTransport: McpMerchantTransport
  private readonly confirmationTimeout: number
  private readonly pollingInterval: number
  private readonly chainRpcs: Record<number, string>
  private readonly inFlightX402 = new Map<string, Promise<X402Receipt>>()
  private readonly x402ReceiptCache = new Map<string, { expiresAt: number; receipt: X402Receipt }>()
  /** Delegate address derived from the private key (if provided) */
  readonly delegateAddress: string | undefined

  constructor(config: HavenClientConfig) {
    this.delegateKey = config.delegateKey
    this.havenApi = new HavenApiTransport(config)
    this.accountReads = new AccountReads({
      transport: this.havenApi,
      getPaymentStatus: (paymentId) => this.getPaymentStatus(paymentId),
    })
    this.delegateSweep = new DelegateSweepApi({
      transport: this.havenApi,
      delegateKey: config.delegateKey,
      chainRpcs: config.chainRpcs ?? {},
      getAgent: () => this.getAgent(),
      buildExplorerUrl: (chainId, hash) => buildExplorerUrl(chainId, hash),
    })
    this.x402Wallet = config.x402Wallet
    this.merchantTransport = new McpMerchantTransport({ merchantTimeout: config.merchantTimeout })
    this.confirmationTimeout = config.confirmationTimeout ?? DEFAULT_CONFIRMATION_TIMEOUT
    this.pollingInterval = config.pollingInterval ?? DEFAULT_POLLING_INTERVAL
    this.chainRpcs = config.chainRpcs ?? {}
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
    return this.havenApi.withRequestContext(headers, fn)
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
      ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
    })

    // Haven returns HTTP 202 with this status when the requested amount
    // exceeds the on-chain allowance. The payment is parked for the owner
    // to approve in the dashboard — there's nothing to sign yet, so the SDK
    // surfaces it as an explicit error rather than returning a malformed
    // intent with no signData.
    if (raw.status === 'pending_approval') {
      throwPaymentStateError('Payment', raw)
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
    // deriving it from a private key. #1348: a caller that already fetched the
    // agent in this flow passes delegateAddress and skips the duplicate fetch.
    const fundingTo = options.delegateAddress ?? (await this.getAgent()).delegateAddress
    if (!fundingTo) {
      throw new HavenApiError('Authenticated agent has no delegate address registered.', 502)
    }

    const idempotencyKey = options.idempotencyKey ?? buildX402IdempotencyKey(paymentRequired, option)
    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: paymentRequired.resource.url,
      payTo: fundingTo,
      merchantPayTo: option.payTo,
      // #1360: this path ALWAYS means the EIP-3009 funding leg (payTo is the
      // agent's own delegate EOA). Saying so explicitly turns a stale/rotated
      // delegate address into the backend's LOUD shape-mismatch 400 instead
      // of a silent reroute to the erc7710 settlement branch (the #1358
      // review's open-budget misroute). Legacy-rail backends ignore the field.
      settlementScheme: 'eip3009',
      amount: x402AuthorizationAmount(option),
      asset: option.asset,
      network: option.network,
      description: paymentRequired.resource.description,
      idempotencyKey,
      // #1307: persisted so the settle leg can rehydrate it by payment_id.
      ...(options.mcpCallContext ? { mcpCallContext: options.mcpCallContext } : {}),
      // #1355: persisted so the SIGN leg can rehydrate it by payment_id — the
      // local signer's context fetch then carries the 402 PaymentRequired and
      // the agent passes only payment_id. Bounded: the backend rejects >64KB,
      // so an oversized blob is omitted here (signer falls back to the
      // caller-supplied copy) rather than failing the intent.
      ...(new TextEncoder().encode(JSON.stringify(paymentRequired)).length <= 65536
        ? { paymentRequired }
        : {}),
    })

    // Anything other than a signable funding intent (pending_approval,
    // expired, already-executed, error) is surfaced through the shared path.
    if (raw.status !== 'pending_signature') {
      throwPaymentStateError('x402 payment', raw)
    }
    if (!raw.sign_data?.hash) {
      throw new HavenApiError('No sign_hash returned from x402/authorize', 500, raw)
    }
    // #946/#1138: a delegation-rail funding intent signs the ACCOUNT's EIP-712
    // typed data, not the bare hash. This path is keyless by construction, so
    // it does not sign either one — it passes the payload through to whoever
    // holds the key (the local signer the connector installs). What it MUST
    // refuse is a scheme it cannot describe faithfully: handing a caller a
    // `hash` for a typed-data intent invites a raw ECDSA signature the account
    // rejects at the bundler, after the intent is claimed.
    if (raw.sign_data.signature_scheme !== undefined && !raw.sign_data.typed_data) {
      throw new HavenSigningError(
        `This account's x402 funding intent declares signature scheme ` +
          `'${raw.sign_data.signature_scheme}' but carried no typed_data to sign. ` +
          'Refusing to fall back to the bare hash — the account would reject that signature ' +
          'on-chain. This is a backend contract violation; report it rather than working around it.',
      )
    }
    if (!raw.x402_expected_auth) {
      throw new HavenApiError('No x402 expected-context binding returned from x402/authorize', 500, raw)
    }

    return {
      paymentId: raw.payment_id,
      idempotencyKey,
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
      // #1138: the digest the delegation-rail expected context commits to.
      // Re-derived locally, exactly like every other context field the edge
      // signer is handed (amount, merchantTo, …) — none of them are trusted
      // because they arrived, they are trusted because the reconstructed
      // message has to match Haven's signature over it. A typed_data altered in
      // transit therefore fails message equality and is refused, and the signer
      // re-derives this digest a second time from the payload it actually signs.
      expectedTypedDataHash: x402TypedDataDigest(raw.sign_data.typed_data),
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
   * Sign a payment's `sign_data` with the correct scheme for its rail.
   *
   * Dispatching on the server-provided scheme means a caller never has to
   * know which rail an account is on; an unknown scheme is a hard error,
   * never a guessed signature. The session rail's 'eip191_userop' is retired
   * (#834) — the backend refuses those intents with HTTP 410 before any
   * sign_data reaches a client, so encountering it here is a hard error too.
   */
  private async signForData(signData: {
    hash: string
    signature_scheme?: string
    typed_data?: unknown
  }): Promise<string> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'Cannot sign without a delegateKey. Pass the private key in HavenClient config, or sign externally.',
      )
    }
    const scheme = signData.signature_scheme
    if (scheme === 'eip191_userop') {
      throw new HavenSigningError(
        "The session rail is retired — 'eip191_userop' intents can no longer be signed. Re-onboard the account on the delegation rail.",
      )
    }
    if (scheme === 'eip712_userop') {
      if (!signData.typed_data) {
        throw new HavenSigningError(
          'sign_data.signature_scheme is eip712_userop but typed_data is missing — refusing to sign the bare hash (the account would reject it).',
        )
      }
      return signUserOpTypedDataForDelegation(this.delegateKey, signData.typed_data as never)
    }
    if (scheme === 'eip712_delegation') {
      // The erc7710 x402 settlement child (#1452, epic #1450). Same guard as
      // eip712_userop above, and for a sharper reason: this signature lets a
      // facilitator pull the exact amount from the treasury. Falling back to
      // the bare hash would produce a signature the DelegationManager rejects
      // at redemption — a failure that surfaces on-chain, after the agent has
      // already told the merchant it paid.
      if (!signData.typed_data) {
        throw new HavenSigningError(
          'sign_data.signature_scheme is eip712_delegation but typed_data is missing — refusing to sign the bare hash (the settlement would be rejected on redemption).',
        )
      }
      return signSettlementDelegationTypedData(this.delegateKey, signData.typed_data as never)
    }
    if (scheme === undefined) {
      return signHash(this.delegateKey, signData.hash) // legacy AllowanceModule rail
    }
    throw new HavenSigningError(
      `Unknown sign_data.signature_scheme '${scheme}' — refusing to guess a signing scheme. Update @haven_ai/sdk.`,
    )
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
    return mapPaymentResult(raw, buildExplorerUrl)
  }

  /**
   * Get agent-actionable status for a payment intent or approval request.
   *
   * Use this for IDs returned by agent tools and machine-payment/x402 flows.
   * `getPayment()` remains available for payment-intent-only integrations.
   */
  async getPaymentStatus(paymentId: string): Promise<PaymentStatusResult> {
    const raw = await this.get<RawPaymentStatusResult>(`/machine-payments/${paymentId}/status`)
    return mapPaymentStatusResult(raw)
  }

  /**
   * Get the agent identity tied to this API key.
   */
  async getAgent(): Promise<HavenAgent> {
    return this.accountReads.getAgent()
  }

  /**
   * One-shot "am I ready?" bootstrap: identity + live spend authority + a
   * readiness signal, in a single call. Folds {@link getAgent} and
   * {@link getAllowances} together and derives a {@link HavenAgentReadiness}
   * so an agent can answer "who am I and can I pay right now" at session start
   * without two round trips and manual assembly.
   */
  async getAgentSummary(): Promise<HavenAgentSummary> {
    return this.accountReads.getAgentSummary()
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
    return this.delegateSweep.sweepDelegate()
  }

  /**
   * Hosted (keyless) split-signer sweep — step 1 of 2.
   *
   * Asks the backend to build a gasless EIP-3009 sweep authorization for the
   * delegate's stranded USDC. Returns `nothing_stranded` when the delegate is
   * empty, otherwise an `authorization` + Haven `expected_auth` to hand to the
   * edge signer's `haven_sign_sweep_delegate`. No key is required on this client.
   */
  async prepareSweep(): Promise<SweepPrepareResponse> {
    return this.delegateSweep.prepareSweep()
  }

  /**
   * Hosted (keyless) split-signer sweep — step 2 of 2.
   *
   * Relays the delegate-signed authorization. The Haven relayer submits the
   * on-chain `transferWithAuthorization` and pays gas; this client never holds
   * the key.
   */
  async submitSweep(
    authorization: SweepAuthorization,
    signature: string,
  ): Promise<SweepSubmitResponse> {
    return this.delegateSweep.submitSweep(authorization, signature)
  }

  /**
   * Get configured and on-chain allowances for the authenticated agent.
   */
  async getAllowances(): Promise<HavenAllowanceSummary> {
    return this.accountReads.getAllowances()
  }

  /**
   * Post-purchase allowance/budget summary for a settled payment (#1310).
   *
   * Reuses the EXACT rail-aware read path {@link getAllowances} / #1306's
   * catalog-purchase preflight `allowance` block use — `GET
   * /machine-payments/allowances`, with delegation-rail values coming from
   * the #1090 `deriveDelegationBudgets`-backed enforcer read, never
   * `agent_allowances` — so this can never disagree with
   * {@link getAllowances} for the same fixture. The settled token is
   * resolved from {@link getPaymentStatus} so callers pass only
   * `paymentId`, never a second haven_get_agent-style round trip.
   *
   * NEVER throws: any failed read (status lookup, agent lookup, or the
   * allowance/budget lookup itself) degrades to `{ allowance: null,
   * warnings: [ALLOWANCE_CHECK_UNAVAILABLE] }` rather than converting a
   * successful settlement into a failure — the on-chain policy remains the
   * actual spend gate regardless of whether this report can be produced.
   *
   * Freshness caveat (#1319): the delegation rail's on-chain enforcer read
   * can silently fall back to the optimistic full period budget without
   * throwing when the RPC read itself fails (#1145's fund-safe design,
   * unchanged here). {@link getAllowances}'s `onchain.remainingIsFromChain`
   * now carries that provenance on the wire, and the #1306 catalog-purchase
   * preflight (`haven_prepare_catalog_purchase`) surfaces it as a warning —
   * this summary does not (yet). `remaining_atomic` here reflects the last
   * successful chain read, not a guaranteed-live one, and callers should not
   * phrase it as guaranteed-fresh.
   */
  async getPostPurchaseAllowanceSummary(
    paymentId: string,
  ): Promise<{
    allowance: PostPurchaseAllowanceSummary | null
    warnings: AgentPaymentWarning[]
    payment: PaymentStatusResult | null
  }> {
    return this.accountReads.getPostPurchaseAllowanceSummary(paymentId)
  }

  /**
   * `haven_get_payment_status` convenience: fetch status and, for a
   * genuinely SETTLED x402 payment, attach the same post-purchase
   * allowance/budget summary a settle response carries.
   *
   * #1310/#1311 parity: this is the ONE home for logic that was duplicated
   * verbatim in `packages/mcp-server/src/tools.ts` and `packages/mcp/src/tools.ts`
   * (both hosted and local `haven_get_payment_status` handlers) — extracted
   * here because both packages already depend on `@haven_ai/sdk` and call
   * methods on a `HavenClient` instance, so this needed no new dependency
   * edge. `funded_but_unsettled` is deliberately excluded: that phase means
   * the merchant did NOT accept the retry. Every other phase/rail returns
   * the status untouched.
   */
  async getPaymentStatusWithPostPurchaseAllowance(paymentId: string): Promise<
    PaymentStatusResult & {
      allowance?: PostPurchaseAllowanceSummary | null
      warnings?: AgentPaymentWarning[]
    }
  > {
    const status = await this.getPaymentStatus(paymentId)
    if (status.rail === AgentPaymentRail.X402 && status.phase === AgentPaymentPhase.PaymentConfirmed) {
      const { allowance, warnings } = await this.getPostPurchaseAllowanceSummary(paymentId)
      return { ...status, allowance, ...(warnings.length > 0 ? { warnings } : {}) }
    }
    return status
  }

  /**
   * Discover payable services from Haven's curated merchant catalog.
   *
   * Read-only: returns catalog entries (price, rail, protocol) so an agent
   * can choose a service and pay it with the regular payment tools in the
   * same session. Never creates payments or signatures.
   */
  async discoverTools(
    options: { category?: string; search?: string; rail?: 'x402' | 'mpp' } = {},
  ): Promise<HavenCatalogEntry[]> {
    const params = new URLSearchParams()
    if (options.category) params.set('category', options.category)
    if (options.search !== undefined) params.set('search', options.search)
    if (options.rail) params.set('rail', options.rail)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    const raw = await this.get<{ entries: RawCatalogEntry[] }>(`/catalog${query}`)
    return raw.entries.map(mapCatalogEntry)
  }

  /**
   * Fetch one curated catalog entry by id (#1306).
   *
   * Chain-scoped for free by the backend's SQL when the client is
   * agent-authenticated (#1299): an unknown id and an id curated for a
   * DIFFERENT chain than this agent's both 404 identically — this method does
   * not (and must not) re-filter by chain in JS. Read-only, like
   * {@link discoverTools}.
   */
  async getCatalogEntry(id: string): Promise<HavenCatalogEntry> {
    const raw = await this.get<RawCatalogEntry>(`/catalog/${encodeURIComponent(id)}`)
    return mapCatalogEntry(raw)
  }

  /**
   * List recent machine-payment receipts/evidence for bookkeeping.
   */
  async listReceipts(options: { limit?: number } = {}): Promise<HavenPaymentReceipt[]> {
    return this.accountReads.listReceipts(options)
  }

  /**
   * Fetch the verifiable receipt bundle for a settled payment and verify it
   * locally. The server's own verification is ignored — the receipt is verified
   * here (independently of Haven) by recovering the signer from the
   * authorisation, so the result is trustworthy even if the backend lied.
   */
  async getReceipt(
    paymentId: string,
  ): Promise<{ receipt: PaymentReceipt; verification: ReceiptVerification }> {
    return this.accountReads.getReceipt(paymentId)
  }

  /**
   * Rehydrate the x402 resume-state bundle for a payment id (#1328: the MPP
   * resume-state variant retired along with the rest of the mpp_demo surface).
   *
   * The server returns stored protocol context only. The client still signs the
   * merchant proof locally when resumeX402Payment() runs.
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
    const response = await this.merchantTransport.fetch(url, initialInit)

    if (response.status !== 402) {
      // #1300: typed, so consumers key on the class instead of message text.
      throw new X402UnexpectedStatusError(
        `Expected an x402 quote response with HTTP 402, got HTTP ${response.status}.`,
        response.status || 400,
      )
    }

    if (response.headers.get('MACHINE-PAYMENT-CHALLENGE')) {
      throw new HavenApiError('quoteX402 only supports standard x402 Payment Required responses.', 400)
    }

    const paymentRequired = await parsePaymentRequiredResponse(response)
    const mcpTransport = await this.merchantTransport.detect(url, paymentRequired, response)
    return this.buildX402Quote(paymentRequired, request, options.idempotencyKey, mcpTransport)
  }

  /**
   * Probe an MCP tool for its x402 quote without creating a payment.
   *
   * Unlike the generic {@link quoteX402} helper, this completes the
   * Streamable-HTTP MCP lifecycle before sending the unpaid `tools/call`.
   * Hosted MCP uses this path while remaining keyless: it resolves only the
   * agent's public delegate address for `x402-wallet`; signing remains local.
   * It refuses before the quote when the merchant does not establish a session;
   * callers that need a plain x402 endpoint must use {@link quoteX402}.
   */
  async quoteMcpX402(
    url: string,
    init?: RequestInit,
    options: X402AuthorizationOptions = {},
  ): Promise<X402Quote> {
    const wallet = await this.resolveX402WalletForMerchantCall()
    const sessionId = await this.merchantTransport.initialize(url, init, wallet)
    if (!sessionId) {
      throw new HavenApiError(
        'The merchant did not establish an MCP session before the x402 quote. No payment was created.',
        502,
        { mcpSessionNotEstablished: true },
      )
    }

    let requestInit = this.withX402Wallet(init, wallet)
    requestInit = this.merchantTransport.withSessionHeaders(requestInit, sessionId)

    const quote = await this.quoteX402(url, requestInit, options)
    // This dedicated helper established an MCP session even when the endpoint
    // uses a custom path and does not advertise Bazaar metadata. Preserve that
    // fact for the later, fresh session used by the paid retry.
    return {
      ...quote,
      mcpTransport: quote.mcpTransport ?? { handshakeRequired: true, source: 'path' },
    }
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
    // #1521: the authorization is minted AFTER the backend's answer is
    // classified, never before. Signing first meant that when the idempotency
    // key resolved to an already-settled payment, a brand-new authorization
    // had already been created against a delegate whose USDC was gone — and
    // it was handed back paired with the FIRST payment's tx_hash. Within one
    // authorize call the header is still created once and reused, which is
    // all the original "reuse one EIP-3009 nonce" note ever meant. If funding
    // fails later, the unused authorization simply expires via validBefore.
    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: paymentRequired.resource.url,
      payTo: this.delegateAddress,
      merchantPayTo: option.payTo,
      amount: x402AuthorizationAmount(option),
      asset: option.asset,
      network: option.network,
      description: paymentRequired.resource.description,
      idempotencyKey,
      // #1360: same explicit funding-leg declaration as createX402Intent —
      // this local-key path derives payTo from the key (never stale), but the
      // declaration keeps both writers of the 3009 shape loud-by-default.
      settlementScheme: 'eip3009',
    })

    // The backend can report an ALREADY-EXECUTED payment in two different
    // shapes, and #1521 is reachable through both — the guard is therefore on
    // the meaning, not on one response shape:
    //
    //   1. `success` + `tx_hash` — the delegation rail's confirmed-intent
    //      replay (`modules/x402/replay.ts`). Reached only by an idempotency
    //      collision; the caller did not ask for THIS payment.
    //   2. `nextAction: retry_original_x402_request` — the legacy rail's
    //      approval-queue replay (`modules/x402/legacy-authorize.ts` returns
    //      `getAgentPaymentStatus`'s body, which carries no `success` field
    //      at all). This is the DOCUMENTED post-approval retry loop, so the
    //      caller is deliberately resuming a payment they know about.
    //
    // In both, "executed" means the FUNDING leg executed, which is ambiguous:
    //
    //   (a) funding confirmed, merchant never paid  → the delegate still
    //       holds the money and minting a header is correct;
    //   (b) funding confirmed, merchant already paid → the delegate is
    //       empty and any authorization minted here is unfundable.
    //
    // Only the delegate's on-chain balance separates them. The two shapes
    // differ in what an UNVERIFIABLE balance should mean, and they differ for
    // the same reason the explicit `resumeAuthorizedX402` path does: shape 1
    // is an accident, so "can't tell" refuses rather than mint a header we
    // cannot vouch for; shape 2 is the caller following documented steps, so
    // "can't tell" proceeds and only a balance verified ABSENT refuses —
    // otherwise every approval resume without a `chainRpcs` entry would break.
    const state = paymentStateFromRaw('x402 payment', raw)
    const executedReplay = raw.success && raw.tx_hash
      ? 'idempotency-collision' as const
      : state?.nextAction === AgentPaymentNextAction.RetryOriginalX402Request
        ? 'approval-resume' as const
        : null

    if (executedReplay) {
      const canFund = await this.delegateCanFund(
        raw.chain_id ?? state?.chainId ?? chainIdFromNetwork(option.network),
        option.asset,
        x402AuthorizationAmount(option),
      )
      const refuse = executedReplay === 'idempotency-collision'
        ? canFund !== true
        : canFund === false
      if (refuse) {
        const settledReceipt = state && executedReplay === 'approval-resume'
          ? this.mapX402ReceiptFromStatus(paymentRequired, option, undefined, state)
          : this.mapX402ReceiptFromAuthorization(paymentRequired, option, undefined, raw)
        throw new X402AlreadySettledError(
          canFund === false
            ? 'This x402 payment already settled — the delegate no longer holds the funds to ' +
              'authorize it again. To buy the same item a second time, pass a distinct ' +
              '`idempotencyKey`; the synthesised key intentionally collapses repeat calls for ' +
              'the same product within a 5-minute window so a retried request cannot pay twice.'
            : 'This x402 payment already settled, and whether the delegate can still fund a new ' +
              'authorization could not be verified (no `chainRpcs` entry for this chain). Refusing ' +
              'rather than issue an authorization that may be unfundable. To buy the same item a ' +
              'second time, pass a distinct `idempotencyKey`; to finish an interrupted payment, ' +
              'resume it by `paymentId`.',
          settledReceipt,
          canFund === false ? 'settled' : 'unverifiable',
        )
      }
    }

    const paymentHeader = await this.createStandardX402Header(paymentRequired, option)

    if (raw.success && raw.tx_hash) {
      const receipt = this.mapX402ReceiptFromAuthorization(paymentRequired, option, paymentHeader, raw)
      this.cacheX402Receipt(idempotencyKey, paymentHeader, receipt)
      return receipt
    }

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
    const sig = await this.signForData(raw.sign_data)

    // 4. Submit signature (reuse existing payments/:id/sign endpoint)
    const execResult = await this.post<RawSignResponse>(
      `/payments/${raw.payment_id}/sign`,
      { signature: sig },
    )

    if (execResult.status !== 'confirmed') {
      throwPaymentStateError('x402 payment', execResult)
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

  /**
   * Pay a merchant through **erc7710 direct settlement** (#1454, epic #1450).
   *
   * The whole point of this path is what it does NOT do. There is no funding
   * leg: the merchant redeems a delegation chain and pulls from the treasury
   * directly, so the delegate EOA never holds the money, no sweep can strand
   * it, and the #713 reconciliation class does not apply. It is also why this
   * method is SMALLER than the 3009 path — the backend assembles the merchant
   * `X-PAYMENT` header in `assembleSettlementPayload`, so the SDK builds no
   * header locally.
   *
   *     authorize (payTo = the MERCHANT) → sign the child → settle → header
   *
   * The caller then retries the merchant with that header. **Nothing has
   * settled when this returns** — that is why it does not return an
   * `X402Receipt`.
   *
   * Requires a delegation-rail account. The backend enforces that
   * (`validateGenericSchemeRail`), and so does this method, before building a
   * request the backend would only reject: an error a client can explain is
   * worth more than a 400 it has to decode.
   *
   * **MCP callers must pass `options.resourceUrl`.** An in-band MCP 402
   * challenge frequently carries no `resource` object at all, so
   * `paymentRequired.resource?.url` is undefined and the backend answers
   * "Valid url is required". The QA scenario this path was ported from falls
   * back to the request URL for exactly that reason — the SDK cannot, because
   * it never saw the request. Pass it.
   */
  async settleX402Erc7710(
    paymentRequired: X402PaymentRequired,
    options: { resourceUrl?: string } = {},
  ): Promise<X402Erc7710Settlement> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for x402 payments. Pass it in the HavenClient config.',
      )
    }
    const prepared = await this.prepareX402Erc7710(paymentRequired, options)
    const signature = await this.signForData(prepared.signData)
    const paymentHeader = await this.submitX402Erc7710(prepared.paymentId, signature)
    return { ...prepared.settlement, paymentHeader }
  }

  /**
   * The AUTHORIZE half of erc7710 settlement (#1456): select the scheme, build
   * the request, and return the child to be signed — without signing it.
   *
   * Split out because the hosted topology cannot use `settleX402Erc7710()`:
   * that method signs in-process with `delegateKey`, and hosted Haven does not
   * have one and must not. The hosted MCP server drives these two halves with
   * the LOCAL signer in between, so the key stays where it belongs and the
   * request shaping stays in one place rather than being reimplemented.
   */
  async prepareX402Erc7710(
    paymentRequired: X402PaymentRequired,
    options: {
      resourceUrl?: string
      /**
       * The account's rail, when the caller has ALREADY read it from
       * `GET /machine-payments/agent` — passing it skips a duplicate fetch
       * (#1456: the hosted tool reads the agent for the delegate address
       * anyway, and #1348 pins that path to exactly one agent round-trip).
       *
       * This is an optimisation, not a trust boundary: omit it and the rail is
       * read here, and either way the backend independently refuses erc7710
       * from a non-delegation account (`validateGenericSchemeRail`). A caller
       * that asserted the wrong rail would build a request the backend rejects.
       */
      delegationRail?: boolean
      /**
       * #1547: the merchant MCP-tool call this authorization was quoted
       * against, persisted so the settle leg can rehydrate it by payment_id
       * (#1307) — the same option `createX402Intent` already carries. Without
       * it an erc7710 settle needs merchant_url/tool_name/arguments
       * re-threaded, which the guided catalog path (#1305) exists to remove.
       */
      mcpCallContext?: X402McpCallContext
    } = {},
  ): Promise<{
    paymentId: string
    signData: SignData
    settlement: Omit<X402Erc7710Settlement, 'paymentHeader'>
  }> {

    // The rail half of the #1450 preference rule is not visible in a 402
    // response — it is a property of the ACCOUNT, so read it rather than let a
    // caller assert it. #1453's selector takes it as input for exactly this
    // reason, and this is the one place that input is sourced from truth.
    const delegationRail =
      options.delegationRail ?? (await this.getAgent()).executionRail === 'delegation'

    // Rail first, and BEFORE selection — the two failures have different
    // remedies and the caller needs the one that applies. Checking selection
    // first made a legacy-rail agent at an erc7710-only merchant get "no
    // compatible payment option", which is true and useless: the option is
    // there, the account cannot use it. (Found by this method's own tests.)
    if (!delegationRail) {
      throw new HavenApiError(
        'erc7710 settlement requires a delegation-rail account; this one is not on it. ' +
          'Use authorizeX402() for the standard EIP-3009 path.',
        400,
      )
    }

    const selection = selectX402SettlementScheme(paymentRequired.accepts, { delegationRail })

    if (!selection || selection.scheme !== 'erc7710') {
      // Never silently reroute to the other scheme (#1454 AC). On a delegation
      // rail the only remaining reason is the merchant, so name that.
      throw new HavenApiError(
        'This merchant does not advertise an erc7710 settlement option ' +
          "(no accepts[] entry carries extra.assetTransferMethod: 'erc7710'). " +
          'Use authorizeX402() for the standard EIP-3009 path.',
        400,
      )
    }

    const option = selection.option
    const merchantPayTo = option.payTo
    const amountAtomic = x402AuthorizationAmount(option)

    const raw = await this.post<RawX402AuthorizeResponse>('/x402', {
      url: options.resourceUrl ?? paymentRequired.resource?.url,
      // payTo = the MERCHANT is what selects direct settlement server-side.
      // The explicit settlementScheme must AGREE with that shape (#1360) —
      // disagreement is a 400 by design, so that a stale delegate address
      // becomes a loud mismatch instead of a silent reroute to the 3009 leg.
      payTo: merchantPayTo,
      settlementScheme: 'erc7710',
      amount: amountAtomic,
      asset: option.asset,
      network: option.network,
      // The v2 header echoes the accepted entry field-for-field, so the quoted
      // timeout must round-trip or the merchant rejects the echo (#1064).
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      // #1058: forward the advertised facilitators verbatim — the child becomes
      // redeemable ONLY by them. `null` here means the merchant advertised none
      // (or an empty array, which the backend 400s on), so the field is OMITTED
      // rather than sent empty. See x402FacilitatorAddresses.
      ...(selection.facilitatorAddresses
        ? { facilitatorAddresses: selection.facilitatorAddresses }
        : {}),
      // #1307/#1547: persisted so the settle leg can rehydrate the merchant
      // call by payment_id on this scheme too, not only on the 3009 bridge.
      ...(options.mcpCallContext ? { mcpCallContext: options.mcpCallContext } : {}),
    })

    if (!raw.payment_id) {
      throw new HavenApiError('No payment_id returned from x402/authorize', 500, raw)
    }
    const signData = raw.sign_data
    if (signData?.signature_scheme !== 'eip712_delegation' || !signData.typed_data) {
      // The backend chose a different scheme than the shape asked for. Refuse
      // loudly: signing whatever came back would be exactly the "silent
      // reroute" this path exists to make impossible.
      throw new HavenApiError(
        'x402/authorize did not return an erc7710 settlement child ' +
          `(signature_scheme was ${JSON.stringify(signData?.signature_scheme)}). ` +
          'Refusing to sign a payload this path did not ask for.',
        500,
        raw,
      )
    }

    return {
      paymentId: raw.payment_id,
      signData,
      settlement: {
        paymentId: raw.payment_id,
        merchantPayTo,
        amountAtomic,
        asset: option.asset,
        network: option.network,
        facilitatorAddresses: selection.facilitatorAddresses,
      },
    }
  }

  /**
   * The SETTLE half (#1456): exchange the signed child for the merchant header.
   *
   * The SDK builds no header on this path — the backend assembles the MetaMask
   * erc7710 payload in `assembleSettlementPayload`. Whoever produced the
   * signature (an in-process delegate key, or the local edge signer over the
   * hosted boundary) is irrelevant here.
   */
  async submitX402Erc7710(paymentId: string, signature: string): Promise<string> {
    const settled = await this.post<RawX402SettleResponse>(
      `/x402/${paymentId}/settle`,
      { signature },
    )
    if (!settled.payment_header) {
      throw new HavenApiError(
        'x402 settle returned no payment_header — the merchant cannot be retried.',
        500,
        settled,
      )
    }
    return settled.payment_header
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

    // #1521: the same fundability question as the authorize path, with the
    // opposite default. Here the caller NAMED this payment, so an
    // unverifiable balance is not grounds to refuse the thing they asked for
    // — only a balance verified ABSENT is, because then the authorization
    // this would mint is known to be unfundable.
    const canFund = await this.delegateCanFund(
      status.chainId ?? chainIdFromNetwork(option.network),
      option.asset,
      x402AuthorizationAmount(option),
    )
    if (canFund === false) {
      throw new X402AlreadySettledError(
        `x402 payment ${status.paymentId} has already settled — the delegate no longer holds the ` +
        'funds to authorize it again, so there is nothing left to resume.',
        this.mapX402ReceiptFromStatus(input.paymentRequired, option, undefined, status),
        'settled',
      )
    }

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
      const response = await this.merchantTransport.fetch(url, initialInit)
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
    if (this.merchantTransport.isMcpUrl(url)) {
      mcpSessionId = await this.merchantTransport.initialize(url, init)
    }

    let requestInit = this.withX402Wallet(init, this.x402PayerAddress())
    if (mcpSessionId) requestInit = this.merchantTransport.withSessionHeaders(requestInit, mcpSessionId)

    // 1. Make the original request
    const response = await this.merchantTransport.fetch(url, requestInit)

    // 2. Not a 402 — return as-is (collapsing SSE for MCP sessions)
    if (response.status !== 402) {
      return mcpSessionId ? this.merchantTransport.surfaceResult(response) : response
    }

    // #1328: the legacy MACHINE-PAYMENT-CHALLENGE / mpp_demo auto-handling is
    // retired — a 402 that isn't standard x402 (including a stray
    // MACHINE-PAYMENT-CHALLENGE header from a pre-retirement caller) is
    // returned to the agent unmodified rather than auto-paid.

    // 3. Parse x402 payment requirements
    let paymentRequired: X402PaymentRequired
    try {
      paymentRequired = await parsePaymentRequiredResponse(response)
    } catch {
      // Not a standard x402 402 response — return it unchanged.
      return response
    }

    // Signal B: a Bazaar `extensions.bazaar` block marks an MCP-discoverable
    // resource even without the `/mcp` convention. Handshake now (if we
    // haven't already) so the paid retry carries the session id.
    if (!mcpSessionId && (await this.merchantTransport.hasBazaarExtension(response))) {
      mcpSessionId = await this.merchantTransport.initialize(url, init)
      if (mcpSessionId) requestInit = this.merchantTransport.withSessionHeaders(requestInit, mcpSessionId)
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
    return mcpSessionId ? this.merchantTransport.surfaceResult(retryResponse) : retryResponse
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
    const retryResponse = await this.merchantTransport.deliverPayment(
      url,
      initialInit,
      receipt.paymentHeader,
    )

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

    await this.reportMerchantReceipt(receipt.paymentId, retryResponse)

    return retryResponse
  }

  /**
   * #956: capture the merchant's OWN receipt when the paid response carries
   * one, and report it to Haven so the reporting feed can attach it next to
   * the Haven-generated payment evidence (#498). Two supported signals on the
   * paid response:
   *
   *   x-receipt-json: base64-encoded JSON receipt document (inline)
   *   x-receipt-url:  https URL to the receipt document (reference)
   *
   * Strictly best-effort: absence is the normal case, and no failure here may
   * ever affect the completed payment — the response is already paid for.
   */
  private async reportMerchantReceipt(paymentId: string, response: Response): Promise<void> {
    try {
      const inlineB64 = response.headers.get('x-receipt-json')
      const url = response.headers.get('x-receipt-url')
      if (!inlineB64 && !url) return

      let body: Record<string, unknown> | null = null
      if (inlineB64) {
        // Mirror the backend's 64KB decoded cap exactly (base64 inflates 4/3)
        // — don't ship what the server will reject.
        if (inlineB64.length > Math.ceil((64 * 1024 * 4) / 3)) return
        const decoded = JSON.parse(Buffer.from(inlineB64, 'base64').toString('utf8')) as unknown
        if (decoded && typeof decoded === 'object') body = { json: decoded }
      } else if (url && url.startsWith('https://') && url.length <= 2048) {
        body = { url }
      }
      if (!body) return

      await this.post(`/machine-payments/${paymentId}/merchant-receipt`, body)
    } catch {
      // Best-effort by contract — a malformed header or a capture-endpoint
      // hiccup never surfaces to the caller of a successful payment.
    }
  }

  /**
   * Deliver an already-signed x402 payment header to the merchant and return
   * the merchant's response. Used by the hosted MCP server to complete the
   * merchant leg of an MCP tool payment after the edge signer has built the
   * `X-PAYMENT` header.
   *
   * Custody note: this never needs the delegate key. It relays a signed,
   * amount/merchant/nonce-bound EIP-3009 authorization the edge signer already
   * produced — the hosted server cannot mint or reuse signing authority.
   *
   * When the URL is MCP-shaped (`/mcp` path) or the quote-time transport context
   * says the merchant was Bazaar-discoverable, runs a fresh `initialize`
   * handshake (the quote-time session is gone once funding confirms; the x402
   * challenge is stateless w.r.t. the MCP session, so a fresh session is
   * accepted), threads the session + wallet headers, sets `X-PAYMENT`, and
   * collapses an SSE JSON-RPC response to its `result`.
   */
  /**
   * Wait for a payment's Safe→delegate funding tx to reach ≥1 on-chain
   * confirmation. The hosted x402 completion path MUST call this after funding
   * and before delivering the X-PAYMENT header, so the merchant's
   * balanceOf(delegate) / transferWithAuthorization verification sees the funded
   * balance — otherwise it rejects with "Payment verification failed". The
   * SDK's local path already does this (see authorizeStandardX402); the hosted
   * split flow regressed when the 5→3 collapse removed the incidental
   * inter-call latency that used to mask it.
   *
   * **NOT a no-op when the funding tx hash is absent** (#1508). The WAIT is
   * skipped without a hash or a chain RPC, but the `GET /payments/:id` read
   * below runs UNCONDITIONALLY — it is how the fallback hash and the chainId
   * are obtained. That distinction is load-bearing: this method must never be
   * called on a scheme with no funding leg, because the read itself fails once
   * the intent reaches a status the backend maps to a non-2xx (`submitted` is a
   * 409), turning a settled payment into a reported error. The previous wording
   * here said "No-op when the funding tx hash ... is unavailable", and the
   * hosted erc7710 path was written against that promise — see
   * `deliverMerchantPayment`'s `noFundingLeg` option.
   */
  async ensureFundingConfirmed(paymentId: string, fundingTxHash?: string): Promise<void> {
    const status = await this.getPaymentStatus(paymentId)
    await this.waitForFundingTx(fundingTxHash ?? status.txHash ?? undefined, status.chainId)
  }

  async completeX402MerchantCall(input: {
    url: string
    init?: RequestInit
    paymentId: string
    paymentHeader: string
    mcpTransport?: X402McpTransport
    /**
     * #1508: the payment settles with NO funding leg (erc7710). This method was
     * written for EIP-3009 and encodes that lifecycle in two places — the
     * readiness gate wants `confirmed`, and a Haven funding tx hash is
     * mandatory. Neither is reachable on a scheme where the MERCHANT redeems
     * the delegation chain: the intent sits at `submitted` by design, and there
     * is no Haven-submitted transaction at all. Set this to take the
     * no-funding-leg path through both.
     */
    noFundingLeg?: boolean
  }): Promise<{ status: number; ok: boolean; body: unknown; settlementTxHash?: string }> {
    const evidenceContext = await this.resolveX402MerchantCompletionContext({
      paymentId: input.paymentId,
      url: input.url,
      noFundingLeg: input.noFundingLeg === true,
    })
    // Non-null on the funding-leg path (the gate below throws without it) and
    // always null on erc7710. Bound once so the evidence calls — which require
    // a string — are provably unreachable without one.
    const fundingTxHash = evidenceContext.txHash
    const shouldHandshakeMcp =
      this.merchantTransport.isMcpUrl(input.url) ||
      input.mcpTransport?.handshakeRequired === true
    const x402Wallet = shouldHandshakeMcp ? await this.resolveX402WalletForMerchantCall() : this.x402PayerAddress()
    let mcpSessionId: string | undefined
    if (shouldHandshakeMcp) {
      mcpSessionId = await this.merchantTransport.initialize(input.url, input.init, x402Wallet)
    }

    let requestInit: RequestInit = this.withX402Wallet(input.init, x402Wallet) ?? {}
    if (mcpSessionId) requestInit = this.merchantTransport.withSessionHeaders(requestInit, mcpSessionId)

    const response = await this.merchantTransport.deliverPayment(input.url, requestInit, input.paymentHeader)
    const surfaced = mcpSessionId ? await this.merchantTransport.surfaceResult(response) : response
    const protocolReceiptHeader = surfaced.headers.get('PAYMENT-RESPONSE') ?? undefined
    const settlement = parseMerchantSettlement(protocolReceiptHeader ?? null)

    const text = await surfaced.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }

    if (!surfaced.ok) {
      // #1508: both evidence surfaces below require a txHash — the backend
      // answers `400 txHash is required` without one, and these calls swallow
      // failures, so an erc7710 row would vanish silently rather than fail
      // loudly. Skipping deliberately (owner decision 2026-08-17) instead of
      // writing a row that cannot be written: their consumer is funding-leg
      // reconciliation (#713 — stranded delegate balances), and this rail has
      // no funding leg to strand. The merchant receipt below still runs, so the
      // paid call remains recorded.
      if (!input.noFundingLeg && fundingTxHash) {
        await this.recordMerchantRetryRejected({
          rail: 'x402',
          paymentId: evidenceContext.paymentId,
          txHash: fundingTxHash,
          resourceUrl: evidenceContext.resourceUrl,
          merchant: {
            merchant_status: surfaced.status,
            merchant_status_text: surfaced.statusText,
            merchant_headers: Object.fromEntries(surfaced.headers.entries()),
            merchant_body: text,
          },
          details: {
            merchant_to: evidenceContext.merchantAddress,
          },
        })
      }
    } else {
      if (!input.noFundingLeg && fundingTxHash) {
        await this.reportMachinePaymentEvidence({
          paymentId: evidenceContext.paymentId,
          rail: 'x402',
          txHash: fundingTxHash,
          resourceUrl: evidenceContext.resourceUrl,
          merchantStatus: surfaced.status,
          paymentProofHeaderName: 'X-PAYMENT',
          paymentProofHeader: input.paymentHeader,
          protocolReceiptHeaderName: protocolReceiptHeader ? 'PAYMENT-RESPONSE' : undefined,
          protocolReceiptHeader,
        })
      }
      // #956: the hosted-MCP completion path is a successful paid retry too —
      // capture the merchant's receipt exactly like the local flow does.
      await this.reportMerchantReceipt(evidenceContext.paymentId, surfaced)
    }

    return {
      status: surfaced.status,
      ok: surfaced.ok,
      body,
      settlementTxHash: settlement.settlementTxHash ?? undefined,
    }
  }

  /**
   * GET /x402/:id/merchant-call-context — the settle-leg twin of #1263's
   * sign-context fetch (#1307). Re-serves the stored merchant MCP-tool call
   * context (merchant_url, tool_name, arguments, mcp_transport) recorded at
   * quote time, so `haven_settle_mcp_tool` / `haven_complete_mcp_tool` can
   * omit those fields and let Haven rehydrate them by payment_id instead of
   * the caller re-threading them. Throws `HavenApiError` (404 unknown/foreign
   * payment_id, 409 no stored context, 410 expired) — the caller decides the
   * fallback (re-send the full context explicitly).
   */
  async getX402MerchantCallContext(paymentId: string): Promise<X402MerchantCallContext> {
    const raw = await this.get<RawX402MerchantCallContext>(
      `/x402/${paymentId}/merchant-call-context`,
    )
    return {
      paymentId: raw.payment_id,
      merchantUrl: raw.merchant_url,
      toolName: raw.tool_name,
      arguments: raw.arguments ?? {},
      ...(raw.mcp_transport
        ? {
            mcpTransport: {
              handshakeRequired: raw.mcp_transport.handshake_required,
              source: raw.mcp_transport.source,
            },
          }
        : {}),
    }
  }

  private async resolveX402MerchantCompletionContext(input: {
    paymentId: string
    url: string
    /** #1508: see completeX402MerchantCall's option of the same name. */
    noFundingLeg?: boolean
  }): Promise<{
    paymentId: string
    /** Null on a no-funding-leg scheme — there is no Haven-submitted tx. */
    txHash: string | null
    resourceUrl: string
    merchantAddress: string | null
  }> {
    const status = await this.getPaymentStatus(input.paymentId)

    if (status.rail !== 'x402') {
      throw new HavenPaymentStateError(
        `Payment ${status.paymentId} is ${status.rail}, not x402.`,
        409,
        status,
      )
    }

    // #1508: BOTH conditions below encode the EIP-3009 lifecycle, where
    // `confirmed` means Haven's funding transaction mined and its hash is the
    // evidence anchor. On a no-funding-leg scheme neither is reachable, and
    // #1456 reused this helper unadapted — so every hosted erc7710 call threw
    // `HavenPaymentStateError(status.message)`, surfacing as "The payment was
    // submitted and is waiting for confirmation" AFTER the settlement had
    // already succeeded, with the merchant never contacted.
    //
    // `submitted` is not a transient state to wait out here: it is the CORRECT
    // and final Haven-side state for erc7710 (`modules/x402/settle.ts` — "The
    // intent flips to 'submitted'; final settlement is observed via the
    // merchant/receipt path"). The merchant redeems the [child, budget] chain,
    // which is exactly the call this method is about to make.
    const readyForMerchantCompletion = input.noFundingLeg
      ? status.kind === 'payment_intent' && status.status === 'submitted'
      : status.nextAction === AgentPaymentNextAction.RetryOriginalX402Request ||
        (
          status.kind === 'payment_intent' &&
          status.status === 'confirmed' &&
          status.phase === AgentPaymentPhase.PaymentConfirmed &&
          status.nextAction === AgentPaymentNextAction.None
        )

    if (!readyForMerchantCompletion) {
      throw new HavenPaymentStateError(status.message, paymentStateStatusCode(status.status, 409), status)
    }

    // Deliberately NOT relaxed to "absent is fine": on the funding-leg path a
    // missing hash still means the evidence anchor is gone and remains a 502.
    // The no-funding-leg path skips it because there is no such transaction to
    // be missing — not because the check is inconvenient.
    if (!input.noFundingLeg && !status.txHash) {
      throw new HavenApiError(
        `x402 payment ${status.paymentId} is ready for merchant completion but has no Haven transaction hash.`,
        502,
        status,
        status.paymentId,
      )
    }

    const approvedResourceUrl = status.resourceUrl ?? status.x402?.resourceUrl ?? null
    if (approvedResourceUrl && approvedResourceUrl !== input.url) {
      throw new HavenApiError(
        'x402 merchant completion does not match the approved resource URL.',
        409,
        { status, url: input.url },
        status.paymentId,
      )
    }

    return {
      paymentId: status.paymentId,
      txHash: status.txHash,
      resourceUrl: approvedResourceUrl ?? input.url,
      merchantAddress: status.merchantAddress ?? status.x402?.merchantAddress ?? null,
    }
  }

  private async resolveX402WalletForMerchantCall(): Promise<string | undefined> {
    const localWallet = this.x402PayerAddress()
    if (localWallet) return localWallet

    try {
      const agent = await this.getAgent()
      return agent.delegateAddress ?? undefined
    } catch {
      return undefined
    }
  }

  // #1328: authorizeMachinePayment / authorizeMppDemoPayment / resumeAuthorizedMpp
  // / resumeMppPayment / fetchWithMachinePayment / retryMppRequest (the
  // MACHINE-PAYMENT-CHALLENGE / mpp_demo client surface) are retired — the
  // backend's POST /machine-payments/authorize refuses unconditionally now,
  // and MACHINE-PAYMENT-CHALLENGE was never produced by any other Haven
  // surface. Use the x402 flow (authorizeX402 / fetch / quoteX402 / payX402Quote)
  // for agent-to-merchant payments.

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
      throw new HavenPaymentStateError(status.message, paymentStateStatusCode(status.status, 409), status)
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


  private mapX402ReceiptFromAuthorization(
    paymentRequired: X402PaymentRequired,
    option: X402PaymentOption,
    // #1521: `undefined` builds the receipt for a payment that already
    // settled. A settled payment has no live authorization to carry, and
    // minting one to fill this slot is precisely the defect that issue names.
    paymentHeader: string | undefined,
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
    // See `mapX402ReceiptFromAuthorization` — `undefined` is the settled case.
    paymentHeader: string | undefined,
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
    // #1521: absent for a receipt describing an ALREADY-SETTLED payment,
    // which has no live authorization to carry. `X402Receipt.paymentHeader`
    // was already optional; only these builders assumed otherwise.
    paymentHeader: string | undefined
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

  /**
   * Can the delegate EOA still fund an authorization for `amountAtomic`?
   *
   * #1521: the only question that separates a legitimate resume (funding
   * confirmed, merchant never paid — the delegate still holds the money) from
   * a replayed settled payment (funding confirmed, merchant paid, delegate
   * spent). The intent's own `status: 'confirmed'` is identical in both.
   *
   * The balance is asked of the CHAIN rather than of Haven's bookkeeping on
   * purpose: the merchant-settlement evidence record is written by this SDK
   * *after* the merchant call, so a client that dies between the two leaves
   * the backend believing the merchant was never paid — the exact case the
   * discriminator has to get right. The chain cannot be behind in that way.
   *
   * Returns `null` — never a guess — when `chainRpcs` has no entry for the
   * chain or the read fails. Callers must treat that as "unverifiable", not
   * as "funded".
   */
  private async delegateCanFund(
    chainId: number | undefined,
    tokenAddress: string,
    amountAtomic: string,
    timeoutMs = 10_000,
  ): Promise<boolean | null> {
    if (!chainId || !this.delegateAddress) return null
    const rpcUrl = this.chainRpcs[chainId]
    if (!rpcUrl) return null
    try {
      const provider = createJsonRpcProvider(rpcUrl)
      const token = createErc20Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'] as const,
        provider,
      )
      // Bounded like `waitForFundingTx` below. This sits on a money
      // authorization path with no way for a caller to route around a stall,
      // so an unresponsive RPC must degrade to "unverifiable" rather than
      // hang the payment: a slow answer is worth less than a prompt refusal.
      const balance = await Promise.race([
        token.balanceOf(this.delegateAddress) as Promise<bigint>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
      ])
      if (balance === null) return null
      return balance >= BigInt(amountAtomic)
    } catch {
      // An RPC that is down, or an amount that will not parse, tells us
      // nothing about the delegate's balance. Saying so is the whole point of
      // the tri-state — and on the accidental-replay path it fails toward
      // refusing, never toward minting.
      return null
    }
  }

  private throwIfNonSignableAuthorizationState(
    label: string,
    raw: RawX402AuthorizeResponse,
  ): void {
    if (raw.status === 'pending_signature') return
    throwPaymentStateError(label, raw)
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
    mcpTransport?: X402McpTransport,
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
      ...(mcpTransport ? { mcpTransport } : {}),
      resourceUrl: paymentRequired.resource.url,
      description: paymentRequired.resource.description ?? option.description ?? null,
      mimeType: paymentRequired.resource.mimeType ?? option.mimeType ?? null,
      amountAtomic: x402AuthorizationAmount(option),
      amount: decimalFromUsdcAtomic(x402AuthorizationAmount(option)),
      token: token?.symbol ?? 'USDC',
      // #1351: null when the asset is unrecognised on this network — the
      // `token` fallback above is a LABEL, not evidence of 6 decimals, and a
      // human-denominated cap must fail closed rather than convert against a
      // guess. Same resolution as `token`, so the two never disagree.
      decimals: token?.decimals ?? null,
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

  // #1328: attachResumeState's 'mpp' branch (buildMppQuote / buildMppResumeState
  // / attachMppResumeState) is retired along with the rest of the MPP-demo
  // client surface — every remaining caller passes rail: 'x402' only, so this
  // is now a direct alias for attachX402ResumeState rather than a dispatcher.
  private attachResumeState(
    err: unknown,
    input: {
      rail: 'x402'
      paymentRequired: X402PaymentRequired
      accepted: X402PaymentOption
      idempotencyKey: string
      request?: X402RequestSnapshot
    },
  ): void {
    this.attachX402ResumeState(
      err,
      input.paymentRequired,
      input.accepted,
      input.idempotencyKey,
      input.request,
    )
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

    // #1328: the 'authorize_machine_payment' tool (mpp_demo only) is retired
    // along with the rest of the SDK's MPP-demo client surface — an unknown
    // toolName falls through to the Error below, same as any other retired name.

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
    return this.havenApi.post<T>(path, body)
  }

  private async get<T>(path: string): Promise<T> {
    return this.havenApi.get<T>(path)
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
