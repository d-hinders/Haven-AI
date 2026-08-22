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

export async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl()
  const { ci, acknowledged } = readDbModeInputs()
  const mode = decideDbMode({ available: await probeDatabase(url), ci, acknowledged })
  verdict = { mode, url }

  // Fail before collection rather than after: nothing downstream can turn a
  // narrowed run back into a proof, so there is no value in running it first.
  if (mode === 'fail-ci') throw new Error(ciFailureMessage(url))
  if (mode === 'fail-unacknowledged') throw new Error(unacknowledgedFailureMessage(url))
}

export async function teardown(): Promise<void> {
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
