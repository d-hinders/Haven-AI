/**
 * #2198 — the harness's cross-worker migration lock must not deadlock a
 * `CREATE INDEX CONCURRENTLY` build.
 *
 * `initDbHarness()` serialised migration runs across vitest workers with a
 * BLOCKING `pg_advisory_lock()`. That statement runs in its own implicit
 * transaction, so the waiter holds a live snapshot for the whole wait, and
 * `CREATE INDEX CONCURRENTLY` must wait out every older snapshot in the
 * DATABASE before it can mark its index valid. Each waits for the other and
 * Postgres kills one with `40P01`.
 *
 * Nothing in `db/migrations/` declares `transactional = false` yet, so the
 * runner cannot emit a `CONCURRENTLY` build today (PR #2199 / #2150 makes it
 * possible). The hazard is therefore proven at the level where it is real
 * NOW — the lock shape itself, against the harness's own key — rather than
 * simulated through a migration that does not exist. The first two tests are
 * that proof: the same scenario, once per lock shape, one deadlocking and one
 * not.
 *
 * Real Postgres only, and deliberately so: a fake `pg` client cannot raise
 * `40P01`, cannot hold a snapshot, and cannot make a `CONCURRENTLY` build
 * wait. Every assertion here would pass against a mock that had none of the
 * behaviour under test.
 */
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import db from '../../db.js'
import { acquireAdvisoryLockByPolling, releaseAdvisoryLock } from '../../db/advisory-lock.js'
import { WORKER_SCHEMA, describeDb, initDbHarness } from './helpers/db-harness.js'

/** The real lock `initDbHarness()` takes. Kept in sync by the test below. */
const HARNESS_LOCK_KEY = 811000061

/**
 * A SEPARATE key for the two mechanism tests. They deliberately provoke a
 * deadlock, and doing that on the real key would kill an unrelated worker
 * that happened to be booting its own schema at that moment.
 */
const SCRATCH_LOCK_KEY = 811000062

/** Worker-scoped: two overlapping runs against one Postgres must not collide. */
const SCRATCH_SCHEMA = `harness_lock_2198_${WORKER_SCHEMA}`

const sqlstateOf = (err: unknown): string | undefined =>
  (err as { code?: string } | undefined)?.code

