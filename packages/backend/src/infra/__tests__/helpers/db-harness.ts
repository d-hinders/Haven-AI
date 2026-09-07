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
 * - `resetDb()` (call in `beforeEach` — see the budget rule below): empties
 *   every table in the worker schema except `schema_migrations`, and restarts
 *   every advanced sequence.
 *   Since #2211 it does that with foreign-key-ordered `DELETE`s rather than
 *   `TRUNCATE`, because `TRUNCATE`'s cost is per-relation and therefore grew
 *   with the migration count; coverage is unchanged. See `resetDb` below.
 *   Since #2354 the emptying runs under an explicit relation-lock budget
 *   (`RESET_LOCK_WAIT_MS`) and fails NAMING the session that holds the lock,
 *   and the cycle fallback truncates only the cycle's footprint instead of
 *   every table. See `performReset` and *A warm reset under contention*.
 *
 * ## Call these from a HOOK, not from a test body (#2329)
 *
 * Both entry points can pay the COLD cost — the full migration run, plus (in
 * CI, where several workers share one Postgres) the wait for whichever worker
 * holds `MIGRATION_LOCK_KEY`. `vitest.config.ts` budgets exactly that with
 * `hookTimeout: 120_000` (#1372), and that budget applies only to a call made
 * from `beforeAll`/`beforeEach`. The same call as the first statement of an
 * `it` body is charged to vitest's 5000 ms `testTimeout`, which was never
 * sized for a migration run: on #2295's runner one bare `resetDb()` measured
 * 4634 ms against that 5000 ms, versus 1162 ms on green `dev` — the same 223
 * files — and two files timed out on pull requests that could not have caused
 * it (#2274, #2295).
 *
 * So the rule, enforced structurally by
 * `helpers/__tests__/harness-call-budget.test.ts`: an in-body harness call is
 * allowed only when a hook in that test's OWN `describe` (or an enclosing one)
 * also calls the harness — making the in-body call a warm one, which is how
 * the harness's own suites reset mid-test, where the reset IS the subject — or
 * when that `it` declares an explicit timeout of its own. The guard follows
 * local helper functions, so moving the call one function away does not hide
 * it. Raising `testTimeout` instead was rejected:
 * the cold path's worst case is a migration run plus every queued worker's
 * run ahead of it, which is why the lock's own deadline is deliberately
 * LARGER than `hookTimeout` — any number big enough to cover it is a number
 * at which the per-test timeout no longer detects a hung test.
 *
 * ## A warm reset under contention (#2354)
 *
 * A WARM `resetDb()` — migration run already memoised — never touches
 * `MIGRATION_LOCK_KEY`: `ensureMigrated()` returns the resolved promise and
 * the reset goes straight to the catalog read. So the advisory lock, which is
 * the whole story on the cold path, explains nothing about a warm reset that
 * misses its budget. Measured on the DELETE path (36 tables, 20 resets per
 * worker, native Postgres 16): median ~90-115 ms at 1, 2, 4 and 8 concurrent
 * workers — flat in workers, and the `DELETE`s themselves are ~5 ms of it. The
 * floor is the CATALOG READ (`readSchemaShape`), which scales with the size of
 * `pg_class` — a developer database that has accumulated hundreds of orphaned
 * `test_w<N>` schemas scans tens of thousands of rows per reset — and not with
 * the table count of one schema (10 vs 36 tables: 54 vs 59 ms). The one path
 * that scales with BOTH relations (~8 ms per relation) and workers (~2x from 1
 * to 8) is the `TRUNCATE` fallback, and under I/O saturation it reaches
 * seconds; before #2354 it truncated every table whenever any cycle existed.
 * (36 is what `readSchemaShape`'s own predicate counts on 2026-09-02 at 74
 * migrations; #2211's 38 below was true on 2026-08-30, before migration 073
 * dropped `x402_receipts` and `x402_resources` — same query, two dates.)
 *
 * What a warm reset can genuinely WAIT on is a relation lock held by another
 * session on this worker's tables — a transaction a test left open, an
 * orphaned vitest worker with the same `VITEST_WORKER_ID` (#2319 found eight
 * orphans on one machine), or an autovacuum on the `TRUNCATE` path. That wait
 * is never a healthy state, so it is bounded by `RESET_LOCK_WAIT_MS` — inside
 * the 5000 ms an in-body call runs under — and the failure names the holder
 * (pid, state, transaction age, query) instead of surfacing as an anonymous
 * "Test timed out in 5000ms". Slowness WITHOUT a holder is the machine's, and
 * the slow-call announcement now says which phase it is in so it reads as
 * that. A third wait — a pooled connection under pool exhaustion — has its
 * own bound (the pool's `connectionTimeoutMillis`) and its own named failure
 * (`describePoolTimeout`), in whichever phase first needed the pool.
 *
 * All of it is pinned by `helpers/__tests__/db-harness-reset-contention.test.ts`,
 * including the residue: a reset slowed with NO holder (a statement-level
 * trigger sleeping through one `DELETE`) must announce the warm phase, name
 * nobody, and complete — and the no-holder branch of the lock message must
 * say "no session holds a lock" rather than fabricate one; and a reset run
 * with every pooled connection checked out must fail naming pool exhaustion.
 * Those are the fixtures that fail the day this limit is silently closed or
 * the diagnostic starts lying.
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
export const MIGRATION_LOCK_KEY = 811000061

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

/**
 * When a harness call has been running long enough to be worth naming out loud.
 *
 * Sized to fire strictly INSIDE the smallest budget the call could be running
 * under. A harness call reached from an `it` body is charged to vitest's
 * default 5000 ms `testTimeout` and dies there with a bare
 * "Test timed out in 5000ms" that names the test and says nothing about the
 * reset — which is why #2274 and #2295 each cost a CI round trip before a
 * `dev`-baseline comparison identified the harness at all. Warning at 2000 ms
 * puts the diagnosis in the log BEFORE that timeout fires.
 * `harness-call-budget.test.ts` keeps call sites out of that budget in the
 * first place; this is the message for the case that reaches it anyway.
 *
 * Above the honest cold cost, so it is not noise: a full migration run measured
 * 572 ms locally on an unloaded native Postgres (73 migrations, 2026-09-01) and
 * 1162 ms on a green CI runner (#2295's `dev` baseline). It is the CONTENDED
 * cold path that reaches seconds — that migration run plus the wait for
 * whichever worker holds `MIGRATION_LOCK_KEY` — and that is exactly the case
 * worth a line.
 */
export const SLOW_HARNESS_CALL_MS = 2_000

/**
 * How long a WARM reset waits for a relation lock before failing with the
 * holder named (#2354).
 *
 * Sized between `SLOW_HARNESS_CALL_MS` and vitest's 5000 ms `testTimeout`, and
 * that ordering is load-bearing: the announcement fires first and says which
 * phase is stuck, this deadline fires next and says WHO holds the lock, and
 * both land before the anonymous per-test timeout an in-body call runs under
 * (the harness's own suites reset mid-test, where the reset is the subject).
 * `db-harness-reset-contention.test.ts` pins the ordering.
 *
 * Not a budget for slowness — `lock_timeout` counts only time spent waiting
 * for a lock another session HOLDS, so a busy machine with no holder never
 * trips it. A warm reset that waits this long on a relation lock is never a
 * healthy run: other vitest workers live in other schemas, so the holder is a
 * transaction this worker's own tests left open, an orphaned worker with the
 * same `VITEST_WORKER_ID`, or an autovacuum on the `TRUNCATE` path (which
 * cancels itself within `deadlock_timeout`, 1 s by default). Raising this
 * number would only hide the holder.
 */
export const RESET_LOCK_WAIT_MS = 3_000

/** The phase a harness call is in, read by the slow-call announcement. */
type PhaseReporter = (phase: string) => void

const PHASE_MIGRATION_HEAD = 'migration head'
const PHASE_ACQUIRING_CONNECTION = 'acquiring connection'

/** What `vitest.setup.ts` capped the per-worker pool at (#1222); 20 is `config.ts`'s default. */
function poolMax(): number {
  return Number(process.env.DB_POOL_MAX) || 20
}

/**
 * pg-pool's connection-acquisition timeout (`connectionTimeoutMillis`,
 * `config.dbPoolConnectionTimeout`). It carries no SQLSTATE — it never reached
 * Postgres — so it is recognised by pg-pool's own message.
 */
function isPoolTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { message: string }).message.includes('timeout exceeded when trying to connect')
  )
}

