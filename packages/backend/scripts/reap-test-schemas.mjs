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
//   node scripts/reap-test-schemas.mjs --audit         # read-only: which schemas are drifted
//   node scripts/reap-test-schemas.mjs                # dry run, lists what would go
//   node scripts/reap-test-schemas.mjs --yes           # drop them
//   node scripts/reap-test-schemas.mjs --keep 40 --yes # keep the 40 lowest ordinals
import pg from 'pg'
import { parse as parseConnectionString } from 'pg-connection-string'

// Loopback only, and only forms `pg-connection-string` actually yields.
//
// `postgres` and `db` were here and are REMOVED (review finding): they are
// ordinary DNS names inside Kubernetes and compose namespaces, including
// production ones, and are not local by any definition. A guard whose whole
// contract is "there is no override flag" cannot also allow-list two names
// that resolve to whatever the cluster says.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** The lowest ordinals are the ones an ordinary run reuses; the tail is dead weight. */
const DEFAULT_KEEP = 0

/**
 * Compare EVERY `test_w*` schema against the run reference (#2622 review, B2).
 *
 * Exists because a claim I made needed it and could not be supported without
 * it. The PR body said "none of the 167 accumulated schemas tripped the guard —
 * the reservoir is currently clean". A run visits only the ordinals its files
 * draw (62 real-DB files against 177 schemas), so a green suite says nothing
 * about the rest — and the reviewer falsified the sentence by running a green
 * suite over a database containing two drifted schemas.
 *
 * The guard is per-file and stays that way; this is the whole-reservoir
 * question, which is a different one and needed its own instrument rather than
 * a softer sentence. Read-only: it names schemas, it never drops one.
 */
async function auditAgainstReference(client) {
  // Imported, not restated. A second copy of the fingerprint SQL here would
  // diverge from the one the guard uses and report on a shape nothing enforces
  // — the failure this repo spent #2625 on. The `.ts` extension is deliberate:
  // this is `.mjs`, and Node strips the types natively (verified on the
  // version this repo runs), so the audit and the guard are the same code.
  const { readFingerprint, diffFingerprints, REFERENCE_SCHEMA } = await import(
    '../src/infra/__tests__/helpers/schema-reference.ts'
  )
  const reference = await readFingerprint(client, REFERENCE_SCHEMA)
  if (reference.length === 0) {
    throw new Error(
      `no reference to audit against — schema ${REFERENCE_SCHEMA} is empty or absent. It is ` +
        'built by a backend test run, so run the suite once first.',
    )
  }
  const { rows } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname ~ '^test_w[0-9]+$' ORDER BY (regexp_replace(nspname, '^test_w', ''))::int`,
  )
  const drifted = []
  for (const { nspname } of rows) {
    const differences = diffFingerprints(reference, await readFingerprint(client, nspname))
    if (differences.length > 0) drifted.push({ schema: nspname, differences })
  }
  console.log(
    `reap-test-schemas: audited ${rows.length} schema(s) against ${REFERENCE_SCHEMA} ` +
      `(${reference.length} tables) — ${drifted.length} drifted.`,
  )
  for (const d of drifted) console.log(`  ${d.schema}: ${d.differences.join('; ')}`)
  return drifted.length
}

function parseArgs(argv) {
  const keepAt = argv.indexOf('--keep')
  // `Number('') === 0`, so `--keep "$N"` with N unset used to mean "drop
  // everything" (review finding). For a destructive script an empty value is
  // a missing value, not a zero.
  const raw = keepAt === -1 ? null : argv[keepAt + 1]
  return {
    apply: argv.includes('--yes'),
    audit: argv.includes('--audit'),
    keep: raw === null ? DEFAULT_KEEP : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN,
  }
}

/**
 * Refuse anything but a loopback database.
 *
 * The host is taken from `pg-connection-string`'s parse — the host `pg` will
 * ACTUALLY DIAL — not from `new URL(...).hostname` (review finding, blocking).
 * A `?host=` query parameter overrides the URL's host for the driver while
 * leaving `new URL().hostname` reading `localhost`, so the earlier check
 * returned cleanly and pg then connected to the foreign host:
 *
 *   postgres://…@localhost:5432/haven?host=prod-db.example.com
 *     new URL().hostname -> "localhost"      (guard passed)
 *     pg dials           -> "prod-db.example.com"
 *
 * Fail CLOSED on anything unparseable or hostless, including unix sockets: a
 * destructive script has no business guessing.
 */
function assertLocal(url) {
  let host
  try {
    host = parseConnectionString(url).host
  } catch (err) {
    throw new Error(`refusing to run: could not parse DATABASE_URL (${err.message}).`)
  }
  if (host && LOCAL_HOSTS.has(host)) return
  throw new Error(
    `refusing to run against host ${JSON.stringify(host ?? null)}. This DROPS schemas, and it ` +
      'only ever makes sense against a loopback test database. There is no override flag. ' +
      '(The host checked is the one pg will DIAL, which a `?host=` parameter can differ from ' +
      "the URL's own hostname.)",
  )
}

async function main() {
  const { apply, keep, audit } = parseArgs(process.argv.slice(2))
  if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep needs a non-negative integer')

  // NOTE: this default restates `DEFAULT_TEST_DATABASE_URL`, which
  // `db-availability.test.ts`'s divergence guard forbids for every other entry
  // point. It is unavoidable here — this is `.mjs` and cannot import the `.ts`
  // constant — so it is called out rather than left to look like an oversight.
  // It is also the least dangerous copy in the tree: a stale value here makes
  // the script refuse or find nothing, never drop the wrong thing.
  const url = process.env.DATABASE_URL ?? 'postgres://haven:haven@localhost:5432/haven'
  assertLocal(url)

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    if (audit) {
      // Read-only, and it never drops: an audit that could destroy the thing
      // it is reporting on is not an audit.
      process.exitCode = (await auditAgainstReference(client)) > 0 ? 1 : 0
      return
    }
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
