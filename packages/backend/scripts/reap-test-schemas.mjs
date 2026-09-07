#!/usr/bin/env node
// Reap accumulated `test_w*` worker schemas (#2622).
//
// ## Why this exists
//
// Worker schemas are created `IF NOT EXISTS` and never dropped, and they are
// allocated per test FILE rather than per core — `VITEST_WORKER_ID` is the
// file's ordinal in the run's spec list. So the set grows with the largest run
// the machine has ever done and never shrinks: 336 measured on one developer
// machine in #2622, 170 on another.
//
// That is a standing cost independent of drift. `readSchemaShape()` scans
// `pg_class`, and `db-harness.ts`'s own docstring names orphaned schemas as the
// floor under every `resetDb()` — the cost #2211 and #2354 exist to have
// attacked. Each one is also a place inherited drift can hide.
//
// ## What it will not do
//
// Refuses any database that does not look local. This drops schemas; a
// standing rule in this repo is that nothing automated writes to a production
// database, and "the operator passed the wrong URL" is exactly the case a
// destructive script has to survive. There is no override flag, deliberately:
// a flag would be used.
//
// Usage:
//   node scripts/reap-test-schemas.mjs                # dry run, lists what would go
//   node scripts/reap-test-schemas.mjs --yes           # drop them
//   node scripts/reap-test-schemas.mjs --keep 40 --yes # keep the 40 lowest ordinals
import pg from 'pg'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db'])

/** The lowest ordinals are the ones an ordinary run reuses; the tail is dead weight. */
const DEFAULT_KEEP = 0

function parseArgs(argv) {
  const keepAt = argv.indexOf('--keep')
  return {
    apply: argv.includes('--yes'),
    keep: keepAt === -1 ? DEFAULT_KEEP : Number(argv[keepAt + 1]),
  }
}

function assertLocal(url) {
  const { hostname } = new URL(url)
  if (LOCAL_HOSTS.has(hostname)) return
  throw new Error(
    `refusing to run against host "${hostname}". This DROPS schemas, and it ` +
      'only ever makes sense against a local test database. There is no override flag.',
  )
}

async function main() {
  const { apply, keep } = parseArgs(process.argv.slice(2))
  if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep needs a non-negative integer')

  const url = process.env.DATABASE_URL ?? 'postgres://haven:haven@localhost:5432/haven'
  assertLocal(url)

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query(
      `SELECT nspname FROM pg_namespace WHERE nspname ~ '^test_w[0-9]+$' ORDER BY (regexp_replace(nspname, '^test_w', ''))::int`,
    )
    const names = rows.map((r) => r.nspname)
    const doomed = names.slice(keep)

    if (doomed.length === 0) {
      console.log(`reap-test-schemas: nothing to drop (${names.length} schema(s), keeping ${keep}).`)
      return
    }
    if (!apply) {
      console.log(
        `reap-test-schemas: DRY RUN — would drop ${doomed.length} of ${names.length} schema(s), ` +
          `keeping the ${keep} lowest ordinal(s).\n  ${doomed.join('\n  ')}\n\n` +
          'Re-run with --yes to apply. The next test run recreates whatever it needs, paying a ' +
          'full migration set for each schema it touches.',
      )
      return
    }
    for (const name of doomed) await client.query(`DROP SCHEMA ${name} CASCADE`)
    console.log(
      `reap-test-schemas: dropped ${doomed.length} of ${names.length} schema(s), kept ${keep}.`,
    )
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(`reap-test-schemas: ${err.message}`)
  process.exit(1)
})
