/**
 * #2117 — a RETRYABLE evidence-report refusal is retried, a TERMINAL one is
 * not; both stays swallowed (evidence reporting is best-effort by contract —
 * the paid merchant response is the caller-visible result, never the evidence
 * report).
 *
 * Wire-form contract the SDK keys on (packages/backend/src/modules/mpp/
 * evidence.ts, attachEvidenceHandler): `POST /machine-payments/evidence`
 * answers HTTP 503 + `{ error: ... }` for the RETRYABLE `settlement_unobservable`
 * marker (erc7710 settlement tx not mined yet, or the chain unreadable) and
 * 4xx for terminal refusals (`settlement_unverified` 409, validation 400,
 * unknown payment 404). The SDK retries ONLY the 503, keyed on status — never
 * on message text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MerchantCompletion,
  type PaymentPoster,
} from './merchant-completion.js'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import { HavenApiError } from './types.js'
import { encodeBase64Json } from './base64.js'

const SETTLEMENT_TX = `0x${'a'.repeat(64)}`
const MERCHANT_URL = 'https://merchant.example/paid'

type PostMock = (path: string, body: Record<string, unknown>) => Promise<unknown>

/** Mirror of the transport's error for the retryable wire form (evidence.ts 586-594). */
function retryableRefusal(): HavenApiError {
  const message =
    'The reported settlement transaction could not be verified on-chain yet — ' +
    'the payment is unchanged; retry once it is mined'
  return new HavenApiError(message, 503, { error: message })
}

function terminalRefusal(status: number): HavenApiError {
  return new HavenApiError('refused', status, { error: 'refused' })
}

function evidence() {
  return {
    paymentId: 'pay_erc7710_1',
    rail: 'x402',
    txHash: SETTLEMENT_TX,
    resourceUrl: MERCHANT_URL,
    merchantStatus: 200,
    paymentProofHeaderName: 'X-PAYMENT',
    paymentProofHeader: 'header-abc',
    protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
    protocolReceiptHeader: encodeBase64Json({ transaction: SETTLEMENT_TX }),
  }
}

function harness(post: PostMock) {
  const completion = new MerchantCompletion({
    // Only this dependency is exercised by reportEvidence; the rest are
    // unused stubs, matching how the evidence trail never touches them.
    post: post as unknown as PaymentPoster,
    merchantTransport: new McpMerchantTransport({ merchantTimeout: 10_000 }),
    getPaymentStatus: async () => ({}) as never,
    getAgent: async () => ({}),
    delegateAddress: undefined,
    x402Wallet: undefined,
  })
  return completion
}

describe('reportEvidence retry policy (#2117)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries a 503 refusal with bounded backoff and reports on a later attempt', async () => {
    vi.useFakeTimers()
    const post = vi.fn<PostMock>()
      .mockRejectedValueOnce(retryableRefusal())
      .mockRejectedValueOnce(retryableRefusal())
      .mockResolvedValueOnce({})

    const pending = harness(post).reportEvidence(evidence())

    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(3)

    await pending
    expect(post).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)

    // The same evidence body is re-reported verbatim (idempotent by server
    // first-write-wins) and the retry never hits another endpoint.
    for (const call of post.mock.calls) {
      expect(call[0]).toBe('/machine-payments/evidence')
      expect(call[1]).toEqual(post.mock.calls[0][1])
    }
  })

  it('stops after 3 attempts on a persistent 503 and still swallows', async () => {
    vi.useFakeTimers()
    const post = vi.fn<PostMock>().mockRejectedValue(retryableRefusal())

    const pending = harness(post).reportEvidence(evidence())
    await vi.advanceTimersByTimeAsync(500 + 1000 + 1)
    await pending

    // Bounded: never retries forever.
    expect(post).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([409, 400] as const)('swallows a terminal %i refusal after a single attempt — no retry', async (status: number) => {
    vi.useFakeTimers()
    const post = vi.fn<PostMock>().mockRejectedValue(terminalRefusal(status))

    await harness(post).reportEvidence(evidence())

    expect(post).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry a transport-level failure (status 0)', async () => {
    vi.useFakeTimers()
    const post = vi.fn<PostMock>().mockRejectedValue(
      new HavenApiError('Request to /machine-payments/evidence failed: ECONNREFUSED', 0),
    )

    await harness(post).reportEvidence(evidence())

    expect(post).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
