// db-mock-exempt: route-level handler test (status/refusal codes) — DB behaviour is proven in infra/repositories/__tests__/{agent-delegations,payment-intents}.test.ts on the real-DB harness
/**
 * #3503 — `POST /payments` pre-checks the agent's PERIOD budget on-chain,
 * the way the x402 legs have since #2082/#2706. Before this, an over-budget
 * direct payment was answered only by the simulation revert: an untyped 502
 * whose hosted next step said "transient, retry once".
 *
 * Pattern-matched DB mocks (#775); the delegation rail is mocked at
 * `createDelegationRail`/`delegationRailBundlerUrl` and the budget read at
 * `readRemainingBudget`, so no bundler or chain call happens.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute, mockCreateRail, mockReadRemaining, mockReadSpent } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateRail: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockReadSpent: vi.fn(),
}))
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))
vi.mock('../../infra/chain/task-budget-spent-reader.js', () => ({
  readTaskBudgetSpent: (...a: unknown[]) => mockReadSpent(...a),
}))
vi.mock('../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})
vi.mock('../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-rail.js')>()
  return {
    ...actual,
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
    createDelegationRail: (...a: unknown[]) => mockCreateRail(...a),
  }
})

const paymentRoutes = (await import('../payments.js')).default

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Period Budget Payer',
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
const PARENT_HASH = `0x${'ab'.repeat(32)}`
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
// The (token, to) grant and a task budget's by-hash parent carry DISTINCT
// delegation_json, so a test can tell which one the budget read was given.
const SELECTED_JSON = delegationJson('0x' + 'e1'.repeat(20), '1')
const PARENT_JSON = delegationJson(AGENT.account_address, '2')

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
const RAIL_STATE: DbRoute = [/SELECT us.execution_rail/, () => ({ rows: [{ execution_rail: 'delegation' }] })]
const NO_IDEMPOTENCY_REPLAY: DbRoute = [/send_idempotency_key = \$2/, () => ({ rows: [] })]
const SELECTED_GRANT_SQL =
  /SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1\s+AND token_address/
const SELECTED_GRANT: DbRoute = [
  SELECTED_GRANT_SQL,
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
const PARENT_BY_HASH: DbRoute = [
  /SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1 AND delegation_hash = \$2/,
  () => ({
    rows: [{ delegation_hash: PARENT_HASH, delegation_json: PARENT_JSON, recipient_address: null, budget_atomic: '10000' }],
  }),
]
const TASK_BUDGET: DbRoute = [
  /FROM agent_task_budgets\s+WHERE id = \$1 AND agent_id = \$2/,
  () => ({
    rows: [
      {
        id: 'tb-1',
        agent_id: AGENT.id,
        chain_id: AGENT.chain_id,
        token_address: USDC.toLowerCase(),
        recipient_address: null,
        parent_delegation_hash: PARENT_HASH,
        delegation_hash: `0x${'cd'.repeat(32)}`,
        delegation_json: delegationJson(DELEGATE_ACCOUNT, '3'),
        label: 'Test task',
        max_atomic: '1000000',
        status: 'open',
        expires_at: String(Math.floor(Date.now() / 1000) + 3600),
        prepared_user_op: null,
        close_tx_hash: null,
        created_at: '2026-09-30T00:00:00.000Z',
        updated_at: '2026-09-30T00:00:00.000Z',
        opened_at: '2026-09-30T00:00:00.000Z',
        closed_at: null,
      },
    ],
  }),
]
const INSERT_INTENT: DbRoute = [
  /INSERT INTO payment_intents/,
  () => ({ rows: [{ id: 'intent-1', status: 'pending_signature', expires_at: '2026-09-30T00:10:00.000Z' }] }),
]
// The verbatim shape a bundler relays (dev, 2026-08-25): the enforcer's reason
// as an ABI-encoded Error(string), hex — never the plain enforcer name, which
// is what the first draft of this fixture carried (review finding).
const PERIOD_REVERT = new Error(
  'UserOperation reverted during simulation with reason: 0x08c379a0' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000034' +
    '4552433230506572696f645472616e73666572456e666f726365723a7472616e736665722d616d6f756e742d65786365656465' +
    '6400000000000000000000000000',
)

describe('POST /payments: the period budget cannot cover the payment (#3503)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())

  const prepareRedemption = vi.fn()
  beforeEach(() => {
    mockQuery.mockReset()
    mockReadRemaining.mockReset()
    mockReadSpent.mockReset()
    mockReadSpent.mockResolvedValue(0n)
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
    prepareRedemption.mockReset()
    prepareRedemption.mockResolvedValue({
      userOperation: { sender: DELEGATE_ACCOUNT },
      userOpHash: `0x${'11'.repeat(32)}`,
      signingTypedData: { primaryType: 'PackedUserOperation' },
      delegateAccountAddress: DELEGATE_ACCOUNT,
    })
    mockCreateRail.mockReset()
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: DELEGATE_ACCOUNT,
      prepareRedemption,
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn(),
    })
    primeDb(AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, SELECTED_GRANT, PARENT_BY_HASH, TASK_BUDGET, INSERT_INTENT)
  })

  // A refusal's ledger write is fire-and-forget. Wait for the DB mock to go
  // quiet so a write a failing test never awaited cannot land in the NEXT
  // test's rows (it made one mutation look like four failures).
  afterEach(async () => {
    let seen = -1
    while (seen !== mockQuery.mock.calls.length) {
      seen = mockQuery.mock.calls.length
      await new Promise((r) => setTimeout(r, 25))
    }
  })

  // 0.005 USDC = 5000 atomic.
  const pay = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.005', to: RECIPIENT, ...extra },
    })
  const refusalRows = () => mockQuery.mock.calls.filter((c) => /INSERT INTO payment_refusals/.test(String(c[0])))
  const intentWritten = () => mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))

  it('pre-check: refuses with a typed 403 before any UserOp is built, and books a budget refusal', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '500', fromChain: true })
    const res = await pay()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      error_code: 'delegation_budget_exceeded',
      phase: 'insufficient_funds',
      next_action: 'fund_account_or_raise_allowance',
      rail: 'direct',
      chain_id: AGENT.chain_id,
      token: 'USDC',
      amount: '0.005',
      amount_atomic: '5000',
      remaining: '0.0005',
      remaining_atomic: '500',
      shortfall: '0.0045',
      shortfall_atomic: '4500',
      recipient: RECIPIENT.toLowerCase(),
    })
    expect(prepareRedemption).not.toHaveBeenCalled()
    expect(intentWritten()).toBe(false)
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
    expect(refusalRows()[0]![1]).toContain('delegation_budget_exceeded')
  })

  it('reads the budget of the (token, to) grant it redeems, selected ONCE', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '10000', fromChain: true })
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect(mockReadRemaining).toHaveBeenCalledWith(AGENT.chain_id, SELECTED_JSON, '5000')
    // The row read is the row redeemed: one selection, handed to the rail.
    expect(mockQuery.mock.calls.filter((c) => SELECTED_GRANT_SQL.test(String(c[0])))).toHaveLength(1)
    const chainArg = prepareRedemption.mock.calls[0]![0]
    expect(chainArg).toEqual([JSON.parse(SELECTED_JSON)])
  })

  it('the exact remainder is allowed', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000', fromChain: true })
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect(prepareRedemption).toHaveBeenCalled()
  })

  it('an unreadable chain skips the pre-check — the enforcer stays the gate', async () => {
    mockReadRemaining.mockRejectedValue(new Error('rpc down'))
    expect((await pay()).statusCode).toBe(201)
  })

  it('a delegation without a readable period caveat (fromChain: false) skips the pre-check', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '0', fromChain: false })
    expect((await pay()).statusCode).toBe(201)
  })

  it('with a task budget, reads the task budget\'s parent by hash — never the (token, to) grant', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '500', fromChain: true })
    const res = await pay({ task_budget_id: 'tb-1' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error_code).toBe('delegation_budget_exceeded')
    expect(mockReadRemaining).toHaveBeenCalledWith(AGENT.chain_id, PARENT_JSON, '5000')
    expect(mockQuery.mock.calls.some((c) => SELECTED_GRANT_SQL.test(String(c[0])))).toBe(false)
    // Drain the fire-and-forget ledger write, or it lands in the NEXT test's
    // mockQuery and doubles its row count (doc-review finding: 3/7 flaky).
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
  })

  it('revert fallback: a period revert a fresh budget read confirms is the same typed 403, not a "transient" 502', async () => {
    // The pre-check read fits (a concurrent payment landed in between); the
    // simulation then reverts; the fallback's fresh read confirms it.
    mockReadRemaining
      .mockResolvedValueOnce({ remainingAtomic: '10000', fromChain: true })
      .mockResolvedValueOnce({ remainingAtomic: '0', fromChain: true })
    prepareRedemption.mockRejectedValue(PERIOD_REVERT)
    const res = await pay()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      error_code: 'delegation_budget_exceeded',
      remaining_atomic: '0',
      shortfall_atomic: '5000',
    })
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
  })

  it('a period revert the fresh read does NOT confirm keeps the 502, booked as a budget refusal', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '10000', fromChain: true })
    prepareRedemption.mockRejectedValue(PERIOD_REVERT)
    const res = await pay()
    expect(res.statusCode).toBe(502)
    // Not the typed budget 403 — the #3609 revert answer, named by the classifier.
    expect(res.json()).toMatchObject({ error_code: 'prepare_reverted', refusal_reason: 'delegation_budget_exceeded' })
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
    expect(refusalRows()[0]![1]).toContain('delegation_budget_exceeded')
  })

  // #3609: what the prepare catch answers once the typed budget fallbacks
  // have passed — typed, and never the raw dump.
  it('#3609: an unconfirmed period revert carrying the live ~6 KB dump answers a bounded prepare_reverted', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '10000', fromChain: true })
    prepareRedemption.mockRejectedValue(
      new Error(
        `${PERIOD_REVERT.message}.\n\nRequest Arguments:\n  callData: 0x5c1c6dcd${'ab'.repeat(2800)}\n  paymasterData: 0x01${'cd'.repeat(80)}`,
      ),
    )
    const res = await pay()
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({
      error_code: 'prepare_reverted',
      refusal_reason: 'delegation_budget_exceeded',
      revert_reason: 'ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
    })
    expect(res.json().details.length).toBeLessThanOrEqual(301)
    expect(res.body.length).toBeLessThan(1500)
    expect(res.body).not.toContain('paymasterData')
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
  })

  it('#3609: a failure that is not a revert answers prepare_failed and books nothing', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '10000', fromChain: true })
    prepareRedemption.mockRejectedValue(new Error('fetch failed: bundler unreachable (ETIMEDOUT)'))
    const res = await pay()
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: 'Delegation-rail authorization failed (bundler or RPC)',
      error_code: 'prepare_failed',
      details: 'fetch failed: bundler unreachable (ETIMEDOUT)',
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(refusalRows()).toHaveLength(0)
  })

  it('no grant for (token, to): no budget read, the existing no-delegation refusal', async () => {
    primeDb(AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, INSERT_INTENT)
    const res = await pay()
    expect(res.json().error_code).not.toBe('delegation_budget_exceeded')
    expect(mockReadRemaining).not.toHaveBeenCalled()
    expect(prepareRedemption).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1)) // drain the no-delegation row
  })
})
