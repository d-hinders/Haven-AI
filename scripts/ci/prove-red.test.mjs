// Self-test for scripts/ci/prove-red.mjs (#4234).
//
// Run: node --test scripts/ci/prove-red.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs` glob)
//
// How it is built, because each choice is a guard (#4234 § Guards):
//
// - Classification is proven as PURE functions over RECORDED runner output
//   (`scripts/ci/fixtures/prove-red/`: real `node --test`, vitest 3.2.4 and
//   Playwright 1.60.0 runs, paths redacted). ci_config_checks has no `npm ci`,
//   so nothing here runs vitest or Playwright — and nothing here SKIPS when
//   they are missing either: a skipped test proves nothing and would read as
//   coverage.
// - Everything end to end runs the real CLI against throwaway git repos under
//   the OS temp dir. No fixture touches this tree.
// - "git checkout is never invoked" is asserted with a `git` stub on PATH that
//   records its argv, not by reading the source.
//
// The e2e block is organised by the incident table in #4234: each test names
// the incident whose guardrail it drives.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applyEdits,
  baselineProblem,
  censusTable,
  classify,
  closeoutTable,
  FAMILIES,
  groupAlive,
  inferRunner,
  normalizeNodeEvents,
  normalizePlaywrightJson,
  normalizeVitestJson,
  parseCandidates,
  rebuildPackage,
  REVIEW_FAMILIES,
  reviewCellsProblem,
  selectCensus,
  validateCells,
} from './prove-red.mjs'

const SCRIPT = fileURLToPath(new URL('./prove-red.mjs', import.meta.url))
const FIX = fileURLToPath(new URL('./fixtures/prove-red/', import.meta.url))
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

