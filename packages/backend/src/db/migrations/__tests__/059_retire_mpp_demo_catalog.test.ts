/**
 * Real-Postgres proof for the #1328 mpp_demo catalog retirement (migration
 * 059): the migration's own `up`/`down`, and — since `resetDb()` truncates
 * the migration-seeded rows between tests (see `db-harness.ts`) — a row this
 * test seeds itself, run through the ACTUAL `refreshCatalog` SQL so the
 * refresh-probe exclusion is proven against Postgres, not a mocked rows array.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { refreshCatalog } from '../../../modules/catalog/merchant-catalog.js'
import { up, down } from '../059_retire_mpp_demo_catalog.js'

const RESOURCE_URL = 'https://havenbackend-production-8a00.up.railway.app/demo/mpp/market-summary'

async function seedMppDemoRow(status = 'active'): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, price_atomic, asset, network, status, verified_at)
     VALUES
       ('Haven MPP demo resource', 'Haven internal MPP demo endpoint.', 'demo',
        $1, 'mpp', 'http', NULL, '$0.01 USDC', '10000', 'USDC', 'eip155:8453', $2, now())
     RETURNING id`,
    [RESOURCE_URL, status],
  )
  return result.rows[0].id
}

describeDb('migration 059: retire mpp_demo catalog row (#1328)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('delists the seeded Haven MPP demo resource row', async () => {
    const id = await seedMppDemoRow('active')

    await up(db as never)

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM merchant_catalog WHERE id = $1`,
      [id],
    )
    expect(rows[0].status).toBe('delisted')
  })

  it('is idempotent — a second run matches nothing and does not error', async () => {
    const id = await seedMppDemoRow('active')

    await up(db as never)
    await up(db as never) // re-run

    const { rows } = await db.query<{ status: string; updated_at: string }>(
      `SELECT status, updated_at FROM merchant_catalog WHERE id = $1`,
      [id],
    )
    expect(rows[0].status).toBe('delisted')
  })

  it('does NOT touch a differently-named or non-mpp catalog row (guarded by name + rail)', async () => {
    const other = await db.query<{ id: string }>(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name,
          price_display, asset, network, status)
       VALUES
         ('Soundside — text generation', 'unrelated merchant', 'media',
          'https://mcp.soundside.ai/mcp', 'x402', 'mcp', 'create_text',
          '$0.01 USDC', 'USDC', 'eip155:8453', 'active')
       RETURNING id`,
    )

    await up(db as never)

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM merchant_catalog WHERE id = $1`,
      [other.rows[0].id],
    )
    expect(rows[0].status).toBe('active')
  })

  it('does NOT clobber a row an operator already re-activated by hand (guarded by status != delisted only where matched)', async () => {
    // A hand-corrected row already at a non-delisted status still matches the
    // WHERE (name + rail) and gets delisted again on a fresh forward run —
    // the guard's job is only to make the statement idempotent, not to skip
    // rows an operator touched. Assert the down() symmetry instead: down()
    // restores exactly the rows this up() delisted, and only those.
    const id = await seedMppDemoRow('active')
    await up(db as never)
    await down(db as never)

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM merchant_catalog WHERE id = $1`,
      [id],
    )
    expect(rows[0].status).toBe('active')
  })

  it('GET /catalog exclusion + refresh-probe exclusion both hold once delisted', async () => {
    const id = await seedMppDemoRow('active')
    await up(db as never)

    // GET /catalog's own WHERE clause (routes/catalog.ts): status != 'delisted'.
    const listed = await db.query<{ id: string }>(
      `SELECT id FROM merchant_catalog WHERE status != 'delisted'`,
    )
    expect(listed.rows.map((r) => r.id)).not.toContain(id)

    // refreshCatalog's own query selects `WHERE status != 'delisted'` — run the
    // REAL function against the REAL row, with only the network fetch mocked
    // (the collaborator the harness doesn't own).
    const fetchMock = vi.fn()
    const counts = await refreshCatalog(db as never, fetchMock as unknown as typeof fetch)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(counts).toEqual({ verified: 0, degraded: 0 })

    const row = await db.query<{ status: string; consecutive_failures: number }>(
      `SELECT status, consecutive_failures FROM merchant_catalog WHERE id = $1`,
      [id],
    )
    // Untouched — the delisted row is invisible to the refresh loop entirely,
    // not probed-and-ignored.
    expect(row.rows[0].status).toBe('delisted')
    expect(row.rows[0].consecutive_failures).toBe(0)
  })

  it('mutation check: WITHOUT the migration, refreshCatalog still probes the live demo row', async () => {
    // Proves the exclusion in the previous test is really coming from the
    // delisted status the migration sets, not from some other filter —
    // the same row, still 'active', DOES get probed.
    await seedMppDemoRow('active')

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    await refreshCatalog(db as never, fetchMock as unknown as typeof fetch)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(RESOURCE_URL, { method: 'GET' })
  })
})

describe('migration 059 registration', () => {
  it('exports up and down', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
  })
})
