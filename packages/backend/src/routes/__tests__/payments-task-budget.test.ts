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
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute, mockCreateRail } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateRail: vi.fn(),
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
// to when no task_budget_id resolves — a DIFFERENT (pinned) grant, so a
// test can prove the by-hash selection is what actually wins.
const PINNED_BUDGET_DELEGATION: DbRoute = [
  /SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1\s+AND token_address/,
  () => ({
    rows: [
      budgetRow({
        delegation_hash: `0x${'99'.repeat(32)}`,
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
    // grant), never the pinned grant's shape (delegator would differ).
    expect(chainArg[1].delegator.toLowerCase()).toBe(AGENT.account_address.toLowerCase())
  })
})
