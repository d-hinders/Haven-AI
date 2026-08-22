/**
 * Database availability policy for the real-Postgres test harness (#1763,
 * epic #1219).
 *
 * Split out of `db-harness.ts` so the SAME probe and the SAME decision are
 * used in two places that must never disagree:
 *
 * - `db-harness.ts`, imported once per test FILE, which decides whether
 *   `describeDb` is `describe` or `describe.skip`;
 * - `vitest.global-setup.ts`, which runs ONCE per run in the main process and
 *   owns the two things a per-file import cannot do: refuse the run up front,
 *   and print the verdict AFTER vitest's summary.
 *
 * ## Why a policy function rather than a chain of `if`s
 *
 * `decideDbMode` is pure and total, so the policy itself is provable by
 * ordinary mocked tests that run with no database at all
 * (`__tests__/db-availability.test.ts`). That is deliberate: a guard against
 * "the suite skipped and nobody noticed" must not itself be a suite that
 * skips when there is no database. Every branch below is asserted, including
 * the two failing ones.
 *
 * ## The four modes
 *
 * | database | CI | HAVEN_SKIP_DB_TESTS=1 | mode                   |
 * |----------|----|-----------------------|------------------------|
 * | up       | *  | *                     | `run`                  |
 * | down     | y  | *                     | `fail-ci`              |
 * | down     | n  | y                     | `skip-acknowledged`    |
 * | down     | n  | n                     | `fail-unacknowledged`  |
 *
 * `fail-ci` is unchanged from #1220 — a green CI run that skipped every DB
 * test defeats the epic. `fail-unacknowledged` is the #1763 inversion: the
 * absence of a database is a condition you SAY you accept, not one that
 * quietly narrows what the run proved. The acknowledgement is one env var and
 * the error message names it, so the friction is one line, once.
 *
 * Note that `HAVEN_SKIP_DB_TESTS=1` is deliberately powerless in CI. It is an
 * acknowledgement by a human at a terminal, not an override.
 */

import pg from 'pg'

export const DEFAULT_TEST_DATABASE_URL = 'postgres://haven:haven@localhost:5432/haven'

/** Set to `1` to accept a locally narrowed run. Ignored in CI, by design. */
export const SKIP_ACK_ENV = 'HAVEN_SKIP_DB_TESTS'

export type DbMode = 'run' | 'skip-acknowledged' | 'fail-ci' | 'fail-unacknowledged'

export interface DbModeInputs {
  available: boolean
  ci: boolean
  acknowledged: boolean
}

/**
 * The whole policy, as one total function over three booleans. Pure — no env
 * reads, no clock, no I/O — so the tests that pin it need nothing to run.
 */
export function decideDbMode({ available, ci, acknowledged }: DbModeInputs): DbMode {
  if (available) return 'run'
  if (ci) return 'fail-ci'
  return acknowledged ? 'skip-acknowledged' : 'fail-unacknowledged'
}

/** Read the three inputs from the environment. */
export function readDbModeInputs(
  env: NodeJS.ProcessEnv = process.env,
): Omit<DbModeInputs, 'available'> {
  return {
    ci: Boolean(env.CI),
    acknowledged: env[SKIP_ACK_ENV] === '1',
  }
}

/**
 * The connection string the harness will use, with the same default
 * `vitest.setup.ts` applies. Exported so global setup — which runs BEFORE
 * setup files — resolves the identical URL rather than a second copy of the
 * literal.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
}

/**
 * Strip credentials before a connection string reaches a log line. The
 * harness has always printed `DATABASE_URL` verbatim on the CI failure path;
 * this run now prints it on more paths, and a local `.env` can carry a real
 * password.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '<unparseable DATABASE_URL>'
  }
}

const REMEDIES = [
  'Start one:   docker compose up -d postgres   (repo root)',
  `Or accept a narrowed run:   ${SKIP_ACK_ENV}=1 npm run test -w packages/backend`,
  '',
  'This fires on EVERY backend run, including a scoped `vitest run <one-file>`',
  'against a file that touches no database: the check runs before collection, so',
  `it cannot know your selection. For database-free iteration, export ${SKIP_ACK_ENV}=1`,
  'in your shell once.',
]

/**
 * One availability probe. A dedicated client rather than the app pool, so an
 * unreachable database fails fast instead of on the pool's production
 * timeout. Retried: under a full parallel run the server can briefly refuse
 * connections at its connection ceiling, and a single-attempt probe misread
 * that as "no database" — skipping suites locally and, worse, failing them in
 * CI (#1222 hardening; `vitest.setup.ts` also caps DB_POOL_MAX so the ceiling
 * is not normally reached).
 *
 * Moved here from `db-harness.ts` by #1763 so global setup can run the
 * identical probe once for the whole run.
 */
export async function probeDatabase(connectionString: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3_000 })
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

/** The message for `fail-ci`. Wording preserved from #1220 — CI must fail, never skip. */
export function ciFailureMessage(url: string): string {
  return (
    `db-harness: DATABASE_URL (${redactDatabaseUrl(url)}) is unreachable, and CI=true. ` +
    'The real-DB suites must FAIL here, not skip — a green run that skipped them would ' +
    'defeat epic #1219. Check the backend_checks postgres service.'
  )
}

/** The message for `fail-unacknowledged` — the #1763 local inversion. */
export function unacknowledgedFailureMessage(url: string): string {
  return [
    `No database is reachable at ${redactDatabaseUrl(url)}, so the real-DB suites`,
    'cannot run — and this run refuses to pretend otherwise.',
    '',
    ...REMEDIES,
    '',
    'Why this is an error and not a warning: the real-DB suites are where every',
    'claim about idempotency, locking, constraints and transactional integrity is',
    'proven (epic #1219). A run that skipped them has proven none of it, and a',
    'warning printed before hundreds of lines of output is not something anyone',
    'reads. Acknowledging is one env var; being wrong about what a green run meant',
    'has cost more than that.',
  ].join('\n')
}
