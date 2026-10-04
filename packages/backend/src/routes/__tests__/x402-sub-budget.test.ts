// db-mock-exempt: route-level handler test (status/refusal codes) — DB behaviour is proven in infra/repositories/__tests__/sub-budgets.test.ts on the real-DB harness
/**
 * #3617 (epic #3615 S-B) — `POST /x402/authorize` with `subBudgetId`, on BOTH
 * legs: the first x402 × sub-budget route tests. Until this file, 0 of the
 * 27 backend test files naming x402 or delegation-authorize mentioned a
 * sub-budget, and the quality scan's probe P3 (sub-budget resolution
 * disabled on both legs) left all of them green.
 *
 * Mirrors `x402-task-budget.test.ts`'s mocking (network seams mocked, the
 * settlement compiler runs REAL). Agent B pays through the sub-budget agent
 * A granted it: the redemption chain is [settlement?, B grant, A
 * parent-child, A budget].
 *
 * The period pre-check reads are keyed by WHICH link they read, so a test
 * can make exactly one link short and see whether the pre-check consulted
 * it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const {
  mockQuery, mockSelect, mockSelectByHash, mockCompute, mockCreateIntent,
  mockPrepareFunding, mockEnsureDeployed, mockReadRemaining, mockReadSpent,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectByHash: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateIntent: vi.fn(),
  mockPrepareFunding: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockReadSpent: vi.fn(),
}))
vi.mock('../../infra/chain/task-budget-spent-reader.js', () => ({
  readTaskBudgetSpent: (...a: unknown[]) => mockReadSpent(...a),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
// The refusal ledger's write values the amount in fiat — a live price fetch
// unmocked, whose latency decides whether a booked row lands inside `waitFor`.
vi.mock('../../infra/fiat-values.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/fiat-values.js')>()
  return { ...actual, getFiatValuesForTokenAmount: async () => ({ usd: 0, eur: 0, sek: 0 }) }
})

import { privateKeyToAccount } from 'viem/accounts'
import { buildBudgetDelegation } from '../../rails/delegation-policy.js'

// This is agent B — the SUB-AGENT paying through A's grant.
const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
vi.mock('../../middleware/agentAuth.js', () => ({
  agentAuthMiddleware: async (request: { agent?: unknown }) => {
    request.agent = {
      id: 'agent-b', user_id: 'user-1', name: 'B',
      delegate_address: DELEGATE_SIGNER.address,
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532, status: 'active',
      execution_rail: 'delegation', account_type: 'delegator_hybrid',
    }
  },
}))
vi.mock('../../rails/delegation-authorization.js', () => ({
  selectDelegation: mockSelect,
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
const B_DELEGATE_ACCT = '0x' + 'dd'.repeat(20)
const A_DELEGATE_ACCT = '0x' + 'd1'.repeat(20)
const INTENT_ID = '33333333-3333-3333-3333-333333333333'
const NOW = Math.floor(Date.now() / 1000)
// A's budget delegation — the ROOT of the chain.
const BUDGET_HASH = `0x${'12'.repeat(32)}`
// A's parent-child row — the MIDDLE link.
const PARENT_CHILD_HASH = `0x${'cd'.repeat(32)}`
// B's own (token, payTo) grant — NOT a link of the sub-budget chain.
const B_OWN_HASH = `0x${'99'.repeat(32)}`

const signedBudget = {
  ...buildBudgetDelegation({
    agentId: 'agent-a', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
    delegateAccountAddress: A_DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }),
  signature: '0x' + 'ab'.repeat(65),
}
const parentChildDelegation = {
  delegate: A_DELEGATE_ACCT,
  delegator: A_DELEGATE_ACCT, // SELF-delegated narrowing
  authority: BUDGET_HASH,
  caveats: [],
  salt: '0x2',
  signature: `0x${'cd'.repeat(65)}`,
}
const grantDelegation = {
  delegate: B_DELEGATE_ACCT,
  delegator: A_DELEGATE_ACCT, // granted BY A
  authority: PARENT_CHILD_HASH,
  caveats: [],
  salt: '0x3',
  signature: `0x${'ef'.repeat(65)}`,
}
// B's own grant — a different delegator, so a read of it is distinguishable.
const bOwnDelegation = { ...signedBudget, delegator: '0x' + 'ee'.repeat(20) }

function parentChildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pc-1',
    agent_id: 'agent-a',
    parent_agent_id: 'agent-a',
    parent_sub_budget_id: null,
    chain_id: 84532,
    token_address: USDC.toLowerCase(),
    recipient_address: null,
    parent_delegation_hash: BUDGET_HASH,
    delegation_hash: PARENT_CHILD_HASH,
    delegation_json: JSON.stringify(parentChildDelegation),
    label: "A's narrowing",
    period_amount_atomic: '1000000',
    status: 'open',
    expires_at: String(NOW + 7200),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-10-04T00:00:00.000Z',
    updated_at: '2026-10-04T00:00:00.000Z',
    opened_at: '2026-10-04T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  }
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sb-1',
    agent_id: 'agent-b',
    parent_agent_id: 'agent-a',
    parent_sub_budget_id: 'pc-1',
    chain_id: 84532,
    token_address: USDC.toLowerCase(),
    recipient_address: null,
    parent_delegation_hash: PARENT_CHILD_HASH,
    delegation_hash: `0x${'ef'.repeat(32)}`,
    delegation_json: JSON.stringify(grantDelegation),
    label: 'B slice',
    period_amount_atomic: '500000',
    status: 'open',
    expires_at: String(NOW + 3600),
    prepared_user_op: null,
    close_tx_hash: null,
    created_at: '2026-10-04T00:00:00.000Z',
    updated_at: '2026-10-04T00:00:00.000Z',
    opened_at: '2026-10-04T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  }
}

/** Route the sub-budget lookups; `confirmed` primes an idempotency replay row. */
function primeDb(opts: { grant?: Record<string, unknown> | null; confirmed?: Record<string, unknown> } = {}) {
  const grant = opts.grant === undefined ? grantRow() : opts.grant
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/max_x402_per_hour/.test(s)) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
    if (/COUNT\(\*\)/.test(s)) return Promise.resolve({ rows: [{ cnt: '0' }] })
    if (/FROM agent_sub_budgets\s+WHERE id = \$1 AND agent_id = \$2/.test(s)) {
      return Promise.resolve({ rows: grant ? [grant] : [] })
    }
    if (/FROM agent_sub_budgets\s+WHERE delegation_hash = \$1/.test(s)) {
      return Promise.resolve({ rows: [parentChildRow()] })
    }
    if (opts.confirmed && /x402_idempotency_key = \$2/.test(s)) {
      return Promise.resolve({ rows: [opts.confirmed] })
    }
    return Promise.resolve({ rows: [] })
  })
}

