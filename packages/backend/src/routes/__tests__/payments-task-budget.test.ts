// db-mock-exempt: route-level handler test (status/refusal codes) — DB behaviour is proven in infra/repositories/__tests__/{task-budgets,payment-intents}.test.ts on the real-DB harness
/**
 * #3329 §3 — `POST /payments` with `task_budget_id`: the [taskChild, budget]
 * chain and the refusal table (task_budget_not_found/not_open/token_mismatch/
 * recipient_mismatch/parent_mismatch). Pattern-matched DB mocks (#775); the
 * delegation rail is mocked at `createDelegationRail`/`delegationRailBundlerUrl`
 * so no bundler/chain call happens — this file owns only the route's
 * decisions, same convention as `payments.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// #3503: POST /payments now pre-checks the period budget on-chain — never a live chain here.
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: async () => ({ remainingAtomic: '1000000000000', fromChain: true }),
}))
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute, mockCreateRail, mockReadSpent } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateRail: vi.fn(),
  mockReadSpent: vi.fn(),
}))
// #3500: the task-budget cap pre-check reads the enforcer's spentMap; no chain here.
vi.mock('../../infra/chain/task-budget-spent-reader.js', () => ({
  readTaskBudgetSpent: (...a: unknown[]) => mockReadSpent(...a),
}))
vi.mock('../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}))
// The refusal ledger's write values the amount in fiat — a live price fetch
// unmocked, whose latency decides whether a booked row lands inside `waitFor`.
vi.mock('../../infra/fiat-values.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/fiat-values.js')>()
  return { ...actual, getFiatValuesForTokenAmount: async () => ({ usd: 0, eur: 0, sek: 0 }) }
})
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
  name: 'Task Budget Payer',
  delegate_address: '0x' + 'bb'.repeat(20),
  account_address: '0x' + 'aa'.repeat(20),
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
  has_bound_account: true,
}
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)
const BUDGET_HASH = `0x${'ab'.repeat(32)}`

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
const RAIL_STATE: DbRoute = [/SELECT us.execution_rail/, () => ({ rows: [{ execution_rail: 'delegation' }] })]
const NO_IDEMPOTENCY_REPLAY: DbRoute = [/send_idempotency_key = \$2/, () => ({ rows: [] })]
function budgetRow(overrides: Record<string, unknown> = {}) {
  return {
    delegation_hash: BUDGET_HASH,
    delegation_json: JSON.stringify({
      delegate: DELEGATE_ACCOUNT,
      delegator: AGENT.account_address,
      authority: `0x${'ff'.repeat(32)}`,
      caveats: [],
      salt: '1',
      signature: `0x${'ab'.repeat(65)}`,
    }),
    recipient_address: null,
    budget_atomic: '5000000',
    ...overrides,
  }
}

// #3329 review finding E: the task-budget payment path selects the parent
// by HASH (never by token/to) — this mock ignores the queried hash and
// always answers with `budgetRow()` unless a test overrides it, matching
// this file's existing style of "the SQL text is matched, not the params".
const BUDGET_DELEGATION: DbRoute = [
  /SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1 AND delegation_hash = \$2/,
  () => ({ rows: [budgetRow()] }),
]
// The ORDINARY (token, to) selection `prepareDelegationPayment` falls back
// to when no task_budget_id resolves — a DIFFERENT (pinned) grant with its
// OWN delegator (nit from #3329 review: the two fixtures used to share
// `budgetRow()`'s delegation_json, so the delegator assertion below was
// vacuous — it would have passed even if the by-hash selection were never
// used), so a test can prove the by-hash selection is what actually wins.
const PINNED_DELEGATOR = '0x' + 'ee'.repeat(20)
const PINNED_BUDGET_DELEGATION: DbRoute = [
  /SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1\s+AND token_address/,
  () => ({
    rows: [
      budgetRow({
        delegation_hash: `0x${'99'.repeat(32)}`,
        delegation_json: JSON.stringify({
          delegate: DELEGATE_ACCOUNT,
          delegator: PINNED_DELEGATOR,
          authority: `0x${'ff'.repeat(32)}`,
          caveats: [],
          salt: '2',
          signature: `0x${'cd'.repeat(65)}`,
        }),
        recipient_address: RECIPIENT.toLowerCase(),
      }),
    ],
  }),
]
const INSERT_INTENT: DbRoute = [
  /INSERT INTO payment_intents/,
  () => ({
    rows: [
      {
        id: 'intent-1',
        status: 'pending_signature',
        expires_at: '2026-09-25T00:10:00.000Z',
      },
    ],
  }),
]

function taskBudgetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tb-1',
    agent_id: AGENT.id,
    chain_id: AGENT.chain_id,
    token_address: USDC.toLowerCase(),
    recipient_address: null,
    parent_delegation_hash: BUDGET_HASH,
    delegation_hash: `0x${'cd'.repeat(32)}`,
    delegation_json: JSON.stringify({
      delegate: DELEGATE_ACCOUNT,
      delegator: DELEGATE_ACCOUNT,
      authority: BUDGET_HASH,
      caveats: [],
      salt: '2',
      signature: `0x${'ef'.repeat(65)}`,
    }),
    label: 'Test task',
    max_atomic: '1000000',
    status: 'open',
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
    opened_at: '2026-09-25T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  }
}

function taskBudgetLookup(row: Record<string, unknown> | null): DbRoute {
  return [/FROM agent_task_budgets\s+WHERE id = \$1 AND agent_id = \$2/, () => ({ rows: row ? [row] : [] })]
}

describe('POST /payments with task_budget_id (#3329)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())

  beforeEach(() => {
    mockQuery.mockReset()
    mockReadSpent.mockReset()
    mockReadSpent.mockResolvedValue(0n)
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
    mockCreateRail.mockReset()
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: DELEGATE_ACCOUNT,
      prepareRedemption: vi.fn().mockResolvedValue({
        userOperation: { sender: DELEGATE_ACCOUNT },
        userOpHash: `0x${'11'.repeat(32)}`,
        signingTypedData: { primaryType: 'PackedUserOperation' },
        delegateAccountAddress: DELEGATE_ACCOUNT,
      }),
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn(),
    })
  })

  function body(overrides: Record<string, unknown> = {}) {
    return { token: 'USDC', amount: '1', to: RECIPIENT, task_budget_id: 'tb-1', ...overrides }
  }

  it('404s task_budget_not_found when the id does not resolve for this agent', async () => {
    primeDb(AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION, taskBudgetLookup(null), INSERT_INTENT)
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: body(),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error_code).toBe('task_budget_not_found')
  })

  it('409s task_budget_not_open for a pending row', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow({ status: 'pending' })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_not_open')
  })

  it('409s task_budget_not_open for an expired open row', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow({ expires_at: String(Math.floor(Date.now() / 1000) - 10) })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_not_open')
  })

  it('409s task_budget_token_mismatch when the payment token differs', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow({ token_address: '0x' + 'f0'.repeat(20) })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_token_mismatch')
  })

  it('409s task_budget_recipient_mismatch when the pinned recipient differs', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow({ recipient_address: '0x' + '99'.repeat(20) })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_recipient_mismatch')
  })

  it('409s task_budget_parent_mismatch when the row was carved from a different parent', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow({ parent_delegation_hash: `0x${'99'.repeat(32)}` })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_parent_mismatch')
  })

  it('happy path: an open, matching task budget authorizes the payment and its id is persisted on the intent', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(201)
    // The chain passed to prepareRedemption is [taskChild, budget] — assert
    // the rail was invoked with a 2-length chain, leaf (task child) first.
    const rail = await mockCreateRail.mock.results[0]!.value
    const chainArg = rail.prepareRedemption.mock.calls[0][0]
    expect(chainArg).toHaveLength(2)
    expect(chainArg[0].delegator).toBe(DELEGATE_ACCOUNT) // task child: self-delegated
    expect(chainArg[1].delegation_hash ?? chainArg[1].delegate).toBeDefined()
    const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO payment_intents/.test(String(c[0])))
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    expect(params).toContain('tb-1')
  })

  it('#3329 review finding E: with BOTH an open and a pinned grant present, the task budget resolves through its OWN parent by hash, not the (token, to) pin', async () => {
    // The pinned grant's recipient equals `to` — under the OLD (token, to)
    // selection this would win and mismatch the task budget's real (open)
    // parent. `PINNED_BUDGET_DELEGATION` answers the ordinary selection
    // `prepareDelegationPayment` would otherwise fall back to; `BUDGET_DELEGATION`
    // (by hash) is the task budget's REAL parent and must be what is used.
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION, PINNED_BUDGET_DELEGATION,
      taskBudgetLookup(taskBudgetRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(201)
    const rail = await mockCreateRail.mock.results[0]!.value
    const chainArg = rail.prepareRedemption.mock.calls[0][0]
    // chainArg[1] is the parent budget delegation redeemed — must be the
    // task budget's OWN parent (delegator = AGENT.account_address, the open
    // grant), never the pinned grant's distinct delegator.
    expect(chainArg[1].delegator.toLowerCase()).toBe(AGENT.account_address.toLowerCase())
    expect(chainArg[1].delegator.toLowerCase()).not.toBe(PINNED_DELEGATOR.toLowerCase())
  })
})

describe('POST /payments: a task budget whose cap cannot cover the payment (#3500)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())

  const prepareRedemption = vi.fn()
  beforeEach(() => {
    mockQuery.mockReset()
    mockReadSpent.mockReset()
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
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, BUDGET_DELEGATION,
      // cap 1.0 USDC (1_000_000 atomic); the payment below is 0.5 USDC.
      taskBudgetLookup(taskBudgetRow({ max_atomic: '1000000' })), INSERT_INTENT,
    )
  })

  const pay = () =>
    app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.5', to: RECIPIENT, task_budget_id: 'tb-1' },
    })
  const refusalRows = () =>
    mockQuery.mock.calls.filter((c) => /INSERT INTO payment_refusals/.test(String(c[0])))

  it('pre-check: refuses with a typed 403 before any UserOp is built, and books a budget refusal', async () => {
    mockReadSpent.mockResolvedValue(700_000n) // 0.3 left, 0.5 asked
    const res = await pay()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      error_code: 'task_budget_exceeded',
      task_budget_id: 'tb-1',
      remaining_atomic: '300000',
      max_atomic: '1000000',
      amount_atomic: '500000',
    })
    expect(prepareRedemption).not.toHaveBeenCalled()
    expect(mockReadSpent).toHaveBeenCalledWith(AGENT.chain_id, `0x${'cd'.repeat(32)}`)
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
    expect(refusalRows()[0]![1]).toContain('delegation_budget_exceeded')
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('the exact remainder is allowed', async () => {
    mockReadSpent.mockResolvedValue(500_000n)
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect(prepareRedemption).toHaveBeenCalled()
  })

  it('an unreadable chain skips the pre-check — the enforcer stays the gate', async () => {
    mockReadSpent.mockRejectedValue(new Error('rpc down'))
    const res = await pay()
    expect(res.statusCode).toBe(201)
  })

  it('revert fallback: a transfer-cap revert the task budget\'s own spent figure confirms is the same typed 403, not a "transient" 502', async () => {
    // The pre-check read fits (a concurrent payment landed in between); the
    // simulation then reverts; the fallback's fresh read confirms the cap.
    mockReadSpent.mockResolvedValueOnce(0n).mockResolvedValueOnce(1_000_000n)
    prepareRedemption.mockRejectedValue(new Error('UserOperation reverted during simulation with reason: ERC20TransferAmountEnforcer:allowance-exceeded'))
    const res = await pay()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error_code: 'task_budget_exceeded', remaining_atomic: '0' })
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
  })

  it('a transfer-cap revert the task budget does NOT explain (a budget lifetime cap) keeps the 502, booked as a budget refusal', async () => {
    mockReadSpent.mockResolvedValue(0n)
    prepareRedemption.mockRejectedValue(new Error('UserOperation reverted during simulation with reason: ERC20TransferAmountEnforcer:allowance-exceeded'))
    const res = await pay()
    expect(res.statusCode).toBe(502)
    // Not the typed budget 403 — the #3609 revert answer, named by the classifier.
    expect(res.json()).toMatchObject({ error_code: 'prepare_reverted', refusal_reason: 'delegation_budget_exceeded' })
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
    expect(refusalRows()[0]![1]).toContain('delegation_budget_exceeded')
  })

  it('a payment without a task budget never reads the task cap', async () => {
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.5', to: RECIPIENT },
    })
    // (No ordinary grant is mocked, so it is refused for that reason — never for a task cap.)
    expect(res.json().error_code).not.toBe('task_budget_exceeded')
    expect(mockReadSpent).not.toHaveBeenCalled()
  })
})
