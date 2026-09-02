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
import { readdir, readFile } from 'node:fs/promises'
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
  claimRetainedWorkerIds,
  reapOrphanWorkerSchemas,
  retainedWorkerIdCeiling,
} from './src/infra/__tests__/helpers/schema-reap.js'

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

let verdict: { mode: DbMode; url: string } | null = null

/**
 * Holds this run's schema-ownership locks (#2418). Kept for the whole run and
 * closed in `teardown()`; the locks are session-scoped, so an aborted run
 * releases them by dying.
 */
let schemaOwner: import('pg').Client | null = null

/**
 * Claim this run's worker-schema ids and drop the ones no live run owns
 * (#2418).
 *
 * Here rather than in `db-harness.ts` because this is the only process that
 * spans the whole run — a per-worker fork does not, and reaping from one drops
 * a sibling's schema between its files. The reasoning, the predicate and the
 * before/after measurement live in `schema-reap.ts`.
 *
 * Entirely best-effort: every failure path warns and continues. This is a
 * performance cleanup, and a run that refused to start because it could not
 * tidy up would be a far worse defect than the ~20 ms per reset it saves.
 */
async function claimAndReapWorkerSchemas(url: string): Promise<void> {
  try {
    const { default: pg } = await import('pg')
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 })
    await client.connect()
    schemaOwner = client
    const ceiling = retainedWorkerIdCeiling()
    await claimRetainedWorkerIds(client, ceiling)

    // A SEPARATE, short-lived connection for the reap, and the separation is
    // load-bearing rather than tidy: Postgres session advisory locks are
    // re-entrant, so `pg_try_advisory_lock` run on `client` would happily
    // re-acquire the very ids `client` just claimed and report them free. The
    // reap's liveness rule would then be blind to this run's own ids, leaving
    // the retention ceiling as their only protection — which is exactly the
    // hole mutation m2 (ceiling check deleted) opened, and it emptied the
    // whole database. On its own connection the two rules are genuinely
    // independent, and either one alone still refuses.
    const reapClient = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 })
    await reapClient.connect()
    let dropped: string[]
    try {
      dropped = await reapOrphanWorkerSchemas(reapClient, { retainCeiling: ceiling })
    } finally {
      await reapClient.end().catch(() => {})
    }
    if (dropped.length > 0) {
      console.warn(
        `db-harness: reaped ${dropped.length} orphaned test_w<N> schema(s) left behind by ` +
          'killed vitest runs (#2418). Each one inflates pg_class, which is the floor of ' +
          'every warm resetDb(). The backlog is drained a budget at a time, so a large one ' +
          'shrinks over the next few runs.',
      )
    }
  } catch (err) {
    console.warn(
      `db-harness: orphaned-schema reap skipped (#2418) — ${(err as Error).message}. ` +
        'Performance cleanup only; this run is unaffected.',
    )
  }
}

export async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl()
  const { ci, acknowledged } = readDbModeInputs()
  const mode = decideDbMode({ available: await probeDatabase(url), ci, acknowledged })
  verdict = { mode, url }

  // Fail before collection rather than after: nothing downstream can turn a
  // narrowed run back into a proof, so there is no value in running it first.
  if (mode === 'fail-ci') throw new Error(ciFailureMessage(url))
  if (mode === 'fail-unacknowledged') throw new Error(unacknowledgedFailureMessage(url))

  // AFTER the verdict and BEFORE any worker starts (#2418): the reap needs a
  // reachable database, and its safety rests on no worker having claimed a
  // schema yet.
  if (mode === 'run') await claimAndReapWorkerSchemas(url)
}

export async function teardown(): Promise<void> {
  // Releases this run's schema-ownership locks (#2418) — first, so they are
  // gone even if the reporting below throws.
  await schemaOwner?.end().catch(() => {})
  schemaOwner = null

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
