/**
 * Real-Postgres proof of the refresh run budget's rotation (#4300).
 *
 * A run that hits its budget leaves the rows it did not reach untouched: no
 * miss, no step toward `degraded`. Because rows are taken least recently
 * updated first, the next run starts with them. So two runs whose budget
 * covers about half the catalog probe every row exactly once. This rests on
 * `ORDER BY`, which only a real database executes.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { refreshCatalog, type QueryableLike } from '../merchant-catalog.js'

const ROWS = 6

async function seedRows(): Promise<string[]> {
  const { rows: merchant } = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name) VALUES ('rotation-merchant', 'Rotation merchant') RETURNING id`,
  )
  const urls: string[] = []
  for (let i = 0; i < ROWS; i += 1) {
    const url = `https://rotation${i}.example/paid`
    urls.push(url)
    // Row 0 is the least recently updated, row 5 the most recent.
    await db.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name,
          price_display, price_atomic, asset, network, status, verified_at, merchant_id, updated_at)
       VALUES ($1, 'Rotation row.', 'api', $2, 'x402', 'http', NULL,
               '0.01 USDC', '10000', 'USDC', 'eip155:8453', 'active', now(), $3,
               now() - interval '2 hours' + ($4::int * interval '1 minute'))`,
      [`Rotation ${i}`, url, merchant[0]!.id, i],
    )
  }
  return urls
}

async function failuresByUrl(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ resource_url: string; consecutive_failures: number }>(
    `SELECT resource_url, consecutive_failures FROM merchant_catalog`,
  )
  return Object.fromEntries(rows.map((r) => [r.resource_url, r.consecutive_failures]))
}

describeDb('refresh run budget rotation (#4300)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('probes every row exactly once over two half-budget runs, and counts no skipped row as a miss', async () => {
    const urls = await seedRows()
    let clock = 0
    const probed: string[] = []
    // Every probe misses, so a probed row shows consecutive_failures = 1 and an
    // unprobed one 0. A skipped row counted as a miss would show up as 1 too early.
    const fetchImpl = (async (input: string | URL | Request) => {
      probed.push(String(input))
      clock += 10
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch
    const options = { runBudgetMs: 35, probeBudgetMs: 10, now: () => clock }

    const first = await refreshCatalog(db as unknown as QueryableLike, fetchImpl, options)
    expect(first).toEqual({ verified: 0, degraded: 0, deferred: 3 })
    expect(probed).toEqual(urls.slice(0, 3))
    const afterFirst = await failuresByUrl()
    for (const url of urls.slice(0, 3)) expect(afterFirst[url], url).toBe(1)
    for (const url of urls.slice(3)) expect(afterFirst[url], url).toBe(0)

    const second = await refreshCatalog(db as unknown as QueryableLike, fetchImpl, options)
    expect(second).toEqual({ verified: 0, degraded: 0, deferred: 3 })
    expect(probed).toEqual([...urls.slice(0, 3), ...urls.slice(3)])
    const afterSecond = await failuresByUrl()
    for (const url of urls) expect(afterSecond[url], url).toBe(1)
  })

  it('keeps rotating past a row whose 402 the probe cannot parse, and records that row as a miss', async () => {
    const urls = await seedRows()
    const probed: string[] = []
    // The oldest row answers a 402 whose `amount` is a number, not a string:
    // parsing it throws. Every other row answers a well-formed challenge.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      probed.push(url)
      const body = url === urls[0]
        ? { accepts: [{ amount: 1000 }] }
        : { accepts: [{ amount: '20000', asset: 'USDC', network: 'eip155:8453', payTo: '0x00000000000000000000000000000000000000aa' }] }
      return new Response(JSON.stringify(body), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    for (let run = 0; run < 2; run += 1) {
      // An escaping throw is caught into the result, so it fails the assertion below.
      const result = await refreshCatalog(db as unknown as QueryableLike, fetchImpl).catch((err: unknown) => ({ threw: String(err) }))
      expect(result, `run ${run}`).toEqual({ verified: ROWS - 1, degraded: 0, deferred: 0 })
    }
    // Both runs reached every row, the unparsable one included. The second
    // run's order depends on write timestamps, so only its set is pinned.
    expect(probed.slice(0, ROWS)).toEqual(urls)
    expect([...probed.slice(ROWS)].sort()).toEqual([...urls].sort())
    const failures = await failuresByUrl()
    expect(failures[urls[0]!]).toBe(2)
    for (const url of urls.slice(1)) expect(failures[url], url).toBe(0)
  })
})
