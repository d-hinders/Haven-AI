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
import {
  newViolations,
  hasShrunk,
  writeBaseline,
  loadBaseline,
  updateRefusals,
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  runGate,
} from './lib/ratchet.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_PATH = join(REPO_ROOT, 'packages', 'backend', 'db-mock-baseline.json')
const SCAN_DIR = join(REPO_ROOT, 'packages', 'backend', 'src')

const DB_MOCK_RE = /vi\.mock\(\s*['"][^'"]*\/db\.js['"]/g
const POSITIONAL_RE = /mockResolvedValueOnce/g
const EXEMPT_RE = /\/\/ db-mock-exempt: .{20,}/

/**
 * Blank out `//` line comments and block comments, keeping string and
 * template literals intact (#3048). The ratchet used to run POSITIONAL_RE on
 * the raw source, so a doc comment that NAMES the counted token — and house
 * comments name it constantly, because it is the ratchet's own subject —
 * counted itself as a phantom positional seed (`contacts.test.ts` went
 * 6 → 7 on PR #3044 with zero new calls). Only comments are removed; the
 * text is replaced with spaces so nothing else shifts. Strings are tracked
 * because a `//` inside `'https://…'` is not a comment, and template
 * literals because a backtick string may span lines. Regex literals are NOT
 * tracked — three consequences, all absent from the tree today (review of
 * #3049 probed every backend test file): a `//` inside a regex (`/\/\//`)
 * blanks the rest of that line, so a real call AFTER it on the same line is
 * missed; a `/*` inside a regex (`/\/*$/`) opens a phantom block comment
 * that swallows real calls until the next `*` `/`; a quote inside a regex
 * (`/'/`) followed by a comment naming the token over-counts it. Parsing
 * regex literals is what a real tokenizer is for; if one of these shapes
 * ever lands in a test, this is the comment to come back to. The two other
 * strippers in the repo were not reused on purpose:
 * `scripts/ci/lib/strip-comments.mjs` is the prose-claim scanner's (no
 * string tracking, joins literals) and `stripCommentsOutsideStrings` in
 * `packages/backend/src/openapi/route-inventory.ts` is TypeScript.
 */
export function stripComments(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && next === '*') {
      out += '  '; i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '; i++
      }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c; i++
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) { out += source[i] + source[i + 1]; i += 2; continue }
        if (quote !== '`' && source[i] === '\n') break
        out += source[i]; i++
      }
      if (i < n) { out += source[i]; i++ }
      continue
    }
    out += c; i++
  }
  return out
}

/** Count both patterns in one file's source; null when the file is exempt. */
export function scanSource(source) {
  if (EXEMPT_RE.test(source)) return null
  const counts = {}
  const dbMocks = source.match(DB_MOCK_RE)?.length ?? 0
  // Code, not prose (#3048). The db.js count stays on the raw source by the
  // issue's scope; its token does not appear in comments today.
  const positional = stripComments(source).match(POSITIONAL_RE)?.length ?? 0
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
  const { baseline, firstRun } = loadBaseline(BASELINE_PATH)
  const acceptNew = process.argv.includes(ACCEPT_NEW_BASELINE_FLAG)
  const t = totals(counts)
  console.log(
    `db-mock gauge: ${t.dbMocks} db.js mock(s) and ${t.positional} positional ` +
      `mockResolvedValueOnce call(s) across ${t.files} test file(s).`,
  )

  if (process.argv.includes('--update')) {
    // #2728: `Object.keys(baseline).length > 0` was the wrong key. `{}` is both
    // "no baseline yet" AND what this gate writes once its debt reaches zero,
    // so the refusal switched itself off on the first successful cleanup.
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
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
  runGate('db-mock-ratchet', main)
}
