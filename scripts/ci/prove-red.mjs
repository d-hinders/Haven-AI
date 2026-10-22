#!/usr/bin/env node
// prove-red — one mutation runner for ship-next, quality-scan and reviewers (#4234).
//
// Usage (run from inside the tree being mutated, never the main checkout):
//
//   SCRATCH=<session scratchpad> node scripts/ci/prove-red.mjs mutate  --issue <n>
//   SCRATCH=<session scratchpad> node scripts/ci/prove-red.mjs verify  --issue <n> --builder <builder-tree>
//   SCRATCH=<session scratchpad> node scripts/ci/prove-red.mjs census  --issue <id> --candidates <file>
//   SCRATCH=<session scratchpad> node scripts/ci/prove-red.mjs recover
//
//   --cells <path>          author cells (default $SCRATCH/prove-red-<issue>-cells.json)
//   --review-cells <path>   verify only: reviewer cells (default $SCRATCH/prove-red-<issue>-review-cells.json)
//   --scratch <dir>         instead of $SCRATCH
//   --timeout <seconds>     per test run (default 600)
//
// The skill (`.agents/skills/prove-red/SKILL.md`) is the manual: cell schema,
// classes, exit codes and when to use which mode. This header records why each
// guardrail exists, because every one of them replaces a hand-rig failure that
// happened (the incident table in #4234):
//
//   1  a mutation was committed (#2117)       → clean committed tree before any
//      cell; never stage or commit; a mutation staged DURING the run (the test
//      runs `git add -A`) fails the post-restore porcelain check → exit 3
//   2  an inverse replace hit the wrong       → restore is `cp` from a sha256-
//      occurrence (#2213)                       verified backup; no inverse edit
//   3  a BSD-sed substitution did not apply   → each edit's `find` must occur
//      and read green (2026-09-21)              exactly once, in memory, first
//   4  a stale dist made the suite error      → a cross-package cell rebuilds the
//      (2026-09-17)                             mutated package before the test
//                                               AND after the restore; until the
//                                               second build succeeds the journal
//                                               marks the tree dirty
//   5  a SQL-error red was the mutation's,    → *mutation-red* is its own class,
//      not the guard's (2026-10-19)             never counted as caught
//   6  restores by `git checkout --`          → `cp` + sha256 + empty porcelain;
//      (2026-10-03)                             git checkout/stash/restore never
//                                               run (asserted with a git stub)
//   7  node_modules resolving workspace       → refused before any cell
//      packages into another checkout
//
// Exit codes: 0 every cell caught (census: every selected cell ran);
// 1 a cell was not caught, or was refused at its baseline; 2 refused with
// nothing left mutated — before any cell, or after earlier cells ran and were
// restored (a later baseline wrote into the tree, an unexpected error with no
// journal pending); 3 a restore, rebuild or clean-tree check failed — the
// journal is kept, run `recover`; 128+n interrupted by signal n and restored.
//
// Everything that decides (schema, edits, classification, census selection,
// tables) is a pure exported function, so the self-test proves the decisions
// on recorded runner output without installing vitest or Playwright.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectFacts, evaluate } from './review-isolation.mjs'

export const EXIT = Object.freeze({ OK: 0, NOT_CAUGHT: 1, REFUSED: 2, RESTORE_FAILED: 3 })
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

// The four families of `docs/contributing/ai-review-patterns.md`
// § Assertions A Wrong Edit Still Satisfies, as slugs. The self-test holds this
// list equal to that section, so a family added there (reviewer.md requires
// all four homes to change together) fails CI until it is added here too.
export const REVIEW_FAMILIES = ['polarity', 'wildcard-token', 'any-error-code', 'unentered-branch']
// The two probe kinds of quality-scan `dimensions.md` § Budget.
export const PROBE_FAMILIES = ['probe-second-copy', 'probe-count-only']
export const FAMILIES = [...REVIEW_FAMILIES, 'guard-out', 'census', ...PROBE_FAMILIES, 'other']
const NOTE_REQUIRED = new Set(['census', ...PROBE_FAMILIES, 'other'])
export const RUNNERS = ['node', 'vitest', 'playwright']
export const CLASSES = ['caught', 'mutation-red', 'survived', 'shadowed']
export const CENSUS_BUDGET = 5
export const PROBE_BUDGET = 2

const CELL_KEYS = new Set(['id', 'guard', 'test', 'file', 'edits', 'all', 'replace', 'family', 'expect_red', 'runner', 'note'])
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ISSUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPORTER = fileURLToPath(new URL('./prove-red-reporter.mjs', import.meta.url))

// ---------------------------------------------------------------------------
// Pure: cells
// ---------------------------------------------------------------------------

const isRepoRelative = (p) =>
  typeof p === 'string' && p !== '' && !path.isAbsolute(p) && path.posix.normalize(p) === p && p !== '..' && !p.startsWith('../')

/** Infer the test runner from the test path, or return the explicit `runner`. Pure. */
export function inferRunner(cell) {
  if (cell.runner !== undefined) return cell.runner
  const t = String(cell.test ?? '')
  if (/\.spec\.(ts|tsx|js|mjs)$/.test(t)) return 'playwright'
  if (/\.test\.(mjs|cjs|js)$/.test(t)) return 'node'
  if (/^packages\/[^/]+\/.+\.test\.(ts|tsx|mts|cts)$/.test(t)) return 'vitest'
  return null
}

/** Validate a parsed cells file. Pure. Unknown keys are refused: a typo'd key is otherwise silently ignored. */
export function validateCells(raw, label = 'cells') {
  const errors = []
  if (!Array.isArray(raw)) return { cells: [], errors: [`${label}: must be a JSON array of cells`] }
  if (raw.length === 0) return { cells: [], errors: [`${label}: holds no cells`] }
  const ids = new Set()
  raw.forEach((cell, i) => {
    const where = `${label}[${i}]${cell && typeof cell.id === 'string' ? ` (${cell.id})` : ''}`
    const err = (m) => errors.push(`${where}: ${m}`)
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return err('is not an object')
    for (const k of Object.keys(cell)) if (!CELL_KEYS.has(k)) err(`unknown key "${k}"`)
    if (typeof cell.id !== 'string' || !ID_RE.test(cell.id)) err('"id" must match [A-Za-z0-9][A-Za-z0-9_-]*')
    else if (ids.has(cell.id)) err(`duplicate id "${cell.id}"`)
    else ids.add(cell.id)
    for (const k of ['guard', 'test', 'file']) {
      if (typeof cell[k] !== 'string' || !cell[k].trim()) err(`"${k}" must be a non-empty string`)
      else if (k !== 'guard' && !isRepoRelative(cell[k])) err(`"${k}" must be a path relative to the tree root, without ".."`)
    }
    if (cell.all !== undefined) {
      if (cell.all !== true) err('"all" may only be true')
      if (cell.edits !== undefined) err('give either "edits" or "all": true with "replace", not both')
      if (typeof cell.replace !== 'string') err('"all": true needs "replace" = the whole new file')
    } else {
      if (cell.replace !== undefined) err('"replace" at cell level belongs to "all": true; put {find, replace} pairs in "edits"')
      if (!Array.isArray(cell.edits) || cell.edits.length === 0) err('"edits" must be a non-empty list of {find, replace}')
      else
        cell.edits.forEach((e, j) => {
          if (!e || typeof e !== 'object' || Object.keys(e).some((k) => k !== 'find' && k !== 'replace')) err(`edits[${j}] takes only "find" and "replace"`)
          else if (typeof e.find !== 'string' || e.find === '') err(`edits[${j}].find must be a non-empty string`)
          else if (typeof e.replace !== 'string') err(`edits[${j}].replace must be a string`)
          else if (e.find === e.replace) err(`edits[${j}]: find and replace are identical, so the edit changes nothing`)
        })
    }
    if (!FAMILIES.includes(cell.family)) err(`"family" must be one of: ${FAMILIES.join(', ')}`)
    if (cell.note !== undefined && typeof cell.note !== 'string') err('"note" must be a string')
    if (NOTE_REQUIRED.has(cell.family) && !(typeof cell.note === 'string' && cell.note.trim())) err(`family "${cell.family}" needs a "note" naming the mutation`)
    if (!Array.isArray(cell.expect_red) || cell.expect_red.length === 0 || cell.expect_red.some((n) => typeof n !== 'string' || !n.trim()))
      err('"expect_red" must list the full names of the tests that must fail (ancestor titles and title joined by " > ")')
    if (cell.runner !== undefined && !RUNNERS.includes(cell.runner)) err(`"runner" must be one of: ${RUNNERS.join(', ')}`)
    else if (typeof cell.test === 'string' && inferRunner(cell) === null) err(`cannot infer the runner for "${cell.test}"; set "runner"`)
    else if (typeof cell.test === 'string' && inferRunner(cell) !== 'node' && !packageOf(cell.test)) err(`a ${inferRunner(cell)} cell's test must live under packages/<pkg>/, where its config is`)
  })
  return { cells: errors.length ? [] : raw, errors }
}