const sha = (s) => createHash('sha256').update(s).digest('hex')
const readJsonl = (f) => readFileSync(path.join(FIX, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const readJson = (f) => JSON.parse(readFileSync(path.join(FIX, f), 'utf8'))

// A baseline for a recorded red run: the same tests, all green.
const greenOf = (r) => ({ exitCode: 0, timedOut: false, loadErrors: [], tests: r.tests.map((t) => ({ ...t, status: t.status === 'skipped' ? 'skipped' : 'passed', kind: null })) })
const res = (tests, extra = {}) => ({ exitCode: tests.some((t) => t.status === 'failed') ? 1 : 0, timedOut: false, loadErrors: [], tests, ...extra })
const t = (name, status = 'passed', kind = null) => ({ name, status, kind, message: kind ? `${kind} message` : null })

const baseCell = (o = {}) => ({
  id: 'C1',
  guard: 'allowed refuses zero',
  test: 'guard.test.mjs',
  file: 'src/guard.mjs',
  edits: [{ find: 'n > 0', replace: 'n >= 0' }],
  family: 'polarity',
  expect_red: ['guard > refuses zero'],
  ...o,
})

// ---------------------------------------------------------------------------
// Pure: cells schema and edits
// ---------------------------------------------------------------------------

describe('cells schema', () => {
  test('a complete cell validates', () => {
    assert.deepEqual(validateCells([baseCell()]).errors, [])
  })
  test('an empty list, a non-list and an unknown key are refused', () => {
    assert.match(validateCells([]).errors[0], /holds no cells/)
    assert.match(validateCells({}).errors[0], /must be a JSON array/)
    assert.match(validateCells([baseCell({ 'expect-red': [] })]).errors.join('\n'), /unknown key "expect-red"/)
  })
  test('duplicate ids, a bad family and a missing expect_red are refused', () => {
    const errs = validateCells([baseCell(), baseCell({ family: 'polarityy', expect_red: [] })]).errors.join('\n')
    assert.match(errs, /duplicate id "C1"/)
    assert.match(errs, /"family" must be one of/)
    assert.match(errs, /"expect_red" must list the full names/)
  })
  test('edits and all: true are exclusive; all: true needs replace', () => {
    assert.match(validateCells([baseCell({ all: true, replace: 'x' })]).errors.join('\n'), /either "edits" or "all"/)
    const { edits, ...noEdits } = baseCell()
    assert.match(validateCells([{ ...noEdits, all: true }]).errors.join('\n'), /needs "replace"/)
    assert.deepEqual(validateCells([{ ...noEdits, all: true, replace: 'whole file' }]).errors, [])
    assert.match(validateCells([baseCell({ edits: [{ find: 'a', replace: 'a' }] })]).errors.join('\n'), /identical/)
  })
  test('census, probe and other cells need a note naming the mutation', () => {
    for (const family of ['census', 'probe-second-copy', 'probe-count-only', 'other'])
      assert.match(validateCells([baseCell({ family })]).errors.join('\n'), /needs a "note"/, family)
    assert.deepEqual(validateCells([baseCell({ family: 'census', note: 'inverted' })]).errors, [])
  })
  test('paths must be tree-relative; a non-node runner needs a package', () => {
    assert.match(validateCells([baseCell({ file: '../outside.mjs' })]).errors.join('\n'), /relative to the tree root/)
    assert.match(validateCells([baseCell({ file: '/abs/x.mjs' })]).errors.join('\n'), /relative to the tree root/)
    assert.match(validateCells([baseCell({ runner: 'vitest' })]).errors.join('\n'), /must live under packages/)
    assert.match(validateCells([baseCell({ test: 'notes.txt' })]).errors.join('\n'), /cannot infer the runner/)
  })
  test('runner inference', () => {
    assert.equal(inferRunner({ test: 'scripts/ci/x.test.mjs' }), 'node')
    assert.equal(inferRunner({ test: 'packages/backend/src/x.test.ts' }), 'vitest')
    assert.equal(inferRunner({ test: 'packages/frontend/e2e/x.spec.ts' }), 'playwright')
    assert.equal(inferRunner({ test: 'packages/frontend/scripts/design-lint.test.mjs' }), 'node')
    assert.equal(inferRunner({ test: 'x.test.ts', runner: 'vitest' }), 'vitest')
  })
})

describe('edits apply exactly once', () => {
  const cell = (edits) => baseCell({ edits })
  test('incident 3: a find that occurs 0 times is refused', () => {
    const r = applyEdits('return n > 0\n', cell([{ find: 'n >= 0', replace: 'x' }]))
    assert.equal(r.ok, false)
    assert.match(r.error, /occurs 0 times.*exactly once.*incident 3/)
  })
  test('incident 2: a find that occurs twice is refused, overlapping matches included', () => {
    assert.match(applyEdits('a > 0 && b > 0', cell([{ find: '> 0', replace: '>= 0' }])).error, /occurs 2 times.*incident 2/)
    assert.match(applyEdits('aaa', cell([{ find: 'aa', replace: 'b' }])).error, /occurs 2 times/)
  })
  test('pairs apply in order, each against the text the previous pair left (a two-edit move)', () => {
    const r = applyEdits('A;B;', cell([{ find: 'A;', replace: '' }, { find: 'B;', replace: 'B;A;' }]))
    assert.deepEqual(r, { ok: true, text: 'B;A;' })
    assert.match(applyEdits('A;', cell([{ find: 'A;', replace: 'C;' }, { find: 'A;', replace: 'D;' }])).error, /edits\[1\]\.find occurs 0 times/)
  })
  test('all: true replaces the whole file; a no-op mutation is refused', () => {
    assert.deepEqual(applyEdits('a\nb\n', { all: true, replace: 'a\r\nb\r\n' }), { ok: true, text: 'a\r\nb\r\n' })
    assert.match(applyEdits('same', { all: true, replace: 'same' }).error, /changes nothing/)
    assert.match(applyEdits('ab', cell([{ find: 'a', replace: 'c' }, { find: 'c', replace: 'a' }])).error, /byte-identical/)
  })
})

// ---------------------------------------------------------------------------
// Pure: classification over recorded runs
// ---------------------------------------------------------------------------

describe('classifier over recorded runner output', () => {
  test('node --test events: full names, assertion vs error, skip', () => {
    const r = normalizeNodeEvents(readJsonl('node-mixed.jsonl'), 1)
    assert.deepEqual(
      r.tests.map((x) => [x.name, x.status, x.kind]),
      [
        ['suite one > passes', 'passed', null],
        ['suite one > fails assert', 'failed', 'assertion'],
        ['suite one > inner > deep', 'failed', 'error'],
        ['top', 'passed', null],
        ['skipped', 'skipped', null],
      ],
    )
    assert.deepEqual(r.loadErrors, [])
  })
  test('node --test: an assertion red in a named test is caught', () => {
    const mutant = normalizeNodeEvents(readJsonl('node-mixed.jsonl'), 1)
    assert.equal(classify({ baseline: greenOf(mutant), mutant, expectRed: ['suite one > fails assert'] }).class, 'caught')
  })
  test('incident 5: a non-assertion error in the named test is mutation-red, never caught', () => {
    const mutant = normalizeNodeEvents(readJsonl('node-mixed.jsonl'), 1)
    const c = classify({ baseline: greenOf(mutant), mutant, expectRed: ['suite one > inner > deep'] })
    assert.equal(c.class, 'mutation-red')
    assert.match(c.detail, /non-assertion error/)
  })
  test('incident 5: a file that no longer loads (compile red) is mutation-red', () => {
    const baseline = normalizeNodeEvents(readJsonl('node-green.jsonl'), 0)
    const mutant = normalizeNodeEvents(readJsonl('node-load-failure.jsonl'), 1)
    assert.equal(baseline.tests.length, 2)
    const c = classify({ baseline, mutant, expectRed: ['one'] })
    assert.equal(c.class, 'mutation-red')
  })
  test('vitest JSON: AssertionError (expect and node:assert) vs TypeError, skipped', () => {
    const r = normalizeVitestJson(readJson('vitest-mixed.json'), 1)
    assert.deepEqual(
      r.tests.map((x) => [x.name, x.status, x.kind]),
      [
        ['suite one > passes', 'passed', null],
        ['suite one > fails expect', 'failed', 'assertion'],
        ['suite one > fails node assert', 'failed', 'assertion'],
        ['suite one > inner > deep', 'failed', 'error'],
        ['suite one > skipped', 'skipped', null],
      ],
    )
    assert.equal(classify({ baseline: greenOf(r), mutant: r, expectRed: ['suite one > fails expect'] }).class, 'caught')
  })
  test('vitest (#4284): the frontend idiom — jest-dom, getBy*, findBy* — is assertion; a code throw is not', () => {
    // Recorded verbatim from vitest 3.2.4 + jsdom (ANSI kept): the jest-dom
    // message has colour codes between `Error: ` and `expect(`, so this case
    // also proves the vitest path strips ANSI before classifying.
    const r = normalizeVitestJson(readJson('vitest-frontend-idiom.json'), 1)
    assert.deepEqual(
      r.tests.map((x) => [x.name, x.kind]),
      [
        ['frontend idiom > jest-dom matcher fails', 'assertion'],
        ['frontend idiom > getBy finds nothing', 'assertion'],
        ['frontend idiom > findBy times out', 'assertion'],
        ['frontend idiom > findByRole times out', 'assertion'],
        ['frontend idiom > findByRole with a name times out', 'assertion'],
        ['frontend idiom > findByLabelText times out', 'assertion'],
        ['frontend idiom > findBy finds several', 'assertion'],
        ['frontend idiom > waitFor getBy finds several', 'assertion'],
        ['frontend idiom > findByLabelText label without control', 'assertion'],
        ['frontend idiom > async waitFor getByRole after an await', 'assertion'],
        // Code throws: each mentions a stem somewhere but not at the start,
        // or is close to one without being it — pins the anchor, the
        // grouping and each stem's exact text.
        ['frontend idiom > plain Error', 'error'],
        ['frontend idiom > code throw starting Found', 'error'],
        ['frontend idiom > Error mentioning expect( later', 'error'],
        ['frontend idiom > code throw wrapping an assertion stem', 'error'],
        ['frontend idiom > code throw wrapping a TestingLibraryElementError', 'error'],
        ['frontend idiom > code throw starting Unable to find', 'error'],
        ['frontend idiom > code throw about a labelled widget', 'error'],
        ['frontend idiom > code throw starting expectation', 'error'],
        ['frontend idiom > TypeError', 'error'],
      ],
    )
    assert.equal(
      classify({ baseline: greenOf(r), mutant: r, expectRed: ['frontend idiom > jest-dom matcher fails'] }).class,
      'caught',
    )
  })
  test('incident 5: the SQL-error shape in vitest is mutation-red', () => {
    const mutant = normalizeVitestJson(readJson('vitest-sql-error.json'), 1)
    assert.deepEqual(mutant.tests.map((x) => [x.name, x.kind]), [['owner join holds', 'error'], ['other', null]])
    assert.equal(classify({ baseline: greenOf(mutant), mutant, expectRed: ['owner join holds'] }).class, 'mutation-red')
  })
  test('vitest: a file that fails to load is mutation-red; a green run survives', () => {
    const load = normalizeVitestJson(readJson('vitest-load-failure.json'), 1)
    assert.match(load.loadErrors[0], /failed outside a test: Cannot find module/)
    const green = normalizeVitestJson(readJson('vitest-green.json'), 0)
    assert.equal(classify({ baseline: green, mutant: load, expectRed: ['only'] }).class, 'mutation-red')
    assert.equal(classify({ baseline: green, mutant: green, expectRed: ['only'] }).class, 'survived')
  })
  test('playwright JSON: expect() failure vs thrown error; load error', () => {
    const r = normalizePlaywrightJson(readJson('playwright-mixed.json'), 1)
    assert.deepEqual(
      r.tests.map((x) => [x.name, x.status, x.kind]),
      [
        ['suite one > passes', 'passed', null],
        ['suite one > fails expect', 'failed', 'assertion'],
        ['suite one > throws', 'failed', 'error'],
      ],
    )
    assert.equal(classify({ baseline: greenOf(r), mutant: r, expectRed: ['suite one > fails expect'] }).class, 'caught')
    assert.equal(classify({ baseline: greenOf(r), mutant: r, expectRed: ['suite one > throws'] }).class, 'mutation-red')
    const load = normalizePlaywrightJson(readJson('playwright-load-failure.json'), 1)
    assert.match(load.loadErrors[0], /Cannot find module/)
  })
  test('playwright (#4294): a custom-message expect is assertion; a thrown error or a test timeout is not', () => {
    // Recorded from Playwright 1.60.0 (page.setContent), message text verbatim
    // with ANSI. Classification reads results.at(-1).error only: the test
    // timeout case also carries the pending expect in errors[], and must
    // still read as an error.
    const r = normalizePlaywrightJson(readJson('playwright-custom-messages.json'), 1)
    const cm = 'custom messages > '
    assert.deepEqual(
      r.tests.map((x) => [x.name.replace(cm, ''), x.kind]),
      [
        ['value with message', 'assertion'],
        ['multi-line message', 'assertion'],
        ['locator timeout with message', 'assertion'],
        ['screenshot with message', 'assertion'],
        ['soft with message', 'assertion'],
        ['poll with message', 'assertion'],
        ['no message', 'assertion'],
        ['plain Error', 'error'],
        ['thrown error mentioning expect later', 'error'],
        ['TypeError', 'error'],
        ['click timeout', 'error'],
        ['test timeout during messaged expect', 'error'],
      ],
    )
    // The reported message is now the custom message, the reader's sentence.
    assert.equal(r.tests[0].message, 'Error: the count is wrong')
    assert.equal(
      classify({ baseline: greenOf(r), mutant: r, expectRed: [`${cm}value with message`] }).class,
      'caught',
    )
  })
  test('caught needs the baseline test count; shadowed is an assertion red outside expect_red', () => {
    const baseline = res([t('a'), t('b'), t('c')])
    const fewer = res([t('a', 'failed', 'assertion'), t('b')])
    assert.equal(classify({ baseline, mutant: fewer, expectRed: ['a'] }).class, 'mutation-red')
    const shadow = res([t('a'), t('b', 'failed', 'assertion'), t('c')])
    const c = classify({ baseline, mutant: shadow, expectRed: ['a'] })
    assert.equal(c.class, 'shadowed')
    assert.match(c.detail, /red only in b/)
    assert.equal(classify({ baseline, mutant: res([t('a', 'failed', 'assertion'), t('b'), t('c')]), expectRed: ['a'] }).class, 'caught')
    assert.equal(classify({ baseline, mutant: res([t('a'), t('b'), t('c')], { exitCode: 1 }), expectRed: ['a'] }).class, 'mutation-red')
    assert.equal(classify({ baseline, mutant: res([t('a'), t('b'), t('c')], { timedOut: true }), expectRed: ['a'] }).class, 'mutation-red')
  })
  test('a baseline must be green, load cleanly, and run every expect_red test unskipped', () => {
    assert.equal(baselineProblem(res([t('a'), t('b')]), ['a']), null)
    assert.match(baselineProblem(res([t('a'), t('b', 'failed', 'assertion')]), ['a']), /is red.*failing: b/)
    assert.match(baselineProblem(res([t('a')]), ['A']), /did not report/)
    assert.match(baselineProblem(res([t('a'), t('s', 'skipped')]), ['s']), /skipped/)
    assert.match(baselineProblem(res([]), ['a']), /no tests/)
    assert.match(baselineProblem(res([t('a')], { loadErrors: ['boom'] }), ['a']), /did not load/)
  })
})

describe('package boundary', () => {
  test('a mutated file in another package is rebuilt; same package is not; Playwright app source is', () => {
    assert.equal(rebuildPackage({ file: 'packages/sdk/src/a.ts', test: 'packages/mcp/src/a.test.ts' }), 'sdk')
    assert.equal(rebuildPackage({ file: 'packages/sdk/src/a.ts', test: 'scripts/ci/a.test.mjs' }), 'sdk')
    assert.equal(rebuildPackage({ file: 'packages/sdk/src/a.ts', test: 'packages/sdk/src/a.test.ts' }), null)
    assert.equal(rebuildPackage({ file: 'scripts/ci/a.mjs', test: 'scripts/ci/a.test.mjs' }), null)
    assert.equal(rebuildPackage({ file: 'packages/frontend/src/app/page.tsx', test: 'packages/frontend/e2e/x.spec.ts' }), 'frontend')
    assert.equal(rebuildPackage({ file: 'packages/frontend/e2e/helpers.ts', test: 'packages/frontend/e2e/x.spec.ts' }), null)
  })
})

describe('reviewer cells must be the reviewer\'s own', () => {
  test('all duplicates (same file and edits, any id) are refused; one new cell is enough', () => {
    const author = [baseCell()]
    assert.match(reviewCellsProblem(author, [baseCell({ id: 'R1', guard: 'other words' })]), /duplicates an author cell/)
    assert.equal(reviewCellsProblem(author, [baseCell({ id: 'R1' }), baseCell({ id: 'R2', edits: [{ find: 'n > 0', replace: 'true' }] })]), null)
    assert.match(reviewCellsProblem(author, [baseCell({ edits: [{ find: 'n > 0', replace: 'true' }] })]), /ids also used by the author: C1/)
  })
})

describe('families stay where they are', () => {
  test('REVIEW_FAMILIES mirrors ai-review-patterns.md § Assertions A Wrong Edit Still Satisfies', () => {
    const doc = readFileSync(path.join(REPO, 'docs/contributing/ai-review-patterns.md'), 'utf8')
    const section = doc.split('## Assertions A Wrong Edit Still Satisfies')[1].split('\n## ')[0]
    const names = [...section.matchAll(/^- \*\*([^*]+?)\.\*\*/gm)].map((m) => m[1].toLowerCase().replace(/\s+/g, '-'))
    assert.ok(names.length >= 4, `parsed ${names.length} family bullets — the section moved`)
    assert.deepEqual(REVIEW_FAMILIES, names)
    for (const f of REVIEW_FAMILIES) assert.ok(FAMILIES.includes(f))
  })
})

// ---------------------------------------------------------------------------
// Pure: census selection and tables
// ---------------------------------------------------------------------------

const CANDIDATES = [
  'a000007 t7.test.mjs',
  'a000006 t6.test.mjs',
  'a000005 t6.test.mjs',
  'a000004 gone.test.mjs',
  'a000003 t5.test.mjs',
  'a000003 t4.test.mjs',
  'a000002 t3.test.mjs',
  'a000001 t2.test.mjs',
  'a000001 t1.test.mjs',
  'candidate guard files: 9',
].join('\n')

const censusCell = (n, o = {}) =>
  baseCell({ id: `X${n}`, guard: `t${n} guard`, test: `t${n}.test.mjs`, family: 'census', note: `invert t${n}`, expect_red: [`t${n} refuses zero`], ...o })
const CENSUS_CELLS = [
  ...[7, 6, 5, 4, 3, 2].map((n) => censusCell(n)),
  censusCell(1, { id: 'P1', family: 'probe-second-copy', note: 'second copy in t1' }),
  censusCell(2, { id: 'P2', family: 'probe-count-only', note: 'count-only pin in t2' }),
  censusCell(1, { id: 'P3', family: 'probe-count-only', note: 'third probe' }),
]

describe('census selection', () => {
  test('the candidate list must carry its own count line, and agree with it', () => {
    assert.equal(parseCandidates(CANDIDATES).errors.length, 0)
    assert.match(parseCandidates('a000007 t7.test.mjs').errors.join(), /no "candidate guard files: N" line/)
    assert.match(parseCandidates('a000007 t7.test.mjs\ncandidate guard files: 2').errors.join(), /declares 2 .* lists 1/)
  })
  test('five census files, one cell each, newest landing first; then two probes; the rest out of budget', () => {
    const { entries } = parseCandidates(CANDIDATES)
    const s = selectCensus(entries, CENSUS_CELLS, (f) => f !== 'gone.test.mjs')
    assert.deepEqual(s.errors, [])
    assert.deepEqual(s.rows.map((r) => [r.slot, r.file, r.cell.id]), [
      ['M1', 't7.test.mjs', 'X7'],
      ['M2', 't6.test.mjs', 'X6'],
      ['M3', 't5.test.mjs', 'X5'],
      ['M4', 't4.test.mjs', 'X4'],
      ['M5', 't3.test.mjs', 'X3'],
    ])
    assert.deepEqual(s.probes.map((p) => [p.slot, p.cell.id]), [['M6', 'P1'], ['M7', 'P2']])
    assert.deepEqual(s.outOfBudget.map((c) => c.id), ['X2', 'P3'])
    assert.deepEqual(s.deleted.map((e) => e.file), ['gone.test.mjs'])
    assert.deepEqual(s.notSampled.map((e) => e.file), ['t2.test.mjs', 't1.test.mjs'])
  })
  test('two census cells for one file, a non-candidate test and a non-census family are refused', () => {
    const { entries } = parseCandidates(CANDIDATES)
    const errs = selectCensus(entries, [censusCell(7), censusCell(7, { id: 'X7b' }), censusCell(9), baseCell({ id: 'Z' })], () => true).errors.join('\n')
    assert.match(errs, /t7\.test\.mjs: 2 census cells/)
    assert.match(errs, /X9: its test t9\.test\.mjs is not a live candidate/)
    assert.match(errs, /Z: census runs census and probe cells only/)
  })
  test('the block-1 table, pinned', () => {
    const { entries, declared } = parseCandidates(CANDIDATES)
    const s = selectCensus(entries, CENSUS_CELLS, (f) => f !== 'gone.test.mjs')
    const r = (id, cls, extra = {}) => [id, { cell: { id }, class: cls, baseline: { total: 2 }, total: 2, failed: 1, red: ['x'], detail: 'd', ...extra }]
    const byId = new Map([
      r('X7', 'caught'),
      r('X6', 'survived', { failed: 0 }),
      r('X5', 'shadowed', { detail: 'red only in t5 accepts one' }),
      r('X4', 'mutation-red', { detail: 'the mutant run reported 1 tests, the baseline 2' }),
      r('X3', 'refused', { detail: 'the unmutated test is red' }),
      r('P1', 'caught'),
      r('P2', 'caught', { failed: 2 }),
    ])
    assert.equal(
      censusTable(s, byId, { head: 'abc123def', declared }),
      [
        '| # | Guard file | Mutation | Baseline → mutant |',
        '|---|---|---|---|',
        '| M1 | `t7.test.mjs` | invert t7 (`src/guard.mjs`) | 2 → **1 failed**: caught |',
        '| M2 | `t6.test.mjs` | invert t6 (`src/guard.mjs`) | 2 → **2 passed: survivor** — diagnosis required (weak test / dead code / not load-bearing at the tested condition / shadowed — caught by a test outside this file) |',
        '| M3 | `t5.test.mjs` | invert t5 (`src/guard.mjs`) | 2 → **1 failed: shadowed** — red only in t5 accepts one |',
        '| M4 | `t4.test.mjs` | invert t4 (`src/guard.mjs`) | 2 → **mutation-red** (the mutant run reported 1 tests, the baseline 2) — not counted; fix the mutation and re-run |',
        '| M5 | `t3.test.mjs` | invert t3 (`src/guard.mjs`) | **refused**: the unmutated test is red |',
        '| M6 | `t1.test.mjs` | second copy in t1 (`src/guard.mjs`) | 2 → **1 failed**: caught |',
        '| M7 | `t2.test.mjs` | count-only pin in t2 (`src/guard.mjs`) | 2 → **2 failed**: caught |',
        '',
        'Census at `abc123def`: 9 candidate guard files; 5 census mutations (one per file, newest landing first) + 2 probes. 3 caught, 1 survived, 1 shadowed, 1 mutation-red, 1 refused, 0 not run.',
        'Not sampled (budget is 5): `t2.test.mjs`, `t1.test.mjs`.',
        'Skipped, absent at HEAD: `gone.test.mjs`.',
        'Out of budget, not run: X2, P3.',
      ].join('\n'),
    )
  })
  test('the Closeout table names the wrong edit and maps class to status', () => {
    const cell = baseCell({ note: 'boundary widened' })
    const out = closeoutTable([{ cell, origin: 'author', class: 'caught', total: 2, failed: 1, red: ['guard > refuses zero'] }], { mode: 'mutate', head: 'abc' })
    assert.equal(
      out.split('\n')[2],
      '| C1 | allowed refuses zero | polarity: boundary widened — `n > 0` → `n >= 0` | caught: 1 of 2 red (guard > refuses zero) @ `abc` | — | author-only |',
    )
    const v = closeoutTable(
      [
        { cell, origin: 'author', class: 'survived', total: 2, failed: 0, red: [] },
        { cell: { ...cell, id: 'R1' }, origin: 'review', class: 'caught', total: 2, failed: 1, red: ['x'] },
      ],
      { mode: 'verify', head: 'def', authorById: new Map([['C1', { class: 'caught', total: 2, failed: 1, red: ['guard > refuses zero'], head: 'abc' }]]) },
    ).split('\n')
    assert.match(v[2], /caught: 1 of 2 red \(guard > refuses zero\) @ `abc` \| prove-red verify: survived: 2 of 2 green @ `def` \| \*\*not reproduced \(survived\)\*\* \|$/)
    assert.match(v[3], /— \(reviewer cell\) \| prove-red verify: caught: 1 of 2 red \(x\) @ `def` \| reviewer cell: caught \|$/)
  })
})

// ---------------------------------------------------------------------------
// End to end, in throwaway repos
// ---------------------------------------------------------------------------

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
})

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
function cleanEnv(extra) {
  const env = { ...process.env, ...GIT_ENV, ...extra }
  delete env.NODE_TEST_CONTEXT
  for (const k of Object.keys(env)) if (k.startsWith('PR_FIXTURE_') && !(k in extra)) delete env[k]
  delete env.SCRATCH
  if (extra.SCRATCH) env.SCRATCH = extra.SCRATCH
  return env
}
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv({}), stdio: ['ignore', 'pipe', 'pipe'] })

