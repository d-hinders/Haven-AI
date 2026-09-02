/**
 * Contract: a WARM `resetDb()` that loses to contention fails NAMING the
 * contention, inside the budget an in-body call runs under (#2354).
 *
 * #2354's observation was a warm reset — migration run already memoised, call
 * site already in a hook — exceeding vitest's 5000 ms `testTimeout` under
 * ad-hoc concurrent load and passing alone in 647 ms. #2329 had already ruled
 * out the cold path for it. Establishing the mechanism first, three facts:
 *
 * 1. A warm reset never touches the migration advisory lock. `ensureMigrated()`
 *    is memoised, so the lock that dominates the cold path explains nothing
 *    here. Pinned below by holding that lock from a second connection while a
 *    warm reset completes anyway.
 * 2. On the DELETE path the reset is flat in the number of concurrent workers
 *    (median ~90-115 ms at 1/2/4/8 workers, native Postgres 16, 36 tables) and
 *    flat in tables (10 vs 36: 54 vs 59 ms); its floor is the catalog read,
 *    which scales with `pg_class` — the size of the WHOLE database's catalog.
 *    The one path that scales with both relations and workers is the `TRUNCATE`
 *    fallback, which before #2354 covered every table on any cycle; it now
 *    covers the cycle's footprint only (`planEmptying`), pinned in
 *    `plan-delete-order.test.ts` and by the census file's cycle case.
 * 3. What a warm reset can genuinely WAIT on is a relation lock held by another
 *    session on this worker's tables — a transaction a test left open, an
 *    orphaned vitest worker with the same `VITEST_WORKER_ID`. Reproduced
 *    deterministically: an external session holding a lock on one table sent
 *    the census file's `TRUNCATE` case to `Test timed out in 5000ms`, alone
 *    it passed. That failure named an innocent test and nothing else.
 *
 * So the reset now runs its emptying under `RESET_LOCK_WAIT_MS` and fails
 * naming the holder. This file pins that the failure is (a) bounded, (b)
 * attributed to the RIGHT session by pid, and (c) recoverable — the pooled
 * connection comes back clean and the next reset succeeds.
 *
 * NOT a bigger number: the per-test budget is untouched, and a reset that
 * simply hangs still dies at 5000 ms. This makes the failure honest about its
 * cause; it does not make the test stop failing.
 *
 * ## The residue is pinned, not described (#2354 item 4)
 *
 * A machine so loaded that a 5 ms `DELETE` batch takes seconds has NO holder
 * to name, and no budget makes that a property of the code. What the harness
 * owes that case is honesty: the announcement names the warm phase, the reset
 * completes, and nothing invents a session. Two fixtures below fail the day
 * that stops being true — a reset slowed by a statement-level trigger (no lock
 * anywhere) and the no-holder branch of the lock message read directly.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import db, { getPool } from '../../../../db.js'
import { acquireAdvisoryLockByPolling, releaseAdvisoryLock } from '../../../../db/advisory-lock.js'
import {
  describeDb,
  describeLockTimeout,
  initDbHarness,
  MIGRATION_LOCK_KEY,
  resetDb,
  RESET_LOCK_WAIT_MS,
  SLOW_HARNESS_CALL_MS,
  WORKER_SCHEMA,
} from '../db-harness.js'

/** vitest's default `testTimeout` — the budget an in-body harness call runs under. */
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000

/**
 * Check out `count` clients, or none.
 *
 * `Promise.all` over `db.connect()` would be the obvious shape, and it is the
 * wrong one (haven-reviewer, round three): if any single acquisition rejects
 * — one client already checked out because a prior test's hook slipped —
 * `Promise.all` rejects at once, the clients that DID resolve are never
 * captured, and no `finally` can release what it never saw. The fixture that
 * exists to diagnose pool exhaustion would then leak the pool for the rest
 * of the worker's life: the #2319-family flake, self-inflicted. So: settle
 * every acquisition, and on any rejection release what resolved before
 * rethrowing. Pinned below by a factory that rejects one of them.
 */
async function acquireAll(
  count: number,
  connect: () => Promise<PoolClient> = () => db.connect(),
): Promise<PoolClient[]> {
  const settled = await Promise.allSettled(Array.from({ length: count }, () => connect()))
  const held = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const rejected = settled.find((r) => r.status === 'rejected')
  if (rejected) {
    for (const client of held) client.release()
    throw rejected.reason
  }
  return held
}

