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
 * The ops read-only role suite's own capability gate (#4767).
 *
 * `ops-readonly-role.test.ts` (#3510) applies a script that issues `CREATE
 * ROLE` and `ALTER ROLE`, so it needs a database role that can create roles.
 * The documented setup — `docker compose up -d postgres` — makes `haven` the
 * `POSTGRES_USER` and therefore a superuser. A native/Homebrew server usually
 * does not, and there the suite reddened 20 tests for an environment reason on
 * every run, which is how a real red gets lost in a known one.
 *
 * Same shape as `decideDbMode`, and for the same reason: the decision is one
 * pure total function, so both branches are provable without a database. The
 * asymmetry is deliberate — a machine that cannot run the suite SKIPS it with
 * a stated reason, but CI must FAIL, because CI's compose service always has
 * the capability and a green CI run that skipped it would prove nothing.
 */
export type RoleMode = 'run' | 'skip' | 'fail-ci'

export interface RoleModeInputs {
  canCreateRole: boolean
  ci: boolean
}

/** The whole policy, as one total function over two booleans. Pure. */
export function decideRoleMode({ canCreateRole, ci }: RoleModeInputs): RoleMode {
  if (canCreateRole) return 'run'
  return ci ? 'fail-ci' : 'skip'
}

/**
 * The marker the harness prints when it skips the ops read-only role suite.
 *
 * Exported so the coupling is CHECKABLE: `scripts/ci/preflight.mjs` detects
 * this string in a gate's output to list the skip apart from the green count,
 * and `scripts/ci/preflight.test.mjs` asserts the detector matches this
 * literal. A reword here without the detector would make the skip silent —
 * the same defect class the real-DB marker exists to prevent.
 */
export const OPS_ROLE_SKIP_MARKER = 'ops-role suites SKIPPED'

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
 *
 * `pg` is imported LAZILY, inside the function (review nit). `vitest.setup.ts`
 * imports this module for `DEFAULT_TEST_DATABASE_URL`, and a top-level `import
 * pg` would therefore load the driver into all 177 test files — including the
 * ~155 that never touch a database — where previously only the real-DB suites
 * paid for it. Nothing else in this module has a module-scope side effect, and
 * this keeps it that way.
 */
export async function probeDatabase(connectionString: string): Promise<boolean> {
  const { default: pg } = await import('pg')
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

/**
 * Whether the connected role can create roles — the capability the ops
 * read-only role suite needs (#4767).
 *
 * `rolsuper OR rolcreaterole`, read for `current_user` rather than for a name
 * from the connection string: the connection string's user is what the server
 * authenticates, but `current_user` is what the session actually runs as, and
 * a `SET ROLE` in a pooler's startup options would make those differ.
 *
 * A probe that cannot answer returns `false`, which is the safe direction: the
 * suite skips locally with a stated reason and FAILS in CI, rather than
 * running 20 tests that will redden on `CREATE ROLE` permission denied.
 *
 * `pg` is imported lazily for the same reason `probeDatabase` does it.
 */
export async function probeRoleCapability(connectionString: string): Promise<boolean> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3_000 })
  try {
    await client.connect()
    const { rows } = await client.query<{ can_create_role: boolean }>(
      'SELECT rolsuper OR rolcreaterole AS can_create_role FROM pg_roles WHERE rolname = current_user',
    )
    return rows[0]?.can_create_role === true
  } catch {
    return false
  } finally {
    void client.end().catch(() => {})
  }
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

/**
 * The message for the ops-role `fail-ci` branch (#4767).
 *
 * CI's `backend_checks` job runs the compose service, where `haven` is
 * `POSTGRES_USER` and therefore a superuser, so this branch firing means the
 * CI database was configured differently — not that the suite is optional.
 * Failing is the same direction as `ciFailureMessage`: a green CI run that
 * skipped the ops read-only role suite would prove nothing about the grants
 * that keep the ops console read-only.
 */
export function roleCiFailureMessage(url: string): string {
  return (
    `db-harness: the database role at ${redactDatabaseUrl(url)} cannot create roles ` +
    '(needs CREATEROLE or superuser), and CI=true. The ops read-only role suite (#3510) ' +
    'must FAIL here, not skip — CI runs `docker compose up -d postgres`, where `haven` is ' +
    'POSTGRES_USER and therefore a superuser, so this means the CI database is configured ' +
    'differently. Check the backend_checks postgres service.'
  )
}

/**
 * The message for the ops-role `skip` branch (#4767) — the local, stated
 * reason. Printed by `db-harness.ts` with `OPS_ROLE_SKIP_MARKER` in front of
 * it, so `scripts/ci/preflight.mjs` can list the skip apart from the green
 * count instead of letting it read as a pass.
 */
export function roleSkipMessage(url: string): string {
  return (
    `${OPS_ROLE_SKIP_MARKER} — the database role at ${redactDatabaseUrl(url)} cannot ` +
    'create roles (needs CREATEROLE or superuser), so the ops read-only role suite (#3510) ' +
    'did not run. `docker compose up -d postgres` provides a role that can; a native or ' +
    'Homebrew server needs `ALTER ROLE <you> CREATEROLE`. See ' +
    'docs/contributing/testing-strategy.md.'
  )
}