const GUARD_SRC = 'export function allowed(n) {\n  return n > 0\n}\n'
const fixtureTest = (prefix = 'guard') => `import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { allowed } from './src/guard.mjs'
const mark = (m) => { if (process.env.PR_FIXTURE_LOG) appendFileSync(process.env.PR_FIXTURE_LOG, m + '\\n') }
mark('ran:${prefix}')
describe('${prefix}', () => {
  test('refuses zero', async () => {
    if (allowed(0)) {
      if (process.env.PR_FIXTURE_HANG) {
        // Block until the self-test releases us (a file appears), never on a
        // timer: a contended machine must not end the hang before the signal.
        mark('mutant-started')
        for (let i = 0; i < 6000 && !existsSync(process.env.PR_FIXTURE_HANG); i += 1) await new Promise((r) => setTimeout(r, 50))
      }
      if (process.env.PR_FIXTURE_STAGE) execFileSync('git', ['add', '-A'])
      if (process.env.PR_FIXTURE_CORRUPT) writeFileSync(process.env.PR_FIXTURE_CORRUPT, 'corrupted\\n')
      if (process.env.PR_FIXTURE_HANDEDIT) writeFileSync('src/guard.mjs', 'hand edit\\n')
    } else if (process.env.PR_FIXTURE_TOUCH) writeFileSync(process.env.PR_FIXTURE_TOUCH, 'written by the baseline run\\n')
    assert.equal(allowed(0), false)
  })
  test('accepts one', () => assert.equal(allowed(1), true))
})
`

