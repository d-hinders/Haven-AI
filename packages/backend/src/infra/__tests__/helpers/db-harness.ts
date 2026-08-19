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
 * `?options=-c search_path=test_wN,public` to `DATABASE_URL` before anything
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
 * - In CI (`process.env.CI`), importing this module THROWS if the database
 *   is unreachable. A green suite that silently skipped every DB test is the
 *   worst outcome this epic can have — CI must fail, never skip.
 * - Locally, `describeDb` degrades to `describe.skip` with a warning. Start
 *   a database with: `docker compose up -d postgres` (repo root), which
 *   serves `postgres://haven:haven@localhost:5432/haven` — the same
 *   credentials CI's service container uses.
 *
 * ## What does NOT belong here
 *
 * No domain fixtures — no agents, safes, payments. Row builders live in the
 * repository test files that need them (and get promoted only when a second
 * file needs the same one).
 */
import { describe } from 'vitest'
import pg from 'pg'
import db from '../../../db.js'
import { runMigrations } from '../../../db/migrate.js'

export const WORKER_SCHEMA = `test_w${process.env.VITEST_WORKER_ID ?? '0'}`

/**
 * One probe per module load (= per test file). A dedicated client rather
 * than the app pool, so an unreachable database fails fast instead of on
 * the pool's production timeout. Retried: under a full parallel run the
 * server can briefly refuse connections at its connection ceiling, and a
 * single-attempt probe misread that as "no database" — skipping suites
 * locally and, worse, failing them in CI (#1222 hardening; the setup file
 * also caps DB_POOL_MAX so the ceiling is not normally reached).
 */
async function probeDatabase(): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3_000,
    })
    try {
      await client.connect()
      return true
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt))
    } finally {
      void client.end().catch(() => {})
    }
  }
  return false
}

const dbAvailable = await probeDatabase()

if (!dbAvailable && process.env.CI) {
  throw new Error(
    `db-harness: DATABASE_URL (${process.env.DATABASE_URL}) is unreachable, and CI=true. ` +
      'The real-DB suites must FAIL here, not skip — a green run that skipped them would ' +
      'defeat epic #1219. Check the backend_checks postgres service.',
  )
}

if (!dbAvailable) {
  console.warn(
    'db-harness: no database reachable — real-DB suites SKIPPED. ' +
      'Run `docker compose up -d postgres` (repo root) to enable them.',
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
    const lockHolder = await db.connect()
    try {
      await lockHolder.query('SELECT pg_advisory_lock(811000061)')
      try {
        // The runner creates/reads `schema_migrations` UNQUALIFIED, so it
        // lives in the worker schema and tracks that schema's versions.
        await runMigrations()
      } finally {
        await lockHolder.query('SELECT pg_advisory_unlock(811000061)')
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
