import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
// #2392: the spec's own schema decides whether the overview matches what the
// dashboard's generated wire types promise — see the #1090 block below.
import { expectMatchesSpec } from '../../openapi/response-shape.js'
// The double below replaces only the FETCHING half of the accounts barrel;
// the route also reads the pure freshness combiner from it (#3295), which
// stays real so the marker math this file pins is the production math.
import { combineBalanceFreshness } from '../../modules/accounts/balance-freshness.js'

const { mockQuery, portfolioMocks, transactionMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  portfolioMocks: {
    fetchPortfolioForAccount: vi.fn(),
    // #3296: the route asks the module whether a result is unpriceable before
    // writing the daily snapshot; the real predicate is proven against the
    // marker in modules/accounts/__tests__/portfolio-unpriceable.test.ts.
    isPortfolioUnpriceable: vi.fn(),
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
    fetchAccountTransactions: vi.fn(),
    mergeX402Transactions: vi.fn(),
    resolveTransactionCurrency: vi.fn(async () => 'SEK'),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../modules/accounts/index.js', () => ({
  ...portfolioMocks,
  combineBalanceFreshness,
}))
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
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  name: 'Main account',
  is_default: true,
}

const AGENT = {
  id: 'agent-1',
  name: 'Research agent',
  status: 'active',
  account_id: SAFE.id,
  account_name: SAFE.name,
  account_chain_id: SAFE.chain_id,
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
    portfolioMocks.fetchPortfolioForAccount.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReturnValue(false)
    transactionMocks.compareTransactions.mockClear()
    transactionMocks.enrichedTransactionIdentityKey.mockClear()
    transactionMocks.enrichTransactionsWithAgents.mockClear()
    transactionMocks.resolveTransactionCurrency.mockClear()
    transactionMocks.fetchAccountTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()

    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({
      totalUsd: 100,
      totalEur: 92,
      totalSek: 920,
    })
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      }
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) {
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

  // #2914 (naming epic #2906 phase 5, the contraction): the twin `#2907`
  // dual-emitted is gone. DashboardAgentPreview and the preview transaction
  // carry the account_* names ONLY, ON THE WIRE — a request-level check, not
  // just the mapper's own unit test (the mapper itself is deleted).
  it('#2914: agents[] and transactions[] carry the account_* names only, not the retired safe*', async () => {
    const tx = {
      hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
      type: 'native',
      from: '0x2222222222222222222222222222222222222222',
      to: SAFE.account_address,
      value: '1000000000000000000',
      valueFormatted: '1',
      asset: 'ETH',
      decimals: 18,
      direction: 'in',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
    }
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [tx] })
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
    expect(body.agents.length).toBeGreaterThan(0)
    for (const agent of body.agents) {
      expect(agent.safeId).toBeUndefined()
      expect(agent.safeName).toBeUndefined()
      expect(agent.safeChainId).toBeUndefined()
      expect(agent.accountId).toBeDefined()
      expect(agent.accountName).toBeDefined()
      expect(agent.accountChainId).toBeDefined()
    }
    expect(body.transactions.length).toBeGreaterThan(0)
    for (const item of body.transactions) {
      expect(item.safeId).toBeUndefined()
      expect(item.safeAddress).toBeUndefined()
      expect(item.safeName).toBeUndefined()
      expect(item.accountId).toBeDefined()
      expect(item.accountAddress).toBeDefined()
    }
  })

  // #2055 (epic #1440, #2021 readability waiver): the approval queue is gone,
  // so `actionableApprovals` / `pendingApprovals` are structurally zero — the
  // wire fields survive for compatibility but no query backs them anymore.
  // Replaces the pre-#2055 "reports the actionable-approval COUNT" and
  // "scopes the approval count to the requesting user" tests, which pinned a
  // query (`status IN ('pending', 'approved')` against `approval_requests`)
  // that no longer runs.
  // #3132: the preview carries the same synthesized x402 rows as the feed, so
  // the MARKED fallback must reach it — a whitelist that drops the mark would
  // put the silent substitution back on the surface a user looks at first.
  it('#3132: the preview carries timestampSource and confirmedAt through its whitelist (no scope — not a list query)', async () => {
    const synthesized = {
      hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a2',
      type: 'erc20',
      from: SAFE.account_address,
      to: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      value: '20000',
      valueFormatted: '0.02',
      asset: 'USDC',
      decimals: 6,
      direction: 'out',
      timestamp: 1778240999,
      timestampSource: 'created_at',
      confirmedAt: null,
      blockNumber: null,
      isError: false,
      source: 'x402',
    }
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockImplementation(async () => [synthesized])

    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const [row] = response.json().transactions as Array<Record<string, unknown>>
    expect(row.timestampSource).toBe('created_at')
    expect(row.confirmedAt).toBeNull()
    expect(row).not.toHaveProperty('scope')
  })

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
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) {
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
      to: SAFE.account_address,
      value: '1000000000000000000',
      valueFormatted: '1',
      asset: 'ETH',
      decimals: 18,
      direction: 'in',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
    }
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [tx] })
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
    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({ totalUsd: 0, totalEur: 0, totalSek: 0 })
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) return Promise.resolve({ rows: [SAFE] })
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({
          rows: [{ ...AGENT, id: AGENT_UUID, account_id: SAFE_UUID, account_type: 'delegator_hybrid' }],
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

// #3295 — `GET /dashboard/overview` under a degraded balance read.
//
// The route tests above mock `fetchPortfolioForAccount` wholesale, which is
// exactly the seam this behavior needs: the module-level substitution itself
// is proven in `modules/accounts/__tests__/portfolio-last-known.test.ts`;
// what a route test CAN pin is how the overview projects a degraded
// portfolio — totals computed from the substituted values, the additive
// marker on `change`, and the change amounts reported unavailable when some
// token has no known value (never a swing computed from a zero).
describe('dashboard overview under degraded balance reads (#3295)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })
  afterAll(async () => app.close())

  beforeEach(() => {
    portfolioMocks.fetchPortfolioForAccount.mockReset()
    transactionMocks.fetchAccountTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()
    transactionMocks.resolveTransactionCurrency.mockClear()
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: false }] })
      }
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [SAFE] })
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
  })

  async function getOverview() {
    return app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('reports degraded totals built from the last-known balances, with the additive marker', async () => {
    // What the module returns when one token's read failed after a good one:
    // the breakdown entry carries the SUBSTITUTED last-known balance and the
    // stale marker; the totals are priced from those substituted values.
    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({
      totalUsd: 2000,
      totalEur: 1800,
      totalSek: 20_000,
      breakdown: [
        {
          symbol: 'USDC',
          balance: '2000000',
          formatted: '2.00',
          usdValue: 2000,
          eurValue: 1800,
          sekValue: 20_000,
          balanceFreshness: { status: 'stale', asOf: '2026-09-25T07:55:00.000Z' },
        },
      ],
    })

    const body = (await getOverview()).json()

    expect(body.totals).toEqual({ usd: 2000, eur: 1800, sek: 20_000 })
    expect(body.change.balancesFreshness).toEqual({
      status: 'stale',
      asOf: '2026-09-25T07:55:00.000Z',
    })
    // Stale tokens still diff normally — the last-known figures sit on both
    // sides of the subtraction.
    expect(body.change.usdAmount).not.toBeNull()
  })

  it('reports the change as unavailable when some token has no known value — never a swing from a zero', async () => {
    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({
      totalUsd: 0,
      totalEur: 0,
      totalSek: 0,
      breakdown: [
        {
          symbol: 'USDC',
          balance: '0',
          formatted: '0.00',
          usdValue: 0,
          eurValue: 0,
          sekValue: 0,
          balanceFreshness: { status: 'unavailable' },
        },
      ],
    })
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return Promise.resolve({
          rows: [
            {
              snapshot_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
              total_usd: '80',
              total_eur: '75',
              total_sek: '740',
            },
          ],
        })
      }
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: false }] })
      }
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [SAFE] })
      }
      if (sql.includes('FROM agents a')) {
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

    const body = (await getOverview()).json()

    expect(body.change.balancesFreshness).toEqual({ status: 'unavailable' })
    // Amounts null (matches how `sekAmount: null` already reads), percentages
    // inert: no -100% swing fabricated from a zero.
    expect(body.change.usdAmount).toBeNull()
    expect(body.change.eurAmount).toBeNull()
    expect(body.change.sekAmount).toBeNull()
  })

  it('clean reads carry no marker and unchanged change amounts', async () => {
    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({
      totalUsd: 100,
      totalEur: 92,
      totalSek: 920,
      breakdown: [
        {
          symbol: 'USDC',
          balance: '100000000',
          formatted: '100.00',
          usdValue: 100,
          eurValue: 92,
          sekValue: 920,
        },
      ],
    })
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return Promise.resolve({
          rows: [
            {
              snapshot_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
              total_usd: '80',
              total_eur: '75',
              total_sek: '740',
            },
          ],
        })
      }
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: false }] })
      }
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [SAFE] })
      }
      if (sql.includes('FROM agents a')) {
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

    const body = (await getOverview()).json()

    expect(body.change.balancesFreshness).toBeUndefined()
    expect(body.change.usdAmount).toBeCloseTo(20, 10)
    expect(body.change.eurAmount).toBeCloseTo(17, 10)
    expect(body.change.sekAmount).toBeCloseTo(180, 10)
  })
})