/** Which link a remaining-budget read was for, from its delegation JSON. */
function linkOf(json: string): 'grant' | 'parentChild' | 'budget' | 'bOwn' {
  const d = JSON.parse(json) as { delegate: string; delegator: string }
  if (d.delegate.toLowerCase() === B_DELEGATE_ACCT.toLowerCase()) return 'grant'
  if (d.delegator.toLowerCase() === A_DELEGATE_ACCT.toLowerCase()) return 'parentChild'
  if (d.delegator.toLowerCase() === bOwnDelegation.delegator.toLowerCase()) return 'bOwn'
  return 'budget'
}

/** Remaining per link (atomic); a value of `'throw'` makes that read fail. */
function remainingByLink(map: Partial<Record<ReturnType<typeof linkOf>, string | 'throw'>>) {
  mockReadRemaining.mockImplementation(async (_chain: number, json: string) => {
    const v = map[linkOf(json)] ?? '5000000'
    if (v === 'throw') throw new Error('rpc down')
    return { remainingAtomic: v, fromChain: true }
  })
}

const fundingPrepared = async () => ({
  delegationHash: BUDGET_HASH,
  prepared: {
    userOpHash: `0x${'aa'.repeat(32)}`,
    userOperation: { sender: B_DELEGATE_ACCT },
    signingTypedData: {
      domain: { chainId: 84532, name: 'HybridDeleGator', version: '1', verifyingContract: B_DELEGATE_ACCT },
      types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
      primaryType: 'PackedUserOperation',
      message: { sender: B_DELEGATE_ACCT },
    },
    delegateAccountAddress: B_DELEGATE_ACCT,
  },
})

