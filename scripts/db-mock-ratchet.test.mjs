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
