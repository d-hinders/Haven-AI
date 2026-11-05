/**
 * Purge throwaway QA identities from the dev database (#4679, epic #4674).
 *
 *   npm run -s qa:purge-throwaways -w packages/backend -- [--retention-days 7] [--apply]
 *
 * Dry run is the default; `--apply` is the only way to delete. The workflow
 * `.github/workflows/qa-purge-throwaways.yml` is the supported caller: it runs
 * from `dev` only, inside the protected `qa-purge-dev` environment, and passes
 * the allowlisted target from that environment's variables.
 *
 * ## Order of guards (each one refuses before the next step)
 *
 *   1. Retention is validated as an integer from 1 to 365 — before connecting.
 *      `0`, negative and malformed values are refused; there is no zero-day
 *      override.
 *   2. The connection URL's exact host, port and database name are compared
 *      with the allowlisted tuple — before connecting.
 *   3. After connecting and BEFORE any purge query (dry run included), the
 *      server's own identity is verified: `current_database()` and
 *      `pg_control_system().system_identifier`. The database name alone proves
 *      nothing when dev and production share a default name (Railway's is
 *      `railway`); the system identifier is what distinguishes the clusters.
 *
 * Exit codes: 0 success, 1 at least one user failed (the run is not green),
 * 2 refused before or during the guard.
 *
 * The summary is counts only — no email, key or address — because the repo is
 * public.
 */

import { appendFileSync } from 'node:fs'
import pg from 'pg'
import {
  DEFAULT_RETENTION_DAYS,
  PurgeRefusal,
  allowedTargetFromEnv,
  assertServerIdentity,
  assertUrlMatchesTarget,
  parseRetentionDays,
  renderSummary,
  runPurge,
} from '../src/infra/repositories/qa-throwaway-purge.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new PurgeRefusal(`--${name} needs a value`)
  return value
}

async function run(): Promise<number> {
  const apply = process.argv.includes('--apply')
  const explicitDryRun = process.argv.includes('--dry-run')
  if (apply && explicitDryRun) throw new PurgeRefusal('--apply and --dry-run are mutually exclusive')

  // Guard 1: retention, before anything touches the network.
  const retentionDays = parseRetentionDays(argValue('retention-days') ?? String(DEFAULT_RETENTION_DAYS))

  // Guard 2: the allowlisted target, then the URL's exact tuple.
  const target = allowedTargetFromEnv()
  const connectionString = process.env.QA_PURGE_DATABASE_URL ?? process.env.DATABASE_URL
  if (!connectionString) {
    throw new PurgeRefusal('refusing to run: QA_PURGE_DATABASE_URL (or DATABASE_URL) is not set')
  }
  assertUrlMatchesTarget(connectionString, target)

  const pool = new pg.Pool({ connectionString, max: 1 })
  try {
    // Guard 3: what the server says it is, before any purge query.
    await assertServerIdentity(pool, target)

    const result = await runPurge(pool, { retentionDays, dryRun: !apply })
    const summary = renderSummary(result)
    process.stdout.write(summary)

    const summaryFile = argValue('summary-file') ?? process.env.GITHUB_STEP_SUMMARY
    if (summaryFile) appendFileSync(summaryFile, summary)

    if (result.failures.length > 0) {
      process.stderr.write(
        `\n${result.failures.length} user(s) failed; the run is NOT green. ` +
          'Each failed user was rolled back whole and left in place.\n',
      )
      return 1
    }
    return 0
  } finally {
    await pool.end()
  }
}

run()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof PurgeRefusal) {
      process.stderr.write(`refused: ${error.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