function countOccurrences(text, find) {
  let n = 0
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) n += 1
  return n
}

/**
 * Apply a cell's edits to a file's text, in memory. Pure. Each `find` must occur
 * exactly once in the text as the previous pairs left it (overlapping matches
 * count). `all: true` is the one waiver: the whole file is replaced.
 */
export function applyEdits(text, cell) {
  if (cell.all === true) {
    if (cell.replace === text) return { ok: false, error: 'the whole-file replacement equals the current file, so the mutation changes nothing' }
    return { ok: true, text: cell.replace }
  }
  let current = text
  for (const [j, e] of cell.edits.entries()) {
    const n = countOccurrences(current, e.find)
    if (n !== 1) {
      const why = n === 0 ? 'an edit that does not apply runs the unmutated code and reads green (incident 3)' : 'the wrong occurrence would be mutated (incident 2)'
      return { ok: false, error: `edits[${j}].find occurs ${n} times in ${cell.file} as the previous pairs left it; it must occur exactly once — ${why}` }
    }
    const at = current.indexOf(e.find)
    current = current.slice(0, at) + e.replace + current.slice(at + e.find.length)
  }
  if (current === text) return { ok: false, error: 'the edits leave the file byte-identical, so the mutation changes nothing' }
  return { ok: true, text: current }
}

/** Identity of a mutation, ignoring its id and prose. Pure. */
export function cellSignature(cell) {
  return JSON.stringify([cell.file, cell.all === true ? ['all', cell.replace] : (cell.edits ?? []).map((e) => [e.find, e.replace])])
}

/** Why a reviewer cells set cannot count as a review, or null. Pure. */
export function reviewCellsProblem(authorCells, reviewCells) {
  const authorIds = new Set(authorCells.map((c) => c.id))
  const clash = reviewCells.filter((c) => authorIds.has(c.id)).map((c) => c.id)
  if (clash.length) return `reviewer cell ids also used by the author: ${clash.join(', ')} — give reviewer cells their own ids`
  const authorSigs = new Set(authorCells.map(cellSignature))
  if (reviewCells.every((c) => authorSigs.has(cellSignature(c))))
    return 'every reviewer cell duplicates an author cell (same file, same edits); a review needs at least one cell the author did not write'
  return null
}

// ---------------------------------------------------------------------------
// Pure: runner output → normalized result → class
// ---------------------------------------------------------------------------
//
// A normalized result is { exitCode, timedOut, tests: [{ name, status, kind,
// message }], loadErrors: [string] }. `name` is the full name: ancestor titles
// and the title joined by " > ". `status` is passed | failed | skipped; `kind`
// is assertion | error for a failure.

const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '')
const firstLine = (s) => stripAnsi(s).split('\n')[0].slice(0, 300)

/** Records written by prove-red-reporter.mjs → normalized result. Pure. */
export function normalizeNodeEvents(records, exitCode, timedOut = false) {
  const stack = []
  const tests = []
  const loadErrors = []
  for (const r of records) {
    if (r.type === 'test:start') {
      stack.length = r.nesting
      stack[r.nesting] = r.name
      continue
    }
    const name = [...stack.slice(0, r.nesting), r.name].join(' > ')
    if (r.testType === 'suite') {
      if (r.type === 'test:fail' && r.error?.failureType !== 'subtestsFailed') loadErrors.push(`suite "${name}" failed: ${r.error?.message ?? 'no message'}`)
      continue
    }
    if (r.skip || r.todo) tests.push({ name, status: 'skipped', kind: null, message: null })
    else if (r.type === 'test:pass') tests.push({ name, status: 'passed', kind: null, message: null })
    else tests.push({ name, status: 'failed', kind: r.error?.causeCode === 'ERR_ASSERTION' ? 'assertion' : 'error', message: r.error?.message ?? null })
  }
  return { exitCode, timedOut, tests, loadErrors }
}

/**
 * A vitest failure message (ANSI stripped) that is an assertion failing, not
 * code throwing. Vitest's own `expect` and `node:assert` throw `AssertionError`;
 * the frontend's idiom does not (#4284): a jest-dom matcher fails as
 * `Error: expect(element).toHaveClass(...)`, a `getBy*` as
 * `TestingLibraryElementError`, and a `findBy*` / `waitFor` timeout as a plain
 * `Error: Unable to find …` carrying a query-library message. Anchored on those
 * exact stems: a bare `Error:` (a throw in the code under test) stays an error.
 */
export const VITEST_ASSERTION_SHAPE =
  /^(AssertionError\b|TestingLibraryElementError\b|Error: expect\(|Error: Unable to find (an element|an accessible element|a label|role=))/

/** `vitest run --reporter=json` output → normalized result. Pure. */
export function normalizeVitestJson(json, exitCode, timedOut = false) {
  const tests = []
  const loadErrors = []
  if (!json || !Array.isArray(json.testResults)) return { exitCode, timedOut, tests, loadErrors: ['vitest wrote no JSON report'] }
  for (const file of json.testResults) {
    const results = file.assertionResults ?? []
    if (file.status === 'failed' && (results.length === 0 || file.message)) loadErrors.push(`test file failed outside a test: ${firstLine(file.message)}`)
    for (const a of results) {
      const name = [...(a.ancestorTitles ?? []), a.title].join(' > ')
      if (a.status === 'passed') tests.push({ name, status: 'passed', kind: null, message: null })
      else if (a.status === 'failed') {
        const m = stripAnsi(a.failureMessages?.[0] ?? '')
        tests.push({ name, status: 'failed', kind: VITEST_ASSERTION_SHAPE.test(m) ? 'assertion' : 'error', message: firstLine(m) })
      } else tests.push({ name, status: 'skipped', kind: null, message: null })
    }
  }
  return { exitCode, timedOut, tests, loadErrors }
}

/** `playwright test --reporter=json` output → normalized result. Pure. */
export function normalizePlaywrightJson(json, exitCode, timedOut = false) {
  const tests = []
  const loadErrors = []
  if (!json || !Array.isArray(json.suites)) return { exitCode, timedOut, tests, loadErrors: ['playwright wrote no JSON report'] }
  for (const e of json.errors ?? []) loadErrors.push(`load error: ${firstLine(e.message)}`)
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const name = [...titles, spec.title].join(' > ')
        if (t.status === 'skipped') tests.push({ name, status: 'skipped', kind: null, message: null })
        else if (t.status === 'expected') tests.push({ name, status: 'passed', kind: null, message: null })
        else {
          const last = (t.results ?? []).at(-1)
          const m = stripAnsi(last?.error?.message ?? '')
          tests.push({ name, status: 'failed', kind: /^Error: (Timed out \d+ms waiting for )?expect\(/.test(m) ? 'assertion' : 'error', message: firstLine(m) })
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title])
  }
  for (const fileSuite of json.suites) walk(fileSuite, [])
  return { exitCode, timedOut, tests, loadErrors }
}

/** Why an unmutated run cannot serve as a cell's baseline, or null. Pure. */
export function baselineProblem(baseline, expectRed) {
  if (baseline.timedOut) return 'the unmutated test timed out'
  if (baseline.loadErrors.length) return `the unmutated test did not load cleanly: ${baseline.loadErrors[0]}`
  const failed = baseline.tests.filter((t) => t.status === 'failed')
  if (baseline.exitCode !== 0 || failed.length)
    return `the unmutated test is red (exit ${baseline.exitCode}${failed.length ? `; failing: ${failed.map((t) => t.name).join(', ')}` : ''}); a cell needs a green baseline`
  if (baseline.tests.length === 0) return 'the unmutated run reported no tests'
  for (const name of expectRed) {
    const t = baseline.tests.find((x) => x.name === name)
    if (!t) {
      const seen = baseline.tests.slice(0, 8).map((x) => `"${x.name}"`).join(', ')
      return `expect_red names "${name}", which the unmutated run did not report (full names join ancestor titles and the title with " > "; it reported ${seen}${baseline.tests.length > 8 ? ', …' : ''})`
    }
    if (t.status !== 'passed') return `expect_red names "${name}", which is skipped in the unmutated run; a skipped test proves nothing`
  }
  return null
}

