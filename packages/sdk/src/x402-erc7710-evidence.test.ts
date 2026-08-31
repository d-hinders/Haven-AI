/**
 * #2092 — evidence IS reported on the erc7710 success path.
 *
 * #1508 deliberately skipped `POST /machine-payments/evidence` whenever there
 * was no funding leg, reasoning that evidence exists for funding-leg
 * reconciliation (#713). Evidence is also the source for the Fortnox reporting
 * feed, `GET /receipts`, transaction history, and the merchant-receipt capture
 * that runs immediately after — so the skip made an entire settlement scheme
 * invisible to the product's bookkeeping surface.
 *
 * These tests assert the REQUEST BODY rather than a call count: what matters
 * is that the reported `txHash` is the MERCHANT's settlement transaction (the
 * one it returned in `PAYMENT-RESPONSE`), because that is the hash the backend
 * verifies on-chain before it confirms anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { encodeBase64Json } from './base64.js'

const MERCHANT_URL = 'https://merchant.example/paid'
const SETTLEMENT_TX = `0x${'a'.repeat(64)}`
const FUNDING_TX = `0x${'f'.repeat(64)}`

function harness(status: {
  paymentStatus: string
  txHash: string | null
  nextAction?: string
  phase?: string
}) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const client = new HavenClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'sk_test',
  })

  vi.spyOn(client, 'getPaymentStatus').mockResolvedValue({
    kind: 'payment_intent',
    paymentId: 'pay_1',
    status: status.paymentStatus,
    rail: 'x402',
    txHash: status.txHash,
    chainId: 84532,
    resourceUrl: MERCHANT_URL,
    merchantAddress: '0x00000000000000000000000000000000000000aa',
    message: 'state',
    phase: status.phase,
    nextAction: status.nextAction,
  } as never)

  vi.spyOn(client as never, 'post').mockImplementation((async (...args: unknown[]) => {
    posts.push({ path: args[0] as string, body: args[1] as Record<string, unknown> })
    return {}
  }) as never)

  return { client, posts }
}

/** The merchant's paid response, carrying its own settlement tx in PAYMENT-RESPONSE. */
function merchantResponse(settlementTxHash?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (settlementTxHash) {
    headers.set('PAYMENT-RESPONSE', encodeBase64Json({ transaction: settlementTxHash }))
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
}

describe('erc7710 merchant completion reports evidence (#2092)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the MERCHANT settlement tx hash as the evidence anchor on the no-funding-leg path', async () => {
    const { client, posts } = harness({ paymentStatus: 'submitted', txHash: null })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(SETTLEMENT_TX))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
      noFundingLeg: true,
    })

    expect(result.ok).toBe(true)
    expect(result.settlementTxHash).toBe(SETTLEMENT_TX)

    const evidence = posts.find((p) => p.path === '/machine-payments/evidence')
    expect(evidence, 'erc7710 must report evidence, not skip it').toBeDefined()
    expect(evidence!.body).toMatchObject({
      paymentId: 'pay_1',
      rail: 'x402',
      // The anchor is the MERCHANT's settlement tx — there is no Haven tx here.
      txHash: SETTLEMENT_TX,
      resourceUrl: MERCHANT_URL,
      merchantStatus: 200,
      paymentProofHeaderName: 'PAYMENT-SIGNATURE, X-PAYMENT',
      paymentProofHeader: 'header-abc',
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
    })
    expect(evidence!.body.protocolReceiptPayload).toMatchObject({ transaction: SETTLEMENT_TX })
  })

  it('still captures the merchant receipt AFTER the evidence row exists', async () => {
    const { client, posts } = harness({ paymentStatus: 'submitted', txHash: null })
    const headers = new Headers({
      'content-type': 'application/json',
      'PAYMENT-RESPONSE': encodeBase64Json({ transaction: SETTLEMENT_TX }),
      'x-receipt-json': Buffer.from(JSON.stringify({ total: '0.02' })).toString('base64'),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers }),
    )

    await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
      noFundingLeg: true,
    })

    const evidenceIdx = posts.findIndex((p) => p.path === '/machine-payments/evidence')
    const receiptIdx = posts.findIndex((p) => p.path === '/machine-payments/pay_1/merchant-receipt')
    expect(evidenceIdx).toBeGreaterThanOrEqual(0)
    expect(receiptIdx).toBeGreaterThan(evidenceIdx)
  })

  it('reports nothing when the merchant returned no settlement tx — the accepted residual gap', async () => {
    const { client, posts } = harness({ paymentStatus: 'submitted', txHash: null })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(undefined))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
      noFundingLeg: true,
    })

    expect(result.ok).toBe(true)
    expect(result.settlementTxHash).toBeUndefined()
    // No hash means nothing to verify on-chain; the intent stays `submitted`
    // rather than a fabricated anchor being invented client-side.
    expect(posts.find((p) => p.path === '/machine-payments/evidence')).toBeUndefined()
  })

  it('the funding-leg path is unchanged — it still anchors on the HAVEN funding tx', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(SETTLEMENT_TX))

    await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    const evidence = posts.find((p) => p.path === '/machine-payments/evidence')
    expect(evidence!.body.txHash).toBe(FUNDING_TX)
  })
})
