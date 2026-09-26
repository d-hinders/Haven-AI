// db-mock-exempt: route-level handler test (status/refusal codes) — DB behaviour is proven in infra/repositories/__tests__/{task-budgets,payment-intents}.test.ts on the real-DB harness
/**
 * #3329 §3 — `POST /x402/authorize` with `taskBudgetId`: erc7710
 * ([settlement, taskChild, budget]) and the EIP-3009 funding leg. Mirrors
 * `x402-delegation.test.ts`'s mocking pattern (network seams mocked, the
 * settlement compiler runs REAL).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const {
  mockQuery, mockSelect, mockSelectByHash, mockCompute, mockCreateIntent,
  mockPrepareFunding, mockEnsureDeployed, mockReadRemaining,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectByHash: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateIntent: vi.fn(),
  mockPrepareFunding: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockReadRemaining: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import { privateKeyToAccount } from 'viem/accounts'
import { buildBudgetDelegation } from '../../rails/delegation-policy.js'

const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
vi.mock('../../middleware/agentAuth.js', () => ({
  agentAuthMiddleware: async (request: { agent?: unknown }) => {
    request.agent = {
      id: 'agent-1', user_id: 'user-1', name: 'A',
      delegate_address: DELEGATE_SIGNER.address,
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532, status: 'active',
      execution_rail: 'delegation', account_type: 'delegator_hybrid',
    }
  },
}))
vi.mock('../../rails/delegation-authorization.js', () => ({
  selectDelegation: mockSelect,
  // #3329 review finding E2: a DISTINCT mock from the (token, to) one — a
  // test can now prove the task-budget path uses the by-hash result and not
  // whatever (token, to) happens to select (deleting the `budget =
  // resolved.parentDelegation` reassignment in delegation-authorize.ts must
  // go red here).
  selectDelegationByHash: mockSelectByHash,
  prepareDelegationPayment: mockPrepareFunding,
}))
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: mockCompute, ensureHybridDeployed: mockEnsureDeployed }
})
vi.mock('../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/payment-intents.js')>()
  return { ...actual, insertMachineIntent: mockCreateIntent }
})

const x402Routes = (await import('../x402.js')).default
const { installRequestValidation } = await import('../../openapi/request-validation.js')

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const MERCHANT = '0x' + 'cc'.repeat(20)
const DELEGATE_ACCT = '0x' + 'dd'.repeat(20)
const INTENT_ID = '33333333-3333-3333-3333-333333333333'
const NOW = Math.floor(Date.now() / 1000)
const BUDGET_HASH = `0x${'12'.repeat(32)}`
// #3329 review finding E2: a distinct "wrong" parent — same token, and (for
// the funding leg) the same `to` — that the by-hash selection must NEVER
// return, so a mutant deleting the by-hash reassignment surfaces as this
// delegator leaking into the redeemed chain.
const WRONG_PARENT_HASH = `0x${'99'.repeat(32)}`
const WRONG_DELEGATOR = '0x' + 'ee'.repeat(20)

const signedBudget = {
  ...buildBudgetDelegation({
    agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
    delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }),
  signature: '0x' + 'ab'.repeat(65),
}

function taskBudgetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tb-1',
    agent_id: 'agent-1',
    chain_id: 84532,
    token_address: USDC.toLowerCase(),
    recipient_address: null,
    parent_delegation_hash: BUDGET_HASH,
    delegation_hash: `0x${'cd'.repeat(32)}`,
    delegation_json: JSON.stringify({
      delegate: DELEGATE_ACCT,
      delegator: DELEGATE_ACCT,
      authority: BUDGET_HASH,
      caveats: [],
      salt: '2',
      signature: `0x${'ef'.repeat(65)}`,
    }),
    label: 'Test task',
    max_atomic: '1000000',
    status: 'open',
    expires_at: String(NOW + 3600),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
    opened_at: '2026-09-25T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  }
}

function primeTaskBudgetLookup(row: Record<string, unknown> | null) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/max_x402_per_hour/.test(s)) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
    if (/COUNT\(\*\)/.test(s)) return Promise.resolve({ rows: [{ cnt: '0' }] })
    if (/FROM agent_task_budgets\s+WHERE id = \$1 AND agent_id = \$2/.test(s)) {
      return Promise.resolve({ rows: row ? [row] : [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

function authorizeBody(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://merchant.example/resource',
    payTo: MERCHANT,
    amount: '100000',
    asset: USDC,
    network: 'eip155:84532',
    taskBudgetId: 'tb-1',
    ...overrides,
  }
}

describe('x402 authorize with taskBudgetId (#3329)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    app = Fastify({ logger: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/x402.ts'] })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockSelect.mockReset()
    mockSelectByHash.mockReset()
    mockCompute.mockReset()
    mockCreateIntent.mockReset()
    mockPrepareFunding.mockReset()
    mockEnsureDeployed.mockReset()
    mockReadRemaining.mockReset()
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
    mockCompute.mockResolvedValue(DELEGATE_ACCT)
    mockEnsureDeployed.mockResolvedValue({ address: DELEGATE_ACCT, alreadyDeployed: true })
    // #3329 review finding E2: the (token, to) selection and the by-hash
    // selection return DISTINGUISHABLE delegations — a wrong-parent grant
    // that happens to also match (token, payTo), and the task budget's REAL
    // parent (BUDGET_HASH) only reachable by hash. A test can then prove
    // which one actually authorized the payment.
    mockSelect.mockResolvedValue({
      delegation_hash: WRONG_PARENT_HASH,
      delegation_json: JSON.stringify({ ...signedBudget, delegator: WRONG_DELEGATOR }),
      recipient_address: null,
      budget_atomic: '5000000',
    })
    mockSelectByHash.mockResolvedValue({
      delegation_hash: BUDGET_HASH,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
      budget_atomic: '5000000',
    })
  })

  it('erc7710: 404s task_budget_not_found', async () => {
    primeTaskBudgetLookup(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error_code).toBe('task_budget_not_found')
  })

  it('erc7710: 409s task_budget_not_open for a closed row', async () => {
    primeTaskBudgetLookup(taskBudgetRow({ status: 'closed' }))
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_not_open')
  })

  it('erc7710: 409s task_budget_recipient_mismatch when pinned to a different merchant', async () => {
    primeTaskBudgetLookup(taskBudgetRow({ recipient_address: '0x' + '99'.repeat(20) }))
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('task_budget_recipient_mismatch')
  })

  it('erc7710 happy path: builds [settlement, taskChild, budget] and persists task_budget_id', async () => {
    primeTaskBudgetLookup(taskBudgetRow())
    mockCreateIntent.mockImplementation(async () => ({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' }))

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      taskBudgetId: 'tb-1',
      preparedUserOp: expect.any(String),
    }))
    const call = mockCreateIntent.mock.calls[0][0] as { preparedUserOp: string; budgetDelegationHash: string }
    const state = JSON.parse(call.preparedUserOp)
    expect(state.taskBudgetChild).toBeDefined()
    expect(state.taskBudgetChild.delegator).toBe(DELEGATE_ACCT) // self-delegated task child
    // #3329 review finding E2: the redeemed budget is the BY-HASH parent
    // (BUDGET_HASH, `signedBudget`'s delegator) — never the (token, payTo)
    // selection's wrong-parent grant (WRONG_PARENT_HASH/WRONG_DELEGATOR),
    // even though the mocked (token, payTo) selection would also resolve.
    expect(state.budget.delegator.toLowerCase()).not.toBe(WRONG_DELEGATOR.toLowerCase())
    expect(call.budgetDelegationHash).toBe(BUDGET_HASH)
    expect(call.budgetDelegationHash).not.toBe(WRONG_PARENT_HASH)
  })

  it('3009 funding leg happy path: threads the task budget child and persists task_budget_id', async () => {
    primeTaskBudgetLookup(taskBudgetRow())
    mockPrepareFunding.mockImplementation(async () => ({
      delegationHash: BUDGET_HASH,
      prepared: {
        userOpHash: `0x${'aa'.repeat(32)}`,
        userOperation: { sender: DELEGATE_ACCT },
        signingTypedData: {
          domain: { chainId: 84532, name: 'HybridDeleGator', version: '1', verifyingContract: DELEGATE_ACCT },
          types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
          primaryType: 'PackedUserOperation',
          message: { sender: DELEGATE_ACCT },
        },
        delegateAccountAddress: DELEGATE_ACCT,
      },
    }))
    mockCreateIntent.mockImplementation(async () => ({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' }))

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_SIGNER.address, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(201)
    expect(mockPrepareFunding).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1' }),
      USDC,
      DELEGATE_SIGNER.address.toLowerCase(),
      100000n,
      expect.objectContaining({ taskBudget: expect.objectContaining({ childDelegation: expect.anything() }) }),
    )
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({ taskBudgetId: 'tb-1' }))
  })

  // #3329: `/x402` is camelCase (`X402AuthorizeRequest`, `additionalProperties:
  // false`) — unlike `POST /payments`, which is snake_case. A caller that
  // sends the `POST /payments` key here is refused by request validation
  // rather than silently ignored (the SDK sent this key by mistake before
  // this issue; this test documents the convention so it does not regress).
  it('refuses a snake_case task_budget_id on /x402 — the convention is camelCase here', async () => {
    primeTaskBudgetLookup(taskBudgetRow())
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ taskBudgetId: undefined, task_budget_id: 'tb-1' }),
    })
    expect(res.statusCode).toBe(400)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })
})