/**
 * Run `work`, announcing it as the cause WHILE it is still slow.
 *
 * The same shape as `onSlowWait` above and for the same reason: a diagnosis
 * printed after the fact never runs, because the timeout kills the test first.
 * A fast call stays completely silent — the closing duration line is printed
 * only when the warning already fired, so the log gains nothing on a good run.
 *
 * `work` receives a phase reporter, and the announcement names the phase it
 * finds (#2354): the cold explanation — the migration run and the advisory
 * lock — was printed verbatim for a warm reset blocked on a table lock, which
 * pointed the reader at the one thing a warm reset never waits on.
 */
async function withSlowAnnouncement<T>(
  label: string,
  work: (phase: PhaseReporter) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  let phase = PHASE_MIGRATION_HEAD
  let warned = false
  const timer = setTimeout(() => {
    warned = true
    const cause =
      phase === PHASE_MIGRATION_HEAD
        ? 'Both harness entry points await the same memoised migration run, which brings ' +
          "this worker's schema to the migration head and serialises that run across " +
          `vitest workers on advisory lock ${MIGRATION_LOCK_KEY}, so a cold call under CI ` +
          'contention costs seconds.'
        : phase === PHASE_ACQUIRING_CONNECTION
          ? 'The migration run is already paid; this WARM call is waiting for a POOLED ' +
            `CONNECTION — pool exhaustion: all DB_POOL_MAX=${poolMax()} of this worker's ` +
            'connections are checked out, by a test that never released one. The pool ' +
            'gives up after its connectionTimeoutMillis and the reset names that (#2354).'
          : 'The migration run is already paid, so this is a WARM call: it never waits on ' +
            `advisory lock ${MIGRATION_LOCK_KEY}. It waits on Postgres itself — a busy ` +
            'machine, which is a cost of the machine and not of the test (#2354) — on a ' +
            "session holding a lock on this worker's tables, which the reset reports by " +
            `pid after ${RESET_LOCK_WAIT_MS} ms, or on a pooled connection when all ` +
            `DB_POOL_MAX=${poolMax()} are checked out by a test that never released one, ` +
            "which the reset names after the pool's connectionTimeoutMillis."
    console.warn(
      `db-harness: ${label} has been running ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s in phase "${phase}" — the ` +
        `HARNESS is what is slow here, not the test body. ${cause} If this call sits ` +
        "in an `it` body it is charged to vitest's 5000 ms testTimeout and will surface " +
        'as an anonymous "Test timed out in 5000ms" naming an innocent test; move it ' +
        "into `beforeAll`/`beforeEach`, where vitest.config.ts's hookTimeout budgets it " +
        '(#2329).',
    )
  }, SLOW_HARNESS_CALL_MS)
  // Never keep the process alive for a diagnostic.
  timer.unref?.()
  try {
    return await work((next) => {
      phase = next
    })
  } finally {
    clearTimeout(timer)
    if (warned) {
      console.warn(
        `db-harness: ${label} finished after ${Date.now() - startedAt}ms (last phase "${phase}").`,
      )
    }
  }
}