/**
 * Classify a mutant run against its baseline. Pure.
 *
 *   caught        at least one `expect_red` test failed with an assertion-type
 *                 error, the run loaded cleanly, and it reported as many tests
 *                 as the unmutated baseline
 *   survived      the run is green with the baseline's test count
 *   shadowed      red on assertions, but in no `expect_red` test: another test
 *                 caught the mutation, so the named guard is not what pins it
 *   mutation-red  red for the mutation's own reasons — a compile, import or SQL
 *                 error, a non-assertion exception in a named test, a timeout,
 *                 or a test count that differs from the baseline. Never caught.
 */
export function classify({ baseline, mutant, expectRed }) {
  const named = new Set(expectRed)
  const failed = mutant.tests.filter((t) => t.status === 'failed')
  const namedAssertion = failed.filter((t) => named.has(t.name) && t.kind === 'assertion')
  const namedError = failed.filter((t) => named.has(t.name) && t.kind !== 'assertion')
  const others = failed.filter((t) => !named.has(t.name))
  const out = (cls, detail) => ({ class: cls, detail, red: failed.map((t) => t.name), total: mutant.tests.length, failed: failed.length })
  if (mutant.timedOut) return out('mutation-red', 'the mutant run timed out')
  if (mutant.loadErrors.length) return out('mutation-red', mutant.loadErrors[0])
  if (mutant.tests.length !== baseline.tests.length) {
    const err = failed.find((t) => t.kind !== 'assertion')
    return out('mutation-red', `the mutant run reported ${mutant.tests.length} tests, the baseline ${baseline.tests.length}${err ? ` (${err.name}: ${err.message ?? 'failed'})` : ''}`)
  }
  if (namedAssertion.length) return out('caught', `${namedAssertion.map((t) => t.name).join(', ')} failed on an assertion`)
  if (failed.length === 0 && mutant.exitCode === 0) return out('survived', `all ${mutant.tests.length} tests green`)
  if (namedError.length) return out('mutation-red', `${namedError[0].name} failed on a non-assertion error: ${namedError[0].message ?? 'no message'}`)
  if (others.length && others.every((t) => t.kind === 'assertion')) return out('shadowed', `red only in ${others.map((t) => t.name).join(', ')}`)
  if (others.length) return out('mutation-red', `${others.find((t) => t.kind !== 'assertion').name} failed on a non-assertion error`)
  return out('mutation-red', `the run exited ${mutant.exitCode} without a failing test`)
}

// ---------------------------------------------------------------------------
// Pure: package boundary
// ---------------------------------------------------------------------------

export function packageOf(file) {
  const m = /^packages\/([^/]+)\//.exec(file)
  return m ? m[1] : null
}

/**
 * The package to rebuild around a cell, or null. Pure. A mutated file in a
 * different `packages/<pkg>/` than its test is reached through that package's
 * built output (tsup leaves dependencies external), so the build is what the
 * test sees. A Playwright cell that mutates app source rebuilds the app.
 */
export function rebuildPackage(cell, runner = inferRunner(cell)) {
  const mutated = packageOf(cell.file)
  if (!mutated) return null
  if (mutated !== packageOf(cell.test)) return mutated
  const testTop = `${cell.test.split('/').slice(0, 3).join('/')}/`
  if (runner === 'playwright' && !cell.file.startsWith(testTop)) return mutated
  return null
}

// ---------------------------------------------------------------------------
// Pure: census
// ---------------------------------------------------------------------------

/** Parse the output of the census command at quality-scan `dimensions.md` § 1. Pure. */
export function parseCandidates(text) {
  const entries = []
  const errors = []
  let declared = null
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t) continue
    let m = /^candidate guard files:\s*(\d+)$/.exec(t)
    if (m) {
      declared = Number(m[1])
      continue
    }
    m = /^([0-9a-f]{7,40})\s+(\S+)$/.exec(t)
    if (m) entries.push({ sha: m[1], file: m[2] })
    else errors.push(`unrecognised line: ${t}`)
  }
  if (declared === null) errors.push('no "candidate guard files: N" line — the output is truncated or is not the census command\'s')
  else if (declared !== entries.length) errors.push(`declares ${declared} candidate files but lists ${entries.length}`)
  return { entries, declared, errors }
}

/**
 * Pick the census sample. Pure. Candidates arrive newest landing first (the
 * census command walks `git log` from the tip); files that no longer exist at
 * HEAD are skipped, the first CENSUS_BUDGET distinct live files get one census
 * cell each (M1…M5), and up to PROBE_BUDGET probe cells follow (M6, M7).
 */
export function selectCensus(entries, cells, exists) {
  const errors = []
  const seen = new Set()
  const live = []
  const deleted = []
  for (const e of entries) {
    if (seen.has(e.file)) continue
    seen.add(e.file)
    ;(exists(e.file) ? live : deleted).push(e)
  }
  const chosen = live.slice(0, CENSUS_BUDGET)
  const candidateFiles = new Set(live.map((e) => e.file))
  for (const c of cells)
    if (c.family !== 'census' && !PROBE_FAMILIES.includes(c.family)) errors.push(`${c.id}: census runs census and probe cells only, not family "${c.family}"`)
  const censusCells = cells.filter((c) => c.family === 'census')
  for (const c of censusCells) if (!candidateFiles.has(c.test)) errors.push(`${c.id}: its test ${c.test} is not a live candidate guard file`)
  const rows = chosen.map((e, i) => {
    const mine = censusCells.filter((c) => c.test === e.file)
    if (mine.length > 1) errors.push(`${e.file}: ${mine.length} census cells (${mine.map((c) => c.id).join(', ')}); the census runs one per file`)
    return { slot: `M${i + 1}`, file: e.file, sha: e.sha, cell: mine[0] ?? null }
  })
  const chosenFiles = new Set(chosen.map((e) => e.file))
  const outOfBudget = censusCells.filter((c) => candidateFiles.has(c.test) && !chosenFiles.has(c.test))
  const probeCells = cells.filter((c) => PROBE_FAMILIES.includes(c.family))
  const probes = probeCells.slice(0, PROBE_BUDGET).map((c, i) => ({ slot: `M${rows.length + i + 1}`, file: c.test, cell: c }))
  outOfBudget.push(...probeCells.slice(PROBE_BUDGET))
  return { rows, probes, outOfBudget, deleted, notSampled: live.slice(CENSUS_BUDGET), errors }
}

// ---------------------------------------------------------------------------
// Pure: tables
// ---------------------------------------------------------------------------

const md = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const short = (s, n = 48) => {
  const one = String(s).replace(/\s+/g, ' ').trim().replace(/`/g, "'")
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export function describeEdit(cell) {
  const what = cell.all === true ? 'whole-file rewrite (`all: true`)' : cell.edits.map((e) => `\`${short(e.find)}\` → \`${short(e.replace)}\``).join('; ')
  return `${cell.family}: ${cell.note ? `${cell.note} — ` : ''}${what}`
}

/** One-phrase outcome of a cell result. Pure. */
export function outcome(r) {
  switch (r.class) {
    case 'caught':
      return `caught: ${r.failed} of ${r.total} red (${r.red.join(', ')})`
    case 'survived':
      return `survived: ${r.total} of ${r.total} green`
    case 'shadowed':
      return `shadowed: ${r.detail}`
    default:
      return `${r.class}: ${r.detail}`
  }
}

const HEADER = ['| # | Guard | Adversarial edit | Author result @ sha | Reproduced by (pass @ sha) | Status |', '|---|---|---|---|---|---|']

/**
 * The per-cell Closeout table of ship-next (`ship-next/SKILL.md` § Closeout).
 * Pure. `mode` is mutate or verify; `authorById` maps an author cell id to its
 * `mutate` result, when the author's result file was available.
 */
