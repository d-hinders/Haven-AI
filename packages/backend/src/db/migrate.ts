import type { Pool, PoolClient } from 'pg'
import { getPool } from '../db.js'
import { migrations as registeredMigrations, type Migration } from './migrations/index.js'

/**
 * Versioned migration runner.
 *
 * Each migration declares a unique `version` and an idempotent `up(client)`.
 * Applied versions are tracked in `schema_migrations`. On boot, we run any
 * migrations whose version is not yet recorded, in the order defined by
 * `migrations/index.ts`.
 *
 * ## Two lanes, and why the second one exists (#2150)
 *
 * **Transactional (the default, and every migration written before #2150).**
 * `BEGIN` → `up()` → record the version → `COMMIT`. The bookkeeping row is
 * inside the same transaction as the work, which is the whole point: a failure
 * anywhere rolls back BOTH, so the schema is untouched, nothing is recorded,
 * and the next boot retries from a clean slate. A migration in this lane
 * cannot leave a partial state behind.
 *
 * **Non-transactional (`export const transactional = false`).** Postgres
 * refuses some statements inside a transaction block with SQLSTATE `25001` —
 * `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` above all, plus
 * `REINDEX CONCURRENTLY`, `VACUUM`, `CREATE DATABASE` and `ALTER SYSTEM`. A
 * lock-free index build on a hot table is therefore impossible in the
 * transactional lane, which is what PR #2149 hit. Its two indexes on
 * `payment_intents` are therefore plain `CREATE INDEX` statements, and the
 * owner decision recorded on that PR is to accept the resulting write-blocking
 * `SHARE` lock in a low-traffic window. The ~6.0 s figure quoted for it was
 * measured on a 200 000-row **harness** table, not in production; that PR is
 * still open, so nothing has yet paid it.
 *
 * ### What is given up, stated plainly
 *
 * Outside a transaction there is **no rollback**. If `up()` throws halfway,
 * the statements that already ran have already committed. The schema is
 * partially changed and the runner cannot undo it.
 *
 * The dangerous part is not the partial schema — it is the bookkeeping. In the
 * transactional lane a failure un-writes the `schema_migrations` row for free.
 * Here it cannot, and the naive shapes are both bad:
 *
 * - record AFTER `up()` → a crash leaves NO row, so the next boot silently
 *   re-runs a half-applied migration. For a failed `CREATE INDEX
 *   CONCURRENTLY` that is actively wrong: the failure leaves an **INVALID**
 *   index, `CREATE INDEX ... IF NOT EXISTS` then no-ops on the name, the
 *   migration "succeeds", and the database carries an index the planner will
 *   never use, forever, with no signal.
 * - record BEFORE `up()` → a crash leaves a row that says "applied", and the
 *   half-applied migration is never revisited at all.
 *
 * So this lane trades rollback for **detection**, which is the only honest
 * trade available:
 *
 * 1. `INSERT ... (version, status) VALUES ($1, 'running')` BEFORE `up()`.
 * 2. `up()`.
 * 3. `UPDATE ... SET status = 'applied'` after it returns.
 *
 * A `'running'` row is therefore *exactly* the "this migration was interrupted"
 * signal, it survives the crash that produced it, and the only reader that
 * matters — the next boot — **refuses to start** and prints the recovery
 * (`partialFailureMessage` below). Fail-closed and loud beats booting onto a
 * schema nobody can describe. Only `status = 'applied'` counts as applied.
 *
 * ### Concurrency
 *
 * `runMigrations()` runs on EVERY replica at boot (`index.ts`), so two nodes
 * can reach the same new migration at the same moment. In the transactional
 * lane Postgres arbitrates: the loser's `INSERT` hits the primary key and its
 * whole transaction rolls back. That does not work here — both nodes would
 * start a `CONCURRENTLY` build. The non-transactional lane therefore holds a
 * session advisory lock (`NON_TRANSACTIONAL_LOCK_KEY`) across the whole
 * step and re-reads the row *inside* the lock, which collapses the three cases
 * into distinguishable ones:
 *
 * - no row → ours to run;
 * - `'applied'` → the other node finished it while we waited → skip;
 * - `'running'` **while we hold the lock** → nobody is running it, so it is a
 *   crashed partial, not a peer → refuse.
 *
 * That last line is what the lock buys: without it, a `'running'` row is
 * ambiguous between "a peer is mid-build" and "a previous run died", and the
 * runner would have to refuse in both cases — turning every concurrent boot
 * into a crashloop.
 *
 * The wait for that lock is POLLED, not blocking, and that detail is load-
 * bearing rather than cosmetic: a blocking waiter deadlocks the very index
 * build it is waiting for. See `acquireLaneLock`.
 *
 * ### One residual an operator will meet, and no lock can fix
 *
 * `CREATE INDEX CONCURRENTLY` finishes by waiting for every transaction with a
 * snapshot older than its own to end — **database-wide**, not just on the table
 * being indexed. So a non-transactional migration can sit there for reasons
 * that have nothing to do with migrations: an ordinary long transaction from
 * application traffic, a report, a slow request. Nothing here can quiesce
 * those, and no advisory-lock scheme would help; the only bound is
 * `LOCK_WAIT_TIMEOUT_MS`. If a boot appears stuck on an index build, look at
 * `pg_stat_activity` for old transactions before suspecting the runner.
 *
 * ### `down()`
 *
 * The runner never calls `down()` in either lane — rollback is a hand-run or
 * test-only operation, and the `Migration` contract does not even include it.
 * For a non-transactional migration the consequence is that `down()` is
 * likewise NOT wrapped by anything (its tests call it on a bare pooled
 * client), which is what makes `DROP INDEX CONCURRENTLY` writable in one. It
 * also means a half-finished `down()` has no rollback either, and no
 * bookkeeping row to detect it with, so a non-transactional `down()` must be
 * written idempotently — `IF EXISTS` on every statement.
 */

