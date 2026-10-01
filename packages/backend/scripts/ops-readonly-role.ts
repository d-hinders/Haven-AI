/**
 * Print the ops console's read-only role SQL (#3510) for an operator to run.
 *
 *   npm run ops:readonly-role-sql -w packages/backend -- [--role haven_ops_readonly] [--schema public]
 *
 * Paste the output into the database console (Railway → Postgres → Query) as
 * a superuser, then give the role a login and set OPS_DATABASE_URL — the full
 * steps are in the ops-console runbook. The script is idempotent: re-run it
 * after any migration that adds a column the ops console should read. It
 * refuses (raises, grants nothing) while a granted free-text column still
 * holds an unredacted vendor secret.
 */
import { buildOpsReadonlyRoleSql, DEFAULT_OPS_READONLY_ROLE } from '../src/infra/ops-readonly-role.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

process.stdout.write(buildOpsReadonlyRoleSql({ role: arg('role', DEFAULT_OPS_READONLY_ROLE), schema: arg('schema', 'public') }))
