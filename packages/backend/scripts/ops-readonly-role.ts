/**
 * Print the ops console's read-only role SQL (#3510) for an operator to run.
 *
 *   npm run -s ops:readonly-role-sql -w packages/backend -- [--role haven_ops_readonly] [--schema public]
 *   npm run -s ops:readonly-role-sql -w packages/backend -- --scrub [--schema public]
 *
 * `-s` matters: without it npm prints its own `> …` banner into the output,
 * which is then not pure SQL. Paste the output into the database console
 * (Railway → Postgres → Query) as the database owner. The full steps — the
 * scrub, the role, its login, OPS_DATABASE_URL, re-running after a
 * migration — are in docs/operations/ops-readonly-role.md.
 *
 * The role script is idempotent and refuses (raises, grants nothing) while a
 * granted free-text column still holds an unredacted vendor secret; `--scrub`
 * prints the one-off clean-up for exactly that case.
 */
import { buildOpsReadonlyRoleSql, buildOpsScrubSql, DEFAULT_OPS_READONLY_ROLE } from '../src/infra/ops-readonly-role.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const schema = arg('schema', 'public')
process.stdout.write(
  process.argv.includes('--scrub')
    ? buildOpsScrubSql({ schema })
    : buildOpsReadonlyRoleSql({ role: arg('role', DEFAULT_OPS_READONLY_ROLE), schema }),
)
