/**
 * #3837 — `POST /payments/:id/sign` records sponsored UserOp gas, and a
 * recording failure never fails a payment.
 *
 * Pattern-matched DB stub mirroring `payments-sign-failure.test.ts`: the
 * route's OWN writes (claim/confirm/fail) are real production code behind a
 * pattern-matched `db.js` mock; only collaborators the route does not own
 * (the bundler seam, fiat) are mocked. The sponsored-gas RECORDER is real
 * code — the tests assert the actual `INSERT INTO
 * sponsored_userop_gas_events` statement it issues, and force the insert to
 * FAIL by making that statement throw.
 *
 * The ledger's real-DB proofs (every outcome lands with its cost) live in
 * `infra/repositories/__tests__/sponsored-userop-gas.db.test.ts`.
 *
 * db-mock-exempt is declared on the line comment below (the ratchet reads
 * `//` comments only).
// db-mock-exempt: route-level handler test of the RECORDING WIRING and the
// failure-isolation contract (a forced-failing insert must never fail the
// payment) — the same exemption payments-sign-failure.test.ts carries. The
// ledger's own SQL behaviour (outcomes, buckets, aggregates) is proven on the
// real-DB harness in the repository test named above, with zero mocks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, fiatMocks, delegationMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeCapture: vi.fn().mockResolvedValue(null),
  },
  delegationMocks: {
    submitDelegationPayment: vi.fn(),
  },
}))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
// Only the network seam of the delegation rail (bundler/EntryPoint/account)
// is mocked — the sponsored-gas recording below is real production code.
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { serializeUserOp } from '../../rails/execution-rail.js'
import { SubmittedUserOpFailedError } from '../../rails/delegation-rail.js'

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Sponsored Gas Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const USEROP_SIGNATURE = `0x${'ab'.repeat(97)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PREPARED_USER_OP = {
  sender: AGENT.account_address,
  nonce: 1n,
  callData: '0xdeadbeef',
}

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
const CLAIM_OK: DbRoute = [/SET signature[\s\S]*status = 'submitted'/, () => ({ rows: [{ id: PAYMENT_ID }] })]
const CONFIRM_OK: DbRoute = [/SET status = 'confirmed'/, () => ({ rows: [{ id: PAYMENT_ID }] })]
const FAIL_WRITE: DbRoute = [/SET status = 'failed'/, () => ({ rows: [] })]

const SPONSORED_INSERT: DbRoute = [/INSERT INTO sponsored_userop_gas_events/, () => ({ rows: [{ id: 'row-1' }] })]

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    account_address: AGENT.account_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    amount_raw: '100000',
    amount_human: '0.10',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 0,
    sign_hash: `0x${'11'.repeat(32)}`,
    signature: null,
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: 'delegation',
    delegation_hash: DELEGATION_HASH,
    budget_delegation_hash: null,
    task_budget_id: null,
    prepared_user_op: JSON.parse(serializeUserOp(PREPARED_USER_OP)),
    payment_rail: null,
    source: null,
    x402_resource_url: null,
    payment_resource_url: null,
    ...overrides,
  }
}

const intentById = (row: Record<string, unknown>): DbRoute => [
  /FROM payment_intents\s+WHERE id/,
  () => ({ rows: [row] }),
]

function sponsoredInsertCalls(): { sql: string; params: unknown[] }[] {
  return mockQuery.mock.calls
    .filter((c) => /INSERT INTO sponsored_userop_gas_events/.test(String(c[0])))
    .map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }))
}

describe('POST /payments/:id/sign — sponsored-gas recording (#3837)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/payments.ts'] })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    fiatMocks.getBookTimeCapture.mockResolvedValue(null)
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0.1, eur: 0.09, sek: 1 })
  })

  async function sign() {
    return app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: USEROP_SIGNATURE },
    })
  }

  it('a successful submit records the receipt cost (direct leg by default), then books confirmed', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, SPONSORED_INSERT, CONFIRM_OK)
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({
      txHash: '0xfeed',
      userOpHash: '0xuop',
      actualGasUsed: 100000n,
      actualGasCost: 3000000000000n,
    })

    const res = await sign()

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('confirmed')
    const calls = sponsoredInsertCalls()
    expect(calls).toHaveLength(1)
    const p = calls[0].params
    expect(p[0]).toBe(PAYMENT_ID)
    expect(p[1]).toBe(AGENT.id)
    expect(p[2]).toBe(AGENT.user_id)
    expect(p[3]).toBe(AGENT.chain_id)
    expect(p[4]).toBe('direct') // payment_rail null → direct
    expect(p[5]).toBe('confirmed')
    expect(p[6]).toBe('0xuop')
    expect(p[7]).toBe('0xfeed')
    expect(p[9]).toBe('3000000000000')
    // Recording happens BEFORE the booking (outside confirmSubmittedIntent).
    const insertAt = mockQuery.mock.calls.findIndex((c) => /INSERT INTO sponsored_userop_gas_events/.test(String(c[0])))
    const confirmAt = mockQuery.mock.calls.findIndex((c) => /SET status = 'confirmed'/.test(String(c[0])))
    expect(insertAt).toBeGreaterThan(-1)
    expect(confirmAt).toBeGreaterThan(insertAt)
  })

  it('an x402 funding leg is tagged x402_funding, not direct', async () => {
    primeDb(AUTH, intentById(intentRow({ payment_rail: 'x402', source: 'x402' })), CLAIM_OK, SPONSORED_INSERT, CONFIRM_OK)
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({
      txHash: '0xfeed',
      userOpHash: '0xuop',
      actualGasUsed: 1n,
      actualGasCost: 5n,
    })

    const res = await sign()

    expect(res.statusCode).toBe(200)
    const p = sponsoredInsertCalls()[0].params
    expect(p[4]).toBe('x402_funding')
  })

  it('a landed-but-reverted op records the cost carried on the widened error, then books failed', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, SPONSORED_INSERT, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new SubmittedUserOpFailedError('redemption UserOp 0xabc included but reverted', '0xabc', 'included_reverted', 123456789n),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().status).toBe('failed')
    const p = sponsoredInsertCalls()[0].params
    expect(p[5]).toBe('included_reverted')
    expect(p[6]).toBe('0xabc')
    expect(p[8]).toBeNull() // no gas_used surface on the error path
    expect(p[9]).toBe('123456789')
    // The op is terminal — the failed booking still ran.
    expect(mockQuery.mock.calls.some((c) => /SET status = 'failed'/.test(String(c[0])))).toBe(true)
  })

  it('a receipt-unconfirmed op records a COST-NULL row and stays outcome-pending', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, SPONSORED_INSERT)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new SubmittedUserOpFailedError('redemption UserOp 0xabc was sent but its receipt could not be confirmed: timeout', '0xabc', 'receipt_unconfirmed'),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('submission_outcome_unknown')
    const p = sponsoredInsertCalls()[0].params
    expect(p[5]).toBe('receipt_unconfirmed')
    expect(p[9]).toBeNull()
    // NOT terminal — no failed booking on the outcome-unknown arm.
    expect(mockQuery.mock.calls.some((c) => /SET status = 'failed'/.test(String(c[0])))).toBe(false)
  })

  it('a pre-send bundler rejection records NOTHING — the op never entered the mempool', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error('UserOperation reverted during simulation: AA24 signature error'),
    )

    const res = await sign()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('signature_rejected')
    expect(sponsoredInsertCalls()).toHaveLength(0)
  })

  it('a recording failure never fails the payment: the insert throws, the submit still books confirmed', async () => {
    primeDb(
      AUTH,
      intentById(intentRow()),
      CLAIM_OK,
      [/INSERT INTO sponsored_userop_gas_events/, () => { throw new Error('connection reset') }],
      CONFIRM_OK,
    )
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({
      txHash: '0xfeed',
      userOpHash: '0xuop',
      actualGasUsed: 100000n,
      actualGasCost: 3000000000000n,
    })

    const res = await sign()

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('confirmed')
    // The insert was attempted (then swallowed), and the booking still ran.
    expect(sponsoredInsertCalls()).toHaveLength(1)
    expect(mockQuery.mock.calls.some((c) => /SET status = 'confirmed'/.test(String(c[0])))).toBe(true)
  })
})
