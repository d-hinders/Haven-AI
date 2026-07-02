import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'

/**
 * On-chain-is-the-final-gate contract test (design:
 * docs/research/non-custody-verification.md; guardrail: casp-risk-guardrails.md
 * Red Line #4, "Off-Chain-Only Spend Control" + "Use On-Chain Enforcement As
 * The Final Gate").
 *
 * Proves the spend envelope is the **on-chain** AllowanceModule remaining, not
 * Haven's database: a payment over the on-chain remaining is queued for owner
 * approval — never turned into a signable/auto-settling intent. The only thing
 * that changes the outcome below is the on-chain `computeEffectiveAllowance`
 * result; the request is identical otherwise.
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
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'

function authRow() {
  return { rows: [AGENT] }
}
function dbAllowanceRow() {
  return { rows: [{ allowance_amount: '1000000000000000000000' }] }
}
function effective(remaining: bigint) {
  return { remaining, effectiveSpent: 0n, nextResetTime: null, isResetPending: false }
}

const PAY = { token: 'xDAI', amount: '1', to: RECIPIENT }

describe('non-custody: the on-chain allowance is the final gate (Red Line #4)', () => {
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
    allowanceMocks.getTokenAllowance.mockResolvedValue({
      token: '0x0000000000000000000000000000000000000000',
      amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 7,
    })
    allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
  })

  it('queues for owner approval when the amount exceeds the on-chain remaining — never auto-settles', async () => {
    allowanceMocks.computeEffectiveAllowance.mockReturnValue(effective(0n)) // nothing left on-chain
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce(dbAllowanceRow())
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
      .mockResolvedValueOnce({ rows: [{ id: 'approval-1', status: 'pending', expires_at: '2099-01-01T00:00:00.000Z' }] })

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ kind: 'approval_request', status: 'pending_approval' })
    // No signable intent was created and nothing settled.
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('creates a signable (still unsigned) intent when within the on-chain remaining', async () => {
    // Control: identical request, but the on-chain remaining now covers it.
    allowanceMocks.computeEffectiveAllowance.mockReturnValue(effective(10n ** 21n))
    allowanceMocks.generateTransferHash.mockResolvedValue(`0x${'11'.repeat(32)}`)
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce(dbAllowanceRow())
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
      .mockResolvedValueOnce({ rows: [{ id: 'intent-1', status: 'pending_signature', expires_at: '2099-01-01T00:00:00.000Z' }] })

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ status: 'pending_signature' })
    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledOnce()
    // Even within allowance, creation never settles — that needs the signature step.
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('refuses a token the agent has no on-chain allowance config for', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] }) // no agent_allowances row

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(403)
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })
})
