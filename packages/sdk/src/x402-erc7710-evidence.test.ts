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
import { MCP_X402_PAYMENT_RESPONSE_META_KEY } from './mcp-merchant-transport.js'
import { HavenApiError } from './types.js'

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

  // #2970: the hosted erc7710 settlement gate reads THIS field to decide
  // whether `settled: true` is honest.
  it('#2970: the resolved evidenceOutcome is confirmed when the backend accepts the report', async () => {
    const { client } = harness({ paymentStatus: 'submitted', txHash: null })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(SETTLEMENT_TX))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
      noFundingLeg: true,
    })

    expect(result.evidenceOutcome).toEqual({ outcome: 'confirmed' })
  })

  // #2970: a zero hash is never a real transaction — reporting it can only
  // ever come back refused, so it is treated as "no hash to report" and
  // skipped BEFORE the network round trip, same as the no-hash case above.
  it('#2970: a ZERO settlement hash is never reported — treated the same as no hash', async () => {
    const ZERO_TX = `0x${'0'.repeat(64)}`
    const { client, posts } = harness({ paymentStatus: 'submitted', txHash: null })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(ZERO_TX))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
      noFundingLeg: true,
    })

    expect(result.ok).toBe(true)
    expect(result.settlementTxHash).toBe(ZERO_TX)
    expect(result.evidenceOutcome).toBeUndefined()
    expect(posts.find((p) => p.path === '/machine-payments/evidence')).toBeUndefined()
  })
})

// ── #3764: on a payment WITH a funding leg, the merchant's own settlement
// transaction (which the funding-leg path has held since #3118 and never
// reported) is a SECOND evidence report after the funding one — the
// transaction the merchant shows, recorded beside the funding hash. ──

