/**
 * Real-Postgres proof for the #1592 price_display normalization (migration
 * 062): seeded `'$0.0015 USDC'`-shaped rows lose the `$` prefix, an
 * already-normalized row is untouched, and a re-run matches nothing — all
 * proven against the actual UPDATE SQL per the #1219 testing strategy, not a
 * mocked rows array.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down } from '../062_normalize_price_display.js'

async function seedRow(priceDisplay: string | null, suffix: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, price_atomic, asset, network, status)
     VALUES
       ('Row ' || $2, 'seeded by 062 test', 'demo', 'https://m.example/' || $2,
        'x402', 'http', NULL, $1, '1500', 'USDC', 'eip155:84532', 'active')
     RETURNING id`,
    [priceDisplay, suffix],
  )
  return result.rows[0].id
}

async function readDisplay(id: string): Promise<string | null> {
  const { rows } = await db.query<{ price_display: string | null }>(
    `SELECT price_display FROM merchant_catalog WHERE id = $1`,
    [id],
  )
  return rows[0].price_display
}

describeDb('migration 062: normalize price_display (#1592)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('strips the $ prefix from seeded $-prefixed USDC rows', async () => {
    const a = await seedRow('$0.0015 USDC', 'a')
    const b = await seedRow('$0.01 USDC', 'b')

    await up(db as never)

    expect(await readDisplay(a)).toBe('0.0015 USDC')
    expect(await readDisplay(b)).toBe('0.01 USDC')
  })

  it('leaves an already-normalized row untouched (updated_at proves no write)', async () => {
    const id = await seedRow('0.0015 USDC', 'norm')
    const before = await db.query<{ updated_at: string }>(
      `SELECT updated_at FROM merchant_catalog WHERE id = $1`,
      [id],
    )

    await up(db as never)

    const after = await db.query<{ updated_at: string; price_display: string }>(
      `SELECT updated_at, price_display FROM merchant_catalog WHERE id = $1`,
      [id],
    )
    expect(after.rows[0].price_display).toBe('0.0015 USDC')
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at)
  })

  it('is idempotent — a second run matches nothing', async () => {
    const id = await seedRow('$0.004 USDC', 'idem')

    await up(db as never)
    await up(db as never) // re-run

    expect(await readDisplay(id)).toBe('0.004 USDC')
  })

  it('does not touch NULL or non-USDC-suffixed displays', async () => {
    const nullRow = await seedRow(null, 'null')
    // A hypothetical genuinely-USD display keeps its prefix — the migration
    // is scoped to the exact seeded `$… USDC` double-statement shape.
    const usd = await seedRow('$0.50 USD', 'usd')

    await up(db as never)

    expect(await readDisplay(nullRow)).toBeNull()
    expect(await readDisplay(usd)).toBe('$0.50 USD')
  })

  it('down restores the $ prefix on normalized USDC rows only', async () => {
    const id = await seedRow('$0.0015 USDC', 'down')
    await up(db as never)
    expect(await readDisplay(id)).toBe('0.0015 USDC')

    await down(db as never)

    expect(await readDisplay(id)).toBe('$0.0015 USDC')
  })
})
