// db-mock-exempt: module-level create-flow test (status/response-shape) — the SQL's real behaviour (idempotency pin, insert, delegation selection) is proven in infra/repositories/__tests__/payment-intents.test.ts on the real-DB harness
/**
 * #4760 (epic #4759 slice 1) — the `POST /payments` create flow, called
 * DIRECTLY.
 *
 * The point of this file is the contract the move created: `createPayment`
 * takes plain inputs and returns a decided `{ code, body }` response, with no
 * Fastify object anywhere in the call. Every case here calls the module
 * function itself — no `app.inject`, no server, no request — and asserts the
 * decided result. The route's own wiring (auth, rate limit, the send) stays
 * covered by the untouched `routes/__tests__/payments*.test.ts`
 * characterization suite.
 *
 * Scaffolding (the delegation-rail mock stack a genuine 201 needs) is cloned
 * from `routes/__tests__/payments-recipient-history.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockCompute, mockCreateRail, mockReadRemaining, mockHasConfirmed } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateRail: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockHasConfirmed: vi.fn(),
}))
vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))
vi.mock('../../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}))
vi.mock('../../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})
vi.mock('../../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-rail.js')>()
  return {
    ...actual,
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
    createDelegationRail: (...a: unknown[]) => mockCreateRail(...a),
  }
})
// The advisory recipient read is mocked directly rather than through its raw
// EXISTS SQL — its real behaviour (confirmed-only, chain-scoped, cross-tenant
// isolation) is the real-DB repository suite's job.
vi.mock('../../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/payment-intents.js')>()
  return { ...actual, hasConfirmedPaymentToRecipient: (...a: unknown[]) => mockHasConfirmed(...a) }
})

const { createPayment } = await import('../create-payment.js')

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Create Flow Payer',
  delegate_address: '0x' + 'bb'.repeat(20),
  account_address: '0x' + 'aa'.repeat(20),
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
  has_bound_account: true,
}
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const RECIPIENT = '0x' + 'cc'.repeat(20)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] }]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

function delegationJson(delegator: string, salt: string) {
  return JSON.stringify({
    delegate: DELEGATE_ACCOUNT,
    delegator,
    authority: `0x${'ff'.repeat(32)}`,
    caveats: [],
    salt,
    signature: `0x${'ab'.repeat(65)}`,
  })
}
const SELECTED_JSON = delegationJson('0x' + 'e1'.repeat(20), '1')

const RAIL_STATE: DbRoute = [/SELECT us.execution_rail/, () => ({ rows: [{ execution_rail: 'delegation' }] })]
const SELECTED_GRANT: DbRoute = [
  /FROM agent_delegations\s+WHERE agent_id = \$1\s+AND token_address/,
  () => ({
    rows: [
      {
        delegation_hash: `0x${'99'.repeat(32)}`,
        delegation_json: SELECTED_JSON,
        recipient_address: null,
        budget_atomic: '10000',
      },
    ],
  }),
]
const INSERT_INTENT: DbRoute = [
  /INSERT INTO payment_intents/,
  () => ({ rows: [{ id: 'intent-1', status: 'pending_signature', expires_at: '2026-09-30T00:10:00.000Z' }] }),
]

const log = { warn: vi.fn() }

const create = (body: Record<string, unknown>) =>
  createPayment({ agent: AGENT as never, body: body as never, log })

describe('createPayment (#4760): the create flow decides without a Fastify object', () => {
  const prepareRedemption = vi.fn()
  beforeEach(() => {
    mockQuery.mockReset()
    mockReadRemaining.mockReset()
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1000000000000', fromChain: true })
    mockHasConfirmed.mockReset()
    mockHasConfirmed.mockResolvedValue(false)
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
    log.warn.mockReset()
    prepareRedemption.mockReset()
    prepareRedemption.mockResolvedValue({
      userOperation: { sender: DELEGATE_ACCOUNT },
      userOpHash: `0x${'11'.repeat(32)}`,
      signingTypedData: { primaryType: 'PackedUserOperation', message: { sender: DELEGATE_ACCOUNT } },
      delegateAccountAddress: DELEGATE_ACCOUNT,
    })
    mockCreateRail.mockReset()
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: DELEGATE_ACCOUNT,
      prepareRedemption,
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn(),
    })
    primeDb(RAIL_STATE, [/send_idempotency_key = \$2/, () => ({ rows: [] })], SELECTED_GRANT, INSERT_INTENT)
  })

  afterEach(async () => {
    // Drain any fire-and-forget write before the next test's mock resets.
    let seen = -1
    while (seen !== mockQuery.mock.calls.length) {
      seen = mockQuery.mock.calls.length
      await new Promise((r) => setTimeout(r, 25))
    }
  })

  it('REFUSES a non-positive amount with the decided 400 body, before any database read', async () => {
    const decided = await create({ token: 'USDC', amount: '0', to: RECIPIENT })
    expect(decided).toEqual({ code: 400, body: { error: 'Amount must be a positive number' } })
    // The refusal is decided by the module alone: no rail read, no chain read,
    // no insert — the route never had to exist for this answer.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(prepareRedemption).not.toHaveBeenCalled()
  })

  it('REFUSES a retired-rail account with the 410 tombstone, before token resolution', async () => {
    primeDb([/SELECT us.execution_rail/, () => ({ rows: [{ execution_rail: null }] })])
    const decided = await create({ token: 'NOT_A_TOKEN', amount: '1', to: RECIPIENT })
    expect(decided.code).toBe(410)
    // #2274: the rail gate answers before the unsupported-token 400 would.
    expect(JSON.stringify(decided.body)).not.toContain('supported')
  })

  it('SUCCEEDS with the 201 create body — payment_id, status and sign_data', async () => {
    const decided = await create({ token: 'USDC', amount: '0.005', to: RECIPIENT })
    expect(decided.code).toBe(201)
    const body = decided.body as Record<string, unknown>
    expect(body.payment_id).toBe('intent-1')
    expect(body.status).toBe('pending_signature')
    expect(body.expires_at).toBe('2026-09-30T00:10:00.000Z')
    expect(body.recipient).toEqual({ class: 'new_address' })
    const signData = body.sign_data as Record<string, unknown>
    expect(signData.hash).toBe(`0x${'11'.repeat(32)}`)
    expect(signData.signature_scheme).toBe('eip712_userop')
    expect(signData.components).toEqual({
      account: DELEGATE_ACCOUNT,
      token: USDC,
      to: RECIPIENT.toLowerCase(),
      amount: '5000',
    })
    expect(prepareRedemption).toHaveBeenCalledTimes(1)
  })

  it('SUCCEEDS with `previously_paid` when this agent has a confirmed payment to the recipient', async () => {
    mockHasConfirmed.mockResolvedValue(true)
    const decided = await create({ token: 'USDC', amount: '0.005', to: RECIPIENT })
    expect(decided.code).toBe(201)
    expect((decided.body as Record<string, unknown>).recipient).toEqual({ class: 'previously_paid' })
    expect(mockHasConfirmed).toHaveBeenCalledWith(AGENT.id, AGENT.chain_id, RECIPIENT.toLowerCase())
  })
})