export function closeoutTable(results, { mode, head, authorById = new Map() }) {
  const lines = [...HEADER]
  for (const r of results) {
    const edit = md(describeEdit(r.cell))
    const mine = `${md(outcome(r))} @ \`${head}\``
    let author
    let reproduced
    let status
    if (mode === 'mutate') {
      author = mine
      reproduced = '—'
      status = r.class === 'caught' ? 'author-only' : `**${r.class}**`
    } else if (r.origin === 'author') {
      const a = authorById.get(r.cell.id)
      author = a ? `${md(outcome(a))} @ \`${a.head}\`` : '— (no author result file)'
      reproduced = `prove-red verify: ${mine}`
      status = r.class === 'caught' ? 'reproduced' : `**not reproduced (${r.class})**`
    } else {
      author = '— (reviewer cell)'
      reproduced = `prove-red verify: ${mine}`
      status = r.class === 'caught' ? 'reviewer cell: caught' : `**reviewer cell: ${r.class}**`
    }
    lines.push(`| ${md(r.cell.id)} | ${md(r.cell.guard)} | ${edit} | ${author} | ${reproduced} | ${status} |`)
  }
  return lines.join('\n')
}

/** The block-1 table of a quality-scan report (`| # | Guard file | Mutation | Baseline → mutant |`). Pure. */
export function censusTable(selection, resultsById, { head, declared }) {
  const lines = ['| # | Guard file | Mutation | Baseline → mutant |', '|---|---|---|---|']
  const counts = Object.fromEntries([...CLASSES, 'refused', 'not run'].map((c) => [c, 0]))
  for (const row of [...selection.rows, ...selection.probes]) {
    const r = row.cell ? resultsById.get(row.cell.id) : null
    let cell
    if (!row.cell) {
      cell = '**not run**: no census cell was written for this file'
      counts['not run'] += 1
    } else if (!r) {
      cell = '**not run**'
      counts['not run'] += 1
    } else {
      counts[r.class] = (counts[r.class] ?? 0) + 1
      const b = r.baseline?.total ?? '?'
      if (r.class === 'caught') cell = `${b} → **${r.failed} failed**: caught`
      else if (r.class === 'survived') cell = `${b} → **${r.total} passed: survivor** — diagnosis required (weak test / dead code / not load-bearing at the tested condition / shadowed — caught by a test outside this file)`
      else if (r.class === 'shadowed') cell = `${b} → **${r.failed} failed: shadowed** — ${r.detail}`
      else if (r.class === 'mutation-red') cell = `${b} → **mutation-red** (${r.detail}) — not counted; fix the mutation and re-run`
      else cell = `**${r.class}**: ${r.detail}`
    }
    const mutation = row.cell ? md(`${row.cell.note} (\`${row.cell.file}\`)`) : '—'
    lines.push(`| ${row.slot} | \`${md(row.file)}\` | ${mutation} | ${md(cell)} |`)
  }
  lines.push('')
  lines.push(
    `Census at \`${head}\`: ${declared} candidate guard files; ${selection.rows.length} census mutations (one per file, newest landing first) + ${selection.probes.length} probes. ` +
      `${counts.caught} caught, ${counts.survived} survived, ${counts.shadowed} shadowed, ${counts['mutation-red']} mutation-red, ${counts.refused} refused, ${counts['not run']} not run.`,
  )
  if (selection.notSampled.length) lines.push(`Not sampled (budget is ${CENSUS_BUDGET}): ${selection.notSampled.map((e) => `\`${e.file}\``).join(', ')}.`)
  if (selection.deleted.length) lines.push(`Skipped, absent at HEAD: ${selection.deleted.map((e) => `\`${e.file}\``).join(', ')}.`)
  if (selection.outOfBudget.length) lines.push(`Out of budget, not run: ${selection.outOfBudget.map((c) => c.id).join(', ')}.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Impure: environment
// ---------------------------------------------------------------------------

class Stop extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const refuse = (m) => new Stop(EXIT.REFUSED, m)
const restoreFailed = (m) => new Stop(EXIT.RESTORE_FAILED, m)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => sha256(readFileSync(p))
const inside = (p, root) => p === root || p.startsWith(root + path.sep)
const say = (m) => process.stdout.write(`${m}\n`)

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
const nulList = (s) => s.split('\0').filter(Boolean)

function porcelain(root) {
  return nulList(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
}

function numstatFiles(root) {
  return nulList(git(root, ['diff', '--numstat', '-z'])).map((l) => l.split('\t')[2])
}

/** Symlinks in node_modules that resolve outside the tree (the `docs/quality/scan-ledger.md:871` trap). */
export function nodeModulesProblems(root) {
  const problems = []
  const dirs = [path.join(root, 'node_modules')]
  const pkgs = path.join(root, 'packages')
  if (existsSync(pkgs) && statSync(pkgs).isDirectory()) for (const d of readdirSync(pkgs)) dirs.push(path.join(pkgs, d, 'node_modules'))
  const rel = (p) => path.relative(root, p)
  for (const nm of dirs) {
    let isLink = false
    try {
      isLink = lstatSync(nm).isSymbolicLink()
    } catch {
      continue
    }
    let real
    try {
      real = realpathSync(nm)
    } catch {
      problems.push(`${rel(nm)} is a dangling symlink`)
      continue
    }
    if (!inside(real, root)) {
      problems.push(`${rel(nm)}${isLink ? ' is a symlink that' : ''} resolves to ${real}, outside this tree`)
      continue
    }
    for (const entry of readdirSync(nm)) {
      const p = path.join(nm, entry)
      const targets = entry.startsWith('@') && lstatSync(p).isDirectory() ? readdirSync(p).map((e) => path.join(p, e)) : [p]
      for (const t of targets) {
        if (!lstatSync(t).isSymbolicLink()) continue
        let tr
        try {
          tr = realpathSync(t)
        } catch {
          continue
        }
        if (!inside(tr, root)) problems.push(`${rel(t)} resolves to ${tr}, outside this tree — run \`npm ci\` in this tree`)
      }
    }
  }
  return problems
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** O_EXCL pid lock at `<git-dir>/prove-red.lock`; a lock whose pid is dead is broken and reported. */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
      closeSync(fd)
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let holder = null
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8'))
      } catch {
        throw refuse(`${lockPath} exists but is unreadable; if no prove-red run is active in this tree, delete it`)
      }
      if (holder && Number.isInteger(holder.pid) && pidAlive(holder.pid)) throw refuse(`another prove-red run (pid ${holder.pid}) holds ${lockPath}`)
      // Break it race-free: whoever wins the atomic rename owns the stale file,
      // then re-reads what it actually moved. If a live run took the lock
      // between our read and the rename, put it back (link refuses to clobber).
      const token = `${lockPath}.stale.${process.pid}.${Date.now()}`
      try {
        renameSync(lockPath, token)
      } catch (err) {
        if (err.code === 'ENOENT') continue
        throw err
      }
      let moved = null
      try {
        moved = JSON.parse(readFileSync(token, 'utf8'))
      } catch {
        // unreadable: treat as stale
      }
      if (moved && Number.isInteger(moved.pid) && pidAlive(moved.pid)) {
        try {
          linkSync(token, lockPath)
        } catch {
          // A third run took a fresh lock between our rename and the link-back.
          // Its lock stands; say so, because the live holder we moved is now
          // running without one.
          let now = null
          try {
            now = JSON.parse(readFileSync(lockPath, 'utf8'))
          } catch {
            // unreadable or gone
          }
          process.stderr.write(
            `prove-red: warning — while breaking a lock, pid ${moved.pid} turned out to be alive and its lock could not be put back; ${lockPath} is now held by pid ${now?.pid ?? '?'}. Two runs may be active in this tree: stop one.\n`,
          )
        }
        rmSync(token, { force: true })
        throw refuse(`another prove-red run (pid ${moved.pid}) holds ${lockPath}`)
      }
      rmSync(token, { force: true })
      say(`prove-red: removed a stale lock left by pid ${holder?.pid ?? '?'}, which is no longer running`)
    }
  }
  throw refuse(`could not take ${lockPath}`)
}

function releaseLock(ctx) {
  if (!ctx.lockHeld) return
  try {
    const holder = JSON.parse(readFileSync(ctx.lockPath, 'utf8'))
    if (holder.pid === process.pid) rmSync(ctx.lockPath, { force: true })
  } catch {
    // already gone
  }
  ctx.lockHeld = false
}