let ready: Promise<void> | null = null

/**
 * Create the worker schema (if absent) and bring it to the current migration
 * head. Idempotent and re-entrant; call from `beforeAll` in every real-DB
 * test file.
 */
export function initDbHarness(): Promise<void> {
  // The announcement wraps the PUBLIC entry point, while the memoised body
  // below stays unannounced. That is what keeps a cold `resetDb()` — which
  // awaits the same body — from printing the paragraph twice, WITHOUT a
  // module-level "am I nested" flag: a flag cannot tell a nested call from a
  // merely concurrent one, and would silence a genuinely separate slow call
  // (haven-reviewer, #2329).
  return withSlowAnnouncement('initDbHarness()', () => ensureMigrated())
}

function ensureMigrated(): Promise<void> {
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
 * A foreign-key edge inside the worker schema: `child` references `parent`.
 * Only edges whose BOTH ends live in the worker schema are modelled — an
 * edge pointing out of the schema constrains nothing about the order in
 * which this harness empties tables it owns.
 */
export type FkEdge = { child: string; parent: string }

/**
 * Order `tables` so that every referencing table is emptied BEFORE the table
 * it references, or return `null` when the foreign-key graph contains a cycle
 * and no such order exists.
 *
 * This is the one derived thing in the reset path, and it is deliberately the
 * SAFE kind of derived: it decides an ORDER over a table list that is always
 * the complete list. A wrong answer here surfaces as a foreign-key violation
 * from `resetDb()` — loudly, on the next run — never as a table quietly left
 * dirty (#2208's lesson: an expectation derived from the thing it guards can
 * be narrowed without failing anything; a coverage set that is not derived at
 * all cannot).
 *
 * Self-references are skipped: a single `DELETE FROM t` removes every row at
 * once, and `NO ACTION`/`CASCADE` self-edges are satisfied at statement end.
 *
 * Kahn's algorithm over edges child → parent, sources first.
 */
export function planDeleteOrder(tables: string[], edges: readonly FkEdge[]): string[] | null {
  const { ordered, stuck } = topologicalSplit(tables, edges)
  return stuck.length === 0 ? ordered : null
}

/**
 * What `resetDb()` actually executes: every table Kahn's algorithm could
 * order is emptied with a `DELETE` in that order, and only the tables it could
 * NOT order — the cycle members and the tables they reference, which no
 * `DELETE` order can reach — are `TRUNCATE ... CASCADE`d (#2354).
 *
 * Before #2354 a single cycle anywhere sent EVERY table down the `TRUNCATE`
 * path — the per-relation cost #2211 removed, back in full, and the one reset
 * shape that scales with both the relation count and the number of concurrent
 * workers. Coverage is identical either way: `deleteOrder ∪ truncate` is
 * always the complete table list, and `CASCADE` re-empties (already empty)
 * referencing tables rather than refusing. The cost is now the cycle's
 * footprint instead of the schema's.
 */
export function planEmptying(
  tables: string[],
  edges: readonly FkEdge[],
): { deleteOrder: string[]; truncate: string[] } {
  const { ordered, stuck } = topologicalSplit(tables, edges)
  return { deleteOrder: ordered, truncate: stuck }
}

/**
 * Kahn's algorithm over edges child → parent, sources first. `ordered` is the
 * child-first prefix; `stuck` is every table that never reached in-degree 0,
 * in the input order — non-empty exactly when the graph has a cycle.
 */
function topologicalSplit(
  tables: string[],
  edges: readonly FkEdge[],
): { ordered: string[]; stuck: string[] } {
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]))
  const inDegree = new Map<string, number>(tables.map((t) => [t, 0]))
  for (const { child, parent } of edges) {
    if (child === parent) continue
    const childParents = parents.get(child)
    if (!childParents || !parents.has(parent) || childParents.has(parent)) continue
    childParents.add(parent)
    inDegree.set(parent, (inDegree.get(parent) ?? 0) + 1)
  }
  const queue = tables.filter((t) => inDegree.get(t) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const table = queue.shift() as string
    order.push(table)
    for (const parent of parents.get(table) as Set<string>) {
      const remaining = (inDegree.get(parent) as number) - 1
      inDegree.set(parent, remaining)
      if (remaining === 0) queue.push(parent)
    }
  }
  const placed = new Set(order)
  return { ordered: order, stuck: tables.filter((t) => !placed.has(t)) }
}

