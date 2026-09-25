// db-mock-exempt: route-level handler test (status codes, refusal shapes) — DB behaviour is proven in infra/repositories/__tests__/task-budgets.test.ts on the real-DB harness
/**
 * #3329 task budgets — agent-auth route tests. Pattern-matched DB mocks
 * (#775), same convention as `agent-delegations.test.ts`: the network seams
 * (delegate-account derivation, the rail, the on-chain remaining-budget
 * read) are mocked, but the caveat compiler and EIP-712 signing/recovery run
 * REAL so identities and signatures are genuine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { privateKeyToAccount } from 'viem/accounts'

const { mockQuery, mockCompute, mockReadRemaining, mockCreateRail } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockCreateRail: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}))
vi.mock('../../middleware/agentAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/agentAuth.js')>()
  return {
    ...actual,
    agentAuthMiddleware: async (request: { agent?: unknown }) => {
      request.agent = CURRENT_AGENT
    },
  }
})
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})
vi.mock('../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/delegation-budget-reader.js')>()
  return { ...actual, readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a) }
})
vi.mock('../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-rail.js')>()
  return {
    ...actual,
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
    createDelegationRail: (...a: unknown[]) => mockCreateRail(...a),
  }
})

const taskBudgetRoutes = (await import('../task-budgets.js')).default

const CHAIN_ID = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DELEGATE_KEY_PRIVATE = `0x${'11'.repeat(32)}` as const
const DELEGATE_ACCOUNT_OWNER = privateKeyToAccount(DELEGATE_KEY_PRIVATE)
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20) // the derived delegate SMART account
const TREASURY = '0x' + 'aa'.repeat(20)
const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const BUDGET_HASH = `0x${'ab'.repeat(32)}`

let CURRENT_AGENT: Record<string, unknown> = {
  id: AGENT_ID,
  user_id: 'user-1',
  delegate_address: DELEGATE_ACCOUNT_OWNER.address,
  account_address: TREASURY,
  chain_id: CHAIN_ID,
  status: 'active',
  account_type: 'delegator_hybrid',
}

const BUDGET_DELEGATION = {
  delegate: DELEGATE_ACCOUNT,
  delegator: TREASURY,
  authority: `0x${'ff'.repeat(32)}`,
  caveats: [],
  salt: '1',
  signature: `0x${'ab'.repeat(65)}`,
}

function mockDb(opts: {
  taskBudget?: Record<string, unknown> | null
  list?: Array<Record<string, unknown>>
  insertReturn?: Record<string, unknown>
  markOpenReturn?: Record<string, unknown> | null
  markClosedReturn?: Record<string, unknown> | null
  markClosingReturn?: Record<string, unknown> | null
}) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/SELECT delegation_hash, delegation_json, recipient_address, budget_atomic\s+FROM agent_delegations/.test(s)) {
      return Promise.resolve({
        rows: [
          {
            delegation_hash: BUDGET_HASH,
            delegation_json: JSON.stringify(BUDGET_DELEGATION),
            recipient_address: null,
            budget_atomic: '5000000',
          },
        ],
      })
    }
    if (/INSERT INTO agent_task_budgets/.test(s)) {
      return Promise.resolve({ rows: [opts.insertReturn ?? {}] })
    }
    if (/UPDATE agent_task_budgets/.test(s) && /status = 'open'/.test(s)) {
      return Promise.resolve({ rows: opts.markOpenReturn === null ? [] : [opts.markOpenReturn ?? {}] })
    }
    if (/UPDATE agent_task_budgets/.test(s) && /status = 'closed'/.test(s)) {
      return Promise.resolve({ rows: opts.markClosedReturn === null ? [] : [opts.markClosedReturn ?? {}] })
    }
    if (/UPDATE agent_task_budgets/.test(s) && /status = 'closing'/.test(s)) {
      return Promise.resolve({ rows: opts.markClosingReturn === null ? [] : [opts.markClosingReturn ?? {}] })
    }
    if (/FROM agent_task_budgets\s+WHERE id = \$1 AND agent_id = \$2/.test(s)) {
      return Promise.resolve({ rows: opts.taskBudget === null || opts.taskBudget === undefined ? [] : [opts.taskBudget] })
    }
    if (/FROM agent_task_budgets\s+WHERE agent_id = \$1/.test(s)) {
      return Promise.resolve({ rows: opts.list ?? [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

function taskBudgetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tb-1',
    agent_id: AGENT_ID,
    chain_id: CHAIN_ID,
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
    status: 'pending',
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
    opened_at: null,
    closed_at: null,
    ...overrides,
  }
}

describe('task budgets API (#3329)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    CURRENT_AGENT = {
      id: AGENT_ID,
      user_id: 'user-1',
      delegate_address: DELEGATE_ACCOUNT_OWNER.address,
      account_address: TREASURY,
      chain_id: CHAIN_ID,
      status: 'active',
      account_type: 'delegator_hybrid',
    }
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
    mockReadRemaining.mockReset()
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
    mockCreateRail.mockReset()
    app = Fastify({ logger: false })
    await app.register(taskBudgetRoutes, { prefix: '/task-budgets' })
  })

  it('POST / builds a pending child and returns typed data to sign', async () => {
    mockDb({ insertReturn: taskBudgetRow() })
    const res = await app.inject({
      method: 'POST',
      url: '/task-budgets',
      payload: { token_address: USDC, max_amount_atomic: '1000000', ttl_seconds: 3600 },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.task_budget.status).toBe('pending')
    expect(body.sign_data.signature_scheme).toBe('eip712_delegation')
    expect(body.next_action).toBe('sign_then_submit')
    expect(body.sign_data.typed_data.primaryType).toBe('Delegation')
  })

  it('POST / refuses when the request exceeds the available (remaining minus reserved) budget', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '500000', fromChain: true })
    mockDb({})
    const res = await app.inject({
      method: 'POST',
      url: '/task-budgets',
      payload: { token_address: USDC, max_amount_atomic: '1000000', ttl_seconds: 3600 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_exceeds_remaining')
  })

  it('POST / 403s when the agent has no active budget delegation for the token', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agent_delegations/.test(String(sql))) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST',
      url: '/task-budgets',
      payload: { token_address: USDC, max_amount_atomic: '1000000', ttl_seconds: 3600 },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error_code).toBe('no_delegation_for_target')
  })

  it('POST / 400s on an out-of-range ttl_seconds', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST',
      url: '/task-budgets',
      payload: { token_address: USDC, max_amount_atomic: '1000000', ttl_seconds: 999999 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET / lists task budgets for the authenticated agent', async () => {
    mockDb({ list: [taskBudgetRow({ status: 'open' })] })
    const res = await app.inject({ method: 'GET', url: '/task-budgets' })
    expect(res.statusCode).toBe(200)
    expect(res.json().task_budgets).toHaveLength(1)
  })

  it('GET /:id 404s for an unknown or foreign task budget', async () => {
    mockDb({ taskBudget: null })
    const res = await app.inject({ method: 'GET', url: '/task-budgets/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /:id/submit opens a pending child with a genuine signature, and refuses a mismatched one', async () => {
    const row = taskBudgetRow()
    mockDb({ taskBudget: row, markOpenReturn: taskBudgetRow({ status: 'open' }) })

    const child = JSON.parse(row.delegation_json as string)
    const { delegationSigningPayload } = await import('../../rails/delegation-policy.js')
    const payload = delegationSigningPayload(child, CHAIN_ID)
    const goodSignature = await DELEGATE_ACCOUNT_OWNER.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message as never,
    })

    const good = await app.inject({
      method: 'POST',
      url: '/task-budgets/tb-1/submit',
      payload: { signature: goodSignature },
    })
    expect(good.statusCode).toBe(200)
    expect(good.json().status).toBe('open')

    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const badSignature = await other.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message as never,
    })
    const bad = await app.inject({
      method: 'POST',
      url: '/task-budgets/tb-1/submit',
      payload: { signature: badSignature },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error_code).toBe('signature_mismatch')
  })

  it('POST /:id/close on a pending row closes trivially, nothing signed', async () => {
    mockDb({ taskBudget: taskBudgetRow(), markClosedReturn: taskBudgetRow({ status: 'closed' }) })
    const res = await app.inject({ method: 'POST', url: '/task-budgets/tb-1/close' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('closed')
  })

  it('POST /:id/close 409s when already closed', async () => {
    mockDb({ taskBudget: taskBudgetRow({ status: 'closed' }) })
    const res = await app.inject({ method: 'POST', url: '/task-budgets/tb-1/close' })
    expect(res.statusCode).toBe(409)
  })

  it('#3329 review finding A: POST /:id/close on a CLOSING row re-prepares a fresh UserOp and overwrites the stale one', async () => {
    const prepareAccountCall = vi.fn().mockResolvedValue({
      userOperation: { sender: DELEGATE_ACCOUNT },
      userOpHash: `0x${'22'.repeat(32)}`,
      signingTypedData: { primaryType: 'PackedUserOperation' },
      delegateAccountAddress: DELEGATE_ACCOUNT,
    })
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: DELEGATE_ACCOUNT,
      prepareAccountCall,
      submitRedemption: vi.fn(),
    })
    mockDb({
      taskBudget: taskBudgetRow({ status: 'closing', prepared_user_op: JSON.stringify({ stale: true }) }),
      markClosingReturn: taskBudgetRow({ status: 'closing', prepared_user_op: JSON.stringify({ fresh: true }) }),
    })

    const res = await app.inject({ method: 'POST', url: '/task-budgets/tb-1/close' })

    expect(res.statusCode).toBe(200)
    expect(res.json().sign_data).toBeDefined()
    expect(res.json().next_action).toBe('sign_then_submit')
    // A fresh prepare ran (not a re-serve of the stale stored op).
    expect(prepareAccountCall).toHaveBeenCalledTimes(1)
    // The overwrite went through the SAME repository call that transitions
    // open -> closing, now also accepting closing -> closing.
    const updateCall = mockQuery.mock.calls.find(
      (c) => /UPDATE agent_task_budgets/.test(String(c[0])) && /status = 'closing'/.test(String(c[0])),
    )
    expect(updateCall).toBeDefined()
  })

  it("#3329 review finding A: POST /:id/submit on a CLOSING row with a stale op 409s close_needs_reprepare, not 502", async () => {
    mockCreateRail.mockResolvedValue({
      delegateAccountAddress: DELEGATE_ACCOUNT,
      prepareAccountCall: vi.fn(),
      submitRedemption: vi.fn().mockRejectedValue(new Error('AA25 invalid account nonce')),
    })
    mockDb({
      taskBudget: taskBudgetRow({ status: 'closing', prepared_user_op: JSON.stringify({ userOp: true }) }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/task-budgets/tb-1/submit',
      payload: { signature: `0x${'ab'.repeat(65)}` },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('close_needs_reprepare')
  })
})
