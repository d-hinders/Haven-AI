import type { PoolClient } from 'pg'

export const version = '068_catalog_lifecycle'

/**
 * Catalogue ingestion lifecycle columns (epic #1717, #1714).
 *
 * Keeps ONLY current-state + `last_verified_at` — no append-only probe
 * history, no stored 402 bodies (the epic's pointer-shaped storage rule).
 * Statuses already cover the lifecycle (submitted → ownership_verified →
 * verified_payable | failed | delisted, migration 066); this migration adds
 * the fields lifecycle (#1714) needs to run a bounded pipeline:
 *
 *   - `consecutive_failures`  — streak of failed probes; the row degrades to
 *     `failed` after the module's threshold instead of churning forever.
 *   - `last_verified_at`      — when the row last passed a probe. The
 *     re-verification cadence selects rows on this column.
 *   - `failed_at`             — when the row entered `failed`, the anchor for
 *     the terminal retention TTL. `delisted` rows use `updated_at` instead
 *     (never touch failed_at for non-failed rows).
 *   - `name` / `description` / `entrypoint` — the pointer metadata a real
 *     x402 quote yields (probe.ts `ProbeMetadata`). Display fields for the
 *     future directory surface; deliberately NOT prices or 402 bodies.
 *
 * The two indexes are the reasons "table size provably bounded" holds: the
 * re-verify selection and the terminal purge each scan by (status, <anchor>)
 * and the partial unique index from migration 066 already caps non-terminal
 * rows per hostname.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE catalog_submissions
      ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS name TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS entrypoint TEXT;

    CREATE INDEX IF NOT EXISTS idx_catalog_submissions_status_last_verified
      ON catalog_submissions(status, last_verified_at);

    CREATE INDEX IF NOT EXISTS idx_catalog_submissions_status_updated
      ON catalog_submissions(status, updated_at);
  `)
}

/** Structural down (#1139): additive columns only — no data survives. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE catalog_submissions
      DROP COLUMN IF EXISTS last_verified_at,
      DROP COLUMN IF EXISTS consecutive_failures,
      DROP COLUMN IF EXISTS failed_at,
      DROP COLUMN IF EXISTS name,
      DROP COLUMN IF EXISTS description,
      DROP COLUMN IF EXISTS entrypoint;

    DROP INDEX IF EXISTS idx_catalog_submissions_status_last_verified;
    DROP INDEX IF EXISTS idx_catalog_submissions_status_updated;
  `)
}
