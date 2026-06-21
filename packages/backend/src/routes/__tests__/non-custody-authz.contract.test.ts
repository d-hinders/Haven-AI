import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'

/**
 * Authn ≠ authz contract test (design: docs/research/non-custody-verification.md;
 * guardrail: casp-risk-guardrails.md Red Line #3, "API auth is identity,
 * signature is authority").
 *
 * Proves the single most important custody promise: an **authenticated** agent
 * request (valid API key) can NEVER move funds on its own. Only a signature that
 * cryptographically recovers to the user-authorised on-chain delegate releases a
 * transfer. Every case below asserts `executeAllowanceTransfer` is not called.
 *
 * If a change ever lets an authenticated-but-unsigned (or wrongly-signed)
 * request spend, one of these fails — the signal to get the legal/product review
 * the guardrails require, not to "fix" the test.
 */

const { mockQuery, allowanceMocks, fiatMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
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
const SIGNATURE = `0x${'ab'.repeat(65)}`

function authRow() {
  return { rows: [AGENT] }
}

function pendingIntent() {
  return {
    rows: [
      {
        id: PAYMENT_ID,
        agent_id: AGENT.id,
        user_id: AGENT.user_id,
        safe_address: AGENT.safe_address,
        chain_id: AGENT.chain_id,
        token_symbol: 'xDAI',
        token_address: '0x0000000000000000000000000000000000000000',
        to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
        amount_raw: '1000000000000000000',
        amount_human: '1',
        delegate_address: AGENT.delegate_address,
        allowance_nonce: 7,
        sign_hash: `0x${'11'.repeat(32)}`,
        signature: null,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ],
  }
}

describe('non-custody: authentication is not authority (Red Line #3)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset()
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
  })

  it('refuses to spend for an authenticated request with no signature', async () => {
    mockQuery.mockResolvedValueOnce(authRow()) // agent auth only

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('refuses to spend on a malformed signature', async () => {
    allowanceMocks.recoverSigner.mockImplementationOnce(() => {
      throw new Error('invalid signature')
    })
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce(pendingIntent())

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(res.statusCode).toBe(400)
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('refuses to spend when the signature recovers to a non-delegate address', async () => {
    // Valid-format signature, but it signs as someone other than the on-chain delegate.
    allowanceMocks.recoverSigner.mockReturnValueOnce('0xdeadBEEFdeadBEEFdeadBEEFdeadBEEFdeadBEEF')
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce(pendingIntent())

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(res.statusCode).toBe(403)
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('only releases the transfer when the signature matches the delegate', async () => {
    // Control case: with a delegate-matching signature, the transfer DOES execute —
    // proving the gate above is the signature, not the API key.
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: `0x${'cd'.repeat(32)}` })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '1.00', eur: '0.92' })
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce(pendingIntent())
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(res.statusCode).toBe(200)
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
  })
})
