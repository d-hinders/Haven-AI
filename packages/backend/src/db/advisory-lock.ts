import type { QueryResultRow } from 'pg'

/**
 * Polled acquisition of a Postgres session advisory lock (#2198).
 *
 * ## Why polling, and why this is not a style preference
 *
 * `SELECT pg_advisory_lock(k)` blocks until the lock is free. That statement
 * runs in its own implicit transaction, so the waiter holds a **live snapshot
 * for the entire wait**. `CREATE INDEX CONCURRENTLY` finishes by waiting out
 * every transaction whose snapshot is older than its own — **database-wide**,
 * not merely on the table being indexed. Put a blocking waiter next to a
 * `CONCURRENTLY` build behind the same lock and each is waiting for the other:
 * Postgres breaks the cycle by killing one with SQLSTATE `40P01`.
 *
 * That is not a rare race. It is the *normal* outcome whenever the thing
 * protected by the lock is a non-transactional index build — i.e. precisely
 * the case such a lock exists to make safe. It was found by execution, not by
 * argument: the concurrent-boot test written for #2150 failed on its first run
 * with `40P01`, and #2198 reproduced the same failure against the
 * real-Postgres test harness's own lock and through `initDbHarness()` itself
 * (`infra/__tests__/db-harness-lock-concurrency.test.ts`).
 *
 * `pg_try_advisory_lock` returns immediately either way, so each attempt is a
 * complete sub-millisecond transaction and **no snapshot is held between
 * tries**. The peer's build is free to finish, the waiter gets the lock on the
 * next tick, and the cycle cannot form.
 *
 * ## Why this lives in its own module
 *
 * There are two independent callers with two different locks — the migration
 * runner's cross-replica lane lock (`db/migrate.ts`, #2150) and the vitest
 * harness's cross-worker migration lock
 * (`infra/__tests__/helpers/db-harness.ts`, #2198) — and the reason above has
 * to be true of both. Two hand-rolled loops that must stay in agreement is how
 * this class of bug comes back, so the loop lives here once and the reason is
 * stated here once. The runner's loop was written first and inlined; #2198
 * moved it here rather than copying it.
 *
 * The *tuning* is deliberately NOT shared. Interval and deadline follow from
 * what each caller is waiting for, and the callers explain their own numbers.
 */

/**
 * The slice of `pg`'s client surface this needs. Narrow on purpose: a `Pool`,
 * a `PoolClient` and a bare `Client` all satisfy it, and advisory locks are
 * session-scoped, so the caller — not this helper — owns the decision of which
 * connection holds the lock.
 */
export interface AdvisoryLockClient {
  query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>
}

export interface PolledAdvisoryLockOptions {
  /** The advisory lock key. Keys are global to the database; keep them unique. */
  key: number
  /** How often to retry `pg_try_advisory_lock`. */
  pollIntervalMs: number
  /** How long to keep trying before giving up. */
  timeoutMs: number
  /**
   * Builds the message thrown when `timeoutMs` elapses. A caller-supplied
   * message because only the caller knows what the lock was protecting and
   * what an operator should do about it.
   */
  describeTimeout: (waitedMs: number) => string
  /**
   * Called ONCE if the wait passes `slowWaitAfterMs`, so a long wait is
   * diagnosable while it is still happening rather than only at the deadline.
   */
  onSlowWait?: (waitedMs: number) => void
  /** Threshold for `onSlowWait`. Ignored when `onSlowWait` is absent. */
  slowWaitAfterMs?: number
}

/**
 * Acquire `key` on `client`, retrying until it is granted or `timeoutMs`
 * elapses. Resolves ONLY when the lock is actually held; otherwise throws.
 *
 * It never resolves without the lock — a "give up and continue anyway" path
 * would turn every guarantee built on the lock into a coin flip that looks
 * green.
 *
 * Release with {@link releaseAdvisoryLock} (or by ending the session).
 */
export async function acquireAdvisoryLockByPolling(
  client: AdvisoryLockClient,
  options: PolledAdvisoryLockOptions,
): Promise<void> {
  const { key, pollIntervalMs, timeoutMs, describeTimeout, onSlowWait, slowWaitAfterMs } = options
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let warned = false

  for (;;) {
    // PROOF BRANCH ONLY (#2208) — NOT FOR MERGE. The pre-#2198 BLOCKING form,
    // restored deliberately so the nightly proof job can be shown going RED.
    await client.query<{ locked: boolean }>('SELECT pg_advisory_lock($1)', [key])
    return
    // @ts-expect-error unreachable by construction on this proof branch
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    )
    if (rows[0]?.locked) return

    const waited = Date.now() - startedAt
    if (Date.now() >= deadline) throw new Error(describeTimeout(waited))
    if (onSlowWait && !warned && slowWaitAfterMs !== undefined && waited >= slowWaitAfterMs) {
      warned = true
      onSlowWait(waited)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

/** Release a lock taken by {@link acquireAdvisoryLockByPolling}. */
export async function releaseAdvisoryLock(
  client: AdvisoryLockClient,
  key: number,
): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [key])
}
