/**
 * Real-Postgres proof for migration 117 — `merchant_catalog.source` (#4245).
 * No mocks — #1219's rule.
 *
 * Pins:
 *   - a row written without the column reads `'operator'` (the default every
 *     existing writer relies on), including rows that predate the column;
 *   - the CHECK keeps the vocabulary closed: `'ingestion'` (a value the wire
 *     uses for a DIFFERENT table) and anything else are refused;
 *   - `up()` is idempotent and `down()` drops the column;
 *   - the discovery cron, end to end against the real table, writes
 *     `'bazaar'`, and the listing serializes that row as `source: 'bazaar'`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { CATALOG_ROW_WITH_MERCHANT_SELECT, type CatalogRowWithMerchant } from '../../../infra/repositories/merchants.js'
import type { CatalogRow } from '../../../modules/catalog/merchant-catalog.js'
import { ingestDiscoveredCatalog } from '../../../modules/catalog/catalog-discovery.js'
import { serialize } from '../../../routes/catalog.js'
import { down, up, version } from '../117_merchant_catalog_source.js'

async function seedMerchant(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name) VALUES ('m117-test-merchant', 'M117 test merchant')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  )
  return rows[0].id
}

/** An operator-style insert: names no `source`, exactly like every writer before 117. */
async function seedOperatorRow(merchantId: string, resourceUrl = 'https://operator.example/paid'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, price_atomic, asset, network, status, verified_at, merchant_id)
     VALUES ('Operator API', 'Curated.', 'api', $1, 'x402', 'http', NULL,
             '$0.01 USDC', '10000', 'USDC', 'eip155:8453', 'active', now(), $2)
     RETURNING id`,
    [resourceUrl, merchantId],
  )
  return rows[0].id
}

async function sourceOf(id: string): Promise<string> {
  const { rows } = await db.query<{ source: string }>(`SELECT source FROM merchant_catalog WHERE id = $1`, [id])
  return rows[0].source
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

describeDb('migration 117: merchant_catalog.source (#4245)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // #2616: this file hand-drives up()/down(); fail here rather than letting
  // the next file on this worker inherit an off-head schema.
  afterAll(assertWorkerSchemaAtHead)

  // Every test reads the column as THIS file's up() builds it, not as the
  // harness built the worker schema at init: an assertion about the
  // migration's DDL against an older build of it certifies nothing. A mutation
  // that widened the CHECK survived until this rebuild existed, and the
  // down/up test below then left the widened CHECK in the worker schema for
  // the next run. Rebuilding here also heals that.
  beforeEach(async () => {
    await resetDb()
    await down(db as never)
    await up(db as never)
  })

  it('names itself', () => {
    expect(version).toBe('117_merchant_catalog_source')
  })

  it('defaults a row written without the column to operator', async () => {
    const id = await seedOperatorRow(await seedMerchant())
    expect(await sourceOf(id)).toBe('operator')
  })

  it('refuses any value outside the closed vocabulary, including ingestion', async () => {
    const id = await seedOperatorRow(await seedMerchant())
    for (const value of ['ingestion', 'Bazaar', '']) {
      // Settled by hand so a write that SUCCEEDS fails the assertion below,
      // not a matcher plumbing error.
      const refusal = await db
        .query(`UPDATE merchant_catalog SET source = $1 WHERE id = $2`, [value, id])
        .then(
          () => null,
          (err: { code?: string }) => err,
        )
      expect(refusal?.code, value).toBe('23514')
    }
    await db.query(`UPDATE merchant_catalog SET source = 'bazaar' WHERE id = $1`, [id])
    expect(await sourceOf(id)).toBe('bazaar')
  })

  it('gives rows that predate the column operator, and down() drops it', async () => {
    const merchantId = await seedMerchant()
    await withMigrationReverted(
      () => down(db as never),
      async () => {
        const { rows: cols } = await db.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'merchant_catalog' AND column_name = 'source'`,
        )
        expect(cols).toHaveLength(0)

        const id = await seedOperatorRow(merchantId)
        await up(db as never)
        expect(await sourceOf(id)).toBe('operator')
        // Idempotent: a second up() is a no-op, not an error.
        await up(db as never)
        expect(await sourceOf(id)).toBe('operator')
      },
      () => up(db as never),
    )
  })

  it('discovery writes bazaar against the real table, and the listing says so', async () => {
    const operatorId = await seedOperatorRow(await seedMerchant())
    const discovered = 'https://seller-117.example/paid'
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/discovery/resources')) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            items: [{ resource: discovered, type: 'http', serviceName: 'Seller Data', description: 'Best data.', accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '20000', payTo: '0x' + '11'.repeat(20) }] }],
            pagination: { limit: 100, offset: 0, total: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(null, {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': b64({
            x402Version: 2,
            accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '20000', payTo: '0x' + '11'.repeat(20) }],
          }),
        },
      })
    }) as typeof fetch

    const result = await ingestDiscoveredCatalog(db, fetchStub, 100)
    expect(result.ingested).toBe(1)

    const { rows } = await db.query<CatalogRow & CatalogRowWithMerchant>(
      `${CATALOG_ROW_WITH_MERCHANT_SELECT} WHERE mc.resource_url = ANY($1::text[]) ORDER BY mc.name`,
      [[discovered, 'https://operator.example/paid']],
    )
    const byUrl = new Map(rows.map((r) => [r.resource_url, serialize(r)]))
    expect(byUrl.get(discovered)).toMatchObject({ source: 'bazaar', domain_verified: false, name: 'Seller Data' })
    expect(byUrl.get('https://operator.example/paid')).toMatchObject({ id: operatorId, source: 'operator' })
  })
})