function makeRepo(extraFiles = {}, { worktree = true, modes = {}, symlinks = {} } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'prove-red-')))
  tmpRoots.push(dir)
  const main = path.join(dir, 'main')
  const files = { '.gitignore': 'node_modules/\nnode_modules\ndist/\n', 'src/guard.mjs': GUARD_SRC, 'guard.test.mjs': fixtureTest(), ...extraFiles }
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(main, f)), { recursive: true })
    writeFileSync(path.join(main, f), c)
  }
  for (const [f, m] of Object.entries(modes)) chmodSync(path.join(main, f), m)
  for (const [f, target] of Object.entries(symlinks)) symlinkSync(target, path.join(main, f))
  g(main, 'init', '-q', '-b', 'main')
  g(main, 'config', 'user.email', 'prove-red@example.com')
  g(main, 'config', 'user.name', 'prove-red')
  g(main, 'add', '-A')
  g(main, 'commit', '-qm', 'fixture')
  let wt = main
  if (worktree) {
    wt = path.join(dir, 'wt')
    g(main, 'worktree', 'add', '-q', wt, '-b', 'wt')
    // `git worktree add` honours the caller's umask when it checks the files
    // out: under umask 0002 a 100755 blob lands as 0775 (#4272). Re-apply the
    // requested modes in the worktree so a fixture's mode is exactly what the
    // test asked for, whatever the shell's umask. Git tracks only the execute
    // bit, which this does not change, so the tree stays clean.
    for (const [f, m] of Object.entries(modes)) chmodSync(path.join(wt, f), m)
  }
  const scratch = path.join(dir, 'scratch')
  mkdirSync(scratch)
  const gitDir = g(wt, 'rev-parse', '--path-format=absolute', '--git-dir').trim()
  return { dir, main, wt, scratch, log: path.join(dir, 'fixture.log'), journal: path.join(gitDir, 'prove-red.journal.json'), lock: path.join(gitDir, 'prove-red.lock') }
}

function writeCells(repo, cells, name = 'prove-red-1-cells.json') {
  const f = path.join(repo.scratch, name)
  writeFileSync(f, JSON.stringify(cells, null, 2))
  return f
}

function start(repo, args, { env = {}, cwd = repo.wt } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: cleanEnv({ SCRATCH: repo.scratch, PR_FIXTURE_LOG: repo.log, ...env }), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out })))
  return { child, done, out: () => out }
}
const run = (repo, args, opts) => start(repo, args, opts).done
const ranCount = (repo) => (existsSync(repo.log) ? readFileSync(repo.log, 'utf8').split('\n').filter((l) => l.startsWith('ran:')).length : 0)
const fileOf = (repo, f = 'src/guard.mjs') => readFileSync(path.join(repo.wt, f), 'utf8')
const result = (repo, mode = 'mutate') => JSON.parse(readFileSync(path.join(repo.scratch, `prove-red-1-${mode}.json`), 'utf8'))
async function waitFor(pred, what, ms = 120000) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 40))
  }
}
const MUTATE = ['mutate', '--issue', '1']
const releaseFile = (repo) => path.join(repo.dir, 'release')
const release = (repo) => writeFileSync(releaseFile(repo), 'go\n')
/**
 * Has this pid exited? A killed process reparented to PID 1 stays a zombie until
 * PID 1 reaps it — lazily on some hosts (1–2 s in the Claude Code container,
 * #4297) — and `kill(pid, 0)` succeeds on a zombie. So state `Z` counts as gone;
 * where /proc is absent (macOS, launchd reaps) ESRCH alone decides.
 */
function pidExited(pid) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code === 'ESRCH') return true
    throw e
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').startsWith('Z')
  } catch {
    return false
  }
}
/** Stop an orphaned process group; it may already be gone (ESRCH), which is fine. */
function stopGroup(pg) {
  try {
    process.kill(-pg, 'SIGTERM')
  } catch (e) {
    if (e.code !== 'ESRCH') throw e
  }
}