/** A merchant paid answer carrying the settlement in result._meta (the #3118 form). */
function metaMerchantResponse(settlementTxHash?: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        ...(settlementTxHash
          ? { _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: settlementTxHash } } }
          : {}),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('#3764 — the merchant settlement is reported after the funding report (hosted)', () => {
  // Well-formed, non-zero, and different from FUNDING_TX in any letter case.
  const SETTLEMENT_TX = `0x${'c'.repeat(64)}`

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('FUNDING EVIDENCE CHARACTERIZATION: an accepted eip3009 completion makes TWO evidence posts — the funding hash first, then {paymentId, rail, txHash: settlement} (header form)', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': encodeBase64Json({ transaction: SETTLEMENT_TX }),
          // A receipt header too, so the #956 capture's ORDER after the
          // evidence posts is observable (D3).
          'x-receipt-json': Buffer.from(JSON.stringify({ total: '0.02' })).toString('base64'),
        },
      }),
    )

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(true)
    const evidencePosts = posts.filter((p) => p.path === '/machine-payments/evidence')
    expect(evidencePosts).toHaveLength(2)
    // FIRST post: the funding report, byte-identical to its pre-#3764 shape.
    expect(evidencePosts[0].body).toMatchObject({
      paymentId: 'pay_1',
      rail: 'x402',
      txHash: FUNDING_TX,
      resourceUrl: MERCHANT_URL,
      merchantStatus: 200,
      paymentProofHeaderName: 'PAYMENT-SIGNATURE, X-PAYMENT',
      paymentProofHeader: 'header-abc',
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
    })
    // SECOND post: the merchant's settlement, exactly the minimal #3475
    // payload — the backend reads rail/amount/merchant from its own record.
    expect(evidencePosts[1].body).toEqual({
      paymentId: 'pay_1',
      rail: 'x402',
      txHash: SETTLEMENT_TX,
    })
    // The merchant-receipt capture stays after the evidence posts (D3).
    const receiptIdx = posts.findIndex((p) => p.path === '/machine-payments/pay_1/merchant-receipt')
    expect(receiptIdx).toBeGreaterThan(posts.findIndex((p) => p.path === '/machine-payments/evidence'))
  })

  it('the same two posts when the settlement arrives in the _meta form (#3118)', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaMerchantResponse(SETTLEMENT_TX))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(true)
    const evidencePosts = posts.filter((p) => p.path === '/machine-payments/evidence')
    expect(evidencePosts).toHaveLength(2)
    expect(evidencePosts[0].body).toMatchObject({ txHash: FUNDING_TX })
    expect(evidencePosts[1].body).toEqual({ paymentId: 'pay_1', rail: 'x402', txHash: SETTLEMENT_TX })
  })

  it('the settlement report is ONE attempt (D2): a retryable 503 answers retryable immediately, no backoff', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(SETTLEMENT_TX))
    let evidenceCalls = 0
    vi.spyOn(client as never, 'post').mockImplementation((async (...args: unknown[]) => {
      const path = args[0] as string
      if (path === '/machine-payments/evidence') {
        evidenceCalls += 1
        posts.push({ path, body: args[1] as Record<string, unknown> })
        if (evidenceCalls === 1) return {} // funding report confirms
        throw new HavenApiError('settlement unobservable', 503)
      }
      posts.push({ path, body: args[1] as Record<string, unknown> })
      return {}
    }) as never)

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    // Exactly TWO evidence attempts total — the settlement was NOT retried
    // through the funding report's backoff.
    expect(posts.filter((p) => p.path === '/machine-payments/evidence')).toHaveLength(2)
    // D1: the funding outcome keeps its meaning; the settlement outcome rides
    // its own field.
    expect(result.evidenceOutcome).toEqual({ outcome: 'confirmed' })
    expect(result.settlementEvidenceOutcome).toEqual({ outcome: 'retryable', statusCode: 503 })
  })

  it('a REFUSED funding report does not gate the settlement post (D3 — the backend makes its own base row)', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(SETTLEMENT_TX))
    let evidenceCalls = 0
    vi.spyOn(client as never, 'post').mockImplementation((async (...args: unknown[]) => {
      const path = args[0] as string
      if (path === '/machine-payments/evidence') {
        evidenceCalls += 1
        posts.push({ path, body: args[1] as Record<string, unknown> })
        if (evidenceCalls === 1) throw new HavenApiError('payment_not_confirmed', 409)
        return {}
      }
      posts.push({ path, body: args[1] as Record<string, unknown> })
      return {}
    }) as never)

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(posts.filter((p) => p.path === '/machine-payments/evidence')).toHaveLength(2)
    expect(result.evidenceOutcome).toEqual({ outcome: 'refused', statusCode: 409 })
    expect(result.settlementEvidenceOutcome).toEqual({ outcome: 'confirmed' })
  })

  it('a merchant REJECTION makes no evidence post at all — no settlement is reported beside a rejection', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(false)
    expect(result.settlementEvidenceOutcome).toBeUndefined()
    expect(posts.find((p) => p.path === '/machine-payments/evidence')).toBeUndefined()
    expect(posts.find((p) => p.path === '/machine-payments/reconciliation-events')).toBeDefined()
  })

  it('NO second post on the no-funding-leg (erc7710) path — its single report IS the settlement', async () => {
    const { client, posts } = harness({ paymentStatus: 'submitted', txHash: null })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(SETTLEMENT_TX))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
      noFundingLeg: true,
    })

    expect(result.ok).toBe(true)
    const evidencePosts = posts.filter((p) => p.path === '/machine-payments/evidence')
    expect(evidencePosts).toHaveLength(1)
    expect(evidencePosts[0].body).toMatchObject({ txHash: SETTLEMENT_TX })
    expect(result.evidenceOutcome).toEqual({ outcome: 'confirmed' })
    expect(result.settlementEvidenceOutcome).toBeUndefined()
  })

  it('no settlement in the answer → nothing is posted, nothing invented (#2117 holds)', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(undefined))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(true)
    expect(result.settlementEvidenceOutcome).toBeUndefined()
    const evidencePosts = posts.filter((p) => p.path === '/machine-payments/evidence')
    expect(evidencePosts).toHaveLength(1)
    expect(evidencePosts[0].body).toMatchObject({ txHash: FUNDING_TX })
  })

  it('a ZERO settlement hash makes no second post', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(merchantResponse(`0x${'0'.repeat(64)}`))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(true)
    expect(result.settlementEvidenceOutcome).toBeUndefined()
    expect(posts.filter((p) => p.path === '/machine-payments/evidence')).toHaveLength(1)
  })

  it('a MALFORMED settlement hash (0xplain) makes no second post', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(metaMerchantResponse('0xplain'))

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(true)
    expect(result.settlementEvidenceOutcome).toBeUndefined()
    expect(posts.filter((p) => p.path === '/machine-payments/evidence')).toHaveLength(1)
  })

  it('a settlement hash equal to the funding hash in ANY letter case makes no second post', async () => {
    const { client, posts } = harness({
      paymentStatus: 'confirmed',
      txHash: FUNDING_TX,
      phase: 'payment_confirmed',
      nextAction: 'none',
    })
    // Same hash as the funding leg, checksummed-cased — the backend compares
    // case-insensitively, so the client must not post it as a settlement.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      merchantResponse('0x' + FUNDING_TX.slice(2).toUpperCase()),
    )

    const result = await client.completeX402MerchantCall({
      url: MERCHANT_URL,
      paymentId: 'pay_1',
      paymentHeader: 'header-abc',
    })

    expect(result.ok).toBe(true)
    expect(result.settlementEvidenceOutcome).toBeUndefined()
    expect(posts.filter((p) => p.path === '/machine-payments/evidence')).toHaveLength(1)
  })
})
