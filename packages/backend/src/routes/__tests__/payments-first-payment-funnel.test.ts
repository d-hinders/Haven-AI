/**
 * #4354 — `POST /payments/:id/sign` writes the funnel's last step,
 * `first_payment_settled`, after its confirm and only after it.
 *
 * This route serves the direct rail AND the x402 EIP-3009 funding leg (the
 * SDK's `x402-funding-leg.ts` posts here), so it is one of the three settled
 * transitions the funnel must hear from. The other two are the erc7710
 * settlement seam (`modules/x402/settlement-observed.ts`) and the outcome
 * reconciler (`modules/payments/submission-reconciler.ts`); the insert's own
 * SQL (once per user, confirmed rows only, the rail label) is proven on real
 * Postgres in `infra/repositories/__tests__/first-payment-settled.db.test.ts`.
 *
 * Pattern-matched DB stub, as in `payments-sponsored-gas.test.ts`: the route's
 * own writes are real production code behind a pattern-matched `db.js` mock;
 * only the bundler seam and fiat are mocked.
 *
 * db-mock-exempt is declared on the line comment below (the ratchet reads
 * `//` comments only).
// db-mock-exempt: route-level test of the FUNNEL WIRING (which outcome emits
// and in what order) — the same exemption payments-sponsored-gas.test.ts
// carries. The insert's SQL behaviour is proven on the real-DB harness in the
// repository test named above, with zero mocks.
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
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { serializeUserOp } from '../../rails/execution-rail.js'
import { SubmittedUserOpFailedError } from '../../rails/delegation-rail.js'

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Funnel Agent',
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
const PREPARED_USER_OP = { sender: AGENT.account_address, nonce: 1n, callData: '0xdeadbeef' }

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
const CONFIRM_LOST: DbRoute = [/SET status = 'confirmed'/, () => ({ rows: [] })]
const FAIL_WRITE: DbRoute = [/SET status = 'failed'/, () => ({ rows: [] })]

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

/** Every funnel write that names this payment, in call order. */
function funnelWritesForPayment(): number[] {
  return mockQuery.mock.calls
    .map((c, i) => ({ sql: String(c[0]), params: c[1], i }))
    .filter(
      (c) =>
        /INSERT INTO onboarding_events/.test(c.sql) &&
        JSON.stringify([c.sql, c.params]).includes('first_payment_settled') &&
        JSON.stringify(c.params ?? []).includes(PAYMENT_ID),
    )
    .map((c) => c.i)
}

/** The emitter is fire-and-forget; let its async body run before asserting. */
const drain = () => new Promise((r) => setTimeout(r, 0))

describe('POST /payments/:id/sign — first_payment_settled wiring (#4354)', () => {
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

  const landed = () =>
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({
      txHash: '0xfeed',
      userOpHash: '0xuop',
      actualGasUsed: 1n,
      actualGasCost: 5n,
    })

  it('a confirmed direct payment writes the funnel step once, after the confirm', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, CONFIRM_OK)
    landed()

    const res = await sign()
    await drain()

    expect(res.statusCode).toBe(200)
    const writes = funnelWritesForPayment()
    expect(writes).toHaveLength(1)
    const confirmAt = mockQuery.mock.calls.findIndex((c) => /SET status = 'confirmed'/.test(String(c[0])))
    expect(writes[0]).toBeGreaterThan(confirmAt)
  })

  it('a confirmed x402 funding leg writes the funnel step too — this route serves it', async () => {
    primeDb(AUTH, intentById(intentRow({ payment_rail: 'x402', source: 'x402' })), CLAIM_OK, CONFIRM_OK)
    landed()

    const res = await sign()
    await drain()

    expect(res.statusCode).toBe(200)
    expect(funnelWritesForPayment()).toHaveLength(1)
  })

  it('a lost confirm (409) writes nothing', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, CONFIRM_LOST)
    landed()

    const res = await sign()
    await drain()

    expect(res.statusCode).toBe(409)
    expect(funnelWritesForPayment()).toHaveLength(0)
  })

  it('a reverted submit writes nothing', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK, FAIL_WRITE)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new SubmittedUserOpFailedError('redemption UserOp 0xabc included but reverted', '0xabc', 'included_reverted', 1n),
    )

    const res = await sign()
    await drain()

    expect(res.statusCode).toBe(502)
    expect(funnelWritesForPayment()).toHaveLength(0)
  })

  it('a receipt-unconfirmed submit writes nothing — the reconciler owns that confirm', async () => {
    primeDb(AUTH, intentById(intentRow()), CLAIM_OK)
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new SubmittedUserOpFailedError('redemption UserOp 0xabc was sent but its receipt could not be confirmed: timeout', '0xabc', 'receipt_unconfirmed'),
    )

    await sign()
    await drain()

    expect(funnelWritesForPayment()).toHaveLength(0)
  })
})