// Fixture workspace for incident 4: packages/b's tests import packages/a's
// BUILT output, the way tsup-built workspace packages are consumed.
const A_SRC = 'export const limit = (n) => n > 0\n'
const WORKSPACE = {
  'package.json': JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*'] }),
  'packages/a/package.json': JSON.stringify({ name: 'a', version: '0.0.0', scripts: { build: 'node build.mjs' } }),
  'packages/a/src/index.mjs': A_SRC,
  'packages/a/build.mjs': `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const src = readFileSync('src/index.mjs')
const log = process.env.PR_FIXTURE_BUILD_LOG
const n = log && existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0
if (log) appendFileSync(log, createHash('sha256').update(src).digest('hex') + '\\n')
if (process.env.PR_FIXTURE_FAIL_BUILD_AT === String(n + 1)) process.exit(1)
if (process.env.PR_FIXTURE_BUILD_PID) appendFileSync(process.env.PR_FIXTURE_BUILD_PID, process.pid + '\\n')
// A mutant build blocks until the self-test releases it (a file appears) — capped, so a crashed test cannot leave it forever.
if (process.env.PR_FIXTURE_BUILD_BLOCK && String(src).includes('>=')) {
  let i = 0
  for (; i < 6000 && !existsSync(process.env.PR_FIXTURE_BUILD_BLOCK); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  if (i === 6000) process.exit(1)
}
mkdirSync('dist', { recursive: true })
writeFileSync('dist/index.mjs', src)
`,
  'packages/b/package.json': JSON.stringify({ name: 'b', version: '0.0.0' }),
  'packages/b/src/b.mjs': 'export const twice = (n) => n * 2\n',
  'packages/b/a.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { limit } from '../a/dist/index.mjs'\ntest('limit refuses zero', () => assert.equal(limit(0), false))\n",
  'packages/b/b.test.mjs':
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { limit } from '../a/dist/index.mjs'\nimport { twice } from './src/b.mjs'\ntest('limit still refuses zero', () => assert.equal(limit(0), false))\ntest('twice doubles', () => assert.equal(twice(2), 4))\n",
}
const WORKSPACE_CELLS = [
  baseCell({ id: 'A1', guard: 'limit refuses zero', test: 'packages/b/a.test.mjs', file: 'packages/a/src/index.mjs', expect_red: ['limit refuses zero'] }),
  baseCell({ id: 'B1', guard: 'twice doubles', test: 'packages/b/b.test.mjs', file: 'packages/b/src/b.mjs', edits: [{ find: 'n * 2', replace: 'n * 3' }], expect_red: ['twice doubles'] }),
]

