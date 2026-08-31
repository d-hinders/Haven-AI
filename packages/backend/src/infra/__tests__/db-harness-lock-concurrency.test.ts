/**
 * #2198 — the harness's cross-worker migration lock must not pin a snapshot
 * while it waits.
 *
 * `initDbHarness()` serialised migration runs across vitest workers with a
 * BLOCKING `pg_advisory_lock()`. That statement runs inside its own implicit
 * transaction, so the waiter pins a live snapshot for the whole wait.
 * `CREATE INDEX CONCURRENTLY` finishes by waiting out every transaction whose
 * snapshot is older than its own — DATABASE-wide, not just on the indexed
 * table — so the builder waits for the waiter and the waiter waits for the
 * builder, and Postgres kills one with `40P01`. `pg_try_advisory_lock` returns
 * immediately, so a polled waiter is idle between attempts and pins nothing.
 *
 * ## What is asserted where, and why it is split
 *
 * The **cause** is asserted always, deterministically, in the parallel suite:
 * a blocking waiter's `pg_stat_activity.backend_xmin` is non-null and it shows
 * up in `pg_locks` as an ungranted advisory waiter; a polled one does neither.
 * That is the property `initDbHarness()` has to have, it is observable in
 * microseconds, and it does not care what else the database is doing.
 *
 * The **consequence** — an actual `40P01` against a real `CREATE INDEX
 * CONCURRENTLY` — is opt-in behind `HAVEN_DB_CONCURRENCY_PROOF=1`, and the
 * reason is the same fact the whole issue is about: a `CONCURRENTLY` build
 * waits out every older snapshot in the database, so inside a 2 700-test
 * parallel suite its duration is unbounded. Measured, not assumed: as an
 * always-on test it passed alone and hung past 120 s under the full suite, on
 * repeat. A test that makes the suite flaky about concurrency would be
 * diagnosed as contention and deleted, which is precisely the failure mode
 * this issue exists to prevent. Run it deliberately against a quiet database:
 *
 *     HAVEN_DB_CONCURRENCY_PROOF=1 npx vitest run \
 *       src/infra/__tests__/db-harness-lock-concurrency.test.ts
 *
 * Real Postgres only, deliberately: a fake `pg` client has no snapshots, no
 * `backend_xmin`, and cannot raise `40P01`. Every assertion here would pass
 * against a mock that had none of the behaviour under test.
 */
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { config } from '../../config.js'
import db from '../../db.js'
import { acquireAdvisoryLockByPolling, releaseAdvisoryLock } from '../../db/advisory-lock.js'
import { WORKER_SCHEMA, describeDb, initDbHarness } from './helpers/db-harness.js'

/** The real lock `initDbHarness()` takes. */
const HARNESS_LOCK_KEY = 811000061

/**
 * A SEPARATE key for the mechanism tests. They park a waiter on a held lock
 * and (opt-in) provoke a deadlock; doing that on the real key would stall or
 * kill an unrelated worker that happened to be booting its schema.
 */
const SCRATCH_LOCK_KEY = 811000062

/** Worker-scoped: two overlapping runs against one Postgres must not collide. */
const SCRATCH_SCHEMA = `harness_lock_2198_${WORKER_SCHEMA}`

const concurrencyProof = process.env.HAVEN_DB_CONCURRENCY_PROOF === '1'

const sqlstateOf = (err: unknown): string | undefined =>
  (err as { code?: string } | undefined)?.code

/**
 * A dedicated session, NOT a pooled client.
 *
 * Advisory locks are session-scoped, and a pooled client that is released
 * while still holding one hands the lock to the next borrower — which is how
 * an earlier draft of this file made three later tests time out on a lock they
 * could never get. `end()` closes the backend, so nothing can leak.
 */
async function session(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: config.databaseUrl })
  await client.connect()
  return client
}

const pidOf = async (client: pg.Client): Promise<number> =>
  (await client.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0].p

/** Is `pid` currently pinning a snapshot? Non-null `backend_xmin` means yes. */
async function snapshotHeldBy(observer: pg.Client, pid: number): Promise<string | null> {
  const { rows } = await observer.query<{ backend_xmin: string | null }>(
    'SELECT backend_xmin FROM pg_stat_activity WHERE pid = $1',
    [pid],
  )
  return rows[0]?.backend_xmin ?? null
}

