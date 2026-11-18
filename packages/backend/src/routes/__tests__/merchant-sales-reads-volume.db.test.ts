/**
 * The totals read at volume, on the real database (#4897, epic #4885).
 *
 * Criterion: "the totals read answers within a stated time for an account with
 * 100,000 sales". One merchant account gets 100,000 sales, each with its
 * indexed transfer (and 20,000 payments with no sale record, and 10,000 own
 * moves beside them), seeded with ONE `INSERT ... SELECT generate_series` per
 * table; the summary read over the whole span is timed through the route.
 *
 * The stated times are `SUMMARY_ALL_BUDGET_MS` and `SUMMARY_MONTH_BUDGET_MS`.
 * The figures measured on the author's laptop are in the PR report; each budget
 * is deliberately about 2.5 to 6 times the measurement, so a slow CI runner does
 * not flake it. The test also seeds 200,000 transfers of OTHER accounts, which
 * migration 132's index lets a one-month read skip.
 *
 * It seeds ~330k rows, so it is kept out of the default run: it runs when
 * `HAVEN_VOLUME_TESTS=1` is set
 * (`HAVEN_VOLUME_TESTS=1 npx vitest run src/routes/__tests__/merchant-sales-reads-volume.db.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const merchantSalesReadRoutes = (await import('../merchant-sales-reads.js')).default

const CHAIN = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

/**
 * The stated times. The whole history of an account with 100,000 sales (a
 * year, here) answers within 3 s; one month of it within 1 s. Measured on the
 * author's laptop with the real database: about 1.2 s and 0.15 s.
 */
const SUMMARY_ALL_BUDGET_MS = 3000
const SUMMARY_MONTH_BUDGET_MS = 1000

const volume = process.env.HAVEN_VOLUME_TESTS === '1'
const suite = volume ? describeDb : describeDb.skip

suite('the summary at 100,000 sales (#4897)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(merchantSalesReadRoutes, { prefix: '/merchant-sales' })
  })
  afterAll(async () => {
    await app?.close()
    // 330k rows must not outlive the test in the worker's schema.
    await resetDb()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('answers the totals read over 100,000 sales within the stated time', async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`volume-${randomUUID()}@test.example`],
    )
    const userId = user.rows[0].id
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, is_merchant_account)
       VALUES ($1, '0x' || md5('volume'), $2, 'delegation', 'delegator_hybrid', false, true) RETURNING id`,
      [userId, CHAIN],
    )
    const accountId = account.rows[0].id
    await db.query(`INSERT INTO merchant_service_settings (user_id, enabled, enabled_at) VALUES ($1, true, NOW())`, [userId])
    // a second merchant-like account whose transfers the read must skip
    const other = await db.query<{ id: string; user_id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
       VALUES ($1, '0x' || md5('other'), $2, 'delegation', 'delegator_hybrid', true) RETURNING id, user_id`,
      [userId, CHAIN],
    )

    const seedStart = Date.now()
    // 130,000 transfers into the merchant account: 100,000 carry a sale, 20,000
    // do not, 10,000 are own moves. Payers: 5,000 distinct wallets. Spread over
    // 365 days. Each transfer is its own transaction.
    await db.query(
      `INSERT INTO inbound_transfers
         (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
          amount_raw, block_number, block_time, sender_is_own_address)
       SELECT $1, $2, $3,
              '0x' || lpad(to_hex(g), 64, '0'),
              0,
              '0x' || lpad(to_hex(g % 5000), 40, '0'),
              $4,
              (1000000 + (g % 97) * 1000)::text,
              g,
              TIMESTAMPTZ '2026-01-01T00:00:00Z' + (g * 242 || ' seconds')::interval,
              g > 120000
         FROM generate_series(1, 130000) AS g`,
      [accountId, userId, CHAIN, USDC],
    )
    await db.query(
      `INSERT INTO merchant_sales
         (account_id, user_id, chain_id, tx_hash, product_id, product_name, merchant_reference,
          amount_raw, token_address, payer_address, block_number, block_time)
       SELECT account_id, user_id, chain_id, tx_hash,
              'product-' || (block_number % 40), 'Product ' || (block_number % 40),
              'ref-' || block_number, amount_raw::numeric, token_address, payer_address,
              block_number, block_time
         FROM inbound_transfers
        WHERE account_id = $1 AND block_number <= 100000`,
      [accountId],
    )
    // 200,000 transfers of another account: noise the read must not scan.
    await db.query(
      `INSERT INTO inbound_transfers
         (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
          amount_raw, block_number, block_time)
       SELECT $1, $2, $3, '0x' || lpad(to_hex(g + 10000000), 64, '0'), 0,
              '0x' || lpad(to_hex(g % 7000), 40, '0'), $4, '1000000', g,
              TIMESTAMPTZ '2026-01-01T00:00:00Z' + (g * 150 || ' seconds')::interval
         FROM generate_series(1, 200000) AS g`,
      [other.rows[0].id, userId, CHAIN, USDC],
    )
    await db.query('ANALYZE inbound_transfers')
    await db.query('ANALYZE merchant_sales')
    const seedMs = Date.now() - seedStart

    const headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'owner@example.com' })}` }
    const timed: number[] = []
    let body: { sales: number; revenue_raw: string } | null = null
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now()
      const res = await app.inject({ method: 'GET', url: '/merchant-sales/summary?from=2026-01-01&to=2026-12-31', headers })
      timed.push(Math.round(performance.now() - start))
      expect(res.statusCode, res.body).toBe(200)
      body = res.json()
    }
    const monthStart = performance.now()
    const month = await app.inject({ method: 'GET', url: '/merchant-sales/summary?from=2026-06-01&to=2026-06-30', headers })
    const monthMs = Math.round(performance.now() - monthStart)
    expect(month.statusCode).toBe(200)
    const pageStart = performance.now()
    const page = await app.inject({ method: 'GET', url: '/merchant-sales/payments?from=2026-01-01&to=2026-12-31&limit=50', headers })
    const pageMs = Math.round(performance.now() - pageStart)
    expect(page.statusCode).toBe(200)

    // eslint-disable-next-line no-console
    console.log(`[volume] seeded in ${seedMs} ms; whole-history summary reads (ms): ${timed.join(', ')}; one-month summary: ${monthMs} ms; first list page (whole history): ${pageMs} ms`)
    expect(body?.sales).toBe(100000)
    // the budget is on the slowest of the three reads, the first included
    expect(Math.max(...timed)).toBeLessThan(SUMMARY_ALL_BUDGET_MS)
    expect(monthMs).toBeLessThan(SUMMARY_MONTH_BUDGET_MS)
  }, 120_000)
})
