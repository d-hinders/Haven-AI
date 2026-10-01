import type { PoolClient } from 'pg'

/**
 * 104 — ops console access log (#3509, epic #3507 invariant 6).
 *
 * One row per ops sign-in (allowed or refused), search, detail view and
 * reveal. It is written through the MAIN pool before the response is sent,
 * and a failed insert fails the request: the ops console never shows data it
 * could not record showing. The read-only ops role (#3510) is never granted
 * this table.
 *
 * Who: `operator_github_id` is GitHub's immutable numeric id (the allowlist
 * key); `operator_login` is the login at the time, for humans reading the log
 * — a login can be renamed, so it is never authority.
 *
 * What: `action` is a closed set (CHECK). `target_type` / `target_id` name
 * the record looked at, `field` the revealed column, and `detail` carries a
 * MASKED search term — never the raw query, which may be a customer's email.
 *
 * Retention (12 months, epic #3507) is not enforced here; it is an operator
 * decision when prod is configured.
 */
export const version = '104_ops_access_log'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ops_access_log (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_github_id  BIGINT NOT NULL,
      operator_login      TEXT NOT NULL,
      action              TEXT NOT NULL
        CHECK (action IN ('sign_in', 'sign_in_denied', 'view', 'search', 'reveal')),
      target_type         TEXT,
      target_id           TEXT,
      field               TEXT,
      detail              TEXT,
      request_id          TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ops_access_log_created_at
      ON ops_access_log (created_at DESC)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_ops_access_log_operator
      ON ops_access_log (operator_github_id, created_at DESC)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ops_access_log`)
}
