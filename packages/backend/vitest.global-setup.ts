/**
 * Run-level database verdict (#1763, epic #1219).
 *
 * Two jobs a per-file import cannot do, because `db-harness.ts` is imported
 * once per test file inside a worker and knows nothing about the run:
 *
 * 1. **Refuse the run up front.** `setup()` probes ONCE, in the main process,
 *    before a single test file is collected. When there is no database and
 *    nobody said that was acceptable, the run stops here with an actionable
 *    message — instead of narrowing itself and exiting 0.
 * 2. **Print the verdict LAST.** `teardown()` runs after vitest's summary, so
 *    the final thing on screen is what the run actually proved about the data
 *    layer. That is the whole point of #1763: the old `console.warn` fired at
 *    import time, hundreds of lines before the summary, and the last thing a
 *    reader saw — the thing they acted on — was a green total.
 *
 * The counterpart line on the happy path is deliberate, not decoration.
 * "27/27 with zero skips" is a materially different claim from "green", and
 * until now only a human who went looking could make it. Now the run makes it.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ciFailureMessage,
  decideDbMode,
  probeDatabase,
  readDbModeInputs,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  unacknowledgedFailureMessage,
  type DbMode,
} from './src/infra/__tests__/helpers/db-availability.js'
import {
  readFingerprint,
  REFERENCE_PATH_ENV,
  REFERENCE_SCHEMA,
} from './src/infra/__tests__/helpers/schema-reference.js'
import { applyTestEnvDefaults } from './src/infra/__tests__/helpers/test-env.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src')

/**
 * Count the test files that would have run against a real database, by the
 * only signal that cannot drift from reality: importing the harness.
 *
 * A hardcoded number here would go stale the first time a real-DB file lands
 * (the count has grown steadily since #1220), and a stale denominator in a
 * "ran 0 of N" line is worse than no line — it reads as authoritative.
 */
async function countRealDbTestFiles(dir: string = SRC): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await countRealDbTestFiles(full)
      continue
    }
    if (!entry.name.endsWith('.test.ts')) continue
    const source = await readFile(full, 'utf8').catch(() => '')
    if (source.includes('db-harness.js')) total += 1
  }
  return total
}

/**
 * Build the run's pristine schema reference and publish its fingerprint (#2622).
 *
 * Runs ONCE, in the main process, before a worker exists — which is the whole
 * economy of the design. The alternative #2622 costed, dropping and recreating
 * every worker schema, pays a full migration run per FILE (worker ids are file
 * ordinals), so 63 of them per suite run here.
 *
 * The reference schema is dropped and recreated rather than reused. Reusing it
 * would reproduce the very defect this closes one level up: a stale reference
 * is worse than none, because every worker would then be compared against
 * yesterday's drift and report clean.
 *
 * `DATABASE_URL` is repointed before the migration runner is imported, because
 * `getPool()` is memoised and `config.ts` reads the URL at import time. The
 * pool is ended in the `finally`, or vitest waits on an open handle.
 */