// #3296 — the daily snapshot is written only from a CLEAN read.
//
// `isPortfolioUnpriceable` is mocked per-portfolio above, so what these tests
// pin is the ROUTE's use of it: any account unpriceable → no INSERT into
// user_daily_portfolio_snapshots plus an info log naming the user only, a
// clean read → the insert exactly as before. The predicate's own truth table
// (marker reuse, cache-hit survival, price-vs-balance failure) is proven
// against the real marker in modules/accounts/__tests__/
// portfolio-unpriceable.test.ts. The query stubs keep the
// characterization suite's keyword-dispatched shape — the ratchet forbids
// growing positional mocking on db.js (mockResolvedValueOnce).
describe('dashboard writes the daily snapshot only from a clean read (#3296)', () => {
  const SKIP_MSG = 'Daily portfolio snapshot skipped: the portfolio read is unpriceable (#3296)'
  let app: FastifyInstance
  let token: string
  const logLines: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    app = Fastify({
      // Capture pino's own JSON lines so the skip log can be pinned without
      // stubbing the logger (a stubbed request.log would no longer prove the
      // route logs at info through the real pipeline).
      logger: {
        level: 'info',
        stream: {
          write(chunk: string) {
            try {
              logLines.push(JSON.parse(chunk))
            } catch {
              // Non-JSON line — not a pino record, not ours to pin.
            }
          },
        },
      },
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })
  afterAll(async () => app.close())

  /** Same UTC-day arithmetic the route uses for its snapshot keys. */
  function snapshotDate(offsetDays = 0): string {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() + offsetDays)
    return date.toISOString().slice(0, 10)
  }

  function installQueryMock(accountRows: unknown[] = [SAFE]) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: false }] })
      }
      if (sql.includes('FROM smart_accounts') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: accountRows })
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
  }

  beforeEach(() => {
    logLines.length = 0
    mockQuery.mockReset()
    portfolioMocks.fetchPortfolioForAccount.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReturnValue(false)
    transactionMocks.fetchAccountTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()
    transactionMocks.resolveTransactionCurrency.mockClear()
    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({
      totalUsd: 100,
      totalEur: 92,
      totalSek: 920,
    })
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])
    installQueryMock()
  })

  async function getOverview() {
    return app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  function insertCalls() {
    return mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO user_daily_portfolio_snapshots'),
    )
  }

  it('a clean read still inserts today\'s snapshot exactly as before', async () => {
    const response = await getOverview()

    expect(response.statusCode).toBe(200)
    const inserts = insertCalls()
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toEqual(['user-1', snapshotDate(0), 100, 92, 920])
    expect(logLines.find((line) => line.msg === SKIP_MSG)).toBeUndefined()
  })

  it('an unpriceable read writes NO snapshot and logs the skip with the user id only', async () => {
    portfolioMocks.isPortfolioUnpriceable.mockReturnValue(true)

    const response = await getOverview()

    expect(response.statusCode).toBe(200)
    expect(insertCalls()).toHaveLength(0)
    const skip = logLines.find((line) => line.msg === SKIP_MSG)
    expect(skip, 'expected one skip log line').toBeDefined()
    expect(skip).toMatchObject({ userId: 'user-1' })
    // The route controls exactly these fields — no amounts, no portfolio
    // figures on the skip line (finding aid, not a figures channel). `reqId`
    // is fastify's automatic per-request binding, present on every line.
    const routeControlled = Object.keys(skip ?? {}).filter(
      (key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key),
    )
    expect(routeControlled).toEqual(['reqId', 'userId'])
  })

  it('asks every account and skips when ANY of them is unpriceable', async () => {
    const gnosisSafe = { ...SAFE, id: 'safe-gnosis', chain_id: 100 }
    installQueryMock([SAFE, gnosisSafe])
    // Clean on the first account, unpriceable on the second.
    portfolioMocks.isPortfolioUnpriceable
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    const response = await getOverview()

    expect(response.statusCode).toBe(200)
    expect(portfolioMocks.isPortfolioUnpriceable).toHaveBeenCalledTimes(2)
    expect(insertCalls()).toHaveLength(0)
    expect(logLines.find((line) => line.msg === SKIP_MSG)).toBeDefined()
  })

  it('all accounts clean after a skipped load writes the snapshot — the day is recoverable', async () => {
    // First load: degraded (the stale row skips the insert — mocked db has no
    // snapshot row to begin with, so the skip is what this pins).
    portfolioMocks.isPortfolioUnpriceable.mockReturnValue(true)
    await getOverview()
    expect(insertCalls()).toHaveLength(0)

    // Later load the same day: clean → the snapshot lands after all.
    portfolioMocks.isPortfolioUnpriceable.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReturnValue(false)
    await getOverview()

    expect(insertCalls()).toHaveLength(1)
    expect(insertsToParams()).toEqual(['user-1', snapshotDate(0), 100, 92, 920])
  })

  function insertsToParams(): unknown {
    const inserts = insertCalls()
    expect(inserts).toHaveLength(1)
    return inserts[0][1]
  }
})
