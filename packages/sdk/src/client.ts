import { hashTypedData } from 'viem'
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
  HavenAgent,
  HavenAgentSummary,
  HavenAgentAllowanceSummary,
  HavenAllowanceSummary,
  PostPurchaseAllowanceSummary,
  HavenPaymentReceipt,
  CatalogSubmissionAccepted,
  HavenCatalogEntry,
  HavenCatalogSubmission,
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
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
} from './types.js'
import {
  buildX402IdempotencyKey,
  parsePaymentRequiredResponse,
  resolveTokenFromAddress,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
  x402AuthorizationAmount,
  x402PaymentHeaderNamesSent,
} from './x402.js'
import type {
  SweepAuthorization,
  SweepPrepareResponse,
  SweepSubmitResponse,
} from './sweep.js'
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
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import { AccountReads } from './account-reads.js'
import { DelegateSweepApi } from './delegate-sweep.js'
import {
  assertCanResumeX402,
  attachResumeState,
  buildExplorerUrl,
  buildX402Quote,
  chainIdFromNetwork,
  chainIdOrNull,
  decimalFromUsdcAtomic,
  explorerUrlOrEmpty,
  noCompatiblePaymentOptionError,
  requestInitFromSnapshot,
  sameAddress,
  snapshotX402Request,
  withX402Wallet,
  x402PayerAddress,
} from './x402-protocol.js'
import { X402FundingLeg } from './x402-funding-leg.js'
import { X402Erc7710 } from './x402-erc7710.js'
import { toolError, toolX402PaymentRequired, x402ToolReceipt } from './tool-adapter.js'
import { MerchantCompletion, parseMerchantSettlement } from './merchant-completion.js'
import type { X402MerchantOutcome, X402MerchantOutcomeReport } from './merchant-completion.js'

const DEFAULT_POLLING_INTERVAL = 3_000