/** Quote an identifier read back from the catalog. */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function qualify(table: string): string {
  return `${WORKER_SCHEMA}.${quote(table)}`
}

type SchemaShape = { tables: string[]; fks: [string, string][]; sequences: string[] }

/**
 * Everything the reset needs about the worker schema, in ONE round trip:
 * the tables to empty, the foreign-key edges that order them, and the
 * sequences that have actually been advanced.
 *
 * Read fresh on every reset rather than cached, because test files legitimately
 * CREATE tables in the worker schema (the harness smoke files do) and a cached
 * shape would silently stop cleaning them.
 */
async function readSchemaShape(): Promise<SchemaShape> {
  const { rows } = await db.query<SchemaShape>(
    `SELECT
       (SELECT coalesce(json_agg(t.tablename ORDER BY t.tablename), '[]'::json)
          FROM pg_tables t
         WHERE t.schemaname = $1 AND t.tablename <> 'schema_migrations') AS tables,
       (SELECT coalesce(json_agg(json_build_array(child.relname, parent.relname)), '[]'::json)
          FROM pg_constraint c
          JOIN pg_class child ON child.oid = c.conrelid
          JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = c.confrelid
          JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
         WHERE c.contype = 'f'
           AND child_ns.nspname = $1
           AND parent_ns.nspname = $1) AS fks,
       (SELECT coalesce(json_agg(s.sequencename), '[]'::json)
          FROM pg_sequences s
         WHERE s.schemaname = $1 AND s.last_value IS NOT NULL) AS sequences`,
    [WORKER_SCHEMA],
  )
  return rows[0]
}

