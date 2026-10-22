import type { PoolClient } from 'pg'

export const version = '117_merchant_catalog_source'

/**
 * #4245 — record where a `merchant_catalog` row came from.
 *
 * Two writers insert into this table: operators (migrations and scripts) and,
 * when `CATALOG_DISCOVERY_ENABLED` is on, the hourly Bazaar discovery cron
 * (`modules/catalog/catalog-discovery.ts`). Nothing told their rows apart, so
 * `GET /catalog` labelled every row `source: 'operator'` — a third party's
 * self-chosen name and description reached agents as operator-curated and
 * passed the SDK's `verified: 'operator'` provenance filter.
 *
 * `source` is that fact: `'operator'` (the default, so every existing writer
 * keeps meaning what it meant) or `'bazaar'`, which the discovery cron now
 * writes. The inline CHECK keeps the vocabulary closed; adding a writer means
 * adding its value here, deliberately.
 *
 * No backfill. Discovery rows carry nothing that distinguishes them from an
 * operator row deterministically, so existing rows keep `'operator'`; whether
 * any environment ever ran discovery, and what to do about its rows, is an
 * owner decision recorded on the PR, not a heuristic in this migration.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'operator'
        CHECK (source IN ('operator', 'bazaar'))
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog DROP COLUMN IF EXISTS source
  `)
}
