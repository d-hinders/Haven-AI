import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
// #2392: the spec's own schema decides whether the overview matches what the
// dashboard's generated wire types promise — see the #1090 block below.
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const { mockQuery, portfolioMocks, transactionMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  portfolioMocks: {
    fetchPortfolioForSafe: vi.fn(),
  },
  transactionMocks: {
    compareTransactions: vi.fn(() => 0),
    enrichedTransactionIdentityKey: vi.fn((tx: {
      chainId: number
      safeId: string
      hash: string
      type: string
      from: string
      to: string
      value: string
      tokenAddress?: string
    }) => [
      tx.chainId,
      tx.safeId,
      tx.hash.toLowerCase(),
      tx.type,
      tx.from.toLowerCase(),
      tx.to.toLowerCase(),
      tx.value,
      tx.tokenAddress?.toLowerCase() ?? 'native',
    ].join(':')),
    enrichTransactionsWithAgents: vi.fn(
      async (_userId: string, transactions: unknown[]) => transactions,
    ),
    fetchSafeTransactions: vi.fn(),
    mergeX402Transactions: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../modules/accounts/index.js', () => portfolioMocks)
vi.mock('../../infra/fiat-values.js', () => ({
  getFiatValuesForTokenAmount: vi.fn(),
}))
// #992: aggregation/enrichment/caching moved to src/modules/transactions/.
vi.mock('../../modules/transactions/index.js', () => transactionMocks)

import dashboardRoutes from '../dashboard.js'

// The spec promises `format: uuid` for `DashboardAgentPreview.id` / `safeId`
// and the columns are UUID PRIMARY KEYs; `ajv-formats` is wired, so a fixture
// id like 'agent-1' fails the round trip for a FIXTURE reason (#2328/#2392).
// The #1090 block below asserts the shape and uses these; the older tests
// above it keep their short ids because they never hand the payload to the spec.
const SAFE_UUID = 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16'
const AGENT_UUID = '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34'
const DELEGATION_UUID = '9c2b7e11-5d4f-4a8c-b3e6-1f0a2d7c8e94'

const SAFE = {
  id: 'safe-1',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  name: 'Main account',
  is_default: true,
}

const AGENT = {
  id: 'agent-1',
  name: 'Research agent',
  status: 'active',
  safe_id: SAFE.id,
  safe_name: SAFE.name,
  safe_chain_id: SAFE.chain_id,
}

describe('dashboard routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    portfolioMocks.fetchPortfolioForSafe.mockReset()
    transactionMocks.compareTransactions.mockClear()
    transactionMocks.enrichedTransactionIdentityKey.mockClear()
    transactionMocks.enrichTransactionsWithAgents.mockClear()
    transactionMocks.fetchSafeTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()

    portfolioMocks.fetchPortfolioForSafe.mockResolvedValue({
      totalUsd: 100,
      totalEur: 92,
    })
    transactionMocks.fetchSafeTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      }
      if (sql.includes('FROM user_safes') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [SAFE] })
      }
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({ rows: [AGENT] })
      }
      if (sql.includes('FROM agent_allowances')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('INSERT INTO user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('GROUP BY token_symbol')) {
        return Promise.resolve({ rows: [] })
      }

      throw new Error(`Unexpected query: ${sql}`)
    })
  })

  it('returns first agent payment progress from authoritative payment records', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      onboardingProgress: {
        hasFirstAgentPayment: true,
      },
    })

    const progressQuery = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('AS has_first_agent_payment'),
    )?.[0] as string
    expect(progressQuery).toContain('FROM payment_intents')
    expect(progressQuery).toContain("status = 'confirmed'")
    // #2055: the approval_requests EXISTS branch is gone with the table —
    // payment_intents is the only source of "has this agent ever paid".
    expect(progressQuery).not.toContain('approval_requests')

    const agentQuery = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM agents a'),
    )?.[0] as string
    expect(agentQuery).toContain("a.status IN ('active', 'paused')")
  })

  // #2055 (epic #1440, #2021 readability waiver): the approval queue is gone,
  // so `actionableApprovals` / `pendingApprovals` are structurally zero — the
  // wire fields survive for compatibility but no query backs them anymore.
  // Replaces the pre-#2055 "reports the actionable-approval COUNT" and
  // "scopes the approval count to the requesting user" tests, which pinned a
  // query (`status IN ('pending', 'approved')` against `approval_requests`)
  // that no longer runs.
  it('reports actionableApprovals/pendingApprovals as hardcoded 0 — no approval query runs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      actionableApprovals: 0,
      pendingApprovals: 0,
    })
    expect(
      mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql))),
      'no query should ever reference the dropped table',
    ).toBe(false)
  })

  it('counts same-address transactions on separate chains independently', async () => {
    const gnosisSafe = { ...SAFE, id: 'safe-gnosis', chain_id: 100 }
    const baseSafe = { ...SAFE, id: 'safe-base', chain_id: 8453 }
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      }
      if (sql.includes('FROM user_safes') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [gnosisSafe, baseSafe] })
      }
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('INSERT INTO user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('GROUP BY token_symbol')) {
        return Promise.resolve({ rows: [] })
      }

      throw new Error(`Unexpected query: ${sql}`)
    })

    const tx = {
      hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
      type: 'native',
      from: '0x2222222222222222222222222222222222222222',
      to: SAFE.safe_address,
      value: '1000000000000000000',
      valueFormatted: '1',
      asset: 'ETH',
      decimals: 18,
      direction: 'in',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
    }
    transactionMocks.fetchSafeTransactions.mockResolvedValue({ transactions: [tx] })
    transactionMocks.mergeX402Transactions.mockImplementation(
      async (_userId: string, _safes: unknown[], transactions: unknown[]) => transactions,
    )

    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.metrics.successfulTransactions).toBe(2)
    expect(body.transactions).toHaveLength(2)
    expect(body.transactions.map((item: { chainId: number }) => item.chainId).sort()).toEqual([
      100,
      8453,
    ])
  })
})

