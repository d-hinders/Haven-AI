// db-mock-exempt: route-level handler test (status/refusal codes) — DB behaviour is proven in infra/repositories/__tests__/sub-budgets.test.ts on the real-DB harness
/**
 * #3330 §3 — `POST /payments` with `sub_budget_id`: agent B pays through the
 * sub-budget agent A granted it. The redemption chain is THREE links —
 * `[B grant, A parent-child, A budget]`, leaf first — and the refusal table
 * (sub_budget_not_found/not_open/token_mismatch/recipient_mismatch/
 * parent_mismatch) decides BEFORE any chain is built. Pattern-matched DB
 * mocks (#775), the same convention as `payments-task-budget.test.ts`: the
 * delegation rail is mocked at `createDelegationRail` so no bundler/chain
 * call happens; this file owns only the route's decisions. The parent-cap
 * question (the DelegationManager enforces A's period enforcer through the
 * chain) is an on-chain property the route cannot mock-prove; what IS proven
 * here is that the route hands the rail the full three-link chain — the
 * chain being the enforcement is what makes A's cap bind.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute, mockCreateRail, mockReadRemaining } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateRail: vi.fn(),
  mockReadRemaining: vi.fn(),
}))
// #3503: POST /payments pre-checks the period budget of every redeemed link
// on-chain — never a live chain here; the period-budget cases below steer it.
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
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

// This is agent B — the SUB-AGENT redeeming its grant.
const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Sub Budget Payer B',
  delegate_address: '0x' + 'bb'.repeat(20),
  account_address: '0x' + 'aa'.repeat(20),
  chain_id: 84532,
  status: 'active',
  account_type: 'delegator_hybrid',
  execution_rail: 'delegation',
  has_bound_account: true,
}
const B_DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const A_DELEGATE_ACCOUNT = '0x' + 'd1'.repeat(20)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)
// A's budget delegation — the ROOT of the chain, granted to A by the user.
const BUDGET_HASH = `0x${'ab'.repeat(32)}`
// A's parent-child row — the MIDDLE link (self-delegated narrowing).
const PARENT_CHILD_HASH = `0x${'cd'.repeat(32)}`

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
const INSERT_INTENT: DbRoute = [
  /INSERT INTO payment_intents/,
  () => ({
    rows: [
      {
        id: 'intent-1',
        status: 'pending_signature',
        expires_at: '2026-09-28T00:10:00.000Z',
      },
    ],
  }),
]

function budgetRow(overrides: Record<string, unknown> = {}) {
  return {
    delegation_hash: BUDGET_HASH,
    delegation_json: JSON.stringify({
      delegate: A_DELEGATE_ACCOUNT,
      delegator: AGENT.account_address, // the user granted A
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

// A's budget delegation, selected BY HASH (the #3329 review finding E rule,
// applied to the sub-budget's grandparent). The sub-budget path runs
// `selectActiveDelegationByHash` — status = 'active' plus live start/expiry
// bounds — which is a DIFFERENT statement from the task-budget file's
// by-hash select; this regex matches the sub-budget one.
const A_BUDGET_DELEGATION: DbRoute = [
  /SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1 AND delegation_hash = \$2 AND status = 'active'/,
  () => ({ rows: [budgetRow()] }),
]

function parentChildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pc-1',
    agent_id: '33333333-3333-3333-3333-333333333333', // agent A
    parent_agent_id: '33333333-3333-3333-3333-333333333333', // A's own row
    parent_sub_budget_id: null,
    chain_id: AGENT.chain_id,
    token_address: USDC.toLowerCase(),
    recipient_address: null,
    parent_delegation_hash: BUDGET_HASH, // carved from A's budget delegation
    delegation_hash: PARENT_CHILD_HASH,
    delegation_json: JSON.stringify({
      delegate: A_DELEGATE_ACCOUNT,
      delegator: A_DELEGATE_ACCOUNT, // SELF-delegated narrowing
      authority: BUDGET_HASH,
      caveats: [],
      salt: '2',
      signature: `0x${'cd'.repeat(65)}`,
    }),
    label: "A's narrowing",
    period_amount_atomic: '1000000',
    status: 'open',
    expires_at: String(Math.floor(Date.now() / 1000) + 7200),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    opened_at: '2026-09-28T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  }
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sb-1',
    agent_id: AGENT.id, // B
    parent_agent_id: '33333333-3333-3333-3333-333333333333', // A
    parent_sub_budget_id: 'pc-1',
    chain_id: AGENT.chain_id,
    token_address: USDC.toLowerCase(),
    recipient_address: null,
    parent_delegation_hash: PARENT_CHILD_HASH, // names A's parent-child
    delegation_hash: `0x${'ef'.repeat(32)}`,
    delegation_json: JSON.stringify({
      delegate: B_DELEGATE_ACCOUNT,
      delegator: A_DELEGATE_ACCOUNT, // granted BY A
      authority: PARENT_CHILD_HASH,
      caveats: [],
      salt: '3',
      signature: `0x${'ef'.repeat(65)}`,
    }),
    label: 'B slice',
    period_amount_atomic: '500000',
    status: 'open',
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    opened_at: '2026-09-28T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  }
}

function grantLookup(row: Record<string, unknown> | null): DbRoute {
  return [/FROM agent_sub_budgets\s+WHERE id = \$1 AND agent_id = \$2/, () => ({ rows: row ? [row] : [] })]
}

function parentChildLookup(row: Record<string, unknown> | null): DbRoute {
  return [
    /FROM agent_sub_budgets\s+WHERE delegation_hash = \$1\s+AND parent_sub_budget_id IS NULL\s+AND status = 'open'/,
    () => ({ rows: row ? [row] : [] }),
  ]
}

describe('POST /payments with sub_budget_id (#3330)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())

  beforeEach(() => {
    mockQuery.mockReset()
    mockReadRemaining.mockReset()
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1000000000000', fromChain: true })
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(B_DELEGATE_ACCOUNT)
    mockCreateRail.mockReset()
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: B_DELEGATE_ACCOUNT,
      prepareRedemption: vi.fn().mockResolvedValue({
        userOperation: { sender: B_DELEGATE_ACCOUNT },
        userOpHash: `0x${'11'.repeat(32)}`,
        signingTypedData: { primaryType: 'PackedUserOperation' },
        delegateAccountAddress: B_DELEGATE_ACCOUNT,
      }),
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn(),
    })
  })

  function body(overrides: Record<string, unknown> = {}) {
    return { token: 'USDC', amount: '1', to: RECIPIENT, sub_budget_id: 'sb-1', ...overrides }
  }

  it('404s sub_budget_not_found when the id does not resolve for this agent', async () => {
    primeDb(AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION, grantLookup(null), INSERT_INTENT)
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: body(),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error_code).toBe('sub_budget_not_found')
  })

  it('409s sub_budget_not_open for a pending grant', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow({ status: 'pending' })), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_not_open')
  })

  it('409s sub_budget_not_open for an expired grant', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow({ expires_at: String(Math.floor(Date.now() / 1000) - 10) })), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_not_open')
  })

  it('409s sub_budget_token_mismatch when the payment token differs', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow({ token_address: '0x' + 'f0'.repeat(20) })), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_token_mismatch')
  })

  it('409s sub_budget_recipient_mismatch when the pinned recipient differs', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow({ recipient_address: '0x' + '99'.repeat(20) })), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_recipient_mismatch')
  })

  it('409s sub_budget_parent_mismatch when the middle link is not open — revoking A strands B', async () => {
    // A's parent-child row is CLOSED (A revoked its grant of B, or A's own
    // budget delegation was revoked and the row was closed with it) — B's
    // grant can never again be redeemed through, whatever B's own status is.
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow()), parentChildLookup(parentChildRow({ status: 'closed' })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_parent_mismatch')
  })

  it('409s sub_budget_parent_mismatch when the middle link row is missing entirely', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow()), parentChildLookup(null), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_parent_mismatch')
  })

  it('409s sub_budget_parent_mismatch when the grant names a different parent-child than the row that resolves', async () => {
    // The grant's parent_delegation_hash names A's parent-child; the by-hash
    // lookup answers a row with a DIFFERENT delegation_hash — the check in
    // checkSubBudgetForPayment must refuse before any chain is built.
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow()), parentChildLookup(parentChildRow({ delegation_hash: `0x${'77'.repeat(32)}` })), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_parent_mismatch')
  })

  it('happy path: an open grant under an open parent-child authorizes the THREE-link chain [grant, parent-child, budget]', async () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow()), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(201)
    // The chain passed to prepareRedemption is [B grant, A parent-child, A
    // budget] — three links, leaf first. THIS is where the parent cap binds:
    // the DelegationManager enforces every hop's caveats in one redemption,
    // so A's period enforcer on the budget link meters any spend B makes.
    const rail = await mockCreateRail.mock.results[0]!.value
    const chainArg = rail.prepareRedemption.mock.calls[0][0]
    expect(chainArg).toHaveLength(3)
    // Leaf: B's grant — delegated BY A's account TO B's account.
    expect(chainArg[0].delegate.toLowerCase()).toBe(B_DELEGATE_ACCOUNT.toLowerCase())
    expect(chainArg[0].delegator.toLowerCase()).toBe(A_DELEGATE_ACCOUNT.toLowerCase())
    // Middle: A's parent-child — SELF-delegated (the task-child shape class).
    expect(chainArg[1].delegate.toLowerCase()).toBe(A_DELEGATE_ACCOUNT.toLowerCase())
    expect(chainArg[1].delegator.toLowerCase()).toBe(A_DELEGATE_ACCOUNT.toLowerCase())
    // Root: A's budget delegation — granted to A by the user, used VERBATIM.
    expect(chainArg[2].delegate.toLowerCase()).toBe(A_DELEGATE_ACCOUNT.toLowerCase())
    expect(chainArg[2].delegator.toLowerCase()).toBe(AGENT.account_address.toLowerCase())
    // The sub-budget id is persisted on the intent (the #3392-style pin).
    const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO payment_intents/.test(String(c[0])))
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    expect(params).toContain('sb-1')
  })

  // #3503 review finding F2: each of the three links carries its own period
  // caveat, and B's slice is usually the tighter — so every link is read and
  // the SMALLEST remaining decides.
  function remainingByLink(grant: string, parentChild: string, root: string) {
    mockReadRemaining.mockImplementation(async (_chain: number, json: string) => {
      const d = JSON.parse(json) as { delegate: string; delegator: string }
      const remainingAtomic =
        d.delegate.toLowerCase() === B_DELEGATE_ACCOUNT.toLowerCase()
          ? grant
          : d.delegator.toLowerCase() === A_DELEGATE_ACCOUNT.toLowerCase()
            ? parentChild
            : root
      return { remainingAtomic, fromChain: true }
    })
  }
  const payThroughGrant = () => {
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, A_BUDGET_DELEGATION,
      grantLookup(grantRow()), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    return app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
  }

  for (const [link, remaining] of [
    ['B\u2019s own grant', ['500', '9000000', '9000000']],
    ['A\u2019s parent-child link', ['9000000', '500', '9000000']],
    ['A\u2019s budget delegation (the root)', ['9000000', '9000000', '500']],
  ] as const) {
    it(`#3503: refuses 403 delegation_budget_exceeded when ${link} cannot cover the payment`, async () => {
      remainingByLink(remaining[0], remaining[1], remaining[2])
      const res = await payThroughGrant()
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error_code: 'delegation_budget_exceeded', remaining_atomic: '500' })
      expect(mockReadRemaining).toHaveBeenCalledTimes(3)
      expect(mockCreateRail).not.toHaveBeenCalled()
    })
  }

  it('#3503: an unreadable link does not disable the others — a readable short link still refuses', async () => {
    mockReadRemaining.mockImplementation(async (_chain: number, json: string) => {
      const d = JSON.parse(json) as { delegate: string; delegator: string }
      if (d.delegate.toLowerCase() === B_DELEGATE_ACCOUNT.toLowerCase()) throw new Error('rpc down')
      if (d.delegator.toLowerCase() === A_DELEGATE_ACCOUNT.toLowerCase()) return { remainingAtomic: '500', fromChain: true }
      return { remainingAtomic: '9000000', fromChain: true }
    })
    const res = await payThroughGrant()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error_code: 'delegation_budget_exceeded', remaining_atomic: '500' })
  })

  it('#3503: pays when every link covers it, and an unreadable link is skipped (fail open per link)', async () => {
    mockReadRemaining.mockImplementation(async (_chain: number, json: string) => {
      const d = JSON.parse(json) as { delegate: string }
      if (d.delegate.toLowerCase() === B_DELEGATE_ACCOUNT.toLowerCase()) throw new Error('rpc down')
      return { remainingAtomic: '1000000', fromChain: true } // exactly the 1 USDC asked
    })
    const res = await payThroughGrant()
    expect(res.statusCode).toBe(201)
    expect(mockReadRemaining).toHaveBeenCalledTimes(3)
  })

  it('an open grant is refused when A\u2019s budget delegation (the chain root) is revoked', async () => {
    // A's budget delegation no longer resolves by hash (owner revoked it) —
    // the chain has no root, so B's child is unredeemable (criterion 3).
    primeDb(
      AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY,
      [/SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations\s+WHERE agent_id = \$1 AND delegation_hash = \$2 AND status = 'active'/, () => ({ rows: [] })],
      grantLookup(grantRow()), parentChildLookup(parentChildRow()), INSERT_INTENT,
    )
    const res = await app.inject({
      method: 'POST', url: '/payments', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sub_budget_parent_mismatch')
  })

  it('refuses a body naming BOTH task_budget_id and sub_budget_id', async () => {
    primeDb(AUTH, RAIL_STATE, NO_IDEMPOTENCY_REPLAY, INSERT_INTENT)
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '1', to: RECIPIENT, task_budget_id: 'tb-1', sub_budget_id: 'sb-1' },
    })
    expect(res.statusCode).toBe(400)
  })
})
