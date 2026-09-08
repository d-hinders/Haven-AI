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
// `'::1'` is DEAD and stays out, which the review noticed and I first
// "fixed" by adding the bracketed form. That was wrong: `pg-connection-string`
// returns `[::1]` with brackets, and `pg` then hands that string to
// `getaddrinfo`, which fails with `ENOTFOUND [::1]`. Allowing it converts a
// clear refusal into a confusing resolver error, so an IPv6 loopback URL is
// refused deliberately rather than accidentally. Use `127.0.0.1`.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

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
async function auditAgainstReference(url) {
  // Imported, not restated. A second copy of the fingerprint SQL here would
  // diverge from the one the guard uses and report on a shape nothing enforces
  // — the failure this repo spent #2625 on. The `.ts` extension is deliberate:
  // this is `.mjs`, and Node strips the types natively (verified on the
  // version this repo runs), so the audit and the guard are the same code.
  const { readFingerprint, diffFingerprints, REFERENCE_SCHEMA } = await import(
    '../src/infra/__tests__/helpers/schema-reference.ts'
  )
  // Each schema is read through a connection bound to THAT schema (review
  // finding). Reading them all on one plain client reintroduces the exact
  // defect this commit is named for: `column_default` renders regclass, enum
  // and function references relative to the reader's `search_path`, so two
  // byte-identical schemas come back qualified differently and diff as
  // drifted. Measured on identical DDL through one plain client:
  //   ref: nextval('a.ser_id_seq'::regclass) / 'ok'::a.mood / a.f()
  //   b  : nextval('b.ser_id_seq'::regclass) / 'ok'::b.mood / b.f()
  //   diff: ["ser (columns ~fd,~id,~m)"]
  // Latent today (no such defaults exist yet) and inverted from the guard's
  // version: this one would report every schema drifted rather than none.
  const readScoped = async (schema) => {
    const scoped = new URL(url)
    scoped.searchParams.set('options', `-c search_path=${schema}`)
    const c = new pg.Client({ connectionString: scoped.toString() })
    await c.connect()
    try {
      return await readFingerprint(c, schema)
    } finally {
      await c.end()
    }
  }

  const reference = await readScoped(REFERENCE_SCHEMA)
  if (reference.length === 0) {
    throw new Error(
      `no reference to audit against — schema ${REFERENCE_SCHEMA} is empty or absent. It is ` +
        'built by a backend test run, so run the suite once first.',
    )
  }
  const lister = new pg.Client({ connectionString: url })
  await lister.connect()
  let rows
  try {
    ;({ rows } = await lister.query(
      `SELECT nspname FROM pg_namespace WHERE nspname ~ '^test_w[0-9]+$' ORDER BY (regexp_replace(nspname, '^test_w', ''))::int`,
    ))
  } finally {
    await lister.end()
  }
  const drifted = []
  for (const { nspname } of rows) {
    const differences = diffFingerprints(reference, await readScoped(nspname))
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
  // Three distinct cases, and collapsing any two of them is how a destructive
  // flag misfires: no `--keep` at all (use the default), `--keep` with a value
  // (parse it), and `--keep` as the LAST argument with no value — which must be
  // an error, not the default and not zero. `?? null` made that last case mean
  // "flag absent", which is the same silent-zero shape the empty-string check
  // below exists for.
  const raw = keepAt === -1 ? null : (argv[keepAt + 1] ?? '')
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
      process.exitCode = (await auditAgainstReference(url)) > 0 ? 1 : 0
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
    // Bounded, and it says who is in the way (review finding). `DROP SCHEMA
    // ... CASCADE` takes ACCESS EXCLUSIVE: measured blocking 11 s behind one
    // open reader transaction. Unbounded, the two outcomes against a live
    // suite are a reaper that hangs forever or one that wins the lock and
    // destroys a schema a run is mid-way through, surfacing as a cascade of
    // unrelated 42P01s in that run. This repo's own docs say many worktrees
    // share one Postgres, so `--yes` without a timeout is a foot-gun. The
    // bounded-wait-and-name-the-holder shape is `db-harness.ts`'s
    // `RESET_LOCK_WAIT_MS` (#2354).
    await client.query("SET lock_timeout = '5s'")
    for (const name of doomed) {
      try {
        await client.query(`DROP SCHEMA ${name} CASCADE`)
      } catch (err) {
        if (err.code !== '55P03') throw err
        const { rows } = await client.query(
          `SELECT pid, state, left(coalesce(query, ''), 80) AS query FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND state <> 'idle' LIMIT 3`,
        )
        throw new Error(
          `timed out waiting to drop ${name} — something is using this database. ` +
            `Active sessions: ${JSON.stringify(rows)}. Nothing was dropped after this point; ` +
            're-run when no test suite is running.',
        )
      }
    }
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