describe('end to end in throwaway repos', { concurrency: true }, () => {
describe('end to end, one guardrail per incident (#4234)', { concurrency: 4 }, () => {
  test('control: a clean cell is caught, restored, and leaves nothing behind', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 0, r.out)
    assert.equal(result(repo).cells[0].class, 'caught')
    assert.equal(fileOf(repo), GUARD_SRC)
    assert.equal(g(repo.wt, 'status', '--porcelain'), '')
    assert.equal(ranCount(repo), 2, 'one baseline run and one mutant run')
    assert.ok(!existsSync(repo.journal) && !existsSync(repo.lock))
    assert.ok(!existsSync(path.join(repo.scratch, 'guard.mjs.1.author.C1.bak')), 'a verified restore removes its backup')
    assert.match(r.out, /\| C1 \| allowed refuses zero \| polarity: `n > 0` → `n >= 0` \| caught: 1 of 2 red \(guard > refuses zero\)/)
  })

  test('incident 1: a tree with uncommitted, untracked or staged changes is refused before any cell', async () => {
    const variants = [
      ['modified', (wt) => writeFileSync(path.join(wt, 'guard.test.mjs'), fixtureTest() + '// edit\n')],
      ['untracked', (wt) => writeFileSync(path.join(wt, 'notes.txt'), 'x')],
      ['staged', (wt) => (writeFileSync(path.join(wt, 'notes.txt'), 'x'), g(wt, 'add', 'notes.txt'))],
    ]
    await Promise.all(
      variants.map(async ([label, dirty]) => {
        const repo = makeRepo()
        writeCells(repo, [baseCell()])
        dirty(repo.wt)
        const r = await run(repo, MUTATE)
        assert.equal(r.code, 2, `${label}: ${r.out}`)
        assert.match(r.out, /not clean and committed/, label)
        assert.equal(ranCount(repo), 0, `${label}: no test ran`)
        assert.equal(fileOf(repo), GUARD_SRC)
      }),
    )
  })

  test('incident 1: a mutation staged during the run fails the restore check and exits 3', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_STAGE: '1' } })
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /RESTORE FAILED.*not clean.*git add -A/s)
    assert.equal(fileOf(repo), GUARD_SRC, 'the working file is restored')
    assert.equal(g(repo.wt, 'diff', '--cached', '--name-only').trim(), 'src/guard.mjs', 'the staged mutant is reported, not hidden')
    assert.equal(g(repo.wt, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed')
    assert.ok(existsSync(repo.journal), 'the journal is kept')
    const cell = result(repo).cells[0]
    assert.equal(cell.class, 'caught', 'the measured class survives the failed restore')
    assert.match(cell.restoreFailed, /index holds a staged change \(src\/guard\.mjs\)/)
  })

  test('a file edited by someone else during the run is not overwritten by the restore — exit 3, edit kept', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_HANDEDIT: '1' } })
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /changed during the run — it matches neither the mutant prove-red wrote nor the original.*nothing was overwritten/s)
    assert.equal(fileOf(repo), 'hand edit\n')
    assert.ok(existsSync(repo.journal), 'the journal is kept')
  })

  test('the restore keeps the file mode (a 100755 file stays executable)', async () => {
    const repo = makeRepo({}, { modes: { 'src/guard.mjs': 0o755 } })
    assert.match(g(repo.wt, 'ls-files', '-s', 'src/guard.mjs'), /^100755 /)
    writeCells(repo, [baseCell()])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 0, r.out)
    assert.equal(statSync(path.join(repo.wt, 'src/guard.mjs')).mode & 0o777, 0o755)
    assert.equal(g(repo.wt, 'status', '--porcelain'), '')
  })

  test('a symlinked file and a file that is not valid UTF-8 are refused before any run', async () => {
    const repo = makeRepo({ 'src/latin1.mjs': Buffer.concat([Buffer.from('export const s = "'), Buffer.from([0xff]), Buffer.from('"\n')]) }, { symlinks: { 'src/link.mjs': 'guard.mjs' } })
    writeCells(repo, [baseCell({ file: 'src/link.mjs' }), baseCell({ id: 'C2', file: 'src/latin1.mjs', edits: [{ find: 'export const s', replace: 'export let s' }] })])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /C1: file src\/link\.mjs is a symlink/)
    assert.match(r.out, /C2: file src\/latin1\.mjs is not valid UTF-8/)
    assert.equal(ranCount(repo), 0)
  })

  test('incident 2: a find that occurs twice is refused before any run', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell({ edits: [{ find: 'n', replace: 'm' }] })])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /occurs \d+ times in src\/guard\.mjs.*exactly once/)
    assert.equal(ranCount(repo), 0)
    assert.equal(fileOf(repo), GUARD_SRC)
  })

  test('incident 3: a find that occurs 0 times is refused before any run', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell({ edits: [{ find: 'n >== 0', replace: 'true' }] })])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /occurs 0 times/)
    assert.equal(ranCount(repo), 0)
  })

  test('incident 4: a cross-package cell rebuilds before the test and after the restore; the next cell sees the original build', async () => {
    const repo = makeRepo(WORKSPACE)
    execFileSync('npm', ['run', 'build', '-w', 'packages/a'], { cwd: repo.wt, env: cleanEnv({}), stdio: 'ignore' })
    const dist = path.join(repo.wt, 'packages/a/dist/index.mjs')
    assert.equal(readFileSync(dist, 'utf8'), A_SRC)
    writeCells(repo, WORKSPACE_CELLS)
    const buildLog = path.join(repo.dir, 'build.log')
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_BUILD_LOG: buildLog } })
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(result(repo).cells.map((c) => [c.id, c.class]), [['A1', 'caught'], ['B1', 'caught']])
    assert.match(r.out, /build: npm run build -w packages\/a \(mutant\).*build: npm run build -w packages\/a \(restored\)/s)
    assert.deepEqual(
      readFileSync(buildLog, 'utf8').split('\n').filter(Boolean),
      [sha(A_SRC), sha(A_SRC.replace('n > 0', 'n >= 0')), sha(A_SRC)],
      'built the original for the baseline, the mutant, then the original again — and nothing for B1',
    )
    assert.match(r.out, /build: npm run build -w packages\/a \(baseline\).*build: npm run build -w packages\/a \(mutant\)/s)
    assert.equal(readFileSync(dist, 'utf8'), A_SRC)
  })

  test('incident 4: a failed post-restore rebuild exits 3, keeps the tree marked dirty, and recover rebuilds', async () => {
    const repo = makeRepo(WORKSPACE)
    execFileSync('npm', ['run', 'build', '-w', 'packages/a'], { cwd: repo.wt, env: cleanEnv({}), stdio: 'ignore' })
    writeCells(repo, [WORKSPACE_CELLS[0]])
    const buildLog = path.join(repo.dir, 'build.log')
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_BUILD_LOG: buildLog, PR_FIXTURE_FAIL_BUILD_AT: '3' } })
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /post-restore rebuild of packages\/a failed.*dist\/ may still hold the mutant build/s)
    assert.equal(JSON.parse(readFileSync(repo.journal, 'utf8')).buildDirty, true)
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/dist/index.mjs'), 'utf8'), A_SRC.replace('n > 0', 'n >= 0'), 'dist still holds the mutant')
    assert.equal(g(repo.wt, 'status', '--porcelain'), '', 'and git status cannot see it — dist/ is gitignored')
    const again = await run(repo, MUTATE, { env: { PR_FIXTURE_BUILD_LOG: buildLog } })
    assert.equal(again.code, 2, again.out)
    assert.match(again.out, /run `node scripts\/ci\/prove-red\.mjs recover` first/)
    const rec = await run(repo, ['recover'], { env: { PR_FIXTURE_BUILD_LOG: buildLog } })
    assert.equal(rec.code, 0, rec.out)
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/dist/index.mjs'), 'utf8'), A_SRC)
    assert.ok(!existsSync(repo.journal))
  })

  test('a test that writes into the tree is refused before anything is mutated', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_TOUCH: 'touched.txt' } })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /unmutated run of guard\.test\.mjs wrote into the tree \(\?\? touched\.txt\); nothing was mutated/)
    assert.ok(!existsSync(path.join(repo.scratch, 'guard.mjs.1.author.C1.bak')), 'no backup was taken')
    assert.equal(ranCount(repo), 1, 'the mutant never ran')
    assert.equal(fileOf(repo), GUARD_SRC)
  })

  test('incident 4: a stale dist cannot make a comment-only mutation read as caught — the baseline reads a fresh build', async () => {
    const repo = makeRepo(WORKSPACE)
    execFileSync('npm', ['run', 'build', '-w', 'packages/a'], { cwd: repo.wt, env: cleanEnv({}), stdio: 'ignore' })
    // The source then breaks the guard and is committed; dist/ still holds the good build.
    writeFileSync(path.join(repo.wt, 'packages/a/src/index.mjs'), A_SRC.replace('n > 0', 'n >= 0'))
    g(repo.wt, 'commit', '-qam', 'break the guard without rebuilding')
    writeCells(repo, [{ ...WORKSPACE_CELLS[0], edits: [{ find: 'export const limit', replace: '// comment only\nexport const limit' }] }])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 1, r.out)
    const c = result(repo).cells[0]
    assert.equal(c.class, 'refused', `a fresh baseline build exposes the broken source: ${c.detail}`)
    assert.match(c.detail, /unmutated test is red/)
  })

  test('incident 4: a package that does not build unmutated refuses the cell before its baseline', async () => {
    const repo = makeRepo(WORKSPACE)
    writeCells(repo, [WORKSPACE_CELLS[0]])
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_BUILD_LOG: path.join(repo.dir, 'build.log'), PR_FIXTURE_FAIL_BUILD_AT: '1' } })
    assert.equal(r.code, 1, r.out)
    const c = result(repo).cells[0]
    assert.equal(c.class, 'refused')
    assert.match(c.detail, /packages\/a does not build unmutated/)
    assert.equal(c.backup, undefined, 'nothing was mutated')
  })

  test('incident 5: a mutation that breaks compilation is mutation-red, not caught', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell({ edits: [{ find: 'n > 0', replace: 'n > > 0' }] })])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 1, r.out)
    assert.equal(result(repo).cells[0].class, 'mutation-red')
    assert.match(r.out, /\*\*mutation-red\*\* \|/)
    assert.equal(fileOf(repo), GUARD_SRC)
  })

  test('incident 6: the restore is cp + sha256, and git checkout/stash/restore are never invoked (git stub on PATH)', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell(), baseCell({ id: 'C2', edits: [{ find: 'n > 0', replace: 'n > > 0' }] })])
    const stubDir = path.join(repo.dir, 'stub')
    const gitLog = path.join(repo.dir, 'git-argv.log')
    mkdirSync(stubDir)
    writeFileSync(path.join(stubDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })
    const r = await run(repo, MUTATE, { env: { PATH: `${stubDir}${path.delimiter}${process.env.PATH}` } })
    assert.equal(r.code, 1, r.out)
    const argv = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean)
    const subcommands = new Set(argv.map((l) => l.split(' ')[0]))
    // Positive control: the stub saw the runner's own git calls.
    assert.ok(subcommands.has('status') && subcommands.has('diff'), `stub saw: ${[...subcommands].join(', ')}`)
    for (const forbidden of ['checkout', 'stash', 'restore', 'switch', 'reset', 'add', 'commit', 'push', 'show', 'apply', 'clean', 'rm'])
      assert.ok(!subcommands.has(forbidden), `git ${forbidden} was invoked: ${argv.filter((l) => l.startsWith(forbidden)).join(' | ')}`)
    const cells = result(repo).cells
    assert.equal(cells[0].origSha, sha(GUARD_SRC))
    assert.equal(cells[0].mutantSha, sha(GUARD_SRC.replace('n > 0', 'n >= 0')))
    assert.equal(cells[0].backup, path.join(realpathSync(repo.scratch), 'guard.mjs.1.author.C1.bak'), 'backup named <file>.<issue>.<role>.<cell>.bak')
    assert.equal(fileOf(repo), GUARD_SRC)
  })

  test('incident 6: a backup that no longer verifies is not copied back — exit 3, journal kept, recover refuses too', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    const backup = path.join(realpathSync(repo.scratch), 'guard.mjs.1.author.C1.bak')
    const r = await run(repo, MUTATE, { env: { PR_FIXTURE_CORRUPT: backup } })
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /missing or no longer matches the original's sha256, so nothing was restored/)
    const mutant = GUARD_SRC.replace('n > 0', 'n >= 0')
    assert.equal(fileOf(repo), mutant, 'the corrupted backup was not copied over the file')
    assert.ok(existsSync(repo.journal))
    const rec = await run(repo, ['recover'])
    assert.equal(rec.code, 3, rec.out)
    assert.match(rec.out, /does not match the journalled sha256; nothing was restored/)
    assert.equal(fileOf(repo), mutant)
  })

  test('incident 7: node_modules resolving outside the tree is refused', async () => {
    for (const label of ['node_modules symlink', 'workspace package symlink']) {
      const repo = makeRepo()
      writeCells(repo, [baseCell()])
      const elsewhere = path.join(repo.dir, 'elsewhere')
      mkdirSync(path.join(elsewhere, 'pkg'), { recursive: true })
      if (label === 'node_modules symlink') symlinkSync(elsewhere, path.join(repo.wt, 'node_modules'))
      else {
        mkdirSync(path.join(repo.wt, 'node_modules', '@haven_ai'), { recursive: true })
        symlinkSync(path.join(elsewhere, 'pkg'), path.join(repo.wt, 'node_modules', '@haven_ai', 'sdk'))
      }
      const r = await run(repo, MUTATE)
      assert.equal(r.code, 2, `${label}: ${r.out}`)
      assert.match(r.out, /node_modules resolves outside this tree/, label)
      assert.equal(ranCount(repo), 0, label)
    }
  })

  test('the main checkout that worktrees hang off is refused; a worktree is not', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    const r = await run(repo, MUTATE, { cwd: repo.main })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /is the main checkout/)
    assert.equal(ranCount(repo), 0)
  })

  test('a cell whose unmutated test is red is refused and never mutated', async () => {
    const repo = makeRepo({ 'red.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { appendFileSync } from 'node:fs'\nappendFileSync(process.env.PR_FIXTURE_LOG, 'ran:red\\n')\ntest('refuses zero', () => assert.equal(1, 2))\n" })
    writeCells(repo, [baseCell({ test: 'red.test.mjs', expect_red: ['refuses zero'] })])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 1, r.out)
    const c = result(repo).cells[0]
    assert.equal(c.class, 'refused')
    assert.match(c.detail, /unmutated test is red/)
    assert.equal(ranCount(repo), 1, 'only the baseline ran')
    assert.equal(c.backup, undefined, 'no backup was taken')
  })

  test('an expect_red name the baseline does not report is refused (full names join with " > ")', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell({ expect_red: ['refuses zero'] })])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 1, r.out)
    assert.match(result(repo).cells[0].detail, /did not report.*"guard > refuses zero"/)
  })

  test('a multi-edit cell and an all: true cell both apply', async () => {
    const repo = makeRepo()
    writeCells(repo, [
      baseCell({ id: 'M2', family: 'unentered-branch', edits: [{ find: 'return n > 0', replace: 'const r = n >= 0' }, { find: '\n}', replace: '\n  return r\n}' }] }),
      { ...baseCell({ id: 'W1', family: 'other', note: 'CRLF rewrite' }), edits: undefined, all: true, replace: 'export function allowed(n) {\r\n  return true\r\n}\r\n' },
    ])
    const r = await run(repo, MUTATE)
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(result(repo).cells.map((c) => [c.id, c.class]), [['M2', 'caught'], ['W1', 'caught']])
    assert.match(r.out, /whole-file rewrite \(`all: true`\)/)
    assert.equal(fileOf(repo), GUARD_SRC)
  })

  test('a live lock, an unset or in-tree SCRATCH, and an in-tree cells file are refused', async () => {
    const repo = makeRepo()
    writeCells(repo, [baseCell()])
    writeFileSync(repo.lock, JSON.stringify({ pid: process.pid }))
    writeFileSync(repo.journal, '{}')
    let r = await run(repo, MUTATE)
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, new RegExp(`another prove-red run \\(pid ${process.pid}\\) holds`), 'the lock is taken before the journal is read')
    unlinkSync(repo.lock)
    unlinkSync(repo.journal)
    r = await run(repo, MUTATE, { env: { SCRATCH: '' } })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /SCRATCH is not set/)
    r = await run(repo, MUTATE, { env: { SCRATCH: path.join(repo.wt, 'src') } })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /is inside the tree/)
    r = await run(repo, [...MUTATE, '--cells', path.join(repo.wt, 'guard.test.mjs')])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /never in the tree/)
    assert.equal(ranCount(repo), 0)
  })
})

