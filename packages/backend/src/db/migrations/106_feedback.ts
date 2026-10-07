import type { PoolClient } from 'pg'

/**
 * 106 — CLI feedback channel (#3597).
 *
 * `haven feedback submit "<text>"` writes one row here. Retention is **7
 * days to start with** (owner decision, 2026-10-02): `expires_at` defaults to
 * `now() + interval '7 days'` at insert time, and the discipline is the same
 * one `rate_limit_counters` and `device_authorizations` already use — every
 * READ filters `expires_at > now()` (so the 7 days hold even if the sweep
 * lags), and a leader-gated interval purge
 * (`infra/repositories/feedback.ts#deleteExpiredFeedback`, wired in
 * `index.ts` through `runIfLeader` under its own `LEADER_LOCK_KEYS` entry)
 * removes expired rows so the table does not grow forever.
 *
 * `id` is a UUID because the ops console's reveal route keys on `target_id`
 * (#3602, a slice of epic #3507) — that reader is a SEPARATE issue and reads
 * through its own column-level grant, never through this migration.
 *
 * The text stored here has already been through `redactVendorSecrets`
 * (`domain/redact-vendor-secrets.ts`) at the repository's write boundary, and
 * through the route's own re-run of the CLI's secret-check layers 1/3/4
 * before that — this migration only shapes the table, it enforces nothing.
 */
export const version = '106_feedback'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
    )
  `)
  // Every read filters on expiry (`expires_at > NOW()`); this index is what
  // keeps that filter — and the purge's own DELETE — off a sequential scan as
  // the table grows.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_expires_at
      ON feedback (expires_at)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_user_created_at
      ON feedback (user_id, created_at DESC)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS feedback`)
}
