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
 *  - month-to-date spend sums the payment aggregate alone (the approval
 *    aggregate is gone, #2055), including the fiat-fallback branch for rows
 *    with no stored usd/eur value;
 *  - the allowance read is SKIPPED entirely when the user has no agents.
 *
 * Written against the UNCHANGED route and passing before the extraction.
 * #2055 (epic #1440, #2021 readability waiver): `approval_requests` is
 * dropped — the approval-spend branch and `status IN ('pending','approved')`
 * actionable-count query this file used to stub are gone from the route, so
 * their stubs are removed rather than left dead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
// The double below replaces only the FETCHING half of the accounts barrel;
// the route also reads the pure freshness combiner from it (#3295), which
// stays real so the marker math this file pins is the production math.
import { combineBalanceFreshness } from '../../modules/accounts/balance-freshness.js'
// #3803: the route answers needs_backup_recommendation per account — kept
// real, like the freshness combiner above.
import { needsBackupSignerRecommendation } from '../../modules/accounts/mainnet-gate.js'

const { mockQuery, portfolioMocks, transactionMocks, fiatMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  portfolioMocks: {
    fetchPortfolioForAccount: vi.fn(),
    // #3296: the route consults the module's unpriceable predicate before
    // writing the daily snapshot; clean by default, the snapshot tests pin.
    isPortfolioUnpriceable: vi.fn(),
  },
  transactionMocks: {
    compareTransactions: vi.fn(() => 0),
    enrichedTransactionIdentityKey: vi.fn((tx: { hash: string }) => tx.hash),
    enrichTransactionsWithAgents: vi.fn(
      async (_userId: string, transactions: unknown[]) => transactions,
    ),
    fetchAccountTransactions: vi.fn(),
    mergeX402Transactions: vi.fn(),
    resolveTransactionCurrency: vi.fn(async () => 'SEK'),
  },
  fiatMocks: { getFiatValuesForTokenAmount: vi.fn() },
}))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../modules/accounts/index.js', () => ({
  ...portfolioMocks,
  combineBalanceFreshness,
  needsBackupSignerRecommendation,
}))
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../modules/transactions/index.js', () => transactionMocks)
// #3803: the route reads today's spot rates for the budget captions. A mock
// keeps the suite off CoinGecko — the price read itself is infra/prices.ts'
// own concern.
vi.mock('../../infra/prices.js', () => ({
  getTokenPrice: vi.fn(async () => ({ usd: 1, eur: 0.9, sek: 10 })),
}))

import dashboardRoutes from '../dashboard.js'

const ACCOUNT = {
  id: 'account-1',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  name: 'Main account',
  is_default: true,
}