/** Cap the merchant body persisted to the reconciliation event (the full body is kept on the thrown error). */
const MERCHANT_BODY_SNIPPET_LIMIT = 1000


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
    source: entry.source,
    domainVerified: entry.domain_verified,
    verifiedPayable: entry.verified_payable,
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
  /**
   * The EIP-3009 funding-leg lifecycle (#1618). The facade holds a reference
   * and delegates; it does not reimplement any of it.
   */
  private readonly fundingLeg: X402FundingLeg
  /**
   * The erc7710 direct-settlement lifecycle (#1619). Separate from the funding
   * leg on purpose: this scheme has no funding leg to share.
   */
  private readonly erc7710: X402Erc7710
  /**
   * Merchant delivery and the evidence trail behind it (#1620). Scheme-neutral
   * on purpose — both settlement schemes finish through the same door.
   */
  private readonly merchantCompletion: MerchantCompletion
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
    // #1756 moved the 90 s literal to `types.ts` so the delegate sweep shares
    // this number rather than choosing a fourth one. Same value, same default.
    this.confirmationTimeout = config.confirmationTimeout ?? DEFAULT_CONFIRMATION_TIMEOUT_MS
    this.pollingInterval = config.pollingInterval ?? DEFAULT_POLLING_INTERVAL
    this.chainRpcs = config.chainRpcs ?? {}
    if (this.delegateKey) {
      this.delegateAddress = addressFromKey(this.delegateKey)
    }
    // Constructed LAST: the funding leg pays into `delegateAddress`, which is
    // only derived on the line above.
    this.fundingLeg = new X402FundingLeg({
      delegateKey: this.delegateKey,
      delegateAddress: this.delegateAddress,
      x402Wallet: this.x402Wallet,
      chainRpcs: this.chainRpcs,
      post: (path, body) => this.post(path, body),
      signForData: (signData) => this.signForData(signData),
      assertSignableAuthorizationState: (label, raw) =>
        this.throwIfNonSignableAuthorizationState(label, raw),
    })
    this.merchantCompletion = new MerchantCompletion({
      post: (path, body) => this.post(path, body),
      merchantTransport: this.merchantTransport,
      getPaymentStatus: (paymentId) => this.getPaymentStatus(paymentId),
      getAgent: () => this.getAgent(),
      delegateAddress: this.delegateAddress,
      x402Wallet: this.x402Wallet,
    })
    this.erc7710 = new X402Erc7710({
      delegateKey: this.delegateKey,
      post: (path, body) => this.post(path, body),
      signForData: (signData) => this.signForData(signData),
      getAgent: () => this.getAgent(),
    })
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
      throw noCompatiblePaymentOptionError(paymentRequired.accepts)
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
      payerDelegate: (raw as { payer_delegate?: string }).payer_delegate,
      payerAgentId: (raw as { payer_agent_id?: string }).payer_agent_id,
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
   * Discover payable services from Haven's merchant catalog (epic #1717).
   *
   * Read-only: returns catalog entries (price, rail, protocol) so an agent
   * can choose a service and pay it with the regular payment tools in the
   * same session. Never creates payments or signatures.
   */
  async discoverTools(
    options: {
      category?: string
      search?: string
      rail?: 'x402' | 'mpp'
      /**
       * Filter on the entry's provenance (epic #1717): `'verified'` returns
       * only self-submitted, domain-verified, probe-verified directory
       * entries; `'operator'` only the operator-curated ones; `'any'` (the
       * default) returns the merged listing.
       */
      verified?: 'any' | 'verified' | 'operator'
    } = {},
  ): Promise<HavenCatalogEntry[]> {
    const params = new URLSearchParams()
    if (options.category) params.set('category', options.category)
    if (options.search !== undefined) params.set('search', options.search)
    if (options.rail) params.set('rail', options.rail)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    const raw = await this.get<{ entries: RawCatalogEntry[] }>(`/catalog${query}`)
    let entries = raw.entries.map(mapCatalogEntry)
    if (options.verified === 'verified') entries = entries.filter((e) => e.source === 'ingestion')
    if (options.verified === 'operator') entries = entries.filter((e) => e.source === 'operator')
    return entries
  }

  /**
   * Submit a merchant's payable (x402/MCP) endpoint to the Verified Payable
   * Directory (epic #1717, #1716). Queue-only: writes a submission row and
   * returns the id + verify_token. The request path makes no outbound
   * request; domain-ownership proof and the read-only quote probe run later
   * on the leader-locked monitor. Ownership proof is ALWAYS required before
   * any listing — this method cannot skip it. `website` is a honeypot field
   * that bots fill; leave it unset.
   */
  async submitCatalogEntry(
    resourceUrl: string,
    options: { website?: string } = {},
  ): Promise<HavenCatalogSubmission> {
    const accepted = await this.post<CatalogSubmissionAccepted>('/catalog/submit', {
      resource_url: resourceUrl,
      ...(options.website ? { website: options.website } : {}),
    })
    return {
      id: accepted.id,
      verifyToken: accepted.verify_token,
      status: accepted.status,
    }
  }

  /**
   * Fetch one submission's coarse status by id (epic #1717, #1716). Public
   * and read-only. While the submission can still prove ownership the
   * response carries the exact well-known / DNS-TXT `instructions`; the
   * verify token is never returned here.
   */
  async getCatalogSubmissionStatus(
    id: string,
  ): Promise<{
    id: string
    status: 'submitted' | 'ownership_verified' | 'verified_payable' | 'failed' | 'delisted'
    instructions?: {
      expires_at: string
      well_known: { url: string; content: string; instruction: string }
      dns_txt: { name: string; value: string; instruction: string }
    } | null
  }> {
    return this.get(`/catalog/submit/${encodeURIComponent(id)}`)
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
      throw noCompatiblePaymentOptionError(paymentRequired.accepts)
    }

    const idempotencyKey = options.idempotencyKey ?? buildX402IdempotencyKey(paymentRequired, option)
    const cached = this.fundingLeg.cachedReceipt(idempotencyKey)
    if (cached) return cached

    const inFlight = this.inFlightX402.get(idempotencyKey)
    if (inFlight) return inFlight

    const promise = this.fundingLeg.authorize(paymentRequired, option, idempotencyKey)
    this.inFlightX402.set(idempotencyKey, promise)

    try {
      return await promise
    } catch (err) {
      attachResumeState(err, {
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
    const initialInit = withX402Wallet(init, x402PayerAddress(this.delegateAddress, this.x402Wallet))
    const request = snapshotX402Request(url, initialInit)
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
    return buildX402Quote(paymentRequired, request, options.idempotencyKey, mcpTransport)
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
    const wallet = await this.merchantCompletion.resolveWalletForMerchantCall()
    const sessionId = await this.merchantTransport.initialize(url, init, wallet)
    if (!sessionId) {
      throw new HavenApiError(
        'The merchant did not establish an MCP session before the x402 quote. No payment was created.',
        502,
        { mcpSessionNotEstablished: true },
      )
    }

    let requestInit = withX402Wallet(init, wallet)
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
      return this.merchantCompletion.retryRequest(
        quote.request.url,
        requestInitFromSnapshot(quote.request),
        quote.paymentRequired,
        receipt,
      )
    } catch (err) {
      attachResumeState(err, {
        rail: 'x402',
        paymentRequired: quote.paymentRequired,
        accepted: quote.accepted,
        idempotencyKey,
        request: quote.request,
      })
      throw err
    }
  }

  /**
   * Pay a merchant through **erc7710 direct settlement** (#1454, epic #1450).
   *
   * **Nothing has settled when this returns** — that is why it does not return
   * an `X402Receipt`; the caller still has to retry the merchant with the
   * header. **MCP callers must pass `options.resourceUrl`**, because an in-band
   * MCP 402 challenge frequently carries no `resource` object at all.
   *
   * Both caveats, and why this scheme has no funding leg, are explained where
   * the lifecycle lives: `x402-erc7710.ts` (#1619).
   */
  async settleX402Erc7710(
    paymentRequired: X402PaymentRequired,
    options: { resourceUrl?: string } = {},
  ): Promise<X402Erc7710Settlement> {
    return this.erc7710.settle(paymentRequired, options)
  }

  /**
   * The AUTHORIZE half of erc7710 settlement (#1456): select the scheme, build
   * the request, and return the child to be signed — without signing it.
   *
   * Split out because the hosted topology cannot use `settleX402Erc7710()`:
   * that method signs in-process with `delegateKey`, and hosted Haven does not
   * have one and must not.
   */
  async prepareX402Erc7710(
    paymentRequired: X402PaymentRequired,
    options: {
      resourceUrl?: string
      /**
       * The account's rail, when the caller has ALREADY read it — passing it
       * skips a duplicate fetch (#1456). An optimisation, not a trust
       * boundary: the backend independently refuses a non-delegation account
       * at the rail seam (the #1986 retired-rail 410, #2245).
       */
      delegationRail?: boolean
      /**
       * #1547: the merchant MCP-tool call this authorization was quoted
       * against, persisted so the settle leg can rehydrate it by payment_id
       * (#1307).
       */
      mcpCallContext?: X402McpCallContext
      /**
       * #2041: replay key, as `createX402Intent` already takes one. Without it
       * a retried authorize mints a second signable settlement child instead
       * of replaying the first.
       */
      idempotencyKey?: string
    } = {},
  ): Promise<{
    paymentId: string
    signData: SignData
    settlement: Omit<X402Erc7710Settlement, 'paymentHeader'>
  }> {
    return this.erc7710.prepare(paymentRequired, options)
  }

  /**
   * The SETTLE half (#1456): exchange the signed child for the merchant header.
   *
   * The SDK builds no header on this path — the backend assembles the MetaMask
   * erc7710 payload. Whoever produced the signature (an in-process delegate
   * key, or the local edge signer over the hosted boundary) is irrelevant.
   */
  async submitX402Erc7710(paymentId: string, signature: string): Promise<string> {
    return this.erc7710.submit(paymentId, signature)
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
      throw noCompatiblePaymentOptionError(input.paymentRequired.accepts)
    }

    const idempotencyKey = input.idempotencyKey ?? buildX402IdempotencyKey(input.paymentRequired, option)
    const cached = this.fundingLeg.cachedReceipt(idempotencyKey)
    if (cached) return cached

    const status = await this.getPaymentStatus(input.paymentId)
    assertCanResumeX402(status, input.paymentRequired, option)

    // #1521: the same fundability question as the authorize path, with the
    // opposite default. Here the caller NAMED this payment, so an
    // unverifiable balance is not grounds to refuse the thing they asked for
    // — only a balance verified ABSENT is, because then the authorization
    // this would mint is known to be unfundable.
    const canFund = await this.fundingLeg.delegateCanFund(
      status.chainId ?? chainIdFromNetwork(option.network),
      option.asset,
      x402AuthorizationAmount(option),
    )
    if (canFund === false) {
      throw new X402AlreadySettledError(
        `x402 payment ${status.paymentId} has already settled — the delegate no longer holds the ` +
        'funds to authorize it again, so there is nothing left to resume.',
        this.fundingLeg.receiptFromStatus(input.paymentRequired, option, undefined, status),
        'settled',
      )
    }

    const paymentHeader = await this.fundingLeg.createPaymentHeader(input.paymentRequired, option)
    const receipt = this.fundingLeg.receiptFromStatus(input.paymentRequired, option, paymentHeader, status)
    this.fundingLeg.cacheReceipt(idempotencyKey, paymentHeader, receipt)
    return receipt
  }

  async resumeX402Payment(input: ResumeX402PaymentInput | X402ResumeState): Promise<Response> {
    const inputInit = 'init' in input ? input.init : undefined
    const initialInit = withX402Wallet(
      inputInit ?? (input.request ? requestInitFromSnapshot(input.request) : undefined),
      x402PayerAddress(this.delegateAddress, this.x402Wallet),
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

    return this.merchantCompletion.retryRequest(url ?? paymentRequired.resource.url, initialInit, paymentRequired, receipt)
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

    let requestInit = withX402Wallet(init, x402PayerAddress(this.delegateAddress, this.x402Wallet))
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
    const request = snapshotX402Request(url, requestInit)
    const option = selectStandardPaymentOption(paymentRequired.accepts)
    const idempotencyKey = options.idempotencyKey ?? (option ? buildX402IdempotencyKey(paymentRequired, option) : undefined)
    let receipt: X402Receipt
    try {
      receipt = await this.authorizeX402(paymentRequired, options)
    } catch (err) {
      if (option && idempotencyKey) {
        attachResumeState(err, {
          rail: 'x402',
          paymentRequired,
          accepted: option,
          idempotencyKey,
          request,
        })
      }
      throw err
    }
    const retryResponse = await this.merchantCompletion.retryRequest(url, requestInit, paymentRequired, receipt)
    return mcpSessionId ? this.merchantTransport.surfaceResult(retryResponse) : retryResponse
  }

  /**
   * Deliver an already-signed x402 payment header to the merchant and return
   * the merchant's response. Used by the hosted MCP server to complete the
   * merchant leg of an MCP tool payment after the edge signer has built the
   * merchant payment header.
   *
   * Custody note: this never needs the delegate key. It relays a signed,
   * amount/merchant/nonce-bound EIP-3009 authorization the edge signer already
   * produced — the hosted server cannot mint or reuse signing authority.
   *
   * When the URL is MCP-shaped (`/mcp` path) or the quote-time transport context
   * says the merchant was Bazaar-discoverable, runs a fresh `initialize`
   * handshake (the quote-time session is gone once funding confirms; the x402
   * challenge is stateless w.r.t. the MCP session, so a fresh session is
   * accepted), threads the session + wallet headers, sets both x402 wire names, and
   * collapses an SSE JSON-RPC response to its `result`.
   */
  /**
   * Wait for a payment's Safe→delegate funding tx to reach ≥1 on-chain
   * confirmation. The hosted x402 completion path MUST call this after funding
   * and before delivering the merchant payment header, so the merchant's
   * balanceOf(delegate) / transferWithAuthorization verification sees the funded
   * balance — otherwise it rejects with "Payment verification failed". The
   * SDK's local path already does this (see `X402FundingLeg.authorize`); the hosted
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
    await this.fundingLeg.waitForFundingTx(fundingTxHash ?? status.txHash ?? undefined, status.chainId)
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
    const evidenceContext = await this.merchantCompletion.resolveCompletionContext({
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
    const x402Wallet = shouldHandshakeMcp ? await this.merchantCompletion.resolveWalletForMerchantCall() : x402PayerAddress(this.delegateAddress, this.x402Wallet)
    let mcpSessionId: string | undefined
    if (shouldHandshakeMcp) {
      mcpSessionId = await this.merchantTransport.initialize(input.url, input.init, x402Wallet)
    }

    let requestInit: RequestInit = withX402Wallet(input.init, x402Wallet) ?? {}
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
        await this.merchantCompletion.recordRetryRejected({
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
      // #2092: the evidence anchor is scheme-dependent, and skipping it on
      // erc7710 (#1508) left a whole settlement scheme with no
      // `machine_payment_evidence` row — and therefore invisible to the Fortnox
      // reporting feed, `GET /receipts`, transaction history, and the
      // merchant-receipt capture on the very next line (which 404s without an
      // evidence row). The #1508 reasoning — "evidence's consumer is
      // funding-leg reconciliation, and this rail has no funding leg" — was
      // true about #713 and incomplete about everything else evidence feeds.
      //
      // On the funding-leg path the anchor is Haven's funding transaction; on
      // erc7710 it is the MERCHANT's settlement transaction, which the merchant
      // just handed us in `PAYMENT-RESPONSE`. Both are reported through the
      // same call, so the backend and every consumer keep one code path. The
      // backend verifies the erc7710 hash on-chain before it confirms anything
      // (#2092), so reporting it is a claim, not an authority.
      const evidenceTxHash = input.noFundingLeg
        ? (settlement.settlementTxHash ?? undefined)
        : (fundingTxHash ?? undefined)
      // #2117: when the merchant returned no settlement transaction there is
      // simply nothing to report, and inventing an anchor client-side is what
      // the backend's on-chain verification exists to prevent. That gap is
      // closed SERVER-side instead, by the passive settlement sweep
      // (`modules/x402/settlement-sweeper.ts`), which finds the settlement by
      // this payment's own intent-unique delegation child. Do not "fix" this
      // branch by fabricating a hash.
      if (evidenceTxHash) {
        await this.merchantCompletion.reportEvidence({
          paymentId: evidenceContext.paymentId,
          rail: 'x402',
          txHash: evidenceTxHash,
          resourceUrl: evidenceContext.resourceUrl,
          merchantStatus: surfaced.status,
          paymentProofHeaderName: x402PaymentHeaderNamesSent(input.paymentHeader),
          paymentProofHeader: input.paymentHeader,
          protocolReceiptHeaderName: protocolReceiptHeader ? 'PAYMENT-RESPONSE' : undefined,
          protocolReceiptHeader,
        })
      }
      // #956: the hosted-MCP completion path is a successful paid retry too —
      // capture the merchant's receipt exactly like the local flow does.
      await this.merchantCompletion.reportMerchantReceipt(evidenceContext.paymentId, surfaced)
    }

    return {
      status: surfaced.status,
      ok: surfaced.ok,
      body,
      settlementTxHash: settlement.settlementTxHash ?? undefined,
    }
  }

  /**
   * #2292: report the outcome of a merchant retry the AGENT performed.
   *
   * The hosted `haven_complete_mcp_tool` / `completeX402MerchantCall` path is
   * for merchants Haven calls itself. On the plain-HTTP x402 path Haven never
   * talks to the merchant, so the outcome of that retry had no way back —
   * see `MerchantCompletion.reportMerchantOutcome` for what is verified about
   * a caller-asserted report and what deliberately is not.
   */
  async reportX402MerchantOutcome(input: {
    paymentId: string
    outcome: X402MerchantOutcome
    merchantStatus: number
    merchantBody?: string
  }): Promise<X402MerchantOutcomeReport> {
    return await this.merchantCompletion.reportMerchantOutcome(input)
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

  /**
   * Wait for a funding tx to be mined with ≥1 confirmation before the
   * merchant retry, eliminating the race where the merchant's
   * `balanceOf(delegate)` runs before the funding block propagates.
   *
   * Skipped when `chainRpcs` does not include the chain; in that case Haven's
   * backend has already confirmed on-chain submission and callers accept the
   * small propagation window as a trade-off for not configuring an RPC URL.
   */
  private throwIfNonSignableAuthorizationState(
    label: string,
    raw: RawX402AuthorizeResponse,
  ): void {
    if (raw.status === 'pending_signature') return
    throwPaymentStateError(label, raw)
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
        return toolError(err)
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
          toolX402PaymentRequired({ url, payTo, amount, asset, network, description }),
          { idempotencyKey },
        )
        return x402ToolReceipt(receipt)
      } catch (err) {
        return toolError(err)
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
          paymentRequired: toolX402PaymentRequired({ url, payTo, amount, asset, network, description }),
          idempotencyKey,
        })
        return x402ToolReceipt(receipt)
      } catch (err) {
        return toolError(err)
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

