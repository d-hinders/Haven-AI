// Self-test for the db-mock ratchet (#1227).
// Run with: node --test scripts/db-mock-ratchet.test.mjs
//
// The case that matters most is that A VIOLATION ACTUALLY FAILS — the
// dependency-boundary lint's own history records that a gate which silently
// passes during development is worse than no gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { newViolations } from './lib/ratchet.mjs'
import { scanSource, scanAll, BASELINE_PATH } from './db-mock-ratchet.mjs'

test('scanSource counts db.js mocks and positional calls', () => {
  const src = `
    vi.mock('../../db.js', () => ({}))
    mockQuery.mockResolvedValueOnce({ rows: [] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] })
  `
  assert.deepEqual(scanSource(src), { 'db-mock': 1, positional: 2 })
})

test('a deeper relative path and double quotes still count as a db.js mock', () => {
  assert.deepEqual(scanSource(`vi.mock("../../../db.js", () => ({}))`), { 'db-mock': 1 })
  // …but an unrelated module does not:
  assert.deepEqual(scanSource(`vi.mock('../../modules/passport/index.js')`), {})
})

test('a violation ACTUALLY FAILS: growth in a baselined file is reported', () => {
  const baseline = { 'a.test.ts': { positional: 5 } }
  const grown = newViolations({ 'a.test.ts': { positional: 6 } }, baseline)
  assert.equal(grown.length, 1)
  assert.deepEqual(grown[0], { file: 'a.test.ts', key: 'positional', count: 6, allowed: 5 })
})

test('a NEW file mocking db.js is a violation even at count 1', () => {
  const grown = newViolations({ 'brand-new.test.ts': { 'db-mock': 1 } }, {})
  assert.equal(grown.length, 1)
  assert.equal(grown[0].allowed, 0)
})

test('equal and shrunk counts pass', () => {
  const baseline = { 'a.test.ts': { positional: 5, 'db-mock': 1 } }
  assert.deepEqual(newViolations({ 'a.test.ts': { positional: 5, 'db-mock': 1 } }, baseline), [])
  assert.deepEqual(newViolations({ 'a.test.ts': { positional: 2 } }, baseline), [])
})

test('the exemption comment removes a file from BOTH counts — but only with a real reason', () => {
  const exempted = `
    // db-mock-exempt: this suite characterizes the exact SQL text sent, which needs the mock
    vi.mock('../../db.js')
    mockQuery.mockResolvedValueOnce({ rows: [] })
  `
  assert.equal(scanSource(exempted), null)
  // A bare marker with no reason does NOT exempt:
  const bare = `
    // db-mock-exempt: short
    vi.mock('../../db.js')
  `
  assert.deepEqual(scanSource(bare), { 'db-mock': 1 })
})

test('the committed baseline matches the tree (bootstrap parity, shrink-only from here)', async () => {
  const counts = await scanAll()
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  const grown = newViolations(counts, baseline)
  assert.deepEqual(
    grown,
    [],
    'the tree grew past the committed db-mock baseline — move DB assertions to a repository test on the real-DB harness',
  )
})

// The phantom-entry guard (#2264), mirroring `scripts/ci/money-path.test.mjs`'s
// "no phantom globs" assertion (#1897) one gate over.
//
// A baseline entry for a file the scan does not produce counts for is INERT in
// one direction and NOISY in the other, and both halves were live on `dev`:
//
//   `newViolations()` iterates the SCANNED files, so the entry is never
//   consulted — it silently grants its whole count as free positional-mock
//   debt to whoever next creates a file at that path.
//
//   `hasShrunk()` iterates the BASELINE, so the entry keeps `lint:db-mocks`
//   printing "counts are below the baseline — lock in the progress" on every
//   backend PR, forever. A permanently-on nag is a nag nobody reads, which is
//   how two deleted-file entries survived from #1987/#2055 to #2264.
//
// The check is against the SCANNED set rather than against `existsSync`,
// because the two ways an entry goes inert are the same defect: the file was
// deleted, OR it still exists and no longer contributes counts (every mock
// removed, or a `// db-mock-exempt:` comment added). `existsSync` sees only the
// first. The fix for either is the same one the nag already names:
// `node scripts/db-mock-ratchet.mjs --update`.
test('no phantom baseline entries — every entry names a file the scan still counts', async () => {
  const counts = await scanAll()
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  const phantom = Object.keys(baseline).filter((file) => !(file in counts))

  assert.deepEqual(
    phantom,
    [],
    'db-mock baseline entries that the scan no longer produces counts for. The ' +
      'file was deleted, or it still exists and no longer mocks the database. ' +
      'Either way the entry is inert (newViolations iterates the scan, not the ' +
      'baseline) while keeping the shrink nag permanently on (hasShrunk ' +
      'iterates the baseline). Run: node scripts/db-mock-ratchet.mjs --update',
  )
})

// --- The CLI path (#2721, epic #2720)
//
// The cases above test the counting and the ratchet arithmetic. Neither
// reaches `main()`, where this guard's two refusals live: growth past the
// baseline, and `--update` declining to RAISE it. Those are the lines that
// decide whether a pull request lands, and the exact shape that survived
// mutation elsewhere in this repo with a green suite (#2690).

import { runGuard } from './test-support/guard-cli.mjs'

const SCANNED = 'packages/backend/src/x.test.ts'
const withMocks = (n) =>
  `vi.mock('../db.js')\n` + Array.from({ length: n }, () => 'mockResolvedValueOnce()').join('\n')