/** Build an index CONCURRENTLY on the scratch table, reporting the SQLSTATE. */
async function buildIndexConcurrently(
  client: PoolClient,
  name: string,
): Promise<{ ok: boolean; code?: string }> {
  try {
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${SCRATCH_SCHEMA}.t (n)`,
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, code: sqlstateOf(err) }
  }
}

/**
 * Give a would-be waiter time to actually be waiting.
 *
 * For the BLOCKING shape this is observable: `pg_locks` carries an ungranted
 * advisory row. For the POLLED shape there is never one — that is the entire
 * point — so this returns `false` after the bounded wait and the caller simply
 * proceeds. Written as an observation rather than a fixed sleep so the
 * deadlock case is deterministic rather than timing-dependent.
 */
async function waitForBlockedAdvisoryWaiter(key: number, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND classid = 0 AND objid = $1`,
      [key],
    )
    if (Number(rows[0].n) > 0) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

describeDb('db-harness migration lock vs CREATE INDEX CONCURRENTLY (#2198)', () => {
  beforeAll(async () => {
    // Deliberately does NOT call `initDbHarness()`. Its result is memoised in
    // module scope, so the harness test below has to be the FIRST call in this
    // file or it would observe an already-resolved promise and its positive
    // control would be vacuous. Nothing here needs the migrated schema.
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCRATCH_SCHEMA}`)
    await db.query(`CREATE TABLE IF NOT EXISTS ${SCRATCH_SCHEMA}.t (id serial primary key, n int)`)
    await db.query(
      `INSERT INTO ${SCRATCH_SCHEMA}.t (n) SELECT g FROM generate_series(1, 50000) g`,
    )
  }, 180_000)

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  })

  // ---------------------------------------------------------------------
  // The hazard, reproduced. This is the load-bearing evidence: the shape the
  // harness used until #2198 deadlocks, by execution.
  // ---------------------------------------------------------------------
  it('a BLOCKING pg_advisory_lock waiter deadlocks a concurrent CONCURRENTLY build (40P01)', async () => {
    const holder = await db.connect()
    const waiter = await db.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])

      // Exactly what initDbHarness() used to do while another worker held it.
      const blocked = waiter
        .query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
        .then(() => ({ ok: true, code: undefined as string | undefined }))
        .catch((err) => ({ ok: false, code: sqlstateOf(err) }))

      expect(await waitForBlockedAdvisoryWaiter(SCRATCH_LOCK_KEY)).toBe(true)

      const build = await buildIndexConcurrently(holder, 'idx_2198_blocking')
      const waited = await blocked

      // Postgres kills one side of the cycle. Which side is its choice; the
      // assertion is that a 40P01 happened at all.
      expect([build.code, waited.code]).toContain('40P01')
    } finally {
      await waiter.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      waiter.release()
      holder.release()
    }
  }, 120_000)

  it('the POLLED waiter does not — same scenario, no 40P01, and the build completes VALID', async () => {
    const holder = await db.connect()
    const waiter = await db.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])

      let waiterError: unknown = null
      let acquired = false
      const polling = acquireAdvisoryLockByPolling(waiter, {
        key: SCRATCH_LOCK_KEY,
        pollIntervalMs: 50,
        timeoutMs: 60_000,
        describeTimeout: () => 'test waiter timed out',
      }).then(
        () => {
          acquired = true
        },
        (err) => {
          waiterError = err
        },
      )

      // No blocked waiter exists in this shape — that IS the fix.
      expect(await waitForBlockedAdvisoryWaiter(SCRATCH_LOCK_KEY, 1000)).toBe(false)

      const build = await buildIndexConcurrently(holder, 'idx_2198_polled')
      expect(build).toEqual({ ok: true })

      // POSITIVE CONTROL: a waiter that gave up and proceeded anyway would
      // make every "it did not deadlock" assertion here vacuous. It must
      // still NOT hold the lock while the holder does.
      expect(acquired).toBe(false)
      expect(waiterError).toBeNull()

      const { rows } = await db.query<{ indisvalid: boolean }>(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
        [`${SCRATCH_SCHEMA}.idx_2198_polled`],
      )
      expect(rows[0]?.indisvalid).toBe(true)

      await holder.query('SELECT pg_advisory_unlock($1)', [SCRATCH_LOCK_KEY])
      await polling
      expect(waiterError).toBeNull()
      expect(acquired).toBe(true)
    } finally {
      await waiter.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      waiter.release()
      holder.release()
    }
  }, 120_000)

  // ---------------------------------------------------------------------
  // The same thing through the real harness entry point, on the real key.
  // ---------------------------------------------------------------------
  it('initDbHarness() waits out a CONCURRENTLY build on the lock holder, and still serialises', async () => {
    const holder = await db.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [HARNESS_LOCK_KEY])

      let outcome: unknown = 'pending'
      const init = initDbHarness().then(
        () => {
          outcome = 'resolved'
        },
        (err) => {
          outcome = err
        },
      )

      // The build the first `transactional = false` migration will do.
      const build = await buildIndexConcurrently(holder, 'idx_2198_harness')
      expect(build).toEqual({ ok: true })

      // POSITIVE CONTROL: the lock is still held, so initDbHarness() must NOT
      // have run migrations. A harness that failed to acquire and proceeded
      // anyway would pass every other assertion in this file.
      await new Promise((r) => setTimeout(r, 500))
      expect(outcome).toBe('pending')

      await holder.query('SELECT pg_advisory_unlock($1)', [HARNESS_LOCK_KEY])
      await init
      // Named explicitly: under the blocking shape this is a 40P01 error.
      expect(sqlstateOf(outcome)).toBeUndefined()
      expect(outcome).toBe('resolved')
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      holder.release()
    }
  }, 180_000)

  it('a waiter that cannot acquire THROWS rather than proceeding without the lock', async () => {
    const holder = await db.connect()
    const waiter = await db.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
      await expect(
        acquireAdvisoryLockByPolling(waiter, {
          key: SCRATCH_LOCK_KEY,
          pollIntervalMs: 25,
          timeoutMs: 200,
          describeTimeout: (waited) => `gave up after ${waited}ms`,
        }),
      ).rejects.toThrow(/gave up after/)

      // And it really did not take the lock on its way out.
      const { rows } = await waiter.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SCRATCH_LOCK_KEY],
      )
      expect(rows[0].locked).toBe(false)
    } finally {
      await waiter.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      waiter.release()
      holder.release()
    }
  }, 60_000)

  it('releaseAdvisoryLock actually releases', async () => {
    const a = await db.connect()
    const b = await db.connect()
    try {
      await acquireAdvisoryLockByPolling(a, {
        key: SCRATCH_LOCK_KEY,
        pollIntervalMs: 25,
        timeoutMs: 10_000,
        describeTimeout: () => 'unexpected',
      })
      const held = await b.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SCRATCH_LOCK_KEY],
      )
      expect(held.rows[0].locked).toBe(false)

      await releaseAdvisoryLock(a, SCRATCH_LOCK_KEY)
      const free = await b.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SCRATCH_LOCK_KEY],
      )
      expect(free.rows[0].locked).toBe(true)
    } finally {
      await b.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      await a.query('SELECT pg_advisory_unlock_all()').catch(() => {})
      b.release()
      a.release()
    }
  }, 60_000)
})
