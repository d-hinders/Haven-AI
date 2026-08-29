/**
 * Real-Postgres test harness (#1220, epic #1219).
 *
 * Gives a test a REAL database with every migration applied, isolated from
 * other vitest workers, and cleaned between tests. The point of the epic:
 * idempotency, locking, constraints and transactional integrity are proven
 * against Postgres, not against `vi.mock('db.js')` choreography.
 *
 * ## Isolation model
 *
 * One Postgres SCHEMA per vitest worker (`test_w<VITEST_WORKER_ID>`), bound
 * via the connection string: `vitest.setup.ts` appends
 * `?options=-c search_path=test_wN` to `DATABASE_URL` before anything
 * imports `config.ts`, so EVERY connection the app pool hands out — including
 * the module-level `pool` import repositories use — resolves unqualified
 * table names into the worker's schema. That is what lets this harness change
 * zero production code: `db.ts`, `migrate.ts` and `transaction.ts` run as-is.
 *
 * Parallel workers therefore cannot observe each other's rows (asserted
 * explicitly by the two db-harness smoke files, which run in different
 * workers against the same table names).
 *
 * ## Lifecycle
 *
 * - `initDbHarness()` (call in `beforeAll`): creates the worker schema if
 *   absent and runs `runMigrations()` — cheap on re-entry, because the
 *   runner's own `schema_migrations` table (created inside the worker
 *   schema) records applied versions. Vitest isolates module state per test
 *   FILE, so this init runs once per file — idempotency, not module state,
 *   is what keeps it from re-applying the full migration set every time
 *   (dozens and growing — never a fixed number here, it goes stale; the
 *   first file per worker DOES pay the full run, which is why
 *   vitest.config.ts sets an explicit hookTimeout, #1372).
 * - `resetDb()` (call in `beforeEach`): truncates every table in the worker
 *   schema except `schema_migrations`, `RESTART IDENTITY CASCADE`.
 *
 * ## When Postgres is absent
 *
 * The policy is one pure function in `db-availability.ts`; read it there.
 * In summary (#1763):
 *
 * - In CI (`process.env.CI`), the run FAILS. A green suite that silently
 *   skipped every DB test is the worst outcome this epic can have — CI must
 *   fail, never skip.
 * - Locally the run also fails **by default**, before collection, from
 *   `vitest.global-setup.ts`. Start a database with `docker compose up -d
 *   postgres` (repo root), which serves
 *   `postgres://haven:haven@localhost:5432/haven` — the same credentials
 *   CI's service container uses.
 * - `HAVEN_SKIP_DB_TESTS=1` accepts a narrowed run: `describeDb` degrades to
 *   `describe.skip`, and the run closes with a banner naming how many
 *   real-DB files did not run. The inversion is #1763's answer to a run that
 *   warned at import time and then exited 0 — nobody scrolls back.
 *
 * ## What does NOT belong here
 *
 * No domain fixtures — no agents, safes, payments. Row builders live in the
 * repository test files that need them (and get promoted only when a second
 * file needs the same one).
 */
import { describe } from 'vitest'
import db from '../../../db.js'
import {
  acquireAdvisoryLockByPolling,
  releaseAdvisoryLock,
} from '../../../db/advisory-lock.js'
import { runMigrations } from '../../../db/migrate.js'
import {
  ciFailureMessage,
  decideDbMode,
  probeDatabase,
  readDbModeInputs,
  resolveTestDatabaseUrl,
  SKIP_ACK_ENV,
  unacknowledgedFailureMessage,
} from './db-availability.js'

export const WORKER_SCHEMA = `test_w${process.env.VITEST_WORKER_ID ?? '0'}`

// One probe per module load (= per test file). The probe itself and the
// decision it feeds live in `db-availability.ts` (#1763), shared with
// `vitest.global-setup.ts` so the run-level verdict and the per-file one can
// never disagree.
const mode = decideDbMode({
  available: await probeDatabase(resolveTestDatabaseUrl()),
  ...readDbModeInputs(),
})