function body(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://merchant.example/resource',
    payTo: MERCHANT,
    amount: '100000',
    asset: USDC,
    network: 'eip155:84532',
    subBudgetId: 'sb-1',
    ...overrides,
  }
}
const funding = { payTo: DELEGATE_SIGNER.address, merchantPayTo: MERCHANT }

// CHARACTERIZATION COMMIT (#3617): the `it.fails` cases are today's
// behaviour on `origin/dev` @ 5625382e7, measured — each asserts the
// intended rule and FAILS against the current code:
// - erc7710 over B's slice (or A's parent-child link) → 201 WITH sign_data:
//   the pre-check reads only A's budget delegation;
// - erc7710 with no agent_delegations row for B → 403 no_delegation_for_target
//   before the sub-budget is ever resolved;
// - the funding leg pre-checks B's OWN (token, payTo) grant — it neither
//   refuses over B's slice nor ignores an unrelated, nearly spent own grant.
// The adoption commit removes `.fails`.
describe('x402 authorize with subBudgetId (#3617)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    app = Fastify({ logger: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/x402.ts'] })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  afterEach(async () => {
    let seen = -1
    while (seen !== mockQuery.mock.calls.length) {
      seen = mockQuery.mock.calls.length
      await new Promise((r) => setTimeout(r, 25))
    }
  })
  beforeEach(() => {
    for (const m of [mockQuery, mockSelect, mockSelectByHash, mockCompute, mockCreateIntent, mockPrepareFunding, mockEnsureDeployed, mockReadRemaining, mockReadSpent]) m.mockReset()
    remainingByLink({})
    mockReadSpent.mockResolvedValue(0n)
    mockCompute.mockResolvedValue(B_DELEGATE_ACCT)
    mockEnsureDeployed.mockResolvedValue({ address: B_DELEGATE_ACCT, alreadyDeployed: true })
    mockPrepareFunding.mockImplementation(fundingPrepared)
    mockCreateIntent.mockImplementation(async () => ({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' }))
    // B holds its own open (token, payTo) grant by default; the no-own-grant
    // fixture clears it.
    mockSelect.mockResolvedValue({
      delegation_hash: B_OWN_HASH,
      delegation_json: JSON.stringify(bOwnDelegation),
      recipient_address: null,
      budget_atomic: '5000000',
    })
    // A's budget delegation, by hash.
    mockSelectByHash.mockResolvedValue({
      delegation_hash: BUDGET_HASH,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
      budget_atomic: '5000000',
    })
    primeDb()
  })

  const pay = (extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/x402/authorize', headers: { authorization: 'Bearer sk_agent_test' }, payload: body(extra) })
  const refusalRows = () => mockQuery.mock.calls.filter((c) => /INSERT INTO payment_refusals/.test(String(c[0])))

  // ── erc7710 leg ──────────────────────────────────────────────────────────
  it('erc7710 (a): under B\'s slice → 201, the settlement redeems [settlement, grant, parentChild, budget] from A\'s budget', async () => {
    const res = await pay()
    expect(res.statusCode).toBe(201)
    const call = mockCreateIntent.mock.calls[0][0] as { preparedUserOp: string; budgetDelegationHash: string; subBudgetId: string }
    expect(call.subBudgetId).toBe('sb-1')
    expect(call.budgetDelegationHash).toBe(BUDGET_HASH)
    const state = JSON.parse(call.preparedUserOp)
    expect(state.subBudget.grantDelegation.delegate.toLowerCase()).toBe(B_DELEGATE_ACCT.toLowerCase())
    expect(state.subBudget.parentChildDelegation.authority).toBe(BUDGET_HASH)
  })

  it.fails('erc7710 (b): over B\'s slice but under A\'s budget → typed 403 delegation_budget_exceeded, no sign_data', async () => {
    remainingByLink({ grant: '50000' }) // 50_000 left on B's slice, 100_000 asked
    const res = await pay()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error_code: 'delegation_budget_exceeded', remaining_atomic: '50000', merchant_address: MERCHANT.toLowerCase() })
    expect(res.json().sign_data).toBeUndefined()
    expect(mockCreateIntent).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
  })

  it.fails('erc7710 (b2): over A\'s parent-child link → the same 403 (every link is read, the smallest decides)', async () => {
    remainingByLink({ parentChild: '70000' })
    const res = await pay()
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error_code: 'delegation_budget_exceeded', remaining_atomic: '70000' })
  })

  it.fails('erc7710 (c): one link\'s read degraded → the others decide (fail open per link)', async () => {
    remainingByLink({ grant: 'throw', parentChild: '70000' })
    expect((await pay()).statusCode).toBe(403)
    remainingByLink({ grant: 'throw' })
    expect((await pay()).statusCode).toBe(201)
  })

  it.fails('erc7710: B with NO agent_delegations row of its own still pays through its sub-budget', async () => {
    mockSelect.mockResolvedValue(null)
    const res = await pay()
    expect(res.statusCode).toBe(201)
    expect((mockCreateIntent.mock.calls[0][0] as { subBudgetId: string }).subBudgetId).toBe('sb-1')
  })

  it('erc7710: the pre-check never reads B\'s own (token, payTo) grant when a sub-budget pays', async () => {
    remainingByLink({ bOwn: '1' })
    expect((await pay()).statusCode).toBe(201)
    expect(mockReadRemaining.mock.calls.map((c) => linkOf(c[1] as string))).not.toContain('bOwn')
  })

  // ── EIP-3009 funding leg ─────────────────────────────────────────────────
  it('3009 funding (a): under B\'s slice → 201, the funding redemption threads the sub-budget chain', async () => {
    const res = await pay(funding)
    expect(res.statusCode).toBe(201)
    expect(mockPrepareFunding).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-b' }),
      USDC,
      DELEGATE_SIGNER.address.toLowerCase(),
      100000n,
      expect.objectContaining({
        subBudget: expect.objectContaining({
          grantDelegation: expect.objectContaining({ delegate: B_DELEGATE_ACCT }),
          parentDelegation: expect.objectContaining({ delegation_hash: BUDGET_HASH }),
        }),
      }),
    )
  })

  it.fails('3009 funding (b): over B\'s slice → typed 403 delegation_budget_exceeded before any funding UserOp, naming the merchant', async () => {
    remainingByLink({ grant: '50000' })
    const res = await pay(funding)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error_code: 'delegation_budget_exceeded', remaining_atomic: '50000', merchant_address: MERCHANT.toLowerCase() })
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(refusalRows()).toHaveLength(1))
    expect(refusalRows()[0]![1]).toContain(MERCHANT.toLowerCase())
  })

  it.fails('3009 funding (c): one link\'s read degraded → the others decide', async () => {
    remainingByLink({ parentChild: 'throw', grant: '50000' })
    expect((await pay(funding)).statusCode).toBe(403)
    remainingByLink({ parentChild: 'throw' })
    expect((await pay(funding)).statusCode).toBe(201)
  })

  it.fails('3009 funding: the pre-check reads the sub-budget chain, never B\'s own (token, payTo) grant', async () => {
    remainingByLink({ bOwn: '1' })
    expect((await pay(funding)).statusCode).toBe(201)
    expect(mockReadRemaining.mock.calls.map((c) => linkOf(c[1] as string))).not.toContain('bOwn')
  })

  it('3009 funding: B with NO agent_delegations row of its own still pays through its sub-budget', async () => {
    mockSelect.mockResolvedValue(null)
    expect((await pay(funding)).statusCode).toBe(201)
  })

  // ── (d) replay ───────────────────────────────────────────────────────────
  it('(d): a replay of a confirmed sub-budget intent answers its stored result, before any budget decision', async () => {
    primeDb({
      confirmed: {
        id: INTENT_ID, status: 'confirmed', tx_hash: `0x${'77'.repeat(32)}`,
        sub_budget_id: 'sb-1', task_budget_id: null, chain_id: 84532,
        account_address: '0x' + 'aa'.repeat(20), token_symbol: 'USDC', amount_human: '0.1',
        to_address: MERCHANT, x402_merchant_address: MERCHANT, x402_resource_url: 'https://merchant.example/resource',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    remainingByLink({ grant: '1' }) // would refuse — must not be consulted
    const res = await pay({ idempotencyKey: 'key-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ payment_id: INTENT_ID, status: 'confirmed' })
    expect(mockReadRemaining).not.toHaveBeenCalled()
  })
})