describe('the three budgets are ordered (#2354)', () => {
  it('announces first, names the holder second, and both land before the per-test timeout', () => {
    // The announcement says WHICH PHASE is stuck; the lock deadline says WHO
    // holds it; the anonymous "Test timed out in 5000ms" must come last, or
    // the diagnosis is never printed. DB-free, so it runs everywhere.
    expect(SLOW_HARNESS_CALL_MS).toBeLessThan(RESET_LOCK_WAIT_MS)
    expect(RESET_LOCK_WAIT_MS).toBeLessThan(VITEST_DEFAULT_TEST_TIMEOUT_MS)
  })
})

describeDb('a warm resetDb() under contention (#2354)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('never waits on the migration advisory lock once warm', async () => {
    // The lock the cold path serialises on, held from a second connection for
    // the duration of a warm reset. If the warm path took it, this would wait
    // until the explicit timeout below and fail; it resolves instead.
    const holder = await db.connect()
    try {
      await acquireAdvisoryLockByPolling(holder, {
        key: MIGRATION_LOCK_KEY,
        pollIntervalMs: 50,
        timeoutMs: 60_000,
        describeTimeout: (waited) =>
          `could not take advisory lock ${MIGRATION_LOCK_KEY} for the test within ${waited}ms`,
      })
      try {
        await resetDb()
      } finally {
        await releaseAdvisoryLock(holder, MIGRATION_LOCK_KEY)
      }
    } finally {
      holder.release()
    }
  }, 90_000)

  it('fails within RESET_LOCK_WAIT_MS naming the lock holder, then recovers', async () => {
    const holder = await db.connect()
    try {
      // Read the pid FIRST: `pg_stat_activity.query` is a session's most recent
      // statement, and the message quotes it — so the lock statement has to be
      // the last thing this session ran.
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const holderPid = rows[0].pid
      await holder.query('BEGIN')
      // ACCESS EXCLUSIVE conflicts with the DELETE path too, so this does not
      // depend on the TRUNCATE fallback being reachable.
      await holder.query(`LOCK TABLE ${WORKER_SCHEMA}.users IN ACCESS EXCLUSIVE MODE`)

      const startedAt = Date.now()
      let failure: Error | null = null
      try {
        await resetDb()
      } catch (err) {
        failure = err as Error
      }
      const elapsed = Date.now() - startedAt

      expect(failure).not.toBeNull()
      const message = (failure as Error).message
      // Bounded: it gave up on the lock, it did not hang until vitest killed it.
      expect(message).toContain(
        `gave up after ${RESET_LOCK_WAIT_MS} ms waiting for a relation lock`,
      )
      expect(message).toContain(`in ${WORKER_SCHEMA}`)
      // Attributed to the RIGHT session — by pid, with its query — not to "a
      // lock" in the abstract.
      expect(message).toContain(`pid ${holderPid} (`)
      expect(message).toContain('LOCK TABLE')
      // Names the phase, so the reader knows it is the emptying and not the
      // migration run.
      expect(message).toMatch(/phase: emptying \(\d+ DELETEs/)
      // The bound is real: well past the deadline is a hang the message would
      // be lying about. Generous upper margin for a loaded machine — this is
      // about the order of magnitude, not the exact number.
      expect(elapsed).toBeGreaterThanOrEqual(RESET_LOCK_WAIT_MS - 50)
      expect(elapsed).toBeLessThan(RESET_LOCK_WAIT_MS * 4)

      await holder.query('ROLLBACK')
      // Recovery: the client that timed out was rolled back and returned to
      // the pool; the very next reset must succeed on the same pool.
      await resetDb()
      const { rows: users } = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM users')
      expect(users[0].n).toBe('0')
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
    }
  }, 60_000)

  it('a merely SLOW reset (no holder) announces the warm phase, names nobody, ends', async () => {
    // A statement-level BEFORE DELETE trigger that sleeps past
    // SLOW_HARNESS_CALL_MS. Fires even on an empty table, takes no lock the
    // reset would wait on, and is the one lever that slows the emptying
    // itself rather than something in front of it. Dropped FIRST as well as
    // in `finally`: left behind, it would slow every later reset in this
    // worker (a killed test is how #2211's probe table survived a run).
    const trigger = 'reset_slow_probe'
    const sleepSeconds = (SLOW_HARNESS_CALL_MS + 500) / 1000
    await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${WORKER_SCHEMA}.users`)
    await db.query(`DROP FUNCTION IF EXISTS ${WORKER_SCHEMA}.${trigger}()`)
    await db.query(
      `CREATE FUNCTION ${WORKER_SCHEMA}.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_sleep(${sleepSeconds}); RETURN NULL; END $$`,
    )
    await db.query(
      `CREATE TRIGGER ${trigger} BEFORE DELETE ON ${WORKER_SCHEMA}.users
         FOR EACH STATEMENT EXECUTE FUNCTION ${WORKER_SCHEMA}.${trigger}()`,
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Completes: no lock, so no lock timeout, and no error of any kind.
      await expect(resetDb()).resolves.toBeUndefined()

      const lines = warn.mock.calls.map((call) => String(call[0]))
      const announcement = lines.find((l) => l.includes('resetDb() has been running'))
      expect(announcement).toBeDefined()
      // Names the phase it was actually in, and says it is a WARM call — not
      // the migration run, not the advisory lock.
      expect(announcement).toMatch(/in phase "emptying \(\d+ DELETEs/)
      expect(announcement).toContain('WARM call')
      expect(announcement).toContain(`never waits on advisory lock ${MIGRATION_LOCK_KEY}`)
      // Names nobody: no holder exists, so no line may claim one.
      for (const line of lines) {
        expect(line).not.toContain('Held by')
        expect(line).not.toContain('gave up')
      }
      // And it closes the loop with the total, so the log reads as one event.
      expect(lines.some((l) => /resetDb\(\) finished after \d+ms/.test(l))).toBe(true)
    } finally {
      warn.mockRestore()
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${WORKER_SCHEMA}.users`)
      await db.query(`DROP FUNCTION IF EXISTS ${WORKER_SCHEMA}.${trigger}()`)
    }
  }, 60_000)

  it('with every pooled connection checked out, fails naming POOL EXHAUSTION, recovers', async () => {
    // The third wait #2354 asked to distinguish from the advisory lock: hold
    // all DB_POOL_MAX clients (vitest.setup.ts caps it at 5) and the reset
    // cannot get one. pg-pool gives up after connectionTimeoutMillis with a
    // bare "timeout exceeded when trying to connect" — the reset must turn
    // that into a message naming the pool, the phase and the leak to look for.
    const poolMax = Number(process.env.DB_POOL_MAX) || 20
    const held = await acquireAll(poolMax)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let failure: Error | null = null
    let lines: string[] = []
    try {
      await resetDb()
    } catch (err) {
      failure = err as Error
    } finally {
      // Read BEFORE mockRestore — it resets the recorded calls as well.
      lines = warn.mock.calls.map((call) => String(call[0]))
      warn.mockRestore()
      for (const client of held) client.release()
    }
    // The announcement fired first (2000 ms < the pool's 5000 ms) and its cause
    // line must agree with what is actually happening: a label is only honest
    // if the explanation next to it names the same mechanism.
    const announcement = lines.find((l) => l.includes('resetDb() has been running'))
    expect(announcement).toBeDefined()
    expect(announcement).toContain(`DB_POOL_MAX=${poolMax}`)
    expect(announcement).not.toContain('Held by')
    expect(failure).not.toBeNull()
    const message = (failure as Error).message
    expect(message).toContain('could not get a pooled connection')
    expect(message).toContain(`pool exhaustion: all DB_POOL_MAX=${poolMax}`)
    // Named in the phase it actually happened — the first one needing the
    // pool — not attributed to the lock or the migration run.
    expect(message).toMatch(/\(phase: (catalog read|acquiring connection)\)/)
    expect(message).not.toContain('Held by')
    expect(message).toContain('timeout exceeded when trying to connect')
    // Recovery: the clients are back, the next reset succeeds.
    await resetDb()
  }, 60_000)

  it('the pool-exhaustion fixture cannot itself leak: one failed acquire releases the rest', async () => {
    // Three real acquisitions and one that rejects, in the middle. The helper
    // must reject AND hand every real client back — checked against the
    // pool's own counters, not against what the helper claims to have done.
    const pool = getPool()
    let n = 0
    const flaky = (): Promise<PoolClient> =>
      ++n === 2 ? Promise.reject(new Error('probe: one acquisition failed')) : db.connect()
    await expect(acquireAll(4, flaky)).rejects.toThrow('probe: one acquisition failed')
    expect(pool.totalCount - pool.idleCount).toBe(0)
    expect(pool.waitingCount).toBe(0)
    // And the pool still serves the next reset.
    await resetDb()
  })

  it('the lock message with NO holder says so, and never fabricates a session', async () => {
    // The branch a released-in-between holder reaches. Read directly, with
    // nobody holding anything in this schema — directly because the natural
    // race (holder lets go between the lock_timeout firing and the lookup) is
    // not reliably producible, so reading the branch is the only practical
    // pin. haven-reviewer mutated this pin itself (fabricated `pid 1 (…)`)
    // and watched it go red before clearing it.
    const message = await describeLockTimeout('emptying (probe)')
    expect(message).toContain('no session holds a lock on this schema any more')
    expect(message).not.toMatch(/Held by: pid \d+/)
    expect(message).toContain('(phase: emptying (probe))')
  })
})
