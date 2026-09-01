import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  HavenApiError,
  HavenPaymentStateError,
} from './types.js'
import type {
  PaymentStatusResult,
  X402PaymentRequired,
  X402Receipt,
} from './types.js'
import {
  captureMerchantResponse,
  McpMerchantTransport,
} from './mcp-merchant-transport.js'
import type { CapturedMerchantResponse } from './mcp-merchant-transport.js'
import { x402PaymentHeaderNamesSent } from './x402.js'
import { buildExplorerUrl, x402PayerAddress } from './x402-protocol.js'
import { paymentStateStatusCode } from './payment-state.js'
import { decodeBase64Json } from './base64.js'

/**
 * Merchant delivery and the evidence trail behind it (#1620, epic #1613).
 *
 * Where `mcp-merchant-transport.ts` (#1616) owns the wire — timeouts,
 * sessions, SSE framing — this module owns what has to be TRUE around a
 * merchant call once a payment exists: which wallet the merchant should see,
 * what the payment's live state permits, and what gets written down
 * afterwards.
 *
 * The reporting is deliberately best-effort and deliberately asymmetric. A
 * merchant that REJECTS a retry after Haven already moved money is a
 * reconciliation event and is recorded as one; a merchant that accepts is
 * evidence, plus its own receipt when it offers one. Neither write may ever
 * change the caller-visible outcome — the resource is already paid for, and
 * an exception thrown from bookkeeping would turn a completed payment into a
 * reported failure. That is why every one of these swallows.
 *
 * Scheme-neutral by construction: it is handed a receipt or a payment id and
 * never asks how the money moved, which is what lets the #1508 no-funding-leg
 * path through the same door as the 3009 path.
 *
 * Internal to `HavenClient`. Exported for direct tests and composition only.
 */

/** #2292: what an agent says a merchant answered to a retry Haven did not make. */
export type X402MerchantOutcome = 'accepted' | 'rejected'

/** #2292: what Haven wrote down for such a report. */
export interface X402MerchantOutcomeReport {
  paymentId: string
  outcome: X402MerchantOutcome
  /** Haven's own funding tx for this payment — the anchor, never caller-supplied. */
  txHash: string
  /** Haven's own recorded resource URL — likewise never caller-supplied. */
  resourceUrl: string
  recorded: 'reconciliation_event' | 'evidence'
}

const MERCHANT_BODY_SNIPPET_LIMIT = 1000

/**
 * Evidence-report retry policy for a RETRYABLE refusal (#2117).
 *
 * The backend already distinguishes two refusals on `POST
 * /machine-payments/evidence` and says so in the status code: `503`
 * (`settlement_unobservable`) means "the chain could not be read, or the
 * settlement is not mined yet — report it again", and `409` means "that is a
 * settled no". The SDK discarded that distinction in a bare `catch {}`,
 * treating both as best-effort silence — so on erc7710, where the reported hash
 * is the ONLY thing that produces an evidence row, a transaction that simply
 * had not been mined yet at report time meant the payment never reached the
 * user's books at all.
 *
 * Bounded, and terminal on anything that is not a 503: a retry loop against a
 * settled no is just noise, and the total wait has to stay far under any
 * caller's patience because the paid resource is already in hand. Four attempts
 * over ~7s of backoff covers the mine-latency case this exists for without ever
 * becoming a reason a completed payment feels slow.
 */
const EVIDENCE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]

/** The backend's retryable refusal — see `modules/mpp/evidence.ts`. */
const EVIDENCE_RETRYABLE_STATUS = 503

export type PaymentPoster = <T>(path: string, body: Record<string, unknown>) => Promise<T>
export type PaymentStatusReader = (paymentId: string) => Promise<PaymentStatusResult>
export type AgentReader = () => Promise<{ delegateAddress?: string }>

