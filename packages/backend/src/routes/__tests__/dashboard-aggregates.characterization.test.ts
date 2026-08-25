/**
 * Characterization tests for the dashboard aggregates `dashboard.test.ts`
 * leaves at their empty-result defaults (#1167).
 *
 * The existing suite answers every aggregate with `{ rows: [] }`, so four
 * behaviours were unpinned before the SQL moved into
 * `infra/repositories/dashboard.ts`:
 *
 *  - the daily snapshot UPSERT is conditional — it must NOT run when today's
 *    row already exists;
 *  - the day-over-day change is read from YESTERDAY's snapshot row;
 *  - month-to-date spend sums the payment and approval aggregates together,
 *    including the fiat-fallback branch for rows with no stored usd/eur value;
 *  - the allowance read is SKIPPED entirely when the user has no agents.
 *
 * Written against the UNCHANGED route and passing before the extraction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const { mockQuery, portfolioMocks, transactionMocks, fiatMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  portfolioMocks: { fetchPortfolioForSafe: vi.fn() },
  transactionMocks: {
    compareTransactions: vi.fn(() => 0),
    enrichedTransactionIdentityKey: vi.fn((tx: { hash: string }) => tx.hash),
    enrichTransactionsWithAgents: vi.fn(
      async (_userId: string, transactions: unknown[]) => transactions,
    ),
    fetchSafeTransactions: vi.fn(),
    mergeX402Transactions: vi.fn(),
  },
  fiatMocks: { getFiatValuesForTokenAmount: vi.fn() },
}))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../modules/accounts/index.js', () => portfolioMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../modules/transactions/index.js', () => transactionMocks)

import dashboardRoutes from '../dashboard.js'

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
  account_type: null,
}

/** Same UTC-day arithmetic the route uses for its snapshot keys. */
function snapshotDate(offsetDays = 0): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

/**
 * Route-shaped query dispatcher. `overrides` replaces individual aggregates;
 * everything else answers empty, matching the route's happy path.
 */
function installQueryMock(overrides: {
  safes?: unknown[]
  agents?: unknown[]
  snapshots?: unknown[]
  paymentSpend?: unknown[]
  approvalSpend?: unknown[]
} = {}) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('AS has_first_agent_payment')) {
      return Promise.resolve({ rows: [{ has_first_agent_payment: false }] })
    }
    if (sql.includes('FROM user_safes') && sql.includes('ORDER BY created_at ASC')) {
      return Promise.resolve({ rows: overrides.safes ?? [SAFE] })
    }
    if (sql.includes('FROM agents a')) {
      return Promise.resolve({ rows: overrides.agents ?? [] })
    }
    if (sql.includes("status IN ('pending', 'approved')")) {
      return Promise.resolve({ rows: [{ count: '0' }] })
    }
    // #2020: no `FROM agent_allowances` branch — the dashboard never issues
    // that query any more (legacy agents get `[]`, delegation agents derive
    // from `agent_delegations`), so there is nothing left to stub here.
    if (sql.includes('FROM user_daily_portfolio_snapshots')) {
      return Promise.resolve({ rows: overrides.snapshots ?? [] })
    }
    if (sql.includes('INSERT INTO user_daily_portfolio_snapshots')) {
      return Promise.resolve({ rows: [] })
    }
    // Both month-to-date aggregates end in GROUP BY token_symbol; they are told
    // apart by their source table (checked AFTER has_first_agent_payment, which
    // names both tables).
    if (sql.includes('GROUP BY token_symbol') && sql.includes('FROM payment_intents')) {
      return Promise.resolve({ rows: overrides.paymentSpend ?? [] })
    }
    if (sql.includes('GROUP BY token_symbol') && sql.includes('FROM approval_requests')) {
      return Promise.resolve({ rows: overrides.approvalSpend ?? [] })
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
}

function callsMatching(pattern: string) {
  return mockQuery.mock.calls.filter(([sql]) => String(sql).includes(pattern))
}