/**
 * Empty every table in the worker schema except `schema_migrations`, and
 * restart every sequence that has been advanced. Call from `beforeEach`.
 *
 * Emptying over per-test transaction wrapping is deliberate (#1220): the code
 * under test uses `withTransaction` itself, and an outer wrapper would make
 * real BEGIN/ROLLBACK behaviour untestable — which is precisely a guarantee
 * this epic exists to prove.
 *
 * ## Why `DELETE`, not `TRUNCATE` (#2211)
 *
 * The reset covers EVERY table, so its cost used to be set by the migration
 * count rather than by what the test wrote — and `TRUNCATE` costs roughly a
 * fixed amount PER RELATION, because each truncated table and each of its
 * indexes gets a fresh relfilenode. At 38 tables / 136 indexes that measured
 * ~370 ms quiet, growing with every migration; the #2209 drift guard paid
 * seven resets and timed out at 5 s under parallel load.
 *
 * `DELETE FROM` costs what the rows cost. A real-DB test leaves single-digit
 * row counts behind, so emptying all 38 tables measured ~48 ms quiet against
 * `TRUNCATE`'s ~371 ms, interleaved so catalog bloat and machine drift hit
 * both arms equally (see #2211 for the loaded numbers). Coverage is
 * identical — every table, every time — so nothing about isolation changes:
 * `db-harness-reset-cleans-everything.test.ts` proves the post-reset census
 * by enumerating `pg_tables`, not by trusting a list this file maintains.
 *
 * Two details `TRUNCATE ... RESTART IDENTITY CASCADE` gave for free and this
 * path restores explicitly:
 *
 * - **Order.** `DELETE` enforces foreign keys, so referencing tables are
 *   emptied first (`planDeleteOrder`). `CASCADE` did that implicitly. Most of
 *   this schema's foreign keys are `ON DELETE CASCADE`, which would tolerate
 *   almost any order — but not all of them are: `self_sign_agents.safe_id`
 *   (001) and `agent_rekeys.initiated_by_user_id` (065) declare no action and
 *   so default to `NO ACTION`. Those two are the reason the ordering is
 *   load-bearing rather than decorative.
 * - **Sequences.** `RESTART IDENTITY` reset them; an explicit
 *   `ALTER SEQUENCE … RESTART` does it here, for the sequences that were
 *   actually advanced.
 *
 * A foreign-key CYCLE has no valid delete order. That is not reachable in
 * today's schema, but a future migration could introduce one, so the
 * `TRUNCATE` path is kept as the fallback — chosen deterministically from
 * the plan, never by swallowing an error — and since #2354 it covers only the
 * tables the plan could not order (`planEmptying`), not the whole schema.
 *
 * The emptying runs in ONE transaction under `RESET_LOCK_WAIT_MS` (#2354): a
 * warm reset that waits on a relation lock fails naming the holder, before
 * the anonymous per-test timeout can. See *A warm reset under contention*.
 *
 * AWAITS the migration-head guarantee first, deliberately — the same memoised
 * run `initDbHarness()` exposes, reached through the private `ensureMigrated()`
 * so a cold reset announces itself once rather than twice (#2329). The
 * #1555/#1559 outbound files called `initDbHarness()` bare at
 * describe-registration time — the
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
export function resetDb(): Promise<void> {
  // The announcement wraps the WHOLE reset, init included: a cold reset's cost
  // is dominated by the migration run it awaits, and the point of the message
  // is to name the harness rather than whichever test drew the short straw.
  return withSlowAnnouncement('resetDb()', performReset)
}

async function performReset(report: PhaseReporter): Promise<void> {
  let current = PHASE_MIGRATION_HEAD
  const phase: PhaseReporter = (next) => {
    current = next
    report(next)
  }
  try {
    await performResetPhases(phase)
  } catch (err) {
    // Pool exhaustion surfaces in whichever phase first needs a pooled
    // connection — usually `catalog read`, since `readSchemaShape()` runs
    // before the dedicated client is taken — and pg-pool's bare "timeout
    // exceeded when trying to connect" says nothing about why. Name it, in
    // the phase it happened, like the lock timeout is named (#2354).
    if (isPoolTimeout(err)) throw new Error(describePoolTimeout(current, err as Error))
    throw err
  }
}

function describePoolTimeout(phaseLabel: string, cause: Error): string {
  return (
    `db-harness: resetDb() could not get a pooled connection (phase: ${phaseLabel}) — ` +
    `pool exhaustion: all DB_POOL_MAX=${poolMax()} of this worker's connections are checked ` +
    'out by a test that never released one (a `db.connect()` without `release()`, or a ' +
    'transaction client kept past its test). The pool gave up after its ' +
    'connectionTimeoutMillis (config.dbPoolConnectionTimeout). Find the leak; a rerun ' +
    `only passes if the leaking test happens not to run first (#2354). Cause: ${cause.message}`
  )
}

async function performResetPhases(phase: PhaseReporter): Promise<void> {
  phase(PHASE_MIGRATION_HEAD)
  await ensureMigrated()
  phase('catalog read')
  const { tables, fks, sequences } = await readSchemaShape()
  if (tables.length === 0) return

  const { deleteOrder, truncate } = planEmptying(
    tables,
    fks.map(([child, parent]) => ({ child, parent })),
  )
  const label =
    truncate.length === 0
      ? `emptying (${deleteOrder.length} DELETEs)`
      : `emptying (${deleteOrder.length} DELETEs, TRUNCATE fallback over ${truncate.join(', ')})`
  phase(label)

  const statements = [
    ...deleteOrder.map((table) => `DELETE FROM ${qualify(table)};`),
    // No valid delete order exists for these. The pre-#2211 shape, which does
    // not need one — scoped to the cycle's footprint since #2354.
    ...(truncate.length > 0
      ? [`TRUNCATE ${truncate.map(qualify).join(', ')} RESTART IDENTITY CASCADE;`]
      : []),
    ...sequences.map((sequence) => `ALTER SEQUENCE ${WORKER_SCHEMA}.${quote(sequence)} RESTART;`),
  ]
  await emptyUnderLockBudget(statements, label, phase)
}

/** SQLSTATE 55P03 `lock_not_available` — what `lock_timeout` raises. */
function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '55P03'
}

