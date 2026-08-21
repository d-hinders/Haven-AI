/**
 * Real-Postgres proof for the #1669 fixture labelling (migration 064): the
 * Minifetch row gains the unmissable marker in all three places an agent or a
 * client could look, a re-run is a no-op in effect, and — the part that keeps
 * the label alive — refreshCatalog's success UPDATE does not touch it.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up } from '../064_label_stranding_fixture.js'

const FIXTURE_URL = 'https://minifetch.com/api/v1/x402/extract/url-preview'

async function seedMinifetch(): Promise<string> {
  // The 035 seed shape, as the row exists in an environment that has not run 064.
  const result = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, price_atomic, asset, network, status)
     VALUES
       ('Minifetch — URL preview',
        'Extract link-preview / Open Graph metadata for a URL. Pay per call.',
        'data', $1, 'x402', 'http', NULL, '0.001 USDC', '1000', 'USDC', 'eip155:8453', 'active')
     RETURNING id`,
    [FIXTURE_URL],
  )
  return result.rows[0].id
}

async function readRow(id: string) {
  const { rows } = await db.query<{ name: string; description: string; category: string }>(
    `SELECT name, description, category FROM merchant_catalog WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describeDb('migration 064: label the stranding fixture (#1669)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('marks the row in name, description AND category — prose for agents, the flag for clients', async () => {
    const id = await seedMinifetch()

    await up(db as never)

    const row = await readRow(id)
    expect(row.name).toContain('TEST FIXTURE: strands funds')
    expect(row.description).toMatch(/Do not expect delivery/)
    expect(row.description).toMatch(/never settles/)
    expect(row.category).toBe('test-fixture')
  })

  it('a re-run writes the same values — idempotent like every migration here', async () => {
    const id = await seedMinifetch()
    await up(db as never)
    const first = await readRow(id)

    await up(db as never)

    expect(await readRow(id)).toEqual(first)
  })

  it('MUTATION-RELEVANT: no other catalog row is touched', async () => {
    const id = await seedMinifetch()
    const other = await db.query<{ id: string }>(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name,
          price_display, price_atomic, asset, network, status)
       VALUES ('Real service', 'Delivers.', 'data', 'https://real.example/x402',
               'x402', 'http', NULL, '0.01 USDC', '10000', 'USDC', 'eip155:8453', 'active')
       RETURNING id`,
    )

    await up(db as never)

    expect((await readRow(id)).category).toBe('test-fixture')
    expect((await readRow(other.rows[0].id)).category).toBe('data')
  })

  it('refreshCatalog leaves the label alone — the property that keeps it alive', async () => {
    // The refresh success-path UPDATE writes price/status fields only. If it
    // ever grew a name/description write, the label would silently revert on
    // the next hourly tick — asserted here against the SQL itself rather
    // than trusted to a comment.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../../modules/catalog/merchant-catalog.ts', import.meta.url),
      'utf8',
    )
    const successUpdate = src.slice(src.indexOf('Success always recovers'), src.indexOf('Hysteresis'))
    expect(successUpdate).toMatch(/SET price_atomic/)
    expect(successUpdate).not.toMatch(/SET[^;]*\bname\b/)
    expect(successUpdate).not.toMatch(/description/)
    expect(successUpdate).not.toMatch(/category/)
  })
})