function writeJournal(ctx, entry) {
  const tmp = `${ctx.journalPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`)
  renameSync(tmp, ctx.journalPath)
}

function treeOf(cwd) {
  let top
  try {
    top = git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel']).trim()
  } catch {
    throw refuse(`${cwd} is not inside a git working tree`)
  }
  const root = realpathSync(top)
  const gitDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-dir']).trim())
  const commonDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  return { root, gitDir, commonDir }
}

function resolveScratch(opts, root) {
  const raw = opts.scratch ?? process.env.SCRATCH
  if (!raw)
    throw refuse(
      'SCRATCH is not set. Point it at your session scratchpad (or pass --scratch): prove-red will not guess a directory, because a backup in a guessed place is one nobody finds after a kill',
    )
  if (!path.isAbsolute(raw) || !existsSync(raw) || !statSync(raw).isDirectory()) throw refuse(`SCRATCH=${raw} is not an existing absolute directory`)
  const scratch = realpathSync(raw)
  if (root && inside(scratch, root)) throw refuse(`SCRATCH=${scratch} is inside the tree; backups and cells files must live outside it`)
  return scratch
}

function readCellsFile(file, label, root) {
  if (!existsSync(file)) throw refuse(`${label} file ${file} does not exist`)
  const real = realpathSync(file)
  if (inside(real, root)) throw refuse(`${label} file ${real} is inside the tree; a cells file lives only in $SCRATCH, never in the tree`)
  let text
  try {
    text = readFileSync(real, 'utf8')
  } catch (e) {
    throw refuse(`${label} file ${real} is unreadable (${e.code ?? e.message})`)
  }
  if (!text.trim()) throw refuse(`${label} file ${real} is empty`)
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw refuse(`${label} file ${real} is not valid JSON: ${e.message}`)
  }
  const { cells, errors } = validateCells(raw, label)
  if (errors.length) throw refuse(`${label} file ${real} is invalid:\n  ${errors.join('\n  ')}`)
  return cells
}

/** Preconditions shared by mutate, verify and census. Throws a refusal (exit 2) before anything is touched. */
function prepare(ctx, cells) {
  const { root } = ctx
  if (ctx.gitDir === ctx.commonDir) {
    const listed = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length
    if (listed > 1)
      throw refuse(`${root} is the main checkout, which ${listed - 1} linked worktree(s) hang off; mutate only in a worktree of your own (\`git worktree add\`) or a disposable clone`)
  }
  try {
    git(root, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    throw refuse('the tree has no commit; commit the assertions under test first')
  }
  acquireLock(ctx.lockPath)
  ctx.lockHeld = true
  if (existsSync(ctx.journalPath))
    throw refuse(`a previous prove-red run left ${ctx.journalPath} (a mutant source or build may still be in place); run \`node scripts/ci/prove-red.mjs recover\` first`)
  const nm = nodeModulesProblems(root)
  if (nm.length) throw refuse(`node_modules resolves outside this tree:\n  ${nm.join('\n  ')}`)
  const dirty = porcelain(root)
  if (dirty.length)
    throw refuse(
      `the tree is not clean and committed (${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'}: ${dirty.slice(0, 5).join(', ')}). Commit the assertions under test first — a cell's result is bound to a commit, and a dirty tree is how a mutation reached a commit (#2117)`,
    )

  const files = [...new Set(cells.flatMap((c) => [c.test, c.file]))]
  const tracked = new Set(nulList(git(root, ['ls-files', '-z', '--', ...files])))
  const errors = []
  for (const cell of cells) {
    for (const k of ['test', 'file']) if (!tracked.has(cell[k])) errors.push(`${cell.id}: ${k} ${cell[k]} is not a tracked file in this tree`)
    const runner = inferRunner(cell)
    if (runner !== 'node') {
      const bin = binPath(root, cell, runner)
      if (!bin) errors.push(`${cell.id}: no ${runner} binary under node_modules/.bin; run \`npm ci\` in this tree`)
    }
    if (!tracked.has(cell.file)) continue
    const abs = path.join(root, cell.file)
    if (lstatSync(abs).isSymbolicLink()) {
      errors.push(`${cell.id}: file ${cell.file} is a symlink; mutate the file it points at, inside the tree, by its own path`)
      continue
    }
    if (!inside(realpathSync(abs), root)) {
      errors.push(`${cell.id}: file ${cell.file} resolves to ${realpathSync(abs)}, outside this tree`)
      continue
    }
    const bytes = readFileSync(abs)
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
      errors.push(`${cell.id}: file ${cell.file} is not valid UTF-8, so an edit would rewrite bytes the cell never named`)
      continue
    }
    const applied = applyEdits(bytes.toString('utf8'), cell)
    if (!applied.ok) errors.push(`${cell.id}: ${applied.error}`)
    const backup = backupPath(ctx, cell)
    if (existsSync(backup)) errors.push(`${cell.id}: a backup from an earlier run is still at ${backup}; inspect it and delete it before re-running`)
  }
  if (errors.length) throw refuse(`cells refused before any run:\n  ${errors.join('\n  ')}`)
}

function binPath(root, cell, runner) {
  const pkg = packageOf(cell.test)
  const candidates = [pkg ? path.join(root, 'packages', pkg, 'node_modules', '.bin', runner) : null, path.join(root, 'node_modules', '.bin', runner)].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

const backupPath = (ctx, cell) => path.join(ctx.scratch, `${path.basename(cell.file)}.${ctx.issue}.${ctx.role}.${cell.id}.bak`)

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT // set when prove-red itself runs under `node --test`; a nested runner would report to the wrong parent
  return env
}

/** Signal a child's whole process group (children run detached, as group leaders). */
function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig)
  } catch {
    // already gone
  }
}

export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * Run a child in its own process group, so a signal (or the timeout) reaches
 * everything it spawned — `npm run build` forks the real build. While a cell is
 * in flight the group id is journalled: after a kill -9 of prove-red the group
 * may still be writing a mutant build, and `recover` refuses until it is gone.
 */
function spawnLogged(ctx, cmd, args, { cwd, env, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const fd = openSync(logFile, 'w')
    let timedOut = false
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true })
    } catch (e) {
      closeSync(fd)
      resolve({ code: null, signal: null, timedOut, error: e.message })
      return
    }
    closeSync(fd)
    ctx.child = child
    if (ctx.current && child.pid) {
      ctx.current.journal.childPgid = child.pid
      writeJournal(ctx, ctx.current.journal)
    }
    const done = () => {
      clearTimeout(timer)
      ctx.child = null
      if (ctx.current && ctx.current.journal.childPgid === child.pid) {
        delete ctx.current.journal.childPgid
        writeJournal(ctx, ctx.current.journal)
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref()
    }, timeoutMs)
    child.on('error', (e) => {
      done()
      resolve({ code: null, signal: null, timedOut, error: e.message })
    })
    child.on('close', (code, signal) => {
      // The leader exited; anything it left behind in its group goes with it.
      killGroup(child.pid, 'SIGTERM')
      done()
      resolve({ code, signal, timedOut })
    })
  })
}