const AGENT = {
  id: 'agent-1',
  name: 'Research agent',
  status: 'active',
  account_id: ACCOUNT.id,
  account_name: ACCOUNT.name,
  account_chain_id: ACCOUNT.chain_id,
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
  accounts?: unknown[]
  agents?: unknown[]
  snapshots?: unknown[]
  paymentSpend?: unknown[]
} = {}) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('AS has_first_agent_payment')) {
      return Promise.resolve({ rows: [{ has_first_agent_payment: false }] })
    }
    if (sql.includes('FROM smart_accounts us') && sql.includes('GROUP BY us.id')) {
      return Promise.resolve({ rows: overrides.accounts ?? [ACCOUNT] })
    }
    if (sql.includes('FROM agents a')) {
      return Promise.resolve({ rows: overrides.agents ?? [] })
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
    // #2055: month-to-date spend is payment_intents alone — the
    // approval_requests GROUP BY token_symbol branch this dispatcher used to
    // route separately is gone with the query it stubbed.
    if (sql.includes('GROUP BY token_symbol') && sql.includes('FROM payment_intents')) {
      return Promise.resolve({ rows: overrides.paymentSpend ?? [] })
    }
    // #3803: the new overview sections. Default: an EMPTY dataset — zero
    // spend, zero merchants, zero refusals, no last payments, no budgets,
    // no setups, no sub-budgets, no contacts. The sections' own real-DB
    // proofs live in infra/repositories/__tests__/dashboard-overview.db.test.ts.
    if (sql.includes('WITH legs AS') && sql.includes('FROM payment_intents pi')) {
      return Promise.resolve({ rows: [] })
    }
    if (sql.includes('distinct_merchants_30')) {
      return Promise.resolve({
        rows: [
          {
            distinct_merchants_30: '0',
            distinct_merchants_7: '0',
            top_merchant_key: null,
            top_merchant_url: null,
            top_merchant_to: null,
            top_merchant_address: null,
          },
        ],
      })
    }
    if (sql.includes('FROM payment_refusals')) {
      return Promise.resolve({ rows: [] })
    }
    if (sql.includes('AS failed_intents')) {
      return Promise.resolve({ rows: [{ failed_intents: '0' }] })
    }
    if (sql.includes('DISTINCT ON (pi.agent_id)')) {
      return Promise.resolve({ rows: [] })
    }
    if (sql.includes('FROM contacts WHERE')) {
      return Promise.resolve({ rows: [] })
    }
    if (sql.includes('FROM agent_connection_setups')) {
      return Promise.resolve({ rows: [] })
    }
    if (sql.includes('agent_sub_budgets')) {
      return Promise.resolve({ rows: [] })
    }
    if (sql.includes('FROM agent_delegations')) {
      return Promise.resolve({ rows: [] })
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
    portfolioMocks.fetchPortfolioForAccount.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReset()
    portfolioMocks.isPortfolioUnpriceable.mockReturnValue(false)
    transactionMocks.fetchAccountTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()
    transactionMocks.resolveTransactionCurrency.mockClear()
    fiatMocks.getFiatValuesForTokenAmount.mockReset()

    portfolioMocks.fetchPortfolioForAccount.mockResolvedValue({
      totalUsd: 100,
      totalEur: 92,
      totalSek: 920,
    })
    transactionMocks.fetchAccountTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0, eur: 0, sek: 0 })
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
      // The SEK total rides the same first-write: one price read books all
      // three currencies beside each other (#3127 round 2).
      expect(inserts[0][1]).toEqual(['user-1', snapshotDate(0), 100, 92, 920])
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

      // #3803: the balance_by_day read ALSO matches this pattern (it is the
      // shared analytics statement), so pin the one whose second bind is the
      // date ARRAY — the snapshot pair.
      const read = mockQuery.mock.calls.find(
        ([sql, params]) =>
          String(sql).includes('FROM user_daily_portfolio_snapshots') && Array.isArray(params?.[1]),
      )
      expect(read?.[1]).toEqual(['user-1', [snapshotDate(0), snapshotDate(-1)]])
    })
  })

  describe('day-over-day change', () => {
    it("derives amounts and percentages from yesterday's snapshot", async () => {
      installQueryMock({
        snapshots: [
          { snapshot_date: snapshotDate(-1), total_usd: '80', total_eur: '75', total_sek: '740' },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.change.available).toBe(true)
      expect(body.change.usdAmount).toBeCloseTo(20, 10)
      expect(body.change.eurAmount).toBeCloseTo(17, 10)
      expect(body.change.sekAmount).toBeCloseTo(180, 10)
      expect(body.change.usdPercent).toBeCloseTo(25, 10)
      expect(body.change.eurPercent).toBeCloseTo((17 / 75) * 100, 10)
      expect(body.change.sekPercent).toBeCloseTo((180 / 740) * 100, 10)
    })

    it('reports change as unavailable and zeroed when yesterday has no snapshot', async () => {
      installQueryMock({ snapshots: [] })

      const body = (await getOverview()).json()

      expect(body.change).toEqual({
        available: false,
        usdAmount: 100,
        eurAmount: 92,
        // No SEK baseline either — the wire carries null, not a fabricated 0.
        sekAmount: null,
        usdPercent: 0,
        eurPercent: 0,
        sekPercent: 0,
      })
    })

    it('reports the SEK change as unavailable when yesterday predates migration 090 (total_sek NULL) — never a fabricated -100% (#3127 round 2)', async () => {
      installQueryMock({
        snapshots: [
          { snapshot_date: snapshotDate(-1), total_usd: '80', total_eur: '75', total_sek: null },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.change.available).toBe(true)
      expect(body.change.sekAmount).toBe(null)
      expect(body.change.sekPercent).toBe(0)
      // The pre-090 day prices the usd/eur pair exactly as before.
      expect(body.change.usdAmount).toBeCloseTo(20, 10)
      expect(body.change.eurAmount).toBeCloseTo(17, 10)
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
    // #2055: was "sums the payment and approval aggregates into one total" —
    // the approval aggregate is gone with `approval_requests`, so the total
    // is the payment aggregate alone.
    it('sums the payment aggregate alone — the approval aggregate is gone (#2055)', async () => {
      installQueryMock({
        paymentSpend: [
          { token_symbol: 'USDC', usd_sum: '10', eur_sum: '9', sek_sum: '95', fallback_amount: '0', fallback_amount_sek: '0' },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.metrics.monthlyAgentSpendUsd).toBeCloseTo(10, 10)
      expect(body.metrics.monthlyAgentSpendEur).toBeCloseTo(9, 10)
      expect(body.metrics.monthlyAgentSpendSek).toBeCloseTo(95, 10)
      expect(fiatMocks.getFiatValuesForTokenAmount).not.toHaveBeenCalled()
    })

    it('prices rows carrying a fallback amount through the fiat lookup', async () => {
      fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 2, eur: 1.8, sek: 18 })
      installQueryMock({
        paymentSpend: [
          { token_symbol: 'USDC', usd_sum: '0', eur_sum: '0', sek_sum: '0', fallback_amount: '2', fallback_amount_sek: '0' },
        ],
      })

      const body = (await getOverview()).json()

      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenCalledWith('USDC', '2')
      expect(body.metrics.monthlyAgentSpendUsd).toBeCloseTo(2, 10)
      expect(body.metrics.monthlyAgentSpendEur).toBeCloseTo(1.8, 10)
      // A zero `fallback_amount_sek` prices NO SEK fallback even though the
      // same fiat read returned one — the SEK bucket prices only what its
      // OWN aggregate collected (#3127 round-2 review), never the USD/EUR
      // read. `fallback_amount_sek` is 0 on this row because the row booked
      // a real SEK figure — priced rows are collected into neither bucket.
      expect(body.metrics.monthlyAgentSpendSek).toBeCloseTo(0, 10)
    })

    it('does NOT double-count a row migration 090 backfilled — the probe fixture, result 21 vs truth 10.5 pre-fix (#3127 round-2 review)', async () => {
      // The reviewer's probe: one confirmed row with a backfilled
      // `sek_value` of 10.5 and no booked USD/EUR. The pre-fix accumulator
      // collected the row's token amount through `fallback_amount` (whose
      // predicate never looks at `sek_value`), handed it to the fiat lookup,
      // and added the read's SEK on top of `sek_sum` — 21 where the truth is
      // 10.5. On the local dev DB this row shape is the common one after
      // migration 090 (117 of 657 confirmed intents backfilled, 18 carry
      // usd_value), and the suite stayed green with the probe present.
      fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0.1, eur: 0.09, sek: 10.5 })
      installQueryMock({
        paymentSpend: [
          { token_symbol: 'USDC', usd_sum: '0', eur_sum: '0', sek_sum: '10.5', fallback_amount: '1', fallback_amount_sek: '0' },
        ],
      })

      const body = (await getOverview()).json()

      expect(body.metrics.monthlyAgentSpendSek).toBeCloseTo(10.5, 10)
      // The USD/EUR re-price still runs for the same row — the buckets are
      // independent, the SEK half of the read is what may not land.
      expect(body.metrics.monthlyAgentSpendUsd).toBeCloseTo(0.1, 10)
      expect(body.metrics.monthlyAgentSpendEur).toBeCloseTo(0.09, 10)
    })

    it('prices SEK from its own bucket under the mirrored predicate — the A/B/C probe rows (#3195)', async () => {
      // The probe rows #3195 measured on a real DB, now as aggregate output
      // (what the mirrored SQL returns for them):
      //   A: booked sek 10.5, usd/eur NULL, amount 1  → fallback 1, sek 0
      //   B: sek NULL, booked usd 2 / eur 1.8, amt 2  → fallback 0, sek 2
      //   C: 0/0/0 booked, amount 4 (the zeroPrice() shape)
      //       → fallback 4, sek 4 under the MIRRORED predicate;
      //         sek 0 under the pre-#3195 NULL-only predicate.
      // Each bucket prices its own rows exactly once. One shared fiat answer
      // serves every read (the ratchet forbids positional mocks here): the
      // SEK figure each row contributes comes from the read its OWN bucket
      // triggered, which the call-count assertions below pin.
      fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0.1, eur: 0.09, sek: 1 })
      installQueryMock({
        paymentSpend: [
          { token_symbol: 'USDC', usd_sum: '0', eur_sum: '0', sek_sum: '10.5', fallback_amount: '1', fallback_amount_sek: '0' },
          { token_symbol: 'USDC', usd_sum: '2', eur_sum: '1.8', sek_sum: '0', fallback_amount: '0', fallback_amount_sek: '2' },
          { token_symbol: 'USDC', usd_sum: '0', eur_sum: '0', sek_sum: '0', fallback_amount: '4', fallback_amount_sek: '4' },
        ],
      })

      const body = (await getOverview()).json()

      // A: the USD/EUR re-price; B: the SEK re-price; C: BOTH (the mirror).
      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenCalledTimes(4)
      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenNthCalledWith(1, 'USDC', '1')
      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenNthCalledWith(2, 'USDC', '2')
      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenNthCalledWith(3, 'USDC', '4')
      expect(fiatMocks.getFiatValuesForTokenAmount).toHaveBeenNthCalledWith(4, 'USDC', '4')
      // C is what the asymmetry hid: under a NULL-only SEK predicate the
      // zero-booked row contributes 0 SEK (total 11.5) while USD/EUR still
      // re-price it — the SEK tile reads LOWER than USD for the same rows.
      expect(body.metrics.monthlyAgentSpendSek).toBeCloseTo(12.5, 10)
      expect(body.metrics.monthlyAgentSpendUsd).toBeCloseTo(2.2, 10)
      expect(body.metrics.monthlyAgentSpendEur).toBeCloseTo(1.98, 10)
      // This file mocks db.query, so it pins what the CALLER does with the
      // aggregate's columns; the row-C values here are only reachable if the
      // SQL produced them. The SQL-side mutation proof — reverting the
      // mirrored zero prong turns the db suite red — lives in
      // infra/repositories/__tests__/dashboard-monthly-spend.db.test.ts,
      // which executes the statement itself.
    })

    it('scopes the month-to-date aggregate to the authenticated user', async () => {
      installQueryMock({})

      await getOverview()

      const paymentSpend = mockQuery.mock.calls.find(
        ([sql]) =>
          String(sql).includes('GROUP BY token_symbol') &&
          String(sql).includes('FROM payment_intents'),
      )
      expect(paymentSpend?.[1]).toEqual(['user-1'])
      // #2055: there is no second (approval) aggregate to scope any more.
      expect(
        mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql))),
      ).toBe(false)
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