/**
 * Run the emptying statements in one transaction with `lock_timeout` set to
 * `RESET_LOCK_WAIT_MS`, on a dedicated connection so the setting and the
 * aborted transaction never leak into the pool. On a lock timeout, rethrow
 * with the holders named (#2354).
 *
 * The connection is acquired BEFORE the lock budget can apply, and that wait
 * is a different wait (#2354 item 1's third candidate): under pool exhaustion
 * — every one of this worker's `DB_POOL_MAX` clients checked out by a test
 * that never released — `db.connect()` blocks. It is bounded by the pool's
 * own `connectionTimeoutMillis` (`config.dbPoolConnectionTimeout`), not by
 * `RESET_LOCK_WAIT_MS`; the phase reporter says `acquiring connection` for
 * exactly that window so the announcement cannot attribute it to the
 * emptying, and `performReset` wraps the pool's bare timeout so it reads
 * like the lock one (haven-reviewer + haven-doc-reviewer, #2354). Measured
 * on the DELETE path at 1-8 workers, acquisition was a 0.1 ms median — it
 * is named here so that when it is the wait, the log says so.
 */
async function emptyUnderLockBudget(
  statements: string[],
  phaseLabel: string,
  phase: PhaseReporter,
): Promise<void> {
  phase(PHASE_ACQUIRING_CONNECTION)
  const client = await db.connect()
  phase(phaseLabel)
  try {
    await client.query(
      [
        `BEGIN;`,
        `SET LOCAL lock_timeout = ${RESET_LOCK_WAIT_MS};`,
        ...statements,
        `COMMIT;`,
      ].join('\n'),
    )
  } catch (err) {
    // The failed statement leaves the transaction aborted; clear it before the
    // connection goes back to the pool, whatever the error was.
    await client.query('ROLLBACK').catch(() => undefined)
    if (isLockTimeout(err)) throw new Error(await describeLockTimeout(phaseLabel))
    throw err
  } finally {
    client.release()
  }
}