async function runTest(ctx, cell, label) {
  const runner = inferRunner(cell)
  const stem = path.join(ctx.scratch, `prove-red-${ctx.issue}-${ctx.role}-${cell.id}-${label}`)
  const report = `${stem}.report`
  const logFile = `${stem}.log`
  rmSync(report, { force: true })
  let cmd
  let args
  let cwd = ctx.root
  let env = childEnv()
  if (runner === 'node') {
    cmd = process.execPath
    args = ['--test', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${report}`, cell.test]
  } else {
    const pkg = packageOf(cell.test)
    cwd = path.join(ctx.root, 'packages', pkg)
    const rel = path.relative(cwd, path.join(ctx.root, cell.test))
    cmd = binPath(ctx.root, cell, runner)
    if (runner === 'vitest') args = ['run', rel, '--reporter=json', `--outputFile=${report}`]
    else {
      args = ['test', rel, '--retries=0', '--reporter=json']
      env = childEnv({ PLAYWRIGHT_JSON_OUTPUT_NAME: report })
    }
  }
  const run = await spawnLogged(ctx, cmd, args, { cwd, env, logFile, timeoutMs: ctx.timeoutMs })
  const exitCode = run.code ?? 1
  let text = null
  try {
    text = readFileSync(report, 'utf8')
  } catch {
    // no report
  }
  if (text === null || !text.trim()) {
    return { exitCode, timedOut: run.timedOut, tests: [], loadErrors: [`${runner} wrote no report (see ${logFile})${run.error ? `: ${run.error}` : ''}`], logFile }
  }
  let result
  try {
    if (runner === 'node') result = normalizeNodeEvents(text.split('\n').filter(Boolean).map((l) => JSON.parse(l)), exitCode, run.timedOut)
    else if (runner === 'vitest') result = normalizeVitestJson(JSON.parse(text), exitCode, run.timedOut)
    else result = normalizePlaywrightJson(JSON.parse(text), exitCode, run.timedOut)
  } catch (e) {
    result = { exitCode, timedOut: run.timedOut, tests: [], loadErrors: [`unreadable ${runner} report ${report}: ${e.message}`] }
  }
  return { ...result, logFile }
}

async function build(ctx, pkg, label) {
  const logFile = path.join(ctx.scratch, `prove-red-${ctx.issue}-${ctx.role}-build-${pkg}-${label}.log`)
  say(`  build: npm run build -w packages/${pkg} (${label})`)
  const run = await spawnLogged(ctx, 'npm', ['run', 'build', '-w', `packages/${pkg}`], { cwd: ctx.root, env: childEnv(), logFile, timeoutMs: ctx.timeoutMs })
  return { ok: run.code === 0, logFile }
}

const summarize = (r) => ({ total: r.tests.length, passed: r.tests.filter((t) => t.status === 'passed').length, exitCode: r.exitCode })

async function runCell(ctx, cell, origin) {
  const res = { cell, origin, class: null, detail: null, red: [], total: 0, failed: 0 }
  const pkg = rebuildPackage(cell)
  if (pkg) {
    // The baseline must read a build of the UNMUTATED source: a stale dist/
    // can pass the baseline while a fresh build of any mutant — even a
    // comment-only one — goes red, which would read as caught.
    ctx.phase = 'build-baseline'
    const b = await build(ctx, pkg, 'baseline')
    if (ctx.interrupted) return { ...res, class: 'interrupted', detail: 'interrupted during the baseline build; nothing was mutated' }
    if (!b.ok) {
      const detail = `packages/${pkg} does not build unmutated (see ${b.logFile}); a cell needs a fresh baseline build`
      say(`[${cell.id}] refused: ${detail}`)
      return { ...res, class: 'refused', detail }
    }
  }
  say(`[${cell.id}] baseline: ${cell.test} (${inferRunner(cell)})`)
  ctx.phase = 'baseline'
  const baseline = await runTest(ctx, cell, 'baseline')
  res.baseline = summarize(baseline)
  if (ctx.interrupted) return { ...res, class: 'interrupted', detail: 'interrupted during the baseline; nothing was mutated' }
  const problem = baselineProblem(baseline, cell.expect_red)
  if (problem) {
    say(`[${cell.id}] refused: ${problem}`)
    return { ...res, class: 'refused', detail: problem }
  }

  const touched = porcelain(ctx.root)
  if (touched.length)
    throw refuse(`${cell.id}: the unmutated run of ${cell.test} wrote into the tree (${touched.join(', ')}); nothing was mutated. A cell's test must leave the tree as it found it, or no restore can be verified`)

  const abs = path.join(ctx.root, cell.file)
  const original = readFileSync(abs)
  const origSha = sha256(original)
  const applied = applyEdits(original.toString('utf8'), cell)
  if (!applied.ok) throw refuse(`${cell.id}: ${applied.error}`)
  const mutant = Buffer.from(applied.text, 'utf8')
  const mutantSha = sha256(mutant)
  const backup = backupPath(ctx, cell)
  writeFileSync(backup, original, { flag: 'wx' })
  if (sha256File(backup) !== origSha) {
    rmSync(backup, { force: true })
    throw refuse(`${cell.id}: the backup at ${backup} did not verify; nothing was mutated`)
  }
  const fileMode = statSync(abs).mode & 0o7777
  const journal = {
    version: 1,
    pid: process.pid,
    mode: ctx.mode,
    issue: ctx.issue,
    role: ctx.role,
    root: ctx.root,
    cell: cell.id,
    file: cell.file,
    backup,
    origSha,
    mutantSha,
    fileMode,
    rebuildPackage: pkg,
    phase: 'mutated',
    buildDirty: false,
  }
  // The journal is written BEFORE the mutant, so a kill between the two leaves
  // a journal whose file still matches origSha — `recover` restores nothing.
  writeJournal(ctx, journal)
  ctx.current = { cell, abs, backup, origSha, mutantSha, fileMode, pkg, journal }
  writeFileSync(abs, mutant)
  Object.assign(res, { backup, origSha, mutantSha, rebuilt: pkg })
  try {
    const numstat = numstatFiles(ctx.root)
    const status = porcelain(ctx.root)
    if (numstat.length !== 1 || numstat[0] !== cell.file || status.length !== 1 || status[0] !== ` M ${cell.file}`) {
      Object.assign(res, { class: 'refused', detail: `the tree changed beyond ${cell.file} once mutated (numstat: ${numstat.join(', ') || 'none'}; status: ${status.join(', ')})` })
      say(`[${cell.id}] refused: ${res.detail}`)
    } else {
      if (pkg) {
        journal.buildDirty = true
        writeJournal(ctx, journal)
        ctx.phase = 'build'
        const b = await build(ctx, pkg, 'mutant')
        if (!b.ok && !ctx.interrupted) Object.assign(res, { class: 'mutation-red', detail: `packages/${pkg} failed to build with the mutation (see ${b.logFile})` })
      }
      if (!res.class && !ctx.interrupted) {
        say(`[${cell.id}] mutant: ${describeEdit(cell)}`)
        ctx.phase = 'mutant'
        const run = await runTest(ctx, cell, 'mutant')
        res.log = run.logFile
        if (!ctx.interrupted) Object.assign(res, classify({ baseline, mutant: run, expectRed: cell.expect_red }))
      }
      if (ctx.interrupted) Object.assign(res, { class: 'interrupted', detail: `interrupted by ${ctx.interrupted}` })
    }
  } finally {
    ctx.phase = 'restore'
    try {
      await restoreCurrent(ctx)
    } catch (e) {
      // Keep what the cell measured; the restore failure is recorded beside it.
      if (!res.class) Object.assign(res, { class: 'refused', detail: 'the run stopped before the cell was classified' })
      res.restoreFailed = e.message
      e.cellResult = res
      throw e
    }
  }
  say(`[${cell.id}] ${outcome(res)}`)
  return res
}

/** Restore the in-flight cell: verified backup → cp → sha256 → rebuild if one ran → empty porcelain. */
async function restoreCurrent(ctx) {
  const cur = ctx.current
  if (!cur) return
  const { cell, abs, backup, origSha, mutantSha, fileMode, pkg, journal } = cur
  const now = existsSync(abs) ? sha256File(abs) : null
  if (now !== mutantSha && now !== origSha)
    throw restoreFailed(
      `${cell.id}: ${cell.file} changed during the run — it matches neither the mutant prove-red wrote nor the original (sha256 ${now ?? 'missing file'}). ` +
        'Refused; nothing was overwritten. The journal is kept: reconcile by hand, then run recover.',
    )
  if (!existsSync(backup) || sha256File(backup) !== origSha)
    throw restoreFailed(
      `${cell.id}: the backup ${backup} is missing or no longer matches the original's sha256, so nothing was restored and ${cell.file} still holds the mutant. ` +
        `The journal is kept. The original is the committed blob: compare with \`git show HEAD:${cell.file}\` before deciding anything.`,
    )
  try {
    copyFileSync(backup, abs)
    chmodSync(abs, fileMode) // the backup carries scratch's mode, not the file's (a 100755 script would lose its x bit)
  } catch (e) {
    throw restoreFailed(`${cell.id}: copying ${backup} over ${cell.file} failed (${e.code ?? e.message}); the journal is kept, run recover`)
  }
  if (sha256File(abs) !== origSha) throw restoreFailed(`${cell.id}: ${cell.file} does not match the original's sha256 after the restore; the journal is kept, run recover`)
  if ((statSync(abs).mode & 0o7777) !== fileMode) throw restoreFailed(`${cell.id}: ${cell.file} did not get its mode ${fileMode.toString(8)} back; the journal is kept, run recover`)
  journal.phase = 'restored'
  writeJournal(ctx, journal)
  if (journal.buildDirty) {
    ctx.phase = 'build-restore'
    const b = await build(ctx, pkg, 'restored')
    if (!b.ok)
      throw restoreFailed(
        `${cell.id}: the post-restore rebuild of packages/${pkg} failed (see ${b.logFile}), so its dist/ may still hold the mutant build — dist/ is gitignored, so git status cannot show it. ` +
          'The journal marks the tree dirty; run recover before any test.',
      )
    journal.buildDirty = false
    writeJournal(ctx, journal)
  }
  const dirty = porcelain(ctx.root)
  if (dirty.length) throw restoreFailed(`${cell.id}: the source is restored (sha256 and mode verified) but the tree is not clean: ${dirty.join(', ')}. ${dirtyHint(ctx.root)} The journal is kept; recover clears it once the tree is clean.`)
  rmSync(backup, { force: true })
  rmSync(ctx.journalPath, { force: true })
  ctx.current = null
}

/** What a non-empty porcelain after a verified restore means, from git's own answer. */
function dirtyHint(root) {
  const staged = nulList(git(root, ['diff', '--cached', '--name-only', '-z']))
  const parts = []
  if (staged.length)
    parts.push(`The index holds a staged change (${staged.join(', ')}) — the run put it there, for example with \`git add -A\`; prove-red never commits, and nothing may be committed until \`git diff --cached\` is inspected.`)
  const worktree = nulList(git(root, ['diff', '--name-only', '-z']))
  if (worktree.length) parts.push(`The working tree differs from the index (${worktree.join(', ')}) in content or mode; see \`git diff\`.`)
  const untracked = nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  if (untracked.length) parts.push(`Untracked files appeared (${untracked.join(', ')}).`)
  return parts.join(' ')
}

function installSignals(ctx) {
  for (const sig of Object.keys(SIGNAL_EXIT)) {
    process.on(sig, () => {
      if (!ctx.interrupted) {
        ctx.interrupted = sig
        process.stderr.write(`prove-red: ${sig} received — restoring before exit; a second signal does not abort the restore\n`)
      }
      if (ctx.child && ctx.phase !== 'build-restore') killGroup(ctx.child.pid, 'SIGTERM')
    })
  }
}

function writeResult(ctx, results, extra = {}) {
  const file = path.join(ctx.scratch, `prove-red-${ctx.issue}-${ctx.mode}.json`)
  const payload = {
    mode: ctx.mode,
    issue: ctx.issue,
    role: ctx.role,
    root: ctx.root,
    head: ctx.head,
    finishedAt: new Date().toISOString(),
    cells: results.map(({ cell, ...r }) => ({ id: cell.id, guard: cell.guard, family: cell.family, file: cell.file, test: cell.test, head: ctx.head, ...r })),
    ...extra,
  }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  say(`result: ${file}`)
  return file
}

function exitFor(ctx, results, allCaught) {
  if (ctx.interrupted) return SIGNAL_EXIT[ctx.interrupted]
  return allCaught(results) ? EXIT.OK : EXIT.NOT_CAUGHT
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runAll(ctx, list) {
  ctx.results = []
  for (const { cell, origin } of list) {
    if (ctx.interrupted) break
    try {
      ctx.results.push(await runCell(ctx, cell, origin))
    } catch (e) {
      if (e.cellResult) ctx.results.push(e.cellResult)
      throw e
    }
  }
  return ctx.results
}

async function modeMutate(ctx, opts) {
  const cells = readCellsFile(opts.cells ?? path.join(ctx.scratch, `prove-red-${ctx.issue}-cells.json`), 'cells', ctx.root)
  prepare(ctx, cells)
  const results = await runAll(ctx, cells.map((cell) => ({ cell, origin: 'author' })))
  writeResult(ctx, results)
  say('')
  say(closeoutTable(results, { mode: 'mutate', head: ctx.head }))
  return exitFor(ctx, results, (rs) => rs.length === cells.length && rs.every((r) => r.class === 'caught'))
}

async function modeVerify(ctx, opts) {
  // Fail closed, before anything else: without a reviewer-authored cells file
  // this would re-run the author's cells alone and read as a review.
  const reviewFile = opts.reviewCells ?? path.join(ctx.scratch, `prove-red-${ctx.issue}-review-cells.json`)
  const reviewCells = readCellsFile(reviewFile, 'reviewer cells', ctx.root)
  const authorCells = readCellsFile(opts.cells ?? path.join(ctx.scratch, `prove-red-${ctx.issue}-cells.json`), 'author cells', ctx.root)
  const dup = reviewCellsProblem(authorCells, reviewCells)
  if (dup) throw refuse(`reviewer cells file ${reviewFile}: ${dup}`)

  if (!opts.builder) throw refuse('verify needs --builder <builder-tree>: it runs only in the reviewer\'s own root, which review-isolation must ACCEPT as distinct from the builder\'s')
  const facts = collectFacts(ctx.root, { builder: opts.builder, baseCheck: false })
  if (facts.builderToplevel === null) throw refuse(`--builder ${opts.builder} is not a git working tree`)
  const checks = evaluate(facts).checks.filter((c) => ['root-exists', 'is-repo', 'toplevel-is-root', 'registered-at-own-path', 'distinct-from-builder'].includes(c.id))
  const failed = checks.filter((c) => c.ok !== true)
  if (failed.length) throw refuse(`this is not a reviewer's own root (review-isolation): ${failed.map((c) => `${c.id}: ${c.detail}`).join('; ')}`)
  if (opts.expectHead) {
    const head = git(ctx.root, ['rev-parse', 'HEAD']).trim()
    let want = null
    try {
      want = git(ctx.root, ['rev-parse', '--verify', `${opts.expectHead}^{commit}`]).trim()
    } catch {
      throw refuse(`--expect-head ${opts.expectHead} does not name a commit in this root`)
    }
    if (head !== want) throw refuse(`this root's HEAD is ${head}, not the --expect-head ${want}; the verdict would describe another commit`)
  }
  const authorById = new Map()
  const authorResult = path.join(ctx.scratch, `prove-red-${ctx.issue}-mutate.json`)
  let authorRun = null
  try {
    authorRun = JSON.parse(readFileSync(authorResult, 'utf8'))
  } catch {
    // no author result: the column says so
  }
  if (authorRun?.root && authorRun.root === ctx.root)
    throw refuse(`${authorResult} was produced in this same root (${ctx.root}); verify runs in the reviewer's own root, not where the author ran mutate`)
  for (const c of authorRun?.cells ?? []) authorById.set(c.id, c)

  prepare(ctx, [...authorCells, ...reviewCells])
  const results = await runAll(ctx, [...authorCells.map((cell) => ({ cell, origin: 'author' })), ...reviewCells.map((cell) => ({ cell, origin: 'review' }))])
  writeResult(ctx, results)
  say('')
  say(closeoutTable(results, { mode: 'verify', head: ctx.head, authorById }))
  const total = authorCells.length + reviewCells.length
  return exitFor(ctx, results, (rs) => rs.length === total && rs.every((r) => r.class === 'caught'))
}

async function modeCensus(ctx, opts) {
  if (!opts.candidates) throw refuse('census needs --candidates <file>: the saved output of the census command in quality-scan dimensions.md § 1')
  let text
  try {
    text = readFileSync(opts.candidates, 'utf8')
  } catch (e) {
    throw refuse(`--candidates ${opts.candidates} is unreadable (${e.code ?? e.message})`)
  }
  const parsed = parseCandidates(text)
  if (parsed.errors.length) throw refuse(`candidate list ${opts.candidates}:\n  ${parsed.errors.join('\n  ')}`)
  const cells = readCellsFile(opts.cells ?? path.join(ctx.scratch, `prove-red-${ctx.issue}-cells.json`), 'census cells', ctx.root)
  const tracked = new Set(nulList(git(ctx.root, ['ls-files', '-z', '--', ...parsed.entries.map((e) => e.file)])))
  const selection = selectCensus(parsed.entries, cells, (f) => tracked.has(f))
  if (selection.errors.length) throw refuse(`census cells refused:\n  ${selection.errors.join('\n  ')}`)
  const toRun = [...selection.rows, ...selection.probes].filter((r) => r.cell).map((r) => r.cell)
  if (toRun.length === 0) throw refuse('no census cell matches a sampled file; write one cell per sampled file first')
  prepare(ctx, toRun)
  const results = await runAll(ctx, toRun.map((cell) => ({ cell, origin: 'author' })))
  const byId = new Map(results.map((r) => [r.cell.id, r]))
  writeResult(ctx, results, { selection: { rows: selection.rows.map((r) => ({ slot: r.slot, file: r.file, cell: r.cell?.id ?? null })), probes: selection.probes.map((p) => ({ slot: p.slot, cell: p.cell.id })) } })
  say('')
  say(censusTable(selection, byId, { head: ctx.head, declared: parsed.declared }))
  if (ctx.interrupted) return SIGNAL_EXIT[ctx.interrupted]
  const complete = selection.rows.every((r) => r.cell) && results.length === toRun.length && results.every((r) => CLASSES.includes(r.class))
  return complete ? EXIT.OK : EXIT.NOT_CAUGHT
}

/**
 * Replay the journal after a kill. Every check runs before any write, so a
 * refusal leaves the file, the build and the journal exactly as they were.
 */
async function modeRecover(ctx) {
  if (!existsSync(ctx.journalPath)) {
    say(`prove-red recover: no journal at ${ctx.journalPath}; nothing to recover`)
    return EXIT.OK
  }
  acquireLock(ctx.lockPath)
  ctx.lockHeld = true
  let j
  try {
    j = JSON.parse(readFileSync(ctx.journalPath, 'utf8'))
  } catch (e) {
    throw restoreFailed(`the journal ${ctx.journalPath} is unreadable (${e.message}); nothing was restored`)
  }
  if (j.root !== ctx.root) throw restoreFailed(`the journal belongs to ${j.root}, not ${ctx.root}; nothing was restored`)
  Object.assign(ctx, { scratch: path.dirname(j.backup), issue: j.issue, role: j.role })
  if (Number.isInteger(j.childPgid) && groupAlive(j.childPgid))
    throw restoreFailed(
      `recover: process group ${j.childPgid} from the killed run is still running and may still write the mutant into the tree or its build; nothing was restored. ` +
        `See what it is with \`ps -o pid,command -g ${j.childPgid}\`; wait for it, or stop it with \`kill -TERM -- -${j.childPgid}\`, then run recover again.`,
    )
  const abs = path.join(ctx.root, j.file)
  const current = existsSync(abs) ? sha256File(abs) : null
  let copy = false
  if (current === j.origSha) say(`recover: ${j.file} already matches the original's sha256`)
  else if (current === j.mutantSha) {
    if (!existsSync(j.backup)) throw restoreFailed(`recover: the backup ${j.backup} no longer exists; nothing was restored and ${j.file} still holds the mutant`)
    if (sha256File(j.backup) !== j.origSha) throw restoreFailed(`recover: the backup ${j.backup} does not match the journalled sha256; nothing was restored`)
    copy = true
  } else
    throw restoreFailed(
      `recover: ${j.file} matches neither the journalled mutant nor the original (sha256 ${current ?? 'missing file'}) — it was edited after the kill. Refused; nothing was overwritten. Reconcile by hand, then delete ${ctx.journalPath}.`,
    )
  if (copy) {
    copyFileSync(j.backup, abs)
    if (Number.isInteger(j.fileMode)) chmodSync(abs, j.fileMode)
    if (sha256File(abs) !== j.origSha) throw restoreFailed(`recover: ${j.file} does not match the original's sha256 after the copy`)
    say(`recover: restored ${j.file} from ${j.backup} (sha256 verified)`)
  }
  j.phase = 'restored'
  writeJournal(ctx, j)
  if (j.buildDirty) {
    const b = await build(ctx, j.rebuildPackage, 'recover')
    if (!b.ok) throw restoreFailed(`recover: the rebuild of packages/${j.rebuildPackage} failed (see ${b.logFile}); the tree stays marked dirty`)
    j.buildDirty = false
    writeJournal(ctx, j)
    say(`recover: rebuilt packages/${j.rebuildPackage}`)
  }
  const dirty = porcelain(ctx.root)
  if (dirty.length) throw restoreFailed(`recover: the source is restored but the tree is not clean: ${dirty.join(', ')}. ${dirtyHint(ctx.root)} The journal is kept.`)
  rmSync(j.backup, { force: true })
  rmSync(ctx.journalPath, { force: true })
  say('recover: tree restored and clean; journal cleared')
  return EXIT.OK
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/ci/prove-red.mjs <mutate|verify|census|recover> [--issue <n>] [--cells <path>] [--review-cells <path>] [--builder <tree>] [--expect-head <sha>] [--candidates <file>] [--scratch <dir>] [--timeout <seconds>]`

export function parseArgs(argv) {
  const opts = { mode: argv[0], timeout: 600 }
  const takes = { '--expect-head': 'expectHead', '--issue': 'issue', '--cells': 'cells', '--review-cells': 'reviewCells', '--builder': 'builder', '--candidates': 'candidates', '--scratch': 'scratch', '--timeout': 'timeout' }
  for (let i = 1; i < argv.length; i += 1) {
    const key = takes[argv[i]]
    if (!key) throw new Error(`unknown argument ${argv[i]}`)
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`)
    opts[key] = argv[++i]
  }
  if (!['mutate', 'verify', 'census', 'recover'].includes(opts.mode)) throw new Error(`unknown mode ${opts.mode ?? '(none)'}`)
  if (opts.mode !== 'recover' && !(opts.issue && ISSUE_RE.test(opts.issue))) throw new Error('--issue <n> is required (letters, digits, ".", "_", "-")')
  opts.timeout = Number(opts.timeout)
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout must be a positive number of seconds')
  return opts
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`prove-red: ${e.message}\n${USAGE}\n`)
    return EXIT.REFUSED
  }
  const ctx = { mode: opts.mode, issue: opts.issue ?? 'recover', role: opts.mode === 'verify' ? 'review' : 'author', interrupted: null, child: null, current: null, lockHeld: false, results: [], timeoutMs: opts.timeout * 1000 }
  installSignals(ctx)
  try {
    Object.assign(ctx, treeOf(process.cwd()))
    ctx.lockPath = path.join(ctx.gitDir, 'prove-red.lock')
    ctx.journalPath = path.join(ctx.gitDir, 'prove-red.journal.json')
    if (opts.mode === 'recover') {
      ctx.scratch = null
      return await modeRecover(ctx)
    }
    ctx.scratch = resolveScratch(opts, ctx.root)
    ctx.head = git(ctx.root, ['rev-parse', '--short=9', 'HEAD']).trim()
    if (opts.mode === 'mutate') return await modeMutate(ctx, opts)
    if (opts.mode === 'verify') return await modeVerify(ctx, opts)
    return await modeCensus(ctx, opts)
  } catch (e) {
    if (!(e instanceof Stop)) {
      const pending = ctx.journalPath && existsSync(ctx.journalPath)
      process.stderr.write(
        `prove-red ${opts.mode}: unexpected error — ${e.stack ?? e}\n` +
          (pending ? `A journal is pending at ${ctx.journalPath}: run \`node scripts/ci/prove-red.mjs recover\` before any test.\n` : 'No journal is pending, so nothing is left mutated.\n'),
      )
      if (ctx.scratch && ctx.results.length) writeResult(ctx, ctx.results, { stopped: String(e.message ?? e), exit: pending ? EXIT.RESTORE_FAILED : EXIT.REFUSED })
      return pending ? EXIT.RESTORE_FAILED : EXIT.REFUSED
    }
    process.stderr.write(`prove-red ${opts.mode}: ${e.code === EXIT.REFUSED ? 'REFUSED' : 'RESTORE FAILED'} — ${e.message}\n`)
    if (ctx.scratch && ctx.results.length) writeResult(ctx, ctx.results, { stopped: e.message, exit: e.code })
    return e.code
  } finally {
    releaseLock(ctx)
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`prove-red: unexpected error — ${e.stack ?? e}\n`)
      process.exit(EXIT.RESTORE_FAILED)
    },
  )
}