async function buildSchemaReference(url: string): Promise<void> {
  // Before ANY import that reaches `config.ts`. Global setup runs ahead of
  // setup files, so nothing has applied these yet and the migration runner
  // would die on `Missing required environment variable: JWT_SECRET`.
  applyTestEnvDefaults()
  const pg = (await import('pg')).default
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${REFERENCE_SCHEMA} CASCADE`)
    await admin.query(`CREATE SCHEMA ${REFERENCE_SCHEMA}`)
  } finally {
    await admin.end()
  }

  const scoped = new URL(url)
  scoped.searchParams.set('options', `-c search_path=${REFERENCE_SCHEMA}`)
  const previousUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = scoped.toString()
  try {
    const { runMigrations } = await import('./src/db/migrate.js')
    await runMigrations()
  } finally {
    // In the `finally`, because `runMigrations()` calls `getPool()` itself:
    // a throw would otherwise leave a live memoised pool in the main process,
    // which is what the docstring above always claimed this line prevented
    // (review finding — it was inside the `try`, after the throwing call).
    const { getPool } = await import('./src/db.js')
    await getPool().end()
    process.env.DATABASE_URL = previousUrl
  }

  // Read the reference through the SAME `search_path` shape the workers use
  // (review finding, blocking). `information_schema.columns.column_default`
  // renders `regclass` references RELATIVE TO THE READER'S search_path, so a
  // plain connection reports `nextval('test_schema_reference.x_id_seq'::regclass)`
  // where a worker bound to its own schema reports `nextval('x_id_seq'::regclass)`
  // — two byte-identical schemas diffing as drifted. Measured directly on a
  // scratch schema.
  //
  // Latent today only because every migration uses `uuid`/`gen_random_uuid()`
  // (verified: zero `nextval` defaults in the reference). The first migration
  // adding a `SERIAL`, a schema-local function default or an enum cast would
  // turn EVERY real-DB file in every run red — with a message that is wrong and
  // a repair (`DROP SCHEMA test_wN CASCADE`) that destroys work without helping,
  // because the recreated schema renders the default the same way.
  const reader = new pg.Client({ connectionString: scoped.toString() })
  await reader.connect()
  let fingerprint
  try {
    fingerprint = await readFingerprint(reader, REFERENCE_SCHEMA)
  } finally {
    await reader.end()
  }
  // A reference of zero tables is never right, and it is reachable: another
  // session dropping `test_schema_reference` in the window between the
  // migration run and this read leaves `readFingerprint` returning `[]` with no
  // error, which would publish an empty reference and redden every real-DB file
  // with "34 tables present that head does not have" — each advising a
  // destructive `DROP SCHEMA`. Fail here instead (review finding).
  if (fingerprint.length === 0) {
    throw new Error(
      `db-harness: the schema reference ${REFERENCE_SCHEMA} fingerprinted as EMPTY right after ` +
        'its migration run. Something removed it concurrently — another session, or a manual ' +
        'DROP. Re-run; if it repeats, the migration runner is not writing into that schema.',
    )
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'haven-schema-ref-'))
  const file = path.join(dir, 'reference.json')
  await writeFile(file, JSON.stringify(fingerprint))
  // Workers inherit the main process's env, so this is the transport — verified
  // rather than assumed: a probe set here was read back inside a worker.
  process.env[REFERENCE_PATH_ENV] = file
  referenceDir = dir
}

let verdict: { mode: DbMode; url: string } | null = null
let referenceDir: string | null = null

export async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl()
  const { ci, acknowledged } = readDbModeInputs()
  const mode = decideDbMode({ available: await probeDatabase(url), ci, acknowledged })
  verdict = { mode, url }

  // Fail before collection rather than after: nothing downstream can turn a
  // narrowed run back into a proof, so there is no value in running it first.
  if (mode === 'fail-ci') throw new Error(ciFailureMessage(url))
  if (mode === 'fail-unacknowledged') throw new Error(unacknowledgedFailureMessage(url))

  if (mode === 'run') await buildSchemaReference(url)
}

export async function teardown(): Promise<void> {
  if (referenceDir) await rm(referenceDir, { recursive: true, force: true })
  if (!verdict) return
  const { mode, url } = verdict

  // The two failing modes already threw out of `setup()` with a message of
  // their own; a second, differently-worded banner underneath it would only
  // compete with it.
  if (mode !== 'run' && mode !== 'skip-acknowledged') return

  if (mode === 'run') {
    // One line, on purpose. A banner nobody needs to read trains people to
    // skip the banner they do.
    console.log(`\n✔ real-DB suites ENABLED against ${redactDatabaseUrl(url)} — nothing was skipped for want of a database.`)
    return
  }

  const files = await countRealDbTestFiles()
  const rule = '─'.repeat(74)
  console.warn(
    [
      '',
      rule,
      // Phrased as "0 ran", not "0 of N selected": a scoped `vitest run <path>`
      // may have selected fewer than N, and the honest claim is that none of
      // them ran, whichever were asked for.
      `⚠  REAL-DB SUITES SKIPPED — 0 real-DB test files ran (this package has ${files}).`,
      '',
      `   No database was reachable at ${redactDatabaseUrl(url)}, and`,
      '   HAVEN_SKIP_DB_TESTS=1 accepted that. The summary above is therefore',
      '   NOT evidence about the data layer: no idempotency, locking,',
      '   constraint or transaction behaviour was exercised (epic #1219).',
      '',
      '   To prove it:   docker compose up -d postgres   (repo root)',
      rule,
      '',
    ].join('\n'),
  )
}
