/**
 * Characterization tests for `routes/demo-mpp.ts` (#997, epic #980 M4).
 *
 * This route had ZERO test coverage before this pass, despite the #997 issue
 * naming its proof check (`routes/demo-mpp.ts:142`) as one half of the
 * `mpp_demo` AUTHORIZATION boundary — the merchant-side verification that a
 * `MACHINE-PAYMENT-PROOF` header corresponds to a REAL confirmed payment for
 * THIS exact challenge (same amount, resource, recipient, token, chain). The
 * bar per money.md and the issue: pin the rejection paths, not just the
 * happy path — a check that always says yes cannot be told apart from a real
 * one by a happy-path-only suite.
 *
 * See the "mutation proof" test at the bottom of this file: it disables one
 * of the SQL match columns (as a real bug would) and asserts a previously-
 * rejected proof now wrongly verifies — demonstrating the suite goes red if
 * this authorization boundary is loosened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

const demoMppRoutes = (await import('../demo-mpp.js')).default

const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const TX_HASH = `0x${'ab'.repeat(32)}`
const CHALLENGE_ID = 'challenge-abc-123'

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function confirmedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    tx_hash: TX_HASH,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '10000',
    chain_id: 8453,
    confirmed_at: '2026-05-15T12:00:00.000Z',
    ...overrides,
  }
}

describe('routes/demo-mpp.ts — mpp_demo challenge/proof (#997)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    process.env.MPP_DEMO_RECIPIENT_ADDRESS = RECIPIENT
    mockQuery.mockReset()
    app = Fastify({ logger: false })
    await app.register(demoMppRoutes, { prefix: '/demo/mpp' })
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.MPP_DEMO_RECIPIENT_ADDRESS
    await app.close()
  })

  /** GET the challenge so the test uses the route's own `resource` URL rather than guessing fastify's inject host/protocol. */
  async function fetchChallenge() {
    const res = await app.inject({ method: 'GET', url: '/demo/mpp/market-summary' })
    expect(res.statusCode).toBe(402)
    return res.json().challenge as { challengeId: string; resource: string }
  }

  function proofFor(challenge: { resource: string }, overrides: Record<string, unknown> = {}) {
    return {
      rail: 'mpp_demo',
      challengeId: CHALLENGE_ID,
      paymentId: PAYMENT_ID,
      txHash: TX_HASH,
      ...overrides,
    }
  }

  it('returns 503 when the demo recipient is not configured', async () => {
    delete process.env.MPP_DEMO_RECIPIENT_ADDRESS
    const res = await app.inject({ method: 'GET', url: '/demo/mpp/market-summary' })
    expect(res.statusCode).toBe(503)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('returns a 402 challenge with the correct fixed price/asset/chain when no proof header is sent', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo/mpp/market-summary' })
    expect(res.statusCode).toBe(402)
    const body = res.json()
    expect(body.challenge).toMatchObject({
      rail: 'mpp_demo',
      network: { chainId: 8453, name: 'base' },
      asset: { symbol: 'USDC', address: USDC, decimals: 6 },
      amount: { display: '0.01', atomic: '10000' },
      recipient: RECIPIENT,
    })
    expect(res.headers['machine-payment-challenge']).toBeDefined()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a non-base64 / non-JSON proof header with 400 — no DB read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': 'not-valid-base64-json!!' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Invalid machine payment proof')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('rejects a proof whose rail is not mpp_demo — no DB read (authorization boundary)', async () => {
    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: {
        'machine-payment-proof': b64(proofFor(challenge, { rail: 'x402' })),
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Invalid machine payment proof')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it.each(['challengeId', 'paymentId', 'txHash'] as const)(
    'rejects a proof missing %s — no DB read',
    async (field) => {
      const challenge = await fetchChallenge()
      const proof = proofFor(challenge)
      delete (proof as Record<string, unknown>)[field]
      const res = await app.inject({
        method: 'GET',
        url: '/demo/mpp/market-summary',
        headers: { 'machine-payment-proof': b64(proof) },
      })
      expect(res.statusCode).toBe(400)
      expect(mockQuery).not.toHaveBeenCalled()
    },
  )

  it('returns verified:false (402) when no confirmed payment matches the strict SQL guard', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }) // strict match SELECT finds nothing
    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })
    expect(res.statusCode).toBe(402)
    expect(res.json()).toMatchObject({ verified: false })
  })

  it('rejects a proof for a payment on the wrong chain, wrong amount, wrong recipient, or wrong asset — the SQL guard, not app logic, enforces this', async () => {
    // The route's ONLY defense against "confirmed payment for a DIFFERENT
    // challenge" is the strict multi-column SQL match. Pin every column the
    // WHERE clause checks so a future edit that drops one is caught here,
    // not in production. Each case: the mocked query returns no row (as the
    // real DB would when a column doesn't match), so the assertion is on
    // the CALL — the exact params sent — not just the response.
    mockQuery.mockResolvedValue({ rows: [] })
    const challenge = await fetchChallenge()
    await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("status = 'confirmed'")
    expect(sql).toContain("payment_rail = 'mpp_demo'")
    expect(sql).toContain('machine_challenge_id = $3')
    expect(sql).toContain('payment_resource_url = $4')
    expect(sql).toContain('chain_id = $5')
    expect(sql).toContain('amount_raw = $6')
    expect(sql).toContain('LOWER(token_address) = LOWER($7)')
    expect(sql).toContain('LOWER(to_address) = LOWER($8)')
    expect(params).toEqual([
      PAYMENT_ID,
      TX_HASH.toLowerCase(),
      CHALLENGE_ID,
      challenge.resource,
      8453,
      '10000',
      USDC,
      RECIPIENT,
    ])
  })

  it('unlocks the resource and records a receipt on first verification', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [confirmedRow()] }) // strict match hit
      .mockResolvedValueOnce({ rows: [] }) // no existing receipt
      .mockResolvedValueOnce({ rows: [{ id: 'receipt-1' }] }) // insert wins

    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.paid).toBe(true)
    expect(body.reused).toBe(false)
    expect(body.txHash).toBe(TX_HASH)
    expect(res.headers['machine-payment-response']).toBeDefined()
    const responseHeader = JSON.parse(
      Buffer.from(res.headers['machine-payment-response'] as string, 'base64').toString(),
    )
    expect(responseHeader).toMatchObject({ success: true, paymentId: PAYMENT_ID, txHash: TX_HASH })

    const insertCall = mockQuery.mock.calls[2]
    expect(insertCall[0]).toContain('INSERT INTO machine_payment_receipts')
    expect(insertCall[0]).toContain('ON CONFLICT (challenge_id)')
    expect(insertCall[1]).toEqual([
      'mpp_demo',
      CHALLENGE_ID,
      PAYMENT_ID,
      TX_HASH,
      challenge.resource,
      RECIPIENT.toLowerCase(),
      '10000',
      8453,
    ])
  })

  it('replays a matching challenge idempotently (reused:true, no second insert)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [confirmedRow()] }) // strict match hit
      .mockResolvedValueOnce({
        rows: [{ id: 'receipt-1', payment_intent_id: PAYMENT_ID, tx_hash: TX_HASH }],
      }) // existing receipt for THIS payment/tx

    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ paid: true, reused: true })
    expect(mockQuery).toHaveBeenCalledTimes(2) // no INSERT on replay
  })

  it('rejects reuse of a challenge for a DIFFERENT payment/tx with 409 — a challenge is single-use', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [confirmedRow()] }) // strict match hit
      .mockResolvedValueOnce({
        rows: [{ id: 'receipt-1', payment_intent_id: 'some-other-payment', tx_hash: `0x${'cd'.repeat(32)}` }],
      }) // existing receipt for a DIFFERENT payment

    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already used/)
  })

  it('replays idempotently when the receipt INSERT loses a concurrent race to a matching row', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [confirmedRow()] }) // strict match hit
      .mockResolvedValueOnce({ rows: [] }) // no existing receipt (yet)
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING: lost the race
      .mockResolvedValueOnce({
        rows: [{ id: 'receipt-1', payment_intent_id: PAYMENT_ID, tx_hash: TX_HASH }],
      }) // re-read: the winner matches this proof

    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ paid: true, reused: true })
  })

  it('rejects when the receipt INSERT loses a race to a MISMATCHED row (409)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [confirmedRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // lost the race
      .mockResolvedValueOnce({
        rows: [{ id: 'receipt-1', payment_intent_id: 'different-payment', tx_hash: `0x${'ee'.repeat(32)}` }],
      })

    const challenge = await fetchChallenge()
    const res = await app.inject({
      method: 'GET',
      url: '/demo/mpp/market-summary',
      headers: { 'machine-payment-proof': b64(proofFor(challenge)) },
    })

    expect(res.statusCode).toBe(409)
  })
})
