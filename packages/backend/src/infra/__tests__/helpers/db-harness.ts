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
const SLOW_HARNESS_CALL_MS = 2_000

/**
 * Run `work`, announcing it as the cause WHILE it is still slow.
 *
 * The same shape as `onSlowWait` above and for the same reason: a diagnosis
 * printed after the fact never runs, because the timeout kills the test first.
 * A fast call stays completely silent — the closing duration line is printed
 * only when the warning already fired, so the log gains nothing on a good run.
 */
async function withSlowAnnouncement<T>(label: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  let warned = false
  const timer = setTimeout(() => {
    warned = true
    console.warn(
      `db-harness: ${label} has been running ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s — the HARNESS SETUP is what is ` +
        'slow here, not the test body. Both harness entry points await the same memoised ' +
        "migration run, which brings this worker's schema to the migration head and " +
        'serialises that run across vitest ' +
        `workers on advisory lock ${MIGRATION_LOCK_KEY}, so a cold call under CI ` +
        'contention costs seconds. If this call sits in an `it` body it is charged to ' +
        "vitest's 5000 ms testTimeout and will surface as an anonymous " +
        '"Test timed out in 5000ms" naming an innocent test; move it into ' +
        "`beforeAll`/`beforeEach`, where vitest.config.ts's hookTimeout budgets it " +
        '(#2329).',
    )
  }, SLOW_HARNESS_CALL_MS)
  // Never keep the process alive for a diagnostic.
  timer.unref?.()
  try {
    return await work()
  } finally {
    clearTimeout(timer)
    if (warned) {
      console.warn(`db-harness: ${label} finished after ${Date.now() - startedAt}ms.`)
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
  return withSlowAnnouncement('initDbHarness()', ensureMigrated)
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
  return order.length === tables.length ? order : null
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
 * `planDeleteOrder` returning `null`, never by swallowing an error.
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

async function performReset(): Promise<void> {
  await ensureMigrated()
  const { tables, fks, sequences } = await readSchemaShape()
  if (tables.length === 0) return

  const order = planDeleteOrder(
    tables,
    fks.map(([child, parent]) => ({ child, parent })),
  )
  if (order === null) {
    // No valid delete order exists. Fall back to the pre-#2211 shape, which
    // does not need one.
    await db.query(
      `TRUNCATE ${tables.map(qualify).join(', ')} RESTART IDENTITY CASCADE`,
    )
    return
  }

  const statements = [
    ...order.map((table) => `DELETE FROM ${qualify(table)};`),
    ...sequences.map((sequence) => `ALTER SEQUENCE ${WORKER_SCHEMA}.${quote(sequence)} RESTART;`),
  ]
  await db.query(statements.join('\n'))
}
