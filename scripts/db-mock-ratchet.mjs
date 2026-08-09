#!/usr/bin/env node
// Shrink-only ratchet on positional DB mocking in the backend suite
// (#1227, epic #1219).
//
// Counts two things per test file, against a committed baseline that may
// only SHRINK:
//
//   db-mock   — `vi.mock('…/db.js')` occurrences: the file fakes the
//               database wholesale
//   positional — `mockResolvedValueOnce` occurrences: the length of the
//               positional chain, which any new query in the handler
//               re-shuffles (the #775 failure mode)
//
// WHY COUNTS AND NOT A COVERAGE THRESHOLD (do not "improve" this later): a
// coverage percentage can be satisfied without proving anything and rewards
// touching whatever is easiest. These counts measure the thing that actually
// hurts — mock choreography on the money path. Database behaviour belongs in
// a repository test on the real-Postgres harness
// (src/infra/__tests__/helpers/db-harness.ts); mocking is for collaborators
// a test does not own (chain RPC, bundlers, external HTTP), not for the
// database.
//
// Escape hatch (expected to be rare): a file-level exemption comment
//   // db-mock-exempt: <reason of at least 20 chars>
// anywhere in the file removes it from BOTH counts. The reason is required;
// a bare marker does not exempt.
//
//   node scripts/db-mock-ratchet.mjs            # check against the baseline
//   node scripts/db-mock-ratchet.mjs --update   # tighten after a reduction
//                                               # (refuses to ratchet upward)
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from './lib/ratchet.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_PATH = join(REPO_ROOT, 'packages', 'backend', 'db-mock-baseline.json')
const SCAN_DIR = join(REPO_ROOT, 'packages', 'backend', 'src')

const DB_MOCK_RE = /vi\.mock\(\s*['"][^'"]*\/db\.js['"]/g
const POSITIONAL_RE = /mockResolvedValueOnce/g
const EXEMPT_RE = /\/\/ db-mock-exempt: .{20,}/

/** Count both patterns in one file's source; null when the file is exempt. */
export function scanSource(source) {
  if (EXEMPT_RE.test(source)) return null
  const counts = {}
  const dbMocks = source.match(DB_MOCK_RE)?.length ?? 0
  const positional = source.match(POSITIONAL_RE)?.length ?? 0
  if (dbMocks > 0) counts['db-mock'] = dbMocks
  if (positional > 0) counts['positional'] = positional
  return counts
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      yield* walk(p)
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      yield p
    }
  }
}

export async function scanAll() {
  const counts = {}
  for await (const file of walk(SCAN_DIR)) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    const fileCounts = scanSource(await readFile(file, 'utf8'))
    if (fileCounts && Object.keys(fileCounts).length > 0) counts[rel] = fileCounts
  }
  return counts
}

function totals(counts) {
  let dbMocks = 0
  let positional = 0
  for (const keys of Object.values(counts)) {
    dbMocks += keys['db-mock'] ?? 0
    positional += keys['positional'] ?? 0
  }
  return { dbMocks, positional, files: Object.keys(counts).length }
}

async function main() {
  const counts = await scanAll()
  const baseline = readBaseline(BASELINE_PATH)
  const t = totals(counts)
  console.log(
    `db-mock gauge: ${t.dbMocks} db.js mock(s) and ${t.positional} positional ` +
      `mockResolvedValueOnce call(s) across ${t.files} test file(s).`,
  )

  if (process.argv.includes('--update')) {
    const violations = newViolations(counts, baseline)
    if (Object.keys(baseline).length > 0 && violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      console.error(
        'Growth is a reviewed decision: use the real-DB harness instead, or add a ' +
          '`// db-mock-exempt: <reason>` with a defensible reason.',
      )
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`✓ baseline written (${BASELINE_PATH}).`)
    return
  }

  const violations = newViolations(counts, baseline)
  if (violations.length > 0) {
    console.error('\n✗ positional DB mocking grew (shrink-only baseline, #1227):\n')
    for (const v of violations) {
      console.error(`  ${v.file} [${v.key}]: baseline ${v.allowed}, now ${v.count}`)
    }
    console.error(
      '\nDatabase behaviour belongs in a repository test on the real-Postgres ' +
        'harness (src/infra/__tests__/helpers/db-harness.ts) — see ' +
        'docs/contributing/ (testing strategy). If you legitimately REDUCED ' +
        'counts elsewhere, run: node scripts/db-mock-ratchet.mjs --update',
    )
    process.exit(1)
  }

  if (hasShrunk(counts, baseline)) {
    console.log(
      '  (counts are below the baseline — lock in the progress: node scripts/db-mock-ratchet.mjs --update)',
    )
  }
  console.log('✓ no new positional DB mocking.')
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