describe('dashboard derives delegation-rail budgets from active delegations (#1090)', () => {
  let app: FastifyInstance
  let token: string
  const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })
  afterAll(async () => app.close())

  it('a delegator_hybrid agent reports the active delegation, not the frozen mirror', async () => {
    portfolioMocks.fetchPortfolioForSafe.mockResolvedValue({ totalUsd: 0, totalEur: 0 })
    transactionMocks.fetchSafeTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      if (sql.includes('FROM user_safes') && sql.includes('ORDER BY created_at ASC')) return Promise.resolve({ rows: [SAFE] })
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({
          rows: [{ ...AGENT, id: AGENT_UUID, safe_id: SAFE_UUID, account_type: 'delegator_hybrid' }],
        })
      }
      if (sql.includes('FROM agent_allowances')) {
        // The frozen onboarding mirror — must NOT be what the dashboard shows.
        return Promise.resolve({ rows: [{ agent_id: AGENT.id, token_symbol: 'USDC', allowance_amount: '10.00', reset_period_min: 1440 }] })
      }
      if (sql.includes('FROM agent_delegations')) {
        return Promise.resolve({ rows: [{ id: DELEGATION_UUID, agent_id: AGENT_UUID, chain_id: 84532, token_address: SEPOLIA_USDC, budget_atomic: '1000000', period_seconds: 86_400 }] })
      }
      if (sql.includes('FROM user_daily_portfolio_snapshots')) return Promise.resolve({ rows: [] })
      if (sql.includes('INSERT INTO user_daily_portfolio_snapshots')) return Promise.resolve({ rows: [] })
      if (sql.includes('GROUP BY token_symbol')) return Promise.resolve({ rows: [] })
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET', url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    const agent = body.agents.find((a: { id: string }) => a.id === AGENT_UUID)
    // Two pins, deliberately both (#2392, revised by #2408).
    //
    // The literal was once the ONLY thing pinning the human-decimal DIGITS:
    // `DashboardAgentAllowance.allowanceAmount` was a bare `string` (#2400
    // named it) and the `allowanceHumanAmount` pattern admitted a bare
    // integer, so a route that started emitting the atomic `budget_atomic`
    // ('1000000') one nesting below passed every schema check and failed only
    // here. That was measured, not feared — it is what #2392 observed.
    //
    // #2408 closed it: the pattern is now `^(0|[0-9]+\.[0-9]{2,6})$`, which
    // `formatTokenValue` can always satisfy and an atomic value never can, so
    // `expectMatchesSpec` below now catches that mutation on its own
    // (mutation-proven both ways on #2408's branch). The literal STAYS as
    // belt-and-braces: it pins the exact digits, where the pattern only pins
    // the shape — '2.00' for a '1000000' budget would still pass the schema.
    // The round trip pins what neither literal can: the field SET, the types,
    // the enum and the uuid formats of the whole overview envelope, against
    // the same schema the dashboard's generated wire types are built from.
    expectMatchesSpec('GET', '/dashboard/overview', body)
    expect(agent.allowances).toEqual([
      { tokenSymbol: 'USDC', allowanceAmount: '1.00', resetPeriodMin: 1440 },
    ])
  })
})
