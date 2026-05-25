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
  SignData,
  X402AuthorizationOptions,
  RawCreateResponse,
  RawSignResponse,
  RawStatusResponse,
  RawPaymentStatusResult,
  X402PaymentRequired,
  X402PaymentOption,
  X402Quote,
  X402Receipt,
  X402RequestSnapshot,
  X402ResumeState,
  ResumeAuthorizedX402Input,
  ResumeX402PaymentInput,
  RawX402AuthorizeResponse,
  MachinePaymentChallenge,
  MachinePaymentReceipt,
  RawMachinePaymentAuthorizeResponse,
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

function explorerUrlOrEmpty(chainId: number | undefined, txHash: string | null | undefined): string {
  return txHash ? buildExplorerUrl(chainId, txHash) : ''
}

const DEFAULT_REQUEST_TIMEOUT = 30_000
const DEFAULT_CONFIRMATION_TIMEOUT = 90_000
const DEFAULT_POLLING_INTERVAL = 3_000

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
      this.attachX402ResumeState(err, paymentRequired, option, idempotencyKey)
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
      this.attachX402ResumeState(
        err,
        quote.paymentRequired,
        quote.accepted,
        idempotencyKey,
        quote.request,
      )
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
      amount: option.amount,
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
   * Requires `delegateKey` to be set in the client config.
   */
  async fetch(
    url: string,
    init?: RequestInit,
    options: X402AuthorizationOptions = {},
  ): Promise<Response> {
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
    const request = this.snapshotX402Request(url, initialInit)
    const option = selectStandardPaymentOption(paymentRequired.accepts)
    const idempotencyKey = options.idempotencyKey ?? (option ? buildX402IdempotencyKey(paymentRequired, option) : undefined)
    let receipt: X402Receipt
    try {
      receipt = await this.authorizeX402(paymentRequired, options)
    } catch (err) {
      if (option && idempotencyKey) {
        this.attachX402ResumeState(err, paymentRequired, option, idempotencyKey, request)
      }
      throw err
    }
    return this.retryX402Request(url, initialInit, paymentRequired, receipt)
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
    const requestedAmount = normalizeDecimal(decimalFromUsdcAtomic(option.amount))
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
    paymentHeader: string,
    raw: RawX402AuthorizeResponse,
    execResult?: RawSignResponse,
  ): X402Receipt {
    const txHash = execResult?.tx_hash ?? raw.tx_hash ?? ''
    const chainId = execResult?.chain_id ?? raw.chain_id ?? chainIdFromNetwork(option.network)
    const token = execResult?.token ?? raw.token ?? 'USDC'
    const amount = execResult?.amount ?? raw.amount ?? decimalFromUsdcAtomic(option.amount)
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
      amount: status.amount || decimalFromUsdcAtomic(option.amount),
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
        amount: input.accepted.amount,
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
            resourceUrl: raw.x402.resource_url ?? raw.resource_url ?? null,
            merchantAddress: raw.x402.merchant_address ?? raw.merchant_address ?? raw.merchant_to ?? null,
            description: raw.x402.description ?? raw.description ?? null,
            idempotencyKey: raw.x402.idempotency_key ?? raw.idempotency_key ?? null,
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
      'quoteX402 can only capture resumable request bodies that are strings or URLSearchParams. ' +
      'For streams, blobs, or binary bodies, preserve the original request yourself and call resumeX402Payment with fresh init.',
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
      amountAtomic: option.amount,
      amount: decimalFromUsdcAtomic(option.amount),
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
      amountAtomic: input.accepted.amount,
      amount: decimalFromUsdcAtomic(input.accepted.amount),
      token: token?.symbol ?? 'USDC',
      asset: input.accepted.asset,
      network: input.accepted.network,
      chainId: chainIdOrNull(input.accepted.network),
      merchantAddress: input.accepted.payTo,
    }
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
        expires_at: result.expiresAt,
        chain_id: result.chainId,
        message: result.message,
      }
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