/** How many sessions are BLOCKED waiting on `key` right now. */
async function blockedWaitersOn(observer: pg.Client, key: number): Promise<number> {
  const { rows } = await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND classid = 0 AND objid = $1`,
    [key],
  )
  return rows[0].n
}

/** Wait until a session is visibly blocked on `key`, or give up. */
async function waitForBlockedWaiter(
  observer: pg.Client,
  key: number,
  budgetMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if ((await blockedWaitersOn(observer, key)) > 0) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}

describeDb('db-harness migration lock: the wait must pin no snapshot (#2198)', () => {
  let observer: pg.Client

  beforeAll(async () => {
    // Deliberately does NOT call `initDbHarness()`: its result is memoised in
    // module scope, so the harness test below has to be this file's FIRST call
    // or it would observe an already-resolved promise and its positive control
    // would be vacuous. Nothing here needs the migrated schema.
    observer = await session()
    // Dropped first rather than `IF NOT EXISTS`-created: an aborted earlier run
    // can leave this schema behind with its index already built, which would
    // turn the build below into a silent no-op. Observed exactly that once.
    await db.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
    await db.query(`CREATE SCHEMA ${SCRATCH_SCHEMA}`)
    await db.query(`CREATE TABLE ${SCRATCH_SCHEMA}.t (id serial primary key, n int)`)
    await db.query(`INSERT INTO ${SCRATCH_SCHEMA}.t (n) SELECT g FROM generate_series(1, 2000) g`)
  }, 120_000)

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
    await observer.end()
  })

  // ---------------------------------------------------------------------
  // THE CAUSE. Deterministic, load-independent, always on.
  // ---------------------------------------------------------------------
  it('a BLOCKING waiter pins a live snapshot; a POLLED waiter pins none', async () => {
    const holder = await session()
    const waiter = await session()
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
      const waiterPid = await pidOf(waiter)

      // The shape initDbHarness() used before #2198.
      const blocking = waiter.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY]).catch(
        (err) => err as Error,
      )
      expect(await waitForBlockedWaiter(observer, SCRATCH_LOCK_KEY)).toBe(true)

      // This is the whole defect in one assertion: a live snapshot, held for
      // as long as the wait lasts, which CREATE INDEX CONCURRENTLY must then
      // wait out before it can mark its index valid.
      expect(await snapshotHeldBy(observer, waiterPid)).not.toBeNull()

      // Hand it over and let the blocking call finish, so the session is not
      // torn down mid-statement.
      await holder.query('SELECT pg_advisory_unlock($1)', [SCRATCH_LOCK_KEY])
      await blocking
      await waiter.query('SELECT pg_advisory_unlock_all()')

      // Same scenario, polled.
      await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
      let acquired = false
      const polling = acquireAdvisoryLockByPolling(waiter, {
        key: SCRATCH_LOCK_KEY,
        pollIntervalMs: 50,
        timeoutMs: 60_000,
        describeTimeout: () => 'polled waiter timed out',
      }).then(() => {
        acquired = true
      })
      await new Promise((r) => setTimeout(r, 500))

      expect(await blockedWaitersOn(observer, SCRATCH_LOCK_KEY)).toBe(0)
      expect(await snapshotHeldBy(observer, waiterPid)).toBeNull()
      // POSITIVE CONTROL: pinning no snapshot is only interesting if the
      // waiter is still genuinely waiting. One that gave up and proceeded
      // would satisfy both assertions above and guarantee nothing.
      expect(acquired).toBe(false)

      await holder.query('SELECT pg_advisory_unlock($1)', [SCRATCH_LOCK_KEY])
      await polling
      expect(acquired).toBe(true)
    } finally {
      await waiter.end()
      await holder.end()
    }
  }, 120_000)

  // ---------------------------------------------------------------------
  // THE REAL ENTRY POINT. Deterministic, always on.
  // ---------------------------------------------------------------------
  it('initDbHarness() waits without pinning a snapshot, and still serialises', async () => {
    const holder = await session()
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
      await new Promise((r) => setTimeout(r, 500))

      // POSITIVE CONTROL, and the reason this test is not just about snapshots:
      // a harness that failed to acquire and ran migrations anyway would pass
      // every other assertion in this file while destroying the serialisation
      // the lock exists for (#1562).
      expect(outcome).toBe('pending')

      // The property that makes a concurrent CONCURRENTLY build survivable.
      // Under the pre-#2198 blocking form this is a non-zero count.
      expect(await blockedWaitersOn(observer, HARNESS_LOCK_KEY)).toBe(0)

      await holder.query('SELECT pg_advisory_unlock($1)', [HARNESS_LOCK_KEY])
      await init
      expect(sqlstateOf(outcome)).toBeUndefined()
      expect(outcome).toBe('resolved')
    } finally {
      await holder.end()
    }
  }, 180_000)

  it('a waiter that cannot acquire THROWS rather than proceeding without the lock', async () => {
    const holder = await session()
    const waiter = await session()
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
      await waiter.end()
      await holder.end()
    }
  }, 60_000)

  it('releaseAdvisoryLock actually releases', async () => {
    const a = await session()
    const b = await session()
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
      await b.end()
      await a.end()
    }
  }, 60_000)

  // ---------------------------------------------------------------------
  // THE CONSEQUENCE. Opt-in — see the file header for why.
  // ---------------------------------------------------------------------
  it.runIf(concurrencyProof)(
    'PROOF: a BLOCKING waiter deadlocks a concurrent CREATE INDEX CONCURRENTLY (40P01)',
    async () => {
      const holder = await session()
      const waiter = await session()
      try {
        await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
        const blocked = waiter
          .query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
          .then(() => ({ code: undefined as string | undefined }))
          .catch((err) => ({ code: sqlstateOf(err) }))
        expect(await waitForBlockedWaiter(observer, SCRATCH_LOCK_KEY)).toBe(true)

        // No `IF NOT EXISTS`: a leftover index would make this a silent no-op,
        // the snapshot-wait would never happen, and the test would hang rather
        // than fail. Loud beats vacuous.
        const build = await holder
          .query(`CREATE INDEX CONCURRENTLY idx_2198_blocking ON ${SCRATCH_SCHEMA}.t (n)`)
          .then(() => ({ code: undefined as string | undefined }))
          .catch((err) => ({ code: sqlstateOf(err) }))
        // Bounded, so a mutation that removes CONCURRENTLY fails with a named
        // assertion instead of hanging until the test timeout.
        const waited = await Promise.race([
          blocked,
          new Promise<{ code: string }>((r) => setTimeout(() => r({ code: 'never-resolved' }), 60_000)),
        ])

        // Postgres kills one side of the cycle; which side is its choice.
        expect([build.code, waited.code]).toContain('40P01')
      } finally {
        await waiter.end()
        await holder.end()
      }
    },
    300_000,
  )

  it.runIf(concurrencyProof)(
    'PROOF: the POLLED waiter does not — the same build completes VALID',
    async () => {
      const holder = await session()
      const waiter = await session()
      try {
        await holder.query('SELECT pg_advisory_lock($1)', [SCRATCH_LOCK_KEY])
        let acquired = false
        const polling = acquireAdvisoryLockByPolling(waiter, {
          key: SCRATCH_LOCK_KEY,
          pollIntervalMs: 50,
          timeoutMs: 120_000,
          describeTimeout: () => 'polled waiter timed out',
        }).then(() => {
          acquired = true
        })

        await holder.query(
          `CREATE INDEX CONCURRENTLY idx_2198_polled ON ${SCRATCH_SCHEMA}.t (n)`,
        )
        const { rows } = await observer.query<{ indisvalid: boolean }>(
          'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)',
          [`${SCRATCH_SCHEMA}.idx_2198_polled`],
        )
        expect(rows[0]?.indisvalid).toBe(true)
        expect(acquired).toBe(false)

        await holder.query('SELECT pg_advisory_unlock($1)', [SCRATCH_LOCK_KEY])
        await polling
        expect(acquired).toBe(true)
      } finally {
        await waiter.end()
        await holder.end()
      }
    },
    300_000,
  )
})
