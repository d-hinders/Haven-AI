/**
 * Data access for `rate_limit_counters` (#1680) — the cross-replica half of
 * the rate limiter.
 *
 * Convention: `README.md` in this directory. One deviation, deliberate and
 * load-bearing:
 *
 * **The increment is FAIL-OPEN.** An error returns `null` and the caller
 * degrades to its per-replica in-process count — the pre-#1680 behaviour —
 * rather than to an outage. That direction is not a coin toss: this table
 * guards the SIGNUP AND LOGIN routes, so a database hiccup that failed closed
 * would lock every user out of the product's front door, which is a far worse
 * outcome than briefly counting per replica again. Nothing here is authority;
 * it is a ceiling on automation.
 *
 * Note what fail-open covers and does not: a REJECTION is handled here, a
 * query that is slow but never settles is not. The caller bounds the call with
 * its own deadline for that, because neither the pool nor Fastify would.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

/**
 * Increment one bucket and return its state, in a single statement.
 *
 * Atomicity matters more here than anywhere else in this file: the whole
 * defect being fixed is separate replicas holding separate counts, so a
 * read-then-write would reintroduce it as a race between replicas instead of
 * as a design property. `ON CONFLICT DO UPDATE` takes a row lock, so
 * concurrent increments of the SAME key serialise; different keys never
 * contend.
 *
 * The `CASE` is the window roll: an expired row starts a fresh window rather
 * than being deleted and re-inserted, so an expired bucket and a brand-new one
 * take the identical path.
 */
export const INCREMENT_RATE_LIMIT_SQL = `INSERT INTO rate_limit_counters (key, count, expires_at)
     VALUES ($1, 1, NOW() + make_interval(secs => $2::double precision / 1000))
     ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN rate_limit_counters.expires_at <= NOW()
                         THEN 1
                         ELSE rate_limit_counters.count + 1 END,
            expires_at = CASE WHEN rate_limit_counters.expires_at <= NOW()
                              THEN NOW() + make_interval(secs => $2::double precision / 1000)
                              ELSE rate_limit_counters.expires_at END
     RETURNING count, GREATEST(0, EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::bigint AS ttl_ms`

/** Non-mutating peek, for the plugin's `{ increment: false }` path. */
export const READ_RATE_LIMIT_SQL = `SELECT count,
            GREATEST(0, EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000)::bigint AS ttl_ms
       FROM rate_limit_counters
      WHERE key = $1 AND expires_at > NOW()`

export const DELETE_EXPIRED_RATE_LIMITS_SQL =
  'DELETE FROM rate_limit_counters WHERE expires_at <= NOW()'

export interface RateLimitCount {
  /** Requests seen in the current window, across every replica. */
  current: number
  /** Milliseconds until the window ends. */
  ttl: number
}

function toCount(row: { count: number | string; ttl_ms: string | number } | undefined): RateLimitCount | null {
  if (!row) return null
  // `count` is INTEGER (a number from pg); ttl_ms is BIGINT (a string). Both
  // are far inside Number's safe range — a count is bounded by traffic in one
  // window and a ttl by the window itself.
  return { current: Number(row.count), ttl: Number(row.ttl_ms) }
}

/**
 * Count one request against `key`. Returns `null` when the database could not
 * answer — see the fail-open note in the file header.
 */
export async function incrementRateLimit(
  key: string,
  timeWindowMs: number,
  db: Executor = pool,
): Promise<RateLimitCount | null> {
  try {
    const result = await db.query<{ count: number; ttl_ms: string }>(
      INCREMENT_RATE_LIMIT_SQL,
      [key, timeWindowMs],
    )
    return toCount(result.rows[0])
  } catch {
    return null
  }
}

/** Read a bucket without counting against it. `null` on any failure. */
export async function readRateLimit(
  key: string,
  db: Executor = pool,
): Promise<RateLimitCount | null> {
  try {
    const result = await db.query<{ count: number; ttl_ms: string }>(READ_RATE_LIMIT_SQL, [key])
    // A key with no live row is a clean slate, not a failure — distinct from
    // the `null` an error returns, which means "could not tell".
    return toCount(result.rows[0]) ?? { current: 0, ttl: 0 }
  } catch {
    return null
  }
}

/**
 * Delete windows that have ended.
 *
 * Needed because nothing else removes rows: a key that is never seen again
 * would otherwise sit in the table forever, and the table is written by
 * unauthenticated traffic — so unbounded growth is reachable by anyone with a
 * script and a supply of source addresses. Returns the number deleted.
 *
 * One unbatched statement, deliberately. The table is UNLOGGED so the delete
 * writes no WAL, and its size tracks DISTINCT keys seen recently rather than
 * requests — a row is keyed by bucket and updated in place, so a flood from
 * one address is one row however many requests it sends. Batching would guard
 * against a scale this table cannot reach by construction.
 */
export async function deleteExpiredRateLimits(db: Executor = pool): Promise<number> {
  const result = await db.query(DELETE_EXPIRED_RATE_LIMITS_SQL)
  return result.rowCount ?? 0
}