describe('signals and recover', { concurrency: 4 }, () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    test(`${sig} mid-cell restores the file and exits ${code}`, async () => {
      const repo = makeRepo()
      writeCells(repo, [baseCell(), baseCell({ id: 'C2' })])
      // The mutant test hangs until released, and this test never releases it:
      // the run ending at all proves the signal reached the test's process group.
      const p = start(repo, MUTATE, { env: { PR_FIXTURE_HANG: releaseFile(repo) } })
      await waitFor(() => existsSync(repo.log) && readFileSync(repo.log, 'utf8').includes('mutant-started'), 'the mutant run')
      assert.equal(fileOf(repo), GUARD_SRC.replace('n > 0', 'n >= 0'), 'the mutant is in place when the signal lands')
      const t0 = Date.now()
      p.child.kill(sig)
      const r = await p.done
      release(repo)
      assert.ok(Date.now() - t0 < 120000, `the run took ${Date.now() - t0} ms to stop: the hanging test was not killed`)
      assert.equal(r.code, code, r.out)
      assert.equal(fileOf(repo), GUARD_SRC)
      assert.equal(g(repo.wt, 'status', '--porcelain'), '')
      assert.ok(!existsSync(repo.journal) && !existsSync(repo.lock))
      assert.equal(result(repo).cells.length, 1, 'the second cell never started')
    })
  }

  test('SIGINT during the mutant build stops the whole build, restores and rebuilds', async () => {
    const repo = makeRepo(WORKSPACE)
    execFileSync('npm', ['run', 'build', '-w', 'packages/a'], { cwd: repo.wt, env: cleanEnv({}), stdio: 'ignore' })
    writeCells(repo, [WORKSPACE_CELLS[0]])
    const buildLog = path.join(repo.dir, 'build.log')
    const pids = path.join(repo.dir, 'build.pids')
    const p = start(repo, MUTATE, { env: { PR_FIXTURE_BUILD_LOG: buildLog, PR_FIXTURE_BUILD_BLOCK: releaseFile(repo), PR_FIXTURE_BUILD_PID: pids } })
    await waitFor(() => existsSync(pids) && readFileSync(pids, 'utf8').split('\n').filter(Boolean).length >= 2, 'the mutant build')
    const mutantBuild = Number(readFileSync(pids, 'utf8').split('\n').filter(Boolean)[1])
    const t0 = Date.now()
    // Pins pidExited's polarity: the blocked build is alive here, whatever its reaping.
    assert.equal(pidExited(mutantBuild), false, 'the blocked mutant build is alive before the signal')
    p.child.kill('SIGINT')
    const r = await p.done
    // Before the release: a build that survived the signal is still blocked
    // here, so it never exits; after it, a survivor would finish by itself.
    // The short poll is for hosts with no /proc, where only the reap says gone (#4297).
    const exited = await waitFor(() => pidExited(mutantBuild), 'the mutant build to exit', 5000).then(
      () => true,
      (e) => {
        if (/^timed out/.test(e.message)) return false
        throw e
      },
    )
    release(repo)
    assert.equal(r.code, 130, r.out)
    assert.ok(Date.now() - t0 < 120000, `took ${Date.now() - t0} ms: the blocked build was not stopped`)
    assert.ok(exited, 'the mutant build process is gone')
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/dist/index.mjs'), 'utf8'), A_SRC)
    assert.ok(!existsSync(repo.journal))
  })

  async function killedMidCell(opts) {
    const repo = makeRepo({}, opts)
    writeCells(repo, [baseCell()])
    const p = start(repo, MUTATE, { env: { PR_FIXTURE_HANG: releaseFile(repo) } })
    await waitFor(() => existsSync(repo.log) && readFileSync(repo.log, 'utf8').includes('mutant-started'), 'the mutant run')
    p.child.kill('SIGKILL')
    const r = await p.done
    assert.equal(r.signal, 'SIGKILL')
    assert.equal(fileOf(repo), GUARD_SRC.replace('n > 0', 'n >= 0'), 'kill -9 left the mutant')
    assert.ok(existsSync(repo.journal))
    const pg = JSON.parse(readFileSync(repo.journal, 'utf8')).childPgid
    assert.ok(Number.isInteger(pg), 'the in-flight test run is journalled by its process group')
    release(repo) // the orphaned test may now finish; it is still running until it does
    stopGroup(pg) // the operator's step the recover refusal prints
    await waitFor(() => !groupAlive(pg), 'the orphaned test run to stop')
    return repo
  }

  test('kill -9 during the mutant build: recover refuses while the orphaned build runs, then restores source and build', async () => {
    const repo = makeRepo(WORKSPACE)
    execFileSync('npm', ['run', 'build', '-w', 'packages/a'], { cwd: repo.wt, env: cleanEnv({}), stdio: 'ignore' })
    writeCells(repo, [WORKSPACE_CELLS[0]])
    const buildLog = path.join(repo.dir, 'build.log')
    // The mutant build blocks until released, so it is guaranteed alive while
    // recover is asserted to refuse; releasing it lets the orphan write its
    // mutant dist, which is exactly what recover must then rebuild over.
    const env = { PR_FIXTURE_BUILD_LOG: buildLog, PR_FIXTURE_BUILD_BLOCK: releaseFile(repo) }
    const p = start(repo, MUTATE, { env })
    await waitFor(() => existsSync(buildLog) && readFileSync(buildLog, 'utf8').split('\n').filter(Boolean).length >= 2, 'the mutant build')
    p.child.kill('SIGKILL')
    await p.done
    const pg = JSON.parse(readFileSync(repo.journal, 'utf8')).childPgid
    assert.ok(Number.isInteger(pg) && groupAlive(pg), `the orphaned build is still running: ${readFileSync(repo.journal, 'utf8')} ${readFileSync(buildLog, 'utf8')}`)
    const early = await run(repo, ['recover'], { env })
    assert.equal(early.code, 3, early.out)
    assert.match(early.out, new RegExp(`process group ${pg} from the killed run is still running`))
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/src/index.mjs'), 'utf8'), A_SRC.replace('n > 0', 'n >= 0'), 'nothing was restored')
    assert.match(early.out, new RegExp(`ps -o pid,command -g ${pg}`))
    assert.ok(groupAlive(pg), 'still blocked: nothing released it yet')
    release(repo)
    await waitFor(() => !groupAlive(pg), 'the released orphan to finish')
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/dist/index.mjs'), 'utf8'), A_SRC.replace('n > 0', 'n >= 0'), 'the orphan wrote its mutant build after the kill')
    const rec = await run(repo, ['recover'], { env })
    assert.equal(rec.code, 0, rec.out)
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/src/index.mjs'), 'utf8'), A_SRC)
    assert.equal(readFileSync(path.join(repo.wt, 'packages/a/dist/index.mjs'), 'utf8'), A_SRC, 'the build is the original again')
  })

  test('kill -9 mid-cell: the next run refuses, recover restores from the journal and verifies the sha256', async () => {
    const repo = await killedMidCell()
    const again = await run(repo, MUTATE)
    assert.equal(again.code, 2, again.out)
    assert.match(again.out, /left .*prove-red\.journal\.json/)
    assert.match(again.out, /removed a stale lock/, 'the next run takes the lock first, breaking the dead one')
    const rec = await run(repo, ['recover'])
    assert.equal(rec.code, 0, rec.out)
    assert.match(rec.out, /restored src\/guard\.mjs from .*\(sha256 verified\)/)
    assert.equal(fileOf(repo), GUARD_SRC)
    assert.ok(!existsSync(repo.journal))
    assert.equal((await run(repo, ['recover'])).code, 0, 'a second recover has nothing to do')
  })

  test('recover keeps the file mode of a 100755 file', async () => {
    const repo = await killedMidCell({ modes: { 'src/guard.mjs': 0o755 } })
    const rec = await run(repo, ['recover'])
    assert.equal(rec.code, 0, rec.out)
    assert.equal(statSync(path.join(repo.wt, 'src/guard.mjs')).mode & 0o777, 0o755)
    assert.equal(g(repo.wt, 'status', '--porcelain'), '')
  })

  test('recover with a journal whose backup is gone exits 3 and restores nothing', async () => {
    const repo = await killedMidCell()
    unlinkSync(JSON.parse(readFileSync(repo.journal, 'utf8')).backup)
    const rec = await run(repo, ['recover'])
    assert.equal(rec.code, 3, rec.out)
    assert.match(rec.out, /no longer exists; nothing was restored/)
    assert.equal(fileOf(repo), GUARD_SRC.replace('n > 0', 'n >= 0'))
    assert.ok(existsSync(repo.journal), 'the journal is kept')
  })

  test('recover refuses a file edited after the kill and does not overwrite it', async () => {
    const repo = await killedMidCell()
    writeFileSync(path.join(repo.wt, 'src/guard.mjs'), 'hand edit\n')
    const rec = await run(repo, ['recover'])
    assert.equal(rec.code, 3, rec.out)
    assert.match(rec.out, /matches neither the journalled mutant nor the original.*nothing was overwritten/s)
    assert.equal(fileOf(repo), 'hand edit\n')
  })
})

