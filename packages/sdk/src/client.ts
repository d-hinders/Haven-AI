import { exact } from 'x402/schemes'
import { privateKeyToAccount } from 'viem/accounts'
import { signHash, addressFromKey, verifySignature } from './signer.js'
import type {
  HavenClientConfig,
  PaymentRequest,
  PaymentIntent,
  PaymentResult,
  PaymentStatus,
  SignData,
  RawCreateResponse,
  RawSignResponse,
  RawStatusResponse,
  X402PaymentRequired,
  X402PaymentOption,
  X402Receipt,
  RawX402AuthorizeResponse,
  MachinePaymentChallenge,
  MachinePaymentReceipt,
  RawMachinePaymentAuthorizeResponse,
} from './types.js'
import {
  HavenApiError,
  HavenSigningError,
  HavenTimeoutError,
} from './types.js'
import {
  buildX402IdempotencyKey,
  parsePaymentRequiredResponse,
  selectStandardPaymentOption,
  toStandardPaymentRequirements,
} from './x402.js'
import {
  buildMachinePaymentIdempotencyKey,
  encodeMachinePaymentProof,
  parseMachinePaymentChallengeResponse,
} from './mpp.js'

const DEFAULT_BASE_URL = 'http://localhost:3001'

const CHAIN_EXPLORER_TX: Record<number, string> = {
  100:  'https://gnosisscan.io/tx',
  8453: 'https://basescan.org/tx',
}

function buildExplorerUrl(chainId: number | undefined, txHash: string): string {
  const base = CHAIN_EXPLORER_TX[chainId ?? 8453] ?? CHAIN_EXPLORER_TX[8453]
  return `${base}/${txHash}`
}
const DEFAULT_REQUEST_TIMEOUT = 30_000
const DEFAULT_CONFIRMATION_TIMEOUT = 90_000
const DEFAULT_POLLING_INTERVAL = 3_000

