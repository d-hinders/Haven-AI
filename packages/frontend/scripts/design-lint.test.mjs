// CLI self-test for the design-system lint (#2728).
//
// This file exists because the guard had NO self-test at all, and its
// `--update` branch had no refusal at all: `if (update) { writeBaseline(...);
// return }`, byte-for-byte the hole #2728 was filed about in the copy lint.
// The issue named three sibling ratchets that refuse to raise; this fifth
// consumer of `scripts/lib/ratchet.mjs` was in neither set, and review found
// it by reading the module's importer list rather than the issue text.
//
// It matters here as much as anywhere: design lint is a BLOCKING CI job, and
// its own failure message sends you to the command that was laundering the
// failure.
//
// The guard is driven as a PROCESS through the shared harness. `runGuard`
// needs no change for a script outside `scripts/`: the path is resolved
// against `scripts/`, so `../packages/frontend/scripts/design-lint.mjs` lands
// at `<root>/packages/frontend/scripts/`, from which the guard's own
// `../../../scripts/lib/ratchet.mjs` resolves to the copy `also:` puts at
// `<root>/scripts/lib/`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runGuard } from '../../../scripts/test-support/guard-cli.mjs'

const SCRIPT = '../packages/frontend/scripts/design-lint.mjs'
const ALSO = ['lib/ratchet.mjs', 'lib/lint-escapes.mjs']
const BASE = 'packages/frontend/design-lint-baseline.json'
const COMP = 'packages/frontend/src/components/Probe.tsx'

// Both SCAN_DIRS have to exist, so `src/app` gets a clean file.
const clean = 'export default function P() {\n  return <p>ok</p>\n}\n'
const withDrift = 'export default function P() {\n  return <p className="text-amber-500">x</p>\n}\n'
const tree = (extra) => ({
  'packages/frontend/src/app/page.tsx': clean,
  [COMP]: clean,
  ...extra,
})

test('CLI: new design drift fails the plain run and names the file', () => {
  const { status, out } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [COMP]: withDrift, [BASE]: '{}' }),
  })
  assert.equal(status, 1)
  assert.match(out, /NEW design-system drift detected/)
  assert.match(out, /Probe\.tsx/)
  assert.match(out, /raw-palette/)
})

test('CLI: a clean tree exits 0', () => {
  // The control. Without it the case above also passes against a lint that
  // fails everything.
  const { status, out } = runGuard(SCRIPT, { also: ALSO, files: tree({ [BASE]: '{}' }) })
  assert.equal(status, 0)
  assert.match(out, /design-lint: OK/)
})

test('CLI: `--update` REFUSES to raise the baseline, and writes nothing', () => {
  // The #2728 hole, on this guard. Before the fix this exited 0 and wrote the
  // drift in -- measured on the real script, not reasoned about.
  const before = JSON.stringify({ [COMP]: { 'raw-palette': 0 } })
  const shared = { also: ALSO, files: tree({ [COMP]: withDrift, [BASE]: before }) }

  // The plain run refuses it, so the growth is real and not a fixture artifact.
  assert.equal(runGuard(SCRIPT, shared).status, 1)

  const { status, out, wrote } = runGuard(SCRIPT, {
    ...shared,
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.match(out, /Probe\.tsx \[raw-palette\]: 0 → 1/)
  // "writes nothing" checked, not claimed.
  assert.equal(wrote[BASE], before)
})

test('CLI: an existing but EMPTY baseline REFUSES growth -- it is not a first run', () => {
  // This guard's baseline IS `{}` on `dev`, so the empty-object state is not a
  // theoretical one here -- it is the state the gate ships in. Keying the
  // allowance on emptiness would leave this guard permanently open.
  const { status, out, wrote } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [COMP]: withDrift, [BASE]: '{}' }),
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.equal(wrote[BASE], '{}')
})

test('CLI: `--update` DOES write when the drift is gone', () => {
  // The accept half: a refusal that refuses everything breaks the ratchet in
  // the other direction, so debt could never be tightened after a cleanup.
  const { status, out, wrote } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [BASE]: JSON.stringify({ [COMP]: { 'raw-palette': 4 } }) }),
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 0)
  assert.match(out, /baseline written/)
  assert.equal(JSON.parse(wrote[BASE])[COMP], undefined)
})

test('CLI: a malformed baseline prints one line — and this gate has a SYNC main', () => {
  // #2761. The other five gates have an async `main`; this one is synchronous,
  // which is why `runGate` uses `Promise.resolve().then(() => main())` rather than
  // `main().catch(...)` — the latter lets a sync throw escape before any
  // handler exists. So this gate is not a fifth copy of the same case: it is
  // the one that would still print a node:internal banner under the obvious
  // implementation.
  const { status, out } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [BASE]: JSON.stringify({ [COMP]: { 'raw-palette': 'x' } }) }),
  })
  assert.equal(status, 1)
  assert.match(out, /✗ design-lint: /)
  assert.match(out, /\[raw-palette\] is "x", not a number/)
  assert.doesNotMatch(out, /node:internal/)
  assert.doesNotMatch(out, /triggerUncaughtException/)
})
