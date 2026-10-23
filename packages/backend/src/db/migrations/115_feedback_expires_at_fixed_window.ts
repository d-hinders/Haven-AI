import type { PoolClient } from 'pg'

export const version = '115_feedback_expires_at_fixed_window'

/**
 * #4084 — the feedback retention window is 168 hours in every time zone.
 *
 * Migration 106 declared `expires_at DEFAULT NOW() + INTERVAL '7 days'`. For
 * `timestamptz + interval`, Postgres adds the `days` field as CALENDAR days in
 * the session `TimeZone`: in a UTC session that is exactly 168 h, but in a
 * `Europe/Stockholm` session a row written within a week before a DST change
 * expires after 167 h or 169 h. The backend never pins the session
 * `TimeZone` (`db.ts` builds its pool with no `options`), so the window
 * production got depended on server/database/role configuration outside this
 * repo — and the 7-day retention is an owner decision (2026-10-02, #3597),
 * not a property of wherever the database happens to run. The symptom was
 * `106_feedback.test.ts` failing locally (a Stockholm-zoned Postgres) on
 * 2026-10-19 with 7 days + 1 hour, while CI (UTC) stayed green.
 *
 * An hours-only interval is pure elapsed time, so `NOW() + INTERVAL '168
 * hours'` is the same instant whatever the session zone. 106 is applied in
 * production and is not edited; this migration only moves the default.
 * Existing rows keep the `expires_at` they were written with — at most one
 * hour off, and only rows written in a non-UTC session — and the purge and
 * the `expires_at > NOW()` reads are unchanged.
 *
 * `down()` restores 106's default exactly.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE feedback
      ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '168 hours'
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE feedback
      ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '7 days'
  `)
}