type LockHolder = {
  pid: number
  backend_type: string
  application_name: string
  state: string | null
  xact_age_s: number | null
  query: string
}

/**
 * Every OTHER session holding a granted lock on a relation in the worker
 * schema, read after the reset's own transaction rolled back (so the reset
 * itself is not in the list). Read from the pool, not from the client that
 * just timed out.
 *
 * Exported for one reason: the no-holder branch has to be PINNED, not
 * described. When nobody holds a lock — the holder released between the
 * timeout and this read, or the timeout came from somewhere the harness did
 * not foresee — the message must say so rather than invent a session, and
 * `db-harness-reset-contention.test.ts` asserts that directly. Directly,
 * because the natural route (a holder that lets go in the microseconds
 * between the `lock_timeout` firing and this read) is not reliably
 * producible; reading the branch is the only practical pin (haven-reviewer).
 */
export async function describeLockTimeout(phaseLabel: string): Promise<string> {
  const { rows } = await db.query<LockHolder>(
    `SELECT DISTINCT a.pid, a.backend_type, a.application_name, a.state,
            extract(epoch FROM (now() - a.xact_start))::int AS xact_age_s,
            left(a.query, 160) AS query
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.granted AND n.nspname = $1 AND l.pid <> pg_backend_pid()
      ORDER BY a.pid`,
    [WORKER_SCHEMA],
  )
  const holders =
    rows.length === 0
      ? 'no session holds a lock on this schema any more — the holder released between ' +
        'the timeout and this read'
      : rows
          .map(
            (h) =>
              `pid ${h.pid} (${h.backend_type}` +
              `${h.application_name ? `, ${h.application_name}` : ''}` +
              `, ${h.state ?? 'no state'}, xact ${h.xact_age_s ?? '?'}s, ` +
              `${JSON.stringify(h.query)})`,
          )
          .join('; ')
  return (
    `db-harness: resetDb() gave up after ${RESET_LOCK_WAIT_MS} ms waiting for a relation ` +
    `lock in ${WORKER_SCHEMA} (phase: ${phaseLabel}). Held by: ${holders}. A warm reset ` +
    `never waits on migration lock ${MIGRATION_LOCK_KEY} — only on a session holding a lock ` +
    "on this worker's tables: a transaction a test left open, an orphaned vitest worker " +
    'with the same VITEST_WORKER_ID, or an autovacuum on the TRUNCATE path. Raising the ' +
    'budget would only hide the holder (#2354).'
  )
}