// Kept here as well as in global setup, deliberately: this module is the last
// line of defence for anyone who runs vitest with a config that does not load
// the global setup. CI must FAIL, never skip.
if (mode === 'fail-ci') throw new Error(ciFailureMessage(resolveTestDatabaseUrl()))

// `fail-unacknowledged` never reaches a test file — global setup refuses the
// run before collection. If it somehow does (a config without globalSetup),
// treat it the same as CI: refusing is the safe direction, and the message
// names the way out.
// The SAME message global setup uses, not a second wording of it (#1763
// review finding) — this module's whole premise is that one decision must not
// exist in two forms that can drift apart.
if (mode === 'fail-unacknowledged') {
  throw new Error(unacknowledgedFailureMessage(resolveTestDatabaseUrl()))
}

const dbAvailable = mode === 'run'

// The end-of-run banner is global setup's job (#1763). This import-time line
// stays only as an inline marker next to the first skipped file — it is the
// thing that scrolls away, which is exactly why it is no longer the only
// signal.
if (!dbAvailable) {
  console.warn(
    `db-harness: no database reachable — real-DB suites SKIPPED (${SKIP_ACK_ENV}=1). ` +
      'See the summary at the END of this run.',
  )
}

/**
 * `describe` when a database is reachable, `describe.skip` otherwise
 * (local only — CI throws above instead). Wrap every real-DB suite in this.
 * Typed explicitly: vitest's inferred suite type references unexported
 * internals, which TS4023s under declaration emit.
 */
export const describeDb: typeof describe = dbAvailable
  ? describe
  : (describe.skip as typeof describe)

/**
 * The global lock that serialises migration runs across vitest workers.
 * Distinct from the migration runner's cross-replica lane lock and from
 * `LEADER_LOCK_KEYS` (`platform/leader-lock.ts`).
 */
const MIGRATION_LOCK_KEY = 811000061

/**
 * How often a waiting worker retries the lock.
 *
 * Shorter than the migration runner's 250 ms, and the difference follows from
 * what each side is waiting for. The runner waits once per process boot, for a
 * production index build measured in minutes, so a quarter-second of extra
 * latency is free. A vitest worker pays up to one interval on EVERY test file
 * that reaches the harness, so the interval shows up as run-wide startup
 * latency. 50 ms keeps that imperceptible; the cost is ~20 `pg_try_advisory_lock`
 * calls per second per waiting worker, which is nothing next to the migration
 * DDL the lock holder is running.
 */
const LOCK_POLL_INTERVAL_MS = 50

/**
 * How long a worker keeps trying before failing the run.
 *
 * Deliberately LARGER than `vitest.config.ts`'s 120 s `hookTimeout`, and that
 * ordering is the whole point. The lock genuinely has to be held for one
 * worker's full migration run, EVERY waiting worker's wait is the sum of the
 * runs ahead of it, and CI runs several workers against one Postgres. A
 * deadline tight enough to expire under that load would convert a slow-but-
 * correct run into a failure — a harness that intermittently refuses to
 * acquire is worse than the deadlock this polling replaced, because it
 * surfaces as flakiness across every real-DB suite and gets misdiagnosed as
 * contention. So the effective budget is unchanged from the blocking form it
 * replaces: vitest's `hookTimeout` is still what bounds a stuck run, and this
 * deadline is a backstop against hanging forever for a non-vitest caller.
 *
 * `onSlowWait` is what recovers the diagnosis that a too-tight deadline would
 * have bought: a long wait names the lock while it is still happening, instead
 * of surfacing as an anonymous "hook timed out".
 */
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000

/** When a wait becomes worth mentioning. Well inside `hookTimeout`. */
const LOCK_SLOW_WAIT_MS = 30 * 1000

let ready: Promise<void> | null = null

/**
 * Create the worker schema (if absent) and bring it to the current migration
 * head. Idempotent and re-entrant; call from `beforeAll` in every real-DB
 * test file.
 */
