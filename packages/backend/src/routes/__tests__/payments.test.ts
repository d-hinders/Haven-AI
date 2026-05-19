import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'

const { mockQuery, allowanceMocks, fiatMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/allowance-module.js', () => allowanceMocks)
vi.mock('../../lib/fiat-values.js', () => fiatMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 100,
  status: 'active',
}

const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const TOKEN = '0x0000000000000000000000000000000000000000'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`
const SIGNATURE = `0x${'ab'.repeat(65)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

function authRow() {
  return { rows: [AGENT] }
}

function pendingIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    safe_address: AGENT.safe_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'xDAI',
    token_address: TOKEN,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '1000000000000000000',
    amount_human: '1',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 7,
    sign_hash: SIGN_HASH,
    signature: null,
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-05-13T10:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('payment routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
  })

  it('claims a pending signature intent before executing on-chain', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '1.00', eur: '0.92' })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: TX_HASH,
    })
    expect(mockQuery.mock.calls[2][0]).toContain("status = 'pending_signature'")
    expect(mockQuery.mock.calls[2][0]).toContain('expires_at > NOW()')
    expect(mockQuery.mock.calls[3][0]).toContain("status = 'submitted'")
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
  })

  it('creates base evidence after a protocol payment is confirmed', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '1.00', eur: '0.92' })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [pendingIntent({
          payment_rail: 'x402',
          source: 'x402',
          payment_resource_url: 'https://merchant.example/data',
          merchant_address: RECIPIENT.toLowerCase(),
          machine_idempotency_key: 'x402:test',
        })],
      })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({
        rows: [pendingIntent({
          status: 'confirmed',
          tx_hash: TX_HASH,
          payment_rail: 'x402',
          source: 'x402',
          payment_resource_url: 'https://merchant.example/data',
          merchant_address: RECIPIENT.toLowerCase(),
          machine_idempotency_key: 'x402:test',
          confirmed_at: '2026-05-19T10:00:00.000Z',
        })],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery.mock.calls[4][0]).toContain('FROM payment_intents')
    expect(mockQuery.mock.calls[5][0]).toContain('machine_payment_evidence')
    expect(mockQuery.mock.calls[5][1]).toContain(PAYMENT_ID)
    expect(mockQuery.mock.calls[5][1]).toContain('x402')
    expect(mockQuery.mock.calls[5][1]).toContain(TX_HASH)
  })

  it('still returns confirmed when protocol evidence indexing fails', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '1.00', eur: '0.92' })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [pendingIntent({
          payment_rail: 'x402',
          source: 'x402',
          payment_resource_url: 'https://merchant.example/data',
          merchant_address: RECIPIENT.toLowerCase(),
          machine_idempotency_key: 'x402:test',
        })],
      })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockRejectedValueOnce(new Error('evidence table unavailable'))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: TX_HASH,
    })
  })

  it('does not execute when another request already claimed the payment intent', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'submitted' }] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: 'Payment intent is submitted, expected pending_signature',
      status: 'submitted',
    })
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('returns expired when an intent expires before it can be claimed', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'expired' }] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toEqual({ error: 'Payment intent has expired' })
    expect(mockQuery.mock.calls[3][0]).toContain('expires_at <= NOW()')
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('only marks submitted payment intents failed after execution errors', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(new Error('relayer unavailable'))

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'failed',
      error: 'On-chain execution failed',
    })
    expect(mockQuery.mock.calls[3][0]).toContain("status = 'submitted'")
  })

  it('expires stale pending signature intents when their status is read', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [pendingIntent({ expires_at: '2000-01-01T00:00:00.000Z' })],
      })
      .mockResolvedValueOnce({ rows: [{ status: 'expired' }] })

    const response = await app.inject({
      method: 'GET',
      url: `/payments/${PAYMENT_ID}`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'expired',
    })
    expect(mockQuery.mock.calls[2][0]).toContain("status = 'pending_signature'")
  })

  it('expires stale pending signature intents before listing payments', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [pendingIntent({ status: 'expired' })] })

    const response = await app.inject({
      method: 'GET',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().payments).toEqual([
      expect.objectContaining({ payment_id: PAYMENT_ID, status: 'expired' }),
    ])
    expect(mockQuery.mock.calls[1][0]).toContain("status = 'pending_signature'")
    expect(mockQuery.mock.calls[2][0]).toContain('ORDER BY created_at DESC')
  })
})