/**
 * Advisory lock serialising the non-transactional lane across replicas. A
 * fixed key for the LANE, not per version: non-transactional migrations are
 * rare, and serialising two different ones against each other costs nothing
 * while making the reasoning above hold for the whole lane. Distinct from
 * `LEADER_LOCK_KEYS` (`platform/leader-lock.ts`) and from the test harness's
 * migration lock (811000061).
 */
export const NON_TRANSACTIONAL_LOCK_KEY = 21_500_001

/**
 * How long a replica waits for a peer's non-transactional migration before
 * giving up. The wait covers a whole index build, so it is generous; it exists
 * only so a boot cannot hang forever on a lock that is never released.
 */
const LOCK_WAIT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * How often the waiter re-tries. The wait is POLLED rather than blocking, and
 * that is a correctness requirement, not a style choice — see
 * `acquireLaneLock`.
 */
const LOCK_POLL_INTERVAL_MS = 250

/** Absence means transactional — the lane that cannot leave a partial state. */
function isTransactional(migration: Migration): boolean {
  return migration.transactional !== false
}

/**
 * The message an operator sees when a non-transactional migration was
 * interrupted. It is long on purpose: whoever reads it is looking at a backend
 * that will not boot, and the two ways out are not guessable.
 */
export function partialFailureMessage(migration: Migration): string {
  return [
    `Migration ${migration.version} was left INCOMPLETE by an earlier run and will not be retried automatically.`,
    '',
    `It is declared non-transactional (${migration.nonTransactionalReason ?? 'no reason recorded'}),`,
    'so its statements were NOT rolled back when it failed: the schema may be partially changed,',
    `and schema_migrations still carries version = '${migration.version}' with status = 'running'.`,
    '',
    'Recover by hand, then restart the backend:',
    "  1. Inspect the schema and decide whether the migration's effects are complete.",
    '  2a. If you FINISHED it by hand, mark it applied:',
    `        UPDATE schema_migrations SET status = 'applied', applied_at = NOW() WHERE version = '${migration.version}';`,
    '  2b. If you UNDID its effects so it can run again from scratch, delete the row:',
    `        DELETE FROM schema_migrations WHERE version = '${migration.version}';`,
    '',
    'Do not simply delete the row without checking: re-running a partially applied migration',
    'is only safe if its up() is idempotent from the state it actually left behind.',
  ].join('\n')
}

/**
 * Bring the database to the current migration head.
 *
 * @param list the migrations to apply. **Test-only — production must always
 *   call this with no argument.** It defaults to the real registry, and the
 *   parameter exists as a seam for the runner's own tests, which need to drive
 *   fixture migrations (including deliberately failing ones) through the real
 *   runner against a real Postgres without adding a permanent migration to
 *   `db/migrations/` whose only purpose is to demonstrate a runner feature.
 *   Passing a partial list from a production path would silently skip real
 *   migrations.
 */
export async function runMigrations(list: Migration[] = registeredMigrations): Promise<void> {
  const pool = getPool()

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  await ensureStatusColumn(pool)

  const recorded = await pool.query<{ version: string; status: string }>(
    `SELECT version, status FROM schema_migrations`,
  )
  const appliedSet = new Set(
    recorded.rows.filter((r) => r.status === 'applied').map((r) => r.version),
  )
  const incompleteSet = new Set(
    recorded.rows.filter((r) => r.status !== 'applied').map((r) => r.version),
  )

  for (const migration of list) {
    if (appliedSet.has(migration.version)) continue

    const client = await pool.connect()
    try {
      if (isTransactional(migration)) {
        // Defensive: a transactional migration can only carry an incomplete
        // row if it was non-transactional when it crashed and the flag was
        // removed afterwards. Naming that beats the `duplicate key` the bare
        // INSERT below would otherwise raise.
        if (incompleteSet.has(migration.version)) throw new Error(partialFailureMessage(migration))
        await applyInTransaction(client, migration)
      } else {
        await applyWithoutTransaction(client, migration)
      }
      console.log(`[migrate] applied ${migration.version}`)
    } catch (err) {
      throw new Error(`Migration ${migration.version} failed: ${(err as Error).message}`, {
        cause: err,
      })
    } finally {
      client.release()
    }
  }
}