export function initDbHarness(): Promise<void> {
  ready ??= (async () => {
    // Explicitly qualified — CREATE SCHEMA ignores search_path.
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${WORKER_SCHEMA}`)
    // SERIALISE migration runs across workers (#1562, found by #1559's CI):
    // two workers applying the full migration set concurrently into fresh
    // schemas can deadlock in Postgres (40P01 on AccessExclusive locks — the
    // DDL touches shared catalog state even though the schemas differ), and
    // every added real-DB test file raises the concurrency. A GLOBAL
    // advisory lock makes builds sequential; re-runs after the first are a
    // no-op schema_migrations read, so the cost is bounded to run start.
    // Held on a dedicated connection: pg advisory locks are session-scoped,
    // and the pool would otherwise hand the lock's session to someone else.
    //
    // The wait is POLLED, never blocking (#2198) — see `advisory-lock.ts` for
    // why, and `LOCK_POLL_INTERVAL_MS` / `LOCK_WAIT_TIMEOUT_MS` below for why
    // this caller's numbers differ from the migration runner's.
    const lockHolder = await db.connect()
    try {
      await acquireAdvisoryLockByPolling(lockHolder, {
        key: MIGRATION_LOCK_KEY,
        pollIntervalMs: LOCK_POLL_INTERVAL_MS,
        timeoutMs: LOCK_WAIT_TIMEOUT_MS,
        slowWaitAfterMs: LOCK_SLOW_WAIT_MS,
        onSlowWait: (waited) => {
          console.warn(
            `db-harness: still waiting ${Math.round(waited / 1000)}s for advisory lock ` +
              `${MIGRATION_LOCK_KEY} (another vitest worker is applying migrations). ` +
              'If this never clears, look for a session holding it in pg_locks.',
          )
        },
        describeTimeout: (waited) =>
          `db-harness: gave up after ${Math.round(waited / 1000)}s waiting for advisory lock ` +
          `${MIGRATION_LOCK_KEY}, which serialises migration runs across vitest workers. ` +
          'Another worker is stuck applying migrations, or a session is holding the lock ' +
          'without releasing it (check pg_locks where locktype = \'advisory\'). ' +
          'Refusing to run migrations unserialised — see db-harness.ts.',
      })
      try {
        // The runner creates/reads `schema_migrations` UNQUALIFIED, so it
        // lives in the worker schema and tracks that schema's versions.
        await runMigrations()
      } finally {
        await releaseAdvisoryLock(lockHolder, MIGRATION_LOCK_KEY)
      }
    } finally {
      lockHolder.release()
    }
  })()
  return ready
}

/**
 * Truncate every table in the worker schema except `schema_migrations`.
 * Call from `beforeEach`. Truncation over per-test transaction wrapping is
 * deliberate (#1220): the code under test uses `withTransaction` itself, and
 * an outer wrapper would make real BEGIN/ROLLBACK behaviour untestable —
 * which is precisely a guarantee this epic exists to prove.
 *
 * AWAITS `initDbHarness()` first, deliberately. The #1555/#1559 outbound
 * files called `initDbHarness()` bare at describe-registration time — the
 * returned promise was never awaited, so whenever a NEW migration had to
 * apply (fresh CI schema), the first tests ran CONCURRENTLY with their own
 * worker's migration DDL: 42P01 "relation does not exist" when a table was
 * not there yet, 40P01 deadlocks when the DDL's AccessExclusive/ShareRow-
 * Exclusive locks collided with the test's queries (three CI hits on
 * 2026-08-19, all on unrelated PRs). Awaiting here makes the ordering a
 * harness GUARANTEE for every file that uses `resetDb` in `beforeEach` —
 * a forgotten await at a call site degrades to correct, not to a race.
 * Init is idempotent and memoised, so this costs one resolved-promise await
 * after the first call.
 */
export async function resetDb(): Promise<void> {
  await initDbHarness()
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> 'schema_migrations'`,
    [WORKER_SCHEMA],
  )
  if (rows.length === 0) return
  const tables = rows.map((r) => `${WORKER_SCHEMA}."${r.tablename}"`).join(', ')
  await db.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`)
}