describe('verify: the reviewer\'s own root and own cells, failing closed', { concurrency: 4 }, () => {
  function reviewRepo() {
    const repo = makeRepo()
    const review = path.join(repo.dir, 'review')
    g(repo.main, 'worktree', 'add', '-q', '--detach', review, 'wt')
    writeCells(repo, [baseCell()])
    return { ...repo, review }
  }
  const VERIFY = (repo) => ['verify', '--issue', '1', '--builder', repo.wt]
  const reviewerCell = baseCell({ id: 'R1', guard: 'allowed refuses zero', family: 'polarity', edits: [{ find: 'n > 0', replace: 'n > -1' }] })

  test('runs the author\'s cells and the reviewer\'s, and fills the reproduced column', async () => {
    const repo = reviewRepo()
    assert.equal((await run(repo, MUTATE)).code, 0)
    writeCells(repo, [reviewerCell], 'prove-red-1-review-cells.json')
    const head = g(repo.review, 'rev-parse', 'HEAD').trim()
    const r = await run(repo, [...VERIFY(repo), '--expect-head', head], { cwd: repo.review })
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(result(repo, 'verify').cells.map((c) => [c.id, c.origin, c.class]), [['C1', 'author', 'caught'], ['R1', 'review', 'caught']])
    assert.match(r.out, /\| C1 \|.*caught: 1 of 2 red \(guard > refuses zero\) @ `[0-9a-f]+` \| prove-red verify: caught.* \| reproduced \|/)
    assert.match(r.out, /\| R1 \|.*— \(reviewer cell\) \|.*\| reviewer cell: caught \|/)
  })

  test('a reviewer file that is missing, empty, unreadable, invalid, or all duplicates runs nothing and exits 2', async () => {
    const cases = [
      ['missing', () => {}, /reviewer cells file .* does not exist/],
      ['empty', (repo) => writeFileSync(path.join(repo.scratch, 'prove-red-1-review-cells.json'), ''), /is empty/],
      ['empty list', (repo) => writeCells(repo, [], 'prove-red-1-review-cells.json'), /holds no cells/],
      ['unreadable', (repo) => mkdirSync(path.join(repo.scratch, 'prove-red-1-review-cells.json')), /is unreadable/],
      ['invalid JSON', (repo) => writeFileSync(path.join(repo.scratch, 'prove-red-1-review-cells.json'), '[{'), /not valid JSON/],
      ['all duplicates', (repo) => writeCells(repo, [baseCell({ id: 'R1' })], 'prove-red-1-review-cells.json'), /every reviewer cell duplicates an author cell/],
    ]
    if (process.getuid?.() !== 0)
      cases.push([
        'mode 000',
        (repo) => {
          const f = writeCells(repo, [reviewerCell], 'prove-red-1-review-cells.json')
          chmodSync(f, 0o000)
        },
        /is unreadable/,
      ])
    for (const [label, setup, expected] of cases) {
      const repo = reviewRepo()
      setup(repo)
      const r = await run(repo, VERIFY(repo), { cwd: repo.review })
      assert.equal(r.code, 2, `${label}: ${r.out}`)
      assert.match(r.out, expected, label)
      assert.equal(ranCount(repo), 0, `${label}: nothing ran`)
    }
  })

  test('verify refuses a HEAD other than --expect-head, and an author result produced in this same root', async () => {
    const repo = reviewRepo()
    writeCells(repo, [reviewerCell], 'prove-red-1-review-cells.json')
    g(repo.main, 'commit', '-q', '--allow-empty', '-m', 'another commit')
    const other = g(repo.main, 'rev-parse', 'HEAD').trim()
    let r = await run(repo, [...VERIFY(repo), '--expect-head', other], { cwd: repo.review })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /not the --expect-head/)
    assert.equal((await run(repo, MUTATE, { cwd: repo.review })).code, 0, 'the author ran mutate in the review root')
    const before = ranCount(repo)
    r = await run(repo, VERIFY(repo), { cwd: repo.review })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /was produced in this same root/)
    assert.equal(ranCount(repo), before, 'nothing ran')
  })

  test('verify refuses the builder\'s own tree and a missing --builder', async () => {
    const repo = reviewRepo()
    writeCells(repo, [reviewerCell], 'prove-red-1-review-cells.json')
    let r = await run(repo, VERIFY(repo), { cwd: repo.wt })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /not a reviewer's own root.*distinct-from-builder/)
    r = await run(repo, ['verify', '--issue', '1'], { cwd: repo.review })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /verify needs --builder/)
    assert.equal(ranCount(repo), 0)
  })
})

describe('census end to end', () => {
  test('runs the five newest files and two probes, nothing out of budget', async () => {
    const files = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`t${n}.test.mjs`, fixtureTest(`t${n}`)]))
    const repo = makeRepo(files)
    writeCells(repo, CENSUS_CELLS.map((c) => ({ ...c, expect_red: [`${c.test.replace('.test.mjs', '')} > refuses zero`] })))
    const candidates = path.join(repo.scratch, 'candidates.txt')
    writeFileSync(candidates, CANDIDATES)
    const r = await run(repo, ['census', '--issue', '1', '--candidates', candidates])
    assert.equal(r.code, 0, r.out)
    const res = result(repo, 'census')
    assert.deepEqual(res.selection.rows.map((x) => [x.slot, x.file, x.cell]), [
      ['M1', 't7.test.mjs', 'X7'],
      ['M2', 't6.test.mjs', 'X6'],
      ['M3', 't5.test.mjs', 'X5'],
      ['M4', 't4.test.mjs', 'X4'],
      ['M5', 't3.test.mjs', 'X3'],
    ])
    assert.deepEqual(res.cells.map((c) => [c.id, c.class]), ['X7', 'X6', 'X5', 'X4', 'X3', 'P1', 'P2'].map((id) => [id, 'caught']))
    const ran = readFileSync(repo.log, 'utf8').split('\n').filter((l) => l.startsWith('ran:')).sort()
    assert.deepEqual(ran, ['t1', 't1', 't2', 't2', 't3', 't3', 't4', 't4', 't5', 't5', 't6', 't6', 't7', 't7'].map((x) => `ran:${x}`))
    assert.match(r.out, /\| M1 \| `t7\.test\.mjs` \| invert t7 \(`src\/guard\.mjs`\) \| 2 → \*\*1 failed\*\*: caught \|/)
    assert.match(r.out, /7 caught, 0 survived, 0 shadowed, 0 mutation-red, 0 refused, 0 not run\./)
    assert.match(r.out, /Out of budget, not run: X2, P3\./)
  })
})
})