test('CLI: growth past the baseline exits non-zero and names the file', () => {
  const { status, out } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SCANNED]: withMocks(3),
      'packages/backend/db-mock-baseline.json': JSON.stringify({ [SCANNED]: { 'db-mock': 1, positional: 1 } }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /positional DB mocking grew/)
  assert.match(out, /x\.test\.ts/)
})

test('CLI: a tree at or under the baseline exits 0', () => {
  // The control: without it the case above passes against a ratchet that
  // refuses everything.
  const { status } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SCANNED]: withMocks(1),
      'packages/backend/db-mock-baseline.json': JSON.stringify({ [SCANNED]: { 'db-mock': 1, positional: 1 } }),
    },
  })
  assert.equal(status, 0)
})

test('CLI: `--update` REFUSES to raise the baseline, and writes nothing', () => {
  // The second clause is checked, not just claimed (review nit): `readBack`
  // reads the fixture file before the harness removes the root, so "writes
  // nothing" means the baseline on disk is byte-identical to what went in.
  // A shrink-only ratchet whose `--update` quietly accepts growth is not a
  // ratchet. This refusal lives only in `main()`.
  const before = JSON.stringify({ [SCANNED]: { 'db-mock': 1, positional: 1 } })
  const { status, out, wrote } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: { [SCANNED]: withMocks(3), 'packages/backend/db-mock-baseline.json': before },
    readBack: ['packages/backend/db-mock-baseline.json'],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.equal(wrote['packages/backend/db-mock-baseline.json'], before)
})

test('CLI: `--update` DOES write when the count fell', () => {
  // `baseline written` is a console line, not evidence: a `writeBaseline` that
  // resolves its path against the wrong root, or swallows an error, prints it
  // and exits 0 having written nothing -- and `npm run lint:db-mocks:update`
  // becomes a no-op while the ratchet drifts. Read the file back instead.
  const { status, out, wrote } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: {
      [SCANNED]: withMocks(1),
      'packages/backend/db-mock-baseline.json': JSON.stringify({ [SCANNED]: { 'db-mock': 1, positional: 5 } }),
    },
    readBack: ['packages/backend/db-mock-baseline.json'],
  })
  assert.equal(status, 0)
  assert.match(out, /baseline written/)
  assert.deepEqual(JSON.parse(wrote['packages/backend/db-mock-baseline.json'])[SCANNED].positional, 1)
})

test('CLI: an existing but EMPTY baseline REFUSES growth -- it is not a first run', () => {
  // #2728. This gate's `--update` used to key its allowance on the baseline
  // being empty, and `{}` is exactly what `writeBaseline` produces once the
  // gate reaches zero debt -- so the refusal switched itself off on the first
  // successful cleanup, which is the step this gate's own message tells you to
  // run. The decision now lives in `lib/ratchet.mjs` and is keyed on the
  // baseline FILE not existing.
  //
  // Pinned HERE rather than only on the gate that #2728 was filed against,
  // because review measured that reverting the shared key left both converted
  // gates' suites fully green: a tightening nothing observes is a tightening
  // that can be undone silently.
  const { status, out, wrote } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: { [SCANNED]: withMocks(3), 'packages/backend/db-mock-baseline.json': '{}' },
    readBack: ['packages/backend/db-mock-baseline.json'],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.equal(wrote['packages/backend/db-mock-baseline.json'], '{}')
})

test('CLI: a MISSING baseline file still writes -- the real first-run allowance', () => {
  // The other half: with no baseline file at all, `--update` is how the
  // baseline comes into existence, and it still does.
  const { status, wrote } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: { [SCANNED]: withMocks(3) },
    readBack: ['packages/backend/db-mock-baseline.json'],
  })
  assert.equal(status, 0)
  assert.match(wrote['packages/backend/db-mock-baseline.json'], /"positional": 3/)
})

test('CLI: a baseline whose count is not a number is refused, not silently obeyed', () => {
  // #2759, driven through a gate OTHER than the one where the defect was found,
  // because the fix is in the shared engine and a single-gate proof would not
  // show that.
  //
  // `newViolations` does `count > allowed`, and `3 > "x"` is false — so before
  // this, the entry disabled itself and the gate reported a clean bill of
  // health over a live violation. `hasShrunk` was false for the same reason, so
  // not even the "residue shrank" hint fired. The read boundary now refuses it
  // and names the file and key.
  const { status, out } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SCANNED]: withMocks(3),
      'packages/backend/db-mock-baseline.json': JSON.stringify({ [SCANNED]: { positional: 'x' } }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /\[positional\] is "x", not a number/)
  assert.match(out, /packages\/backend\/src\/x\.test\.ts/)
})

test('CLI: a malformed baseline prints one line, not a node:internal banner', () => {
  // #2761, and the reason it is measured as a PROCESS: the defect was entirely
  // in how Node frames an uncaught throw, which no unit test can see. Before
  // this, the four bare-`main()` gates answered an operator with
  // `node:internal/modules/run_main:107 / triggerUncaughtException( / ^` and a
  // version footer wrapped around the message.
  const { status, out } = runGuard('db-mock-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SCANNED]: withMocks(1),
      'packages/backend/db-mock-baseline.json': JSON.stringify({ [SCANNED]: { positional: 'x' } }),
    },
  })
  assert.equal(status, 1)
  assert.match(out, /✗ db-mock-ratchet: /)
  assert.match(out, /\[positional\] is "x", not a number/)
  // The framing, which is the whole finding.
  assert.doesNotMatch(out, /node:internal/)
  assert.doesNotMatch(out, /triggerUncaughtException/)
  // And a refusal is not reported as a crash.
  assert.doesNotMatch(out, /failed:/)
})