export interface MerchantCompletionOptions {
  post: PaymentPoster
  merchantTransport: McpMerchantTransport
  getPaymentStatus: PaymentStatusReader
  getAgent: AgentReader
  delegateAddress: string | undefined
  x402Wallet: string | undefined
  /** Injectable only so tests do not spend the real backoff. */
  sleep?: (ms: number) => Promise<void>
}

export class MerchantCompletion {
  private readonly post: PaymentPoster
  private readonly merchantTransport: McpMerchantTransport
  private readonly getPaymentStatus: PaymentStatusReader
  private readonly getAgent: AgentReader
  private readonly delegateAddress: string | undefined
  private readonly x402Wallet: string | undefined
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: MerchantCompletionOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.post = options.post
    this.merchantTransport = options.merchantTransport
    this.getPaymentStatus = options.getPaymentStatus
    this.getAgent = options.getAgent
    this.delegateAddress = options.delegateAddress
    this.x402Wallet = options.x402Wallet
  }

  async retryRequest(
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
      await this.recordRetryRejected({
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

    await this.reportEvidence({
      paymentId: receipt.paymentId,
      rail: 'x402',
      txHash: receipt.txHash,
      resourceUrl: receipt.resourceUrl,
      merchantStatus: retryResponse.status,
      challengePayload: paymentRequired as unknown as Record<string, unknown>,
      selectedPayment: receipt.accepted as unknown as Record<string, unknown>,
      paymentProofHeaderName: x402PaymentHeaderNamesSent(receipt.paymentHeader),
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
  async reportMerchantReceipt(paymentId: string, response: Response): Promise<void> {
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

  async resolveCompletionContext(input: {
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

  async resolveWalletForMerchantCall(): Promise<string | undefined> {
    const localWallet = x402PayerAddress(this.delegateAddress, this.x402Wallet)
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

  async recordRetryRejected(input: {
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

  /**
   * #2292: record what a merchant said to a retry **Haven did not make**.
   *
   * On the plain-HTTP x402 path Haven tells the agent to call the merchant
   * itself — that is the keyless design, not an oversight — so the two writes
   * above were reachable only from `completeX402MerchantCall`, where Haven IS
   * the caller. A manual retry had nowhere to put its outcome, which left
   * `intentStateFor`'s merchant-rejected branch dead on the one flow Haven
   * prescribes and made the 15-minute grace window the only route to
   * `funded_but_unsettled`.
   *
   * Three properties distinguish this from `recordRetryRejected` /
   * `reportEvidence`, and each is deliberate:
   *
   * 1. **It does not swallow.** Those two are bookkeeping hung off a call
   *    whose outcome is already decided, so an exception there would turn a
   *    completed payment into a reported failure. Here the report IS the
   *    caller's request; silently dropping it would recreate the exact
   *    unobservability #2292 exists to remove.
   * 2. **The anchor is server-side.** `txHash` and `resourceUrl` come from
   *    the payment's own Haven record, never from the reporter — so a report
   *    cannot be pointed at a different transaction or a different resource,
   *    and it can never CONFIRM an intent (an erc7710 intent has no Haven
   *    tx hash and is refused here rather than completed from a supplied one,
   *    which is #2092's verified seam and stays its own path).
   * 3. **It is evidence, never authority.** Haven does not and must not check
   *    the claim: verifying it would mean calling the merchant, which is the
   *    property this whole path exists to preserve. What bounds a false
   *    report is scope — the backend routes resolve the payment
   *    `WHERE agent_id = $`, so a caller can only ever describe its own
   *    payment — plus the fact that nothing financial keys off the claim:
   *    the sweep is balance-driven, the intent's status/amount/recipient are
   *    untouched, and a false `accepted` runs the server's own on-chain
   *    residue check, which re-flags stranded funds independently.
   */
  async reportMerchantOutcome(input: {
    paymentId: string
    outcome: X402MerchantOutcome
    merchantStatus: number
    merchantBody?: string
  }): Promise<X402MerchantOutcomeReport> {
    if (!Number.isInteger(input.merchantStatus) || input.merchantStatus < 100 || input.merchantStatus > 599) {
      throw new HavenApiError(
        `merchant_status must be an integer HTTP status from 100 to 599 (received ${input.merchantStatus}).`,
        400,
        undefined,
        input.paymentId,
      )
    }
    // A self-contradictory report is refused rather than recorded: this is
    // the one thing about the claim Haven CAN check without contacting the
    // merchant, so it checks it.
    const looksAccepted = input.merchantStatus >= 200 && input.merchantStatus < 300
    if (looksAccepted !== (input.outcome === 'accepted')) {
      throw new HavenApiError(
        `outcome "${input.outcome}" contradicts merchant_status ${input.merchantStatus}: ` +
          'report "accepted" only for a 2xx and "rejected" only for a non-2xx.',
        400,
        undefined,
        input.paymentId,
      )
    }

    const status = await this.getPaymentStatus(input.paymentId)
    if (status.rail !== 'x402') {
      throw new HavenPaymentStateError(
        `Payment ${status.paymentId} is ${status.rail}, not x402 — there is no merchant retry to report.`,
        409,
        status,
      )
    }
    if (status.status !== 'confirmed' || !status.txHash) {
      throw new HavenPaymentStateError(
        `Payment ${status.paymentId} has no confirmed Haven funding transaction to anchor a ` +
          `merchant report to (status ${status.status}). ${status.message}`,
        paymentStateStatusCode(status.status, 409),
        status,
      )
    }
    const resourceUrl = status.resourceUrl ?? status.x402?.resourceUrl ?? null
    if (!resourceUrl) {
      throw new HavenApiError(
        `Payment ${status.paymentId} has no recorded resource URL, so a merchant report cannot be stored.`,
        409,
        status,
        status.paymentId,
      )
    }

    const txHash = status.txHash
    if (input.outcome === 'rejected') {
      await this.post('/machine-payments/reconciliation-events', {
        paymentId: status.paymentId,
        rail: 'x402',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash,
        reason: `Agent-reported: merchant returned HTTP ${input.merchantStatus} to a manual retry after Haven payment confirmation`,
        details: {
          resource_url: resourceUrl,
          retry_status: input.merchantStatus,
          retry_body: input.merchantBody?.slice(0, MERCHANT_BODY_SNIPPET_LIMIT) || null,
          reported_by: 'agent_manual_retry',
        },
      })
      return { paymentId: status.paymentId, outcome: 'rejected', txHash, resourceUrl, recorded: 'reconciliation_event' }
    }

    await this.post('/machine-payments/evidence', {
      paymentId: status.paymentId,
      rail: 'x402',
      txHash,
      resourceUrl,
      merchantStatus: input.merchantStatus,
    })
    return { paymentId: status.paymentId, outcome: 'accepted', txHash, resourceUrl, recorded: 'evidence' }
  }

  async reportEvidence(input: {
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
    const body = {
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
    }

    // Still best-effort in the sense that matters — nothing here may change
    // the caller-visible outcome, because the resource is already paid for and
    // delivered. What changed (#2117) is that a RETRYABLE refusal is no longer
    // swallowed identically to a terminal one. On erc7710 this report is the
    // only thing that produces an evidence row, and therefore the only thing
    // that puts the payment in the user's books.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.post('/machine-payments/evidence', body)
        return
      } catch (err) {
        const retryable =
          err instanceof HavenApiError && err.statusCode === EVIDENCE_RETRYABLE_STATUS
        if (!retryable || attempt >= EVIDENCE_RETRY_DELAYS_MS.length) return
        await this.sleep(EVIDENCE_RETRY_DELAYS_MS[attempt])
      }
    }
  }
}

export function parseMerchantSettlement(header: string | null): {
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

export function parseProtocolReceiptHeader(value: string): Record<string, unknown> | undefined {
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