const PAYMENT_STATE_STATUS_CODES: Record<string, number> = {
  pending_approval: 202,
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

export class HavenClient {
  private readonly apiKey: string
  private readonly delegateKey: string | undefined
  private readonly baseUrl: string
  private readonly x402Wallet: string | undefined
  private readonly requestTimeout: number
  private readonly confirmationTimeout: number
  private readonly pollingInterval: number
  private readonly inFlightX402 = new Map<string, Promise<X402Receipt>>()
  private readonly x402ReceiptCache = new Map<string, { expiresAt: number; receipt: X402Receipt }>()
  private readonly inFlightMachinePayments = new Map<string, Promise<MachinePaymentReceipt>>()

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

    if (this.delegateKey) {
      this.delegateAddress = addressFromKey(this.delegateKey)
    }
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
      throw new HavenApiError(
        `Payment exceeds the on-chain allowance and was queued for owner approval (payment_id: ${raw.payment_id}).`,
        202,
        raw,
      )
    }

    return {
      paymentId: raw.payment_id,
      status: 'pending_signature',
      expiresAt: raw.expires_at,
      signData: raw.sign_data,
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
  async authorizeX402(paymentRequired: X402PaymentRequired): Promise<X402Receipt> {
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

    const idempotencyKey = buildX402IdempotencyKey(paymentRequired, option)
    const cached = this.x402ReceiptCache.get(idempotencyKey)
    if (cached && cached.expiresAt > Date.now()) return cached.receipt

    const inFlight = this.inFlightX402.get(idempotencyKey)
    if (inFlight) return inFlight

    const promise = this.authorizeStandardX402(paymentRequired, option, idempotencyKey)
    this.inFlightX402.set(idempotencyKey, promise)

    try {
      return await promise
    } finally {
      this.inFlightX402.delete(idempotencyKey)
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
      amount: option.amount,
      asset: option.asset,
      network: option.network,
      description: paymentRequired.resource.description,
      idempotencyKey,
    })

    // If the backend already executed (shouldn't happen without sig), return
    if (raw.success && raw.tx_hash) {
      const receipt = {
        success: true,
        paymentId: raw.payment_id,
        txHash: raw.tx_hash,
        token: raw.token ?? '',
        amount: raw.amount ?? '',
        to: raw.to ?? '',
        resourceUrl: paymentRequired.resource.url,
        explorerUrl: raw.explorer_url ?? (raw.tx_hash ? buildExplorerUrl(raw.chain_id, raw.tx_hash) : ''),
        accepted: option,
        paymentHeader,
        merchantTo: raw.merchant_to ?? option.payTo,
        payer: raw.payer ?? raw.safe_address,
        chainId: raw.chain_id ?? chainIdFromNetwork(option.network),
      }
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

    const receipt = {
      success: true,
      paymentId: raw.payment_id,
      txHash: execResult.tx_hash ?? '',
      token: execResult.token ?? raw.token ?? '',
      amount: execResult.amount ?? raw.amount ?? '',
      to: execResult.to ?? raw.to ?? '',
      resourceUrl: paymentRequired.resource.url,
      explorerUrl: execResult.explorer_url ?? (execResult.tx_hash ? buildExplorerUrl(execResult.chain_id, execResult.tx_hash) : ''),
      accepted: option,
      paymentHeader,
      merchantTo: option.payTo,
      payer: raw.payer ?? raw.safe_address ?? raw.sign_data?.components.safe,
      chainId: execResult.chain_id ?? raw.chain_id ?? chainIdFromNetwork(option.network),
    }
    this.cacheX402Receipt(idempotencyKey, paymentHeader, receipt)
    return receipt
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
   * Requires `delegateKey` to be set in the client config.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const initialInit = this.withX402Wallet(init, this.x402PayerAddress())

    // 1. Make the original request
    const response = await globalThis.fetch(url, initialInit)

    // 2. Not a 402 — return as-is
    if (response.status !== 402) return response

    const machineChallengeHeader = response.headers.get('MACHINE-PAYMENT-CHALLENGE')
    if (machineChallengeHeader) {
      const challenge = await parseMachinePaymentChallengeResponse(response)
      return this.fetchWithMachinePayment(url, initialInit, challenge)
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
      return this.fetchWithMachinePayment(url, initialInit, challenge)
    }

    // 4. Pay through Haven
    const receipt = await this.authorizeX402(paymentRequired)
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

    if (retryResponse.status === 402) {
      await this.recordMerchantRetryRejected({
        rail: 'x402',
        paymentId: receipt.paymentId,
        txHash: receipt.txHash,
        resourceUrl: receipt.resourceUrl,
        retryResponse,
        details: {
          merchant_to: receipt.merchantTo,
          delegate_to: receipt.to,
        },
      })

      throw new HavenApiError(
        'x402 retry was rejected after Haven funded the delegate wallet; reconciliation may be required.',
        402,
        {
          marker: 'x402_retry_rejected_after_funding',
          payment_id: receipt.paymentId,
          tx_hash: receipt.txHash,
          resource_url: receipt.resourceUrl,
          merchant_to: receipt.merchantTo,
          delegate_to: receipt.to,
        },
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
  ): Promise<MachinePaymentReceipt> {
    if (!this.delegateKey) {
      throw new HavenSigningError(
        'delegateKey is required for machine payments. Pass it in the HavenClient config.',
      )
    }

    if (challenge.rail !== 'mpp_demo') {
      throw new HavenApiError(`Unsupported machine payment rail: ${challenge.rail}`, 400)
    }

    const idempotencyKey = buildMachinePaymentIdempotencyKey(challenge)
    const inFlight = this.inFlightMachinePayments.get(idempotencyKey)
    if (inFlight) return inFlight

    const promise = this.authorizeMppDemoPayment(challenge, idempotencyKey)
    this.inFlightMachinePayments.set(idempotencyKey, promise)

    try {
      return await promise
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

  private async fetchWithMachinePayment(
    url: string,
    initialInit: RequestInit | undefined,
    challenge: MachinePaymentChallenge,
  ): Promise<Response> {
    const receipt = await this.authorizeMachinePayment(challenge)

    const retryHeaders = new Headers(initialInit?.headers)
    retryHeaders.set('MACHINE-PAYMENT-PROOF', receipt.proofHeader)

    const retryResponse = await globalThis.fetch(url, {
      ...initialInit,
      headers: retryHeaders,
    })

    if (retryResponse.status === 402) {
      await this.recordMerchantRetryRejected({
        rail: receipt.rail,
        paymentId: receipt.paymentId,
        txHash: receipt.txHash,
        resourceUrl: receipt.resourceUrl,
        retryResponse,
        details: {
          challenge_id: receipt.challengeId,
        },
      })

      throw new HavenApiError(
        'Machine payment retry was rejected after Haven sent the payment.',
        402,
        {
          marker: 'machine_payment_retry_rejected_after_payment',
          payment_id: receipt.paymentId,
          tx_hash: receipt.txHash,
          resource_url: receipt.resourceUrl,
          rail: receipt.rail,
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
    return btoa(JSON.stringify({
      x402Version: paymentRequired.x402Version,
      accepted: option,
      payload: payment.payload,
    }))
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

  private async recordMerchantRetryRejected(input: {
    rail: string
    paymentId: string
    txHash: string
    resourceUrl: string
    retryResponse: Response
    details?: Record<string, unknown>
  }): Promise<void> {
    try {
      await this.post('/machine-payments/reconciliation-events', {
        paymentId: input.paymentId,
        rail: input.rail,
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: input.txHash,
        reason: `Merchant returned HTTP ${input.retryResponse.status} after Haven payment confirmation`,
        details: {
          resource_url: input.resourceUrl,
          retry_status: input.retryResponse.status,
          retry_body: await responseSnippet(input.retryResponse),
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
    const paymentId = raw.payment_id ? ` (payment_id: ${raw.payment_id})` : ''

    if (raw.status === 'pending_approval') {
      throw new HavenApiError(
        `${label} exceeds the on-chain allowance and was queued for owner approval${paymentId}.`,
        statusCode,
        raw,
      )
    }

    if (raw.status === 'expired') {
      throw new HavenApiError(`${label} expired before it could be completed${paymentId}.`, statusCode, raw)
    }

    const message = raw.error ?? `${label} ${raw.status}${paymentId}`
    throw new HavenApiError(message, statusCode, raw)
  }

  private x402PayerAddress(): string | undefined {
    return this.delegateAddress ?? this.x402Wallet
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
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    if (toolName === 'authorize_x402_payment') {
      const { url, payTo, amount, asset, network, description } = input as {
        url: string
        payTo: string
        amount: string
        asset: string
        network: string
        description?: string
      }

      try {
        const receipt = await this.authorizeX402({
          x402Version: 2,
          resource: { url, description },
          accepts: [
            {
              scheme: 'exact',
              network,
              amount,
              asset,
              payTo,
              maxTimeoutSeconds: 30,
            },
          ],
        })
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
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    if (toolName === 'authorize_machine_payment') {
      const { challenge } = input as { challenge: MachinePaymentChallenge }

      try {
        const receipt = await this.authorizeMachinePayment(challenge)
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
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    if (toolName === 'get_payment_status') {
      const { payment_id } = input as { payment_id: string }
      const result = await this.getPayment(payment_id)
      return {
        payment_id: result.paymentId,
        status: result.status,
        tx_hash: result.txHash,
        token: result.token,
        amount: result.amount,
        to: result.to,
        explorer_url: result.explorerUrl,
      }
    }

    throw new Error(`Unknown tool: ${toolName}`)
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
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
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

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(atob(value)) as T
}

function parseProtocolReceiptHeader(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(atob(value)) as Record<string, unknown>
  } catch {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}

async function responseSnippet(response: Response): Promise<string | null> {
  try {
    const text = await response.clone().text()
    return text.slice(0, 1000) || null
  } catch {
    return null
  }
}
