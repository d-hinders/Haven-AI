import type { PoolClient } from 'pg'

export const version = '025_catalog_consecutive_failures'

/**
 * Hysteresis for catalog availability.
 *
 * Previously a single failed verification probe flipped an entry straight to
 * `degraded`, so one transient miss (a cold start, a flaky network, or an MCP
 * server that wants an `initialize` before `tools/call`) lit up a scary
 * low-availability warning across the catalog. Track consecutive failures so an
 * entry only degrades after several misses in a row and recovers immediately on
 * the next success.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog DROP COLUMN IF EXISTS consecutive_failures
  `)
}
