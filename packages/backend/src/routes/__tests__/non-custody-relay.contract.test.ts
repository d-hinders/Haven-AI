import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'

/**
 * Non-discretionary relay contract test (design:
 * docs/research/non-custody-verification.md; guardrail: casp-risk-guardrails.md
 * "Treat Relaying As Non-Discretionary Infrastructure" — Haven must not alter
 * recipient, amount, or token after signature).
 *
 * Proves the relay forwards exactly the params the user/agent signed: the
 * on-chain transfer is executed with the recipient/amount/token stored on the
 * signed intent, and the /sign request (which carries only a signature) cannot
 * redirect it.
 */

const ZERO = '0x0000000000000000000000000000000000000000'

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
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 100,
  status: 'active',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const SIGNED_RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGNED_TOKEN = '0x0000000000000000000000000000000000000000'
const SIGNED_AMOUNT = '1000000000000000000'
const SIGNATURE = `0x${'ab'.repeat(65)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

function authRow() {
  return { rows: [AGENT] }
}
function signedIntent() {
  return {
    rows: [
      {
        id: PAYMENT_ID,
        agent_id: AGENT.id,
        user_id: AGENT.user_id,
        safe_address: AGENT.safe_address,
        chain_id: AGENT.chain_id,
        token_symbol: 'xDAI',
        token_address: SIGNED_TOKEN,
        to_address: SIGNED_RECIPIENT,
        amount_raw: SIGNED_AMOUNT,
        amount_human: '1',
        delegate_address: AGENT.delegate_address,
        allowance_nonce: 7,
        sign_hash: `0x${'11'.repeat(32)}`,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ],
  }
}

describe('non-custody: the relay is non-discretionary', () => {
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

  it('executes the transfer with the signed recipient/amount/token, unchanged', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '1.00', eur: '0.92' })
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce(signedIntent())
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
    // The relay forwards the SIGNED params verbatim — no Haven substitution.
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledWith(
      AGENT.chain_id,
      AGENT.safe_address,
      SIGNED_TOKEN,
      SIGNED_RECIPIENT,
      BigInt(SIGNED_AMOUNT),
      ZERO,
      0n,
      AGENT.delegate_address,
      SIGNATURE,
    )
  })
})
