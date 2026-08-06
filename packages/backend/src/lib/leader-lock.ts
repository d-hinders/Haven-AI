/**
 * Postgres advisory-lock leader election for periodic monitor ticks.
 *
 * Every backend replica starts the same in-process `setInterval` monitors
 * (catalog refresh, delegate balance, schedule renewal, relayer balance), so
 * a multi-instance deployment runs every scan N times and — because the
 * edge-trigger alert state is per-process memory — sends up to N copies of
 * each webhook alert. Wrapping a tick in `runIfLeader` makes exactly one
 * replica execute it: `pg_try_advisory_lock` is non-blocking, so the losers
 * skip the tick instead of queueing behind the winner.
 *
 * The lock is session-scoped, so acquire and release MUST happen on the same
 * pooled connection — that is why this checks out a dedicated client rather
 * than using `pool.query` (which may run the two statements on different
 * connections, leaking the lock).
 */

import pool from '../db.js'

/**
 * One stable key per monitor. Advisory locks share a global 64-bit keyspace
 * with anything else in the database, so keep these grouped under an
 * arbitrary but distinctive prefix (81100x) and never reuse a value.
 */
export const LEADER_LOCK_KEYS = {
  catalogRefresh: 811001,
  delegateBalanceMonitor: 811002,
  relayerBalanceMonitor: 811004,
  /** L0 passport anchor sweep — issuance retries + revocation reconciliation (#973). */
  passportSweep: 811005,
} as const

export interface QueryableClientLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  /** pg semantics: a truthy argument destroys the connection instead of pooling it. */
  release: (destroy?: boolean) => void
}

export interface PoolLike {
  connect: () => Promise<QueryableClientLike>
}

/**
 * Run `fn` only if this replica wins the advisory lock for `lockKey`.
 * Returns true when `fn` ran (we were the leader), false when another
 * replica held the lock and the tick was skipped. Errors from `fn`
 * propagate after the lock is released.
 */
export async function runIfLeader(
  lockKey: number,
  fn: () => Promise<void>,
  db: PoolLike = pool as unknown as PoolLike,
): Promise<boolean> {
  const client = await db.connect()
  let destroyConnection = false
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey])
    if (result.rows[0]?.locked !== true) {
      return false
    }
    try {
      await fn()
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey])
      } catch {
        // The session still holds the lock; pooling the connection again
        // would leak leadership onto an idle-but-held session and leave the
        // monitor leaderless cluster-wide. Destroy the connection instead —
        // Postgres frees session advisory locks on disconnect. (A hard crash
        // mid-tick is safe for the same reason.)
        destroyConnection = true
      }
    }
    return true
  } finally {
    client.release(destroyConnection || undefined)
  }
}