/**
 * Add `schema_migrations.status` to a database that predates #2150.
 *
 * `NOT NULL DEFAULT 'applied'` does the backfill for free: every row already
 * in the table was written by the old transactional-only runner, which
 * recorded a version only AFTER the work had committed, so 'applied' is not a
 * guess. Postgres 11+ adds a defaulted NOT NULL column without rewriting the
 * table.
 *
 * The existence check is there because `ADD COLUMN IF NOT EXISTS` still takes
 * an `ACCESS EXCLUSIVE` lock on `schema_migrations` when the column is already
 * present — a no-op that briefly blocks every other reader of the bookkeeping
 * table, on every boot, forever. Reading the catalog first means every boot
 * after the first takes no DDL lock at all. (It is NOT what makes concurrent
 * boots safe: that is `acquireLaneLock`'s polled wait, and this check alone
 * did not fix the 40P01 the concurrent-boot test found.)
 *
 * The check-then-act window is handled rather than hoped away: on failure the
 * column is re-read to decide whether a peer won (continue) or the ALTER failed
 * for its own reasons (rethrow).
 *
 * **That `catch` is defensive and is deliberately NOT claimed as a proven
 * guard.** The ordinary race does not reach it — `ADD COLUMN IF NOT EXISTS` is
 * a no-op for the loser, not an error — so what is left is Postgres raising
 * `XX000 tuple concurrently updated` from concurrent catalog writes, which
 * cannot be scheduled from a test. The concurrent path that CAN be proven is,
 * by `two concurrent boots ADD the status column exactly once` in
 * `__tests__/migrate-non-transactional.test.ts`. Saying so beats a test shaped
 * like a proof that never exercises the branch.
 */
async function ensureStatusColumn(pool: Pool): Promise<void> {
  if (await statusColumnExists(pool)) return
  try {
    await pool.query(`
      ALTER TABLE schema_migrations
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied';
    `)
  } catch (err) {
    if (!(await statusColumnExists(pool))) throw err
  }
}

async function statusColumnExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = to_regclass('schema_migrations')
         AND attname = 'status'
         AND NOT attisdropped
     ) AS exists`,
  )
  return rows[0].exists
}

/**
 * Take the lane lock, polling with `pg_try_advisory_lock` instead of blocking
 * on `pg_advisory_lock`.
 *
 * **This is a correctness requirement, and it was found by execution rather
 * than reasoning.** A blocking `pg_advisory_lock()` runs inside its own
 * implicit transaction, so a waiting replica holds a live virtual transaction
 * id and a snapshot for the whole wait. `CREATE INDEX CONCURRENTLY` on the
 * replica that HOLDS the lock must wait for exactly such transactions to
 * finish before it can complete. Each side then waits for the other and
 * Postgres kills one with `40P01 deadlock detected` — which is not a rare race
 * but the *normal* outcome of two replicas booting into the same
 * non-transactional migration, i.e. the case this lock exists to make safe.
 * The concurrent-boot test in `__tests__/migrate-non-transactional.test.ts`
 * reproduced it on the first run.
 *
 * `pg_try_advisory_lock` returns immediately, so each attempt is a complete,
 * short transaction and the waiter holds no snapshot between attempts. The
 * peer's index build is then free to finish, which is the only thing that ever
 * ends the wait.
 */
async function acquireLaneLock(client: PoolClient, migration: Migration): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [NON_TRANSACTIONAL_LOCK_KEY],
    )
    if (rows[0].locked) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(LOCK_WAIT_TIMEOUT_MS / 1000)}s waiting for another node to ` +
          `finish a non-transactional migration before applying ${migration.version}. ` +
          'Check whether a peer is still building, or whether a session is holding ' +
          `advisory lock ${NON_TRANSACTIONAL_LOCK_KEY} without releasing it.`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS))
  }
}

/** The default lane. Work and bookkeeping commit or roll back together. */
async function applyInTransaction(client: PoolClient, migration: Migration): Promise<void> {
  try {
    await client.query('BEGIN')
    await migration.up(client)
    await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [migration.version])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * The opt-out lane. No `BEGIN`, so no rollback — see the header for the
 * bookkeeping this substitutes for it.
 */
async function applyWithoutTransaction(client: PoolClient, migration: Migration): Promise<void> {
  await acquireLaneLock(client, migration)

  try {
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM schema_migrations WHERE version = $1`,
      [migration.version],
    )
    // Another replica finished it while we waited on the lock.
    if (rows[0]?.status === 'applied') return
    // We hold the lock, so nobody else is running it: this is a crashed run.
    if (rows[0]) throw new Error(partialFailureMessage(migration))

    await client.query(`INSERT INTO schema_migrations (version, status) VALUES ($1, 'running')`, [
      migration.version,
    ])
    await migration.up(client)
    // The row is NOT deleted if up() throws — it is the detection signal.
    await client.query(
      `UPDATE schema_migrations SET status = 'applied', applied_at = NOW() WHERE version = $1`,
      [migration.version],
    )
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [NON_TRANSACTIONAL_LOCK_KEY])
  }
}
