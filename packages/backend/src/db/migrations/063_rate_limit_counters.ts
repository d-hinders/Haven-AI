import type { PoolClient } from 'pg'

export const version = '063_rate_limit_counters'

/**
 * Cross-replica rate-limit counters (#1680).
 *
 * `@fastify/rate-limit`'s default store is an in-process LRU, so every replica
 * counted only the requests that happened to land on it: the effective ceiling
 * was `max × replicas`, and it rose exactly when load did. Live probing of the
 * dev deployment read `x-ratelimit-remaining` back as two interleaved
 * descending series — the defect made visible.
 *
 * One row per bucket key, holding the count and when the window ends. The
 * primary key IS the bucket key, so the increment is a single upsert and
 * Postgres serialises concurrent writers on the row.
 *
 * UNLOGGED, deliberately: these rows are throwaway counters with a lifetime of
 * one time window, and skipping WAL keeps an unauthenticated request cheap.
 * The cost is that the table is truncated by crash recovery — which loses at
 * most one window of counts and cannot corrupt anything, because nothing reads
 * this table for authority. The same fail-open reasoning as
 * `allowance_nonce_watermarks` (#718): a database problem degrades this to the
 * pre-#1680 per-replica behaviour, never to an outage on the front door.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_counters (
      key        TEXT PRIMARY KEY,
      count      INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `)

  // The sweep deletes by expiry; without this it seq-scans a table whose whole
  // point is to be hit on every unauthenticated request.
  await client.query(`
    CREATE INDEX IF NOT EXISTS rate_limit_counters_expires_at_idx
      ON rate_limit_counters (expires_at)
  `)
}

/** Drops the table outright — it holds nothing worth keeping past a window. */
export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS rate_limit_counters')
}
