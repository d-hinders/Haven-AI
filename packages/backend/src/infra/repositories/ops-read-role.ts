/**
 * The ops read pool's self-check (#3510). Convention: `README.md` in this directory.
 *
 * `config/ops.ts` refuses an `OPS_DATABASE_URL` that logs in as the main
 * user, but a URL is only a claim about privileges. Before the first ops
 * data read, the pool asks the database what the login can actually do, and
 * refuses — for the life of the process — a login that can read a withheld
 * credential column, write, create objects, or run outside a read-only
 * transaction. A superuser answers true to every privilege question, so it
 * is refused here too.
 */
import type { Executor, QueryRow } from '../transaction.js'

export const OPS_READ_ROLE_SELF_CHECK_SQL = `
  SELECT has_column_privilege('users', 'password_hash', 'SELECT') AS reads_password_hash,
         has_column_privilege('payment_intents', 'signature', 'SELECT') AS reads_signature,
         has_table_privilege('users', 'INSERT') OR has_table_privilege('users', 'UPDATE')
           OR has_table_privilege('users', 'DELETE') AS writes_users,
         has_schema_privilege(current_schema(), 'CREATE') AS creates_in_schema,
         current_setting('default_transaction_read_only') = 'on' AS read_only`

interface SelfCheckRow {
  reads_password_hash: boolean
  reads_signature: boolean
  writes_users: boolean
  creates_in_schema: boolean
  read_only: boolean
}

/** Thrown by the guarded executor when the login is not the read-only role. */
export class OpsReadRoleUnsafeError extends Error {
  constructor(public readonly problems: string[]) {
    super(`OPS_DATABASE_URL is not the read-only role: ${problems.join(', ')}`)
    this.name = 'OpsReadRoleUnsafeError'
  }
}

/** What is wrong with this login, or [] when it is the read-only role. */
export async function opsReadRoleProblems(db: Executor): Promise<string[]> {
  const { rows } = await db.query<SelfCheckRow>(OPS_READ_ROLE_SELF_CHECK_SQL)
  const row = rows[0]
  const problems: string[] = []
  if (row.reads_password_hash) problems.push('can read users.password_hash')
  if (row.reads_signature) problems.push('can read payment_intents.signature')
  if (row.writes_users) problems.push('can write users')
  if (row.creates_in_schema) problems.push('can CREATE in its schema')
  if (!row.read_only) problems.push('default_transaction_read_only is off')
  return problems
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