describe('dashboard aggregates (characterization, #1167)', () => {
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
    transactionMocks.fetchSafeTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()
    fiatMocks.getFiatValuesForTokenAmount.mockReset()

    portfolioMocks.fetchPortfolioForSafe.mockResolvedValue({ totalUsd: 100, totalEur: 92 })
    transactionMocks.fetchSafeTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0, eur: 0 })
  })

  async function getOverview() {
    return app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })
  }

  describe('daily portfolio snapshot', () => {
    it("writes today's snapshot when none exists, with the live portfolio totals", async () => {
      installQueryMock({ snapshots: [] })

      const response = await getOverview()

      expect(response.statusCode).toBe(200)
      const inserts = callsMatching('INSERT INTO user_daily_portfolio_snapshots')
      expect(inserts).toHaveLength(1)
      expect(inserts[0][1]).toEqual(['user-1', snapshotDate(0), 100, 92])
    })

    it("does NOT re-write the snapshot when today's row already exists", async () => {
      installQueryMock({
        snapshots: [
          { snapshot_date: snapshotDate(0), total_usd: '90', total_eur: '85' },
        ],
      })

      const response = await getOverview()

      expect(response.statusCode).toBe(200)
      expect(callsMatching('INSERT INTO user_daily_portfolio_snapshots')).toHaveLength(0)
    })

    it('reads the snapshot pair for today and yesterday, scoped to the user', async () => {
      installQueryMock({})

      await getOverview()

      const read = callsMatching('FROM user_daily_portfolio_snapshots')[0]
      expect(read[1]).toEqual(['user-1', [snapshotDate(0), snapshotDate(-1)]])
    })
  })

  describe('day-over-day change', () => {
    it("derives amounts and percentages from yesterday's snapshot", async () => {
      installQueryMock({
        snapshots: [
          { snapshot_date: snapshotDate(-1), total_usd: '80', total_eur: '75' },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.change.available).toBe(true)
      expect(body.change.usdAmount).toBeCloseTo(20, 10)
      expect(body.change.eurAmount).toBeCloseTo(17, 10)
      expect(body.change.usdPercent).toBeCloseTo(25, 10)
      expect(body.change.eurPercent).toBeCloseTo((17 / 75) * 100, 10)
    })

    it('reports change as unavailable and zeroed when yesterday has no snapshot', async () => {
      installQueryMock({ snapshots: [] })

      const body = (await getOverview()).json()

      expect(body.change).toEqual({
        available: false,
        usdAmount: 100,
        eurAmount: 92,
        usdPercent: 0,
        eurPercent: 0,
      })
    })

    it('reports a zero percentage rather than dividing by a zero baseline', async () => {
      installQueryMock({
        snapshots: [
          { snapshot_date: snapshotDate(-1), total_usd: '0', total_eur: '0' },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.change.available).toBe(true)
      expect(body.change.usdPercent).toBe(0)
      expect(body.change.eurPercent).toBe(0)
    })
  })

  describe('month-to-date agent spend', () => {
    it('sums the payment and approval aggregates into one total', async () => {
      installQueryMock({
        paymentSpend: [
          { token_symbol: 'USDC', usd_sum: '10', eur_sum: '9', fallback_amount: '0' },
        ],
        approvalSpend: [
          { token_symbol: 'USDC', usd_sum: '5', eur_sum: '4', fallback_amount: '0' },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.metrics.monthlyAgentSpendUsd).toBeCloseTo(15, 10)
      expect(body.metrics.monthlyAgentSpendEur).toBeCloseTo(13, 10)
      expect(fiatMocks.getFiatValuesForTokenAmount).not.toHaveBeenCalled()
    })

    it('prices rows carrying a fallback amount through the fiat lookup', async () => {
      fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 2, eur: 1.8 })
      installQueryMock({
        paymentSpend: [
          { token_symbol: 'USDC', usd_sum: '0', eur_sum: '0', fallback_amount: '2' },
        ],
      })

      const body = (await getOverview()).json()

      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenCalledWith('USDC', '2')
      expect(body.metrics.monthlyAgentSpendUsd).toBeCloseTo(2, 10)
      expect(body.metrics.monthlyAgentSpendEur).toBeCloseTo(1.8, 10)
    })

    it('scopes both month-to-date aggregates to the authenticated user', async () => {
      installQueryMock({})

      await getOverview()

      const paymentSpend = mockQuery.mock.calls.find(
        ([sql]) =>
          String(sql).includes('GROUP BY token_symbol') &&
          String(sql).includes('FROM payment_intents'),
      )
      const approvalSpend = mockQuery.mock.calls.find(
        ([sql]) =>
          String(sql).includes('GROUP BY token_symbol') &&
          String(sql).includes('FROM approval_requests'),
      )
      expect(paymentSpend?.[1]).toEqual(['user-1'])
      expect(approvalSpend?.[1]).toEqual(['user-1'])
    })
  })

  describe('agent allowances', () => {
    // #2020 (epic #1440), reversing the byte-identical mirror pin this
    // replaces: the Safe rail is retired and `agent_allowances` is never
    // queried by the dashboard any more, so a legacy (non-delegator_hybrid)
    // agent reports NO allowance entries rather than mapping the mirror rows.
    it('legacy agents get [] allowances — the mirror is retired and never queried', async () => {
      installQueryMock({
        agents: [AGENT],
      })

      const body = (await getOverview()).json()

      expect(body.agents[0].allowances).toEqual([])
      expect(callsMatching('FROM agent_allowances')).toHaveLength(0)
    })

    it('skips the allowance read entirely when the user has no agents', async () => {
      installQueryMock({ agents: [] })

      const response = await getOverview()

      expect(response.statusCode).toBe(200)
      expect(callsMatching('FROM agent_allowances')).toHaveLength(0)
      expect(response.json().agents).toEqual([])
    })
  })
})
