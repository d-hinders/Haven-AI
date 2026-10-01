/**
 * The ops read pool's self-check (#3510). Convention: `README.md` in this directory.
 *
 * `config/ops.ts` refuses an `OPS_DATABASE_URL` that logs in as the main
 * user, but a URL is only a claim about privileges. Before the first ops
 * data read, the pool asks the database what the login can actually do, and
 * refuses — for the life of the process — a login that can read any
 * `OPS_NEVER_GRANT` column, write any table in its schema, create objects
 * there, or run outside a read-only transaction. A superuser answers true to every privilege question, so it
 * is refused here too.
 */
import { OPS_NEVER_GRANT } from '../ops-readonly-role.js'
import type { Executor, QueryRow } from '../transaction.js'

/**
 * One boolean per question, aliased by what it detects. Generated from
 * `OPS_NEVER_GRANT`, so the list and the check cannot drift. Write access is
 * asked of EVERY table in the login's schema. With an empty search_path the
 * unqualified column checks error, so the self-check cannot run and every ops
 * read fails (retried, never remembered); the `coalesce` only guards a NULL
 * `current_schema()` the column checks did not already catch.
 */
export const OPS_READ_ROLE_SELF_CHECK_SQL = `SELECT ${[
  ...Object.keys(OPS_NEVER_GRANT).map((qualified) => {
    const [table, column] = qualified.split('.')
    return `has_column_privilege('${table}', '${column}', 'SELECT') AS "can read ${qualified}"`
  }),
  `EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
              AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')) AS "can write a table"`,
  `coalesce(has_schema_privilege(current_schema(), 'CREATE'), true) AS "can CREATE in its schema"`,
  `current_setting('default_transaction_read_only') <> 'on' AS "default_transaction_read_only is off"`,
].join(',\n       ')}`

/** Thrown by the guarded executor when the login is not the read-only role. */
export class OpsReadRoleUnsafeError extends Error {
  constructor(public readonly problems: string[]) {
    super(`OPS_DATABASE_URL is not the read-only role: ${problems.join(', ')}`)
    this.name = 'OpsReadRoleUnsafeError'
  }
}

/** What is wrong with this login, or [] when it is the read-only role. */
export async function opsReadRoleProblems(db: Executor): Promise<string[]> {
  const { rows } = await db.query<Record<string, boolean>>(OPS_READ_ROLE_SELF_CHECK_SQL)
  return Object.entries(rows[0])
    .filter(([, bad]) => bad)
    .map(([problem]) => problem)
}

/**
 * `db`, behind the self-check: the first query runs it, and an unsafe login
 * fails every query after with `OpsReadRoleUnsafeError`. A check that could
 * not run (connection error) is not remembered — the next query retries it.
 */
export function guardOpsReadExecutor(db: Executor, onUnsafe: (err: OpsReadRoleUnsafeError) => void = () => {}): Executor {
  let verdict: Promise<void> | null = null
  const verify = (): Promise<void> => {
    verdict ??= opsReadRoleProblems(db).then(
      (problems) => {
        if (problems.length === 0) return
        const err = new OpsReadRoleUnsafeError(problems)
        onUnsafe(err)
        throw err
      },
      (err: unknown) => {
        verdict = null
        throw err
      },
    )
    return verdict
  }
  return {
    async query<R extends QueryRow = QueryRow>(sql: string, values?: unknown[]) {
      await verify()
      return db.query<R>(sql, values)
    },
  }
}
