import pool from '../../db.js'
import { redactVendorSecrets } from '../../domain/redact-vendor-secrets.js'
import type { Executor } from '../transaction.js'

export type { Executor }

/**
 * Data access for `feedback` (#3597) — the CLI's `haven feedback submit`
 * channel.
 *
 * Retention is 7 days (owner decision, 2026-10-02): `expires_at` defaults at
 * insert time (migration 106), every read here filters `expires_at > NOW()`
 * so the 7 days hold even if the purge lags, and `deleteExpiredFeedback`
 * mirrors `deleteExpiredRateLimits`
 * (`infra/repositories/rate-limit-counters.ts`) — wired in `index.ts` through
 * `runIfLeader` under its own `LEADER_LOCK_KEYS` entry, never on an interval
 * of its own.
 */

export interface FeedbackRow {
  id: string
  user_id: string
  text: string
  created_at: string
  expires_at: string
}

export const INSERT_FEEDBACK_SQL = `
  INSERT INTO feedback (user_id, text)
  VALUES ($1, $2)
  RETURNING id, user_id, text, created_at, expires_at`

/**
 * Write one feedback row. `redactVendorSecrets` runs here, at the write
 * boundary — the same place `markOutboundTxFailed` applies it — so a vendor
 * credential that slipped past every upstream check (CLI layers 1-4, the
 * route's layers 1/3/4 re-run) is still never stored verbatim. It is a
 * backstop, not the control: the route refuses before this function is ever
 * called when its own checks catch something.
 */
export async function insertFeedback(
  userId: string,
  text: string,
  db: Executor = pool,
): Promise<FeedbackRow> {
  const result = await db.query<FeedbackRow>(INSERT_FEEDBACK_SQL, [
    userId,
    redactVendorSecrets(text),
  ])
  return result.rows[0]
}

/**
 * Read one row, UNEXPIRED. The only reader today is the repository's own
 * test; the ops console's masked read (#3602, epic #3507) will call a read
 * like this one rather than inventing its own, so the expiry filter lives in
 * exactly one place.
 */
export async function findFeedbackById(
  id: string,
  db: Executor = pool,
): Promise<FeedbackRow | null> {
  const result = await db.query<FeedbackRow>(
    `SELECT id, user_id, text, created_at, expires_at
       FROM feedback
      WHERE id = $1 AND expires_at > NOW()`,
    [id],
  )
  return result.rows[0] ?? null
}

export const IS_KEY_BACKED_ADDRESS_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM agents WHERE lower(delegate_address) = lower($1)
    UNION ALL
    SELECT 1 FROM smart_accounts WHERE lower(owner_address) = lower($1)
  ) AS found`

/**
 * Layer 3's database backstop (#3597): is `address` ANY agent's
 * `delegate_address`, or any Hybrid DeleGator's `owner_address` — system-wide,
 * not scoped to the caller. A private key reaching Haven is a custody
 * problem regardless of whose account it belongs to, so the backstop is
 * deliberately broader than the CLI's own check (which can only read the
 * caller's own agents and accounts).
 */
export async function isKeyBackedAddress(address: string, db: Executor = pool): Promise<boolean> {
  const result = await db.query<{ found: boolean }>(IS_KEY_BACKED_ADDRESS_SQL, [address])
  return result.rows[0]?.found ?? false
}

/**
 * Drop expired rows. Mirrors `deleteExpiredRateLimits` exactly: one
 * unbatched statement, because this table's growth tracks feedback
 * submissions (bounded by a per-user rate limit) rather than unauthenticated
 * traffic. Returns the number deleted.
 */
export async function deleteExpiredFeedback(db: Executor = pool): Promise<number> {
  const result = await db.query('DELETE FROM feedback WHERE expires_at <= NOW()')
  return result.rowCount ?? 0
}
