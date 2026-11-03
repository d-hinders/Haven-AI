// Self-test for the quality-scan re-measurement runner (#4625).
//
// Every case drives the real CLI (`scripts/test-support/guard-cli.mjs`,
// #2720) against a fixture git repository with its own fixture manifest at
// the default path: the runner computes its repo root from its own location,
// so the copy in the fixture scans the fixture and never this repository.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runGuard } from '../test-support/guard-cli.mjs'
import { parseFigures, refusalLine, verdict } from './scan-remeasure.mjs'

const MANIFEST = 'docs/quality/scan-baselines.json'

/** A fixture tree: three nested and three top-level SDK files, two with a hit. */
const TREE = {
  'packages/sdk/src/top-a.ts': 'export const a = "retry once"\n',
  'packages/sdk/src/top-b.ts': 'export const b = 1\n',
  'packages/sdk/src/top-c.ts': 'export const c = "retry once"\n',
  'packages/sdk/src/nested/x.ts': 'export const x = 1\n',
  'packages/sdk/src/nested/y.ts': 'export const y = 1\n',
  'packages/sdk/src/nested/z.ts': 'export const z = "retry once"\n',
}

function row(overrides) {
  return { block: '6', name: overrides.id, kind: 'count', figures: [1], sha: 'fixture', tolerance: 0, requires: [], ...overrides }
}

function run(rows, { env = {} } = {}) {
  return runGuard('docs/scan-remeasure.mjs', {
    files: { ...TREE, [MANIFEST]: JSON.stringify({ rows }, null, 2) },
    gitCommit: true,
    args: ['--sha', 'HEAD'],
    env,
  })
}

/** The report line for one row id. */
function lineFor(out, id) {
  return out.split('\n').find((l) => l.includes(`| ${id} |`)) ?? ''
}

test('a row whose command exits non-zero is listed as failed, never compared', () => {
  const { status, out } = run([row({ id: 'boom', command: 'echo "$SHA" >/dev/null; exit 3' })])
  assert.equal(status, 0, out)
  assert.match(out, /\*\*failed\*\* — exit 3/)
  assert.match(out, /\*\*Failed or printed nothing:\*\* \n- boom \(block 6\) — exit 3/)
})

test('a row that prints nothing is "printed nothing", never a figure', () => {
  const { out } = run([row({ id: 'silent', command: 'true "$SHA"', figures: [0] })])
  assert.match(lineFor(out, 'silent'), /\*\*failed\*\* — printed nothing/)
  assert.match(lineFor(out, 'silent'), /\| — \| — \|/)
  assert.match(out, /- silent \(block 6\) — printed nothing/)
})

test('an invariant that moved is flagged', () => {
  const { out } = run([row({ id: 'inv', kind: 'invariant', figures: [282], command: 'echo 283 # $SHA' })])
  assert.match(lineFor(out, 'inv'), /\*\*flagged\*\* — an invariant moved/)
  assert.match(lineFor(out, 'inv'), /\| \+1 \|/)
})

test('a grows row that grew is not flagged; one that shrank is', () => {
  const { out } = run([
    row({ id: 'grew', kind: 'grows', figures: [1420, 1705], command: 'printf "1428\\n1713\\n" # $SHA' }),
    row({ id: 'shrank', kind: 'grows', figures: [1420, 1705], command: 'printf "1400\\n1713\\n" # $SHA' }),
  ])
  assert.match(lineFor(out, 'grew'), /\| grew \|$/)
  assert.doesNotMatch(lineFor(out, 'grew'), /flagged/)
  assert.match(lineFor(out, 'shrank'), /\*\*flagged\*\* — shrank/)
})

test('a head-sample row that moved is not flagged', () => {
  const { out } = run([row({ id: 'head', kind: 'head-sample', figures: [13, 2], command: 'printf "9\\n0\\n" # $SHA' })])
  assert.match(lineFor(out, 'head'), /head sample \(not compared\)/)
  assert.doesNotMatch(lineFor(out, 'head'), /flagged/)
})

test('a count row: exact below 100, tolerance above', () => {
  const { out } = run([
    row({ id: 'exact', figures: [39], tolerance: 0, command: 'echo 40 # $SHA' }),
    row({ id: 'within', figures: [2223], tolerance: 0.05, command: 'echo 2300 # $SHA' }),
    row({ id: 'past', figures: [2223], tolerance: 0.05, command: 'echo 2000 # $SHA' }),
  ])
  assert.match(lineFor(out, 'exact'), /\*\*flagged\*\* — moved \(exact\)/)
  assert.match(lineFor(out, 'within'), /within tolerance/)
  assert.match(lineFor(out, 'past'), /\*\*flagged\*\* — moved past ±5%/)
})

test('a control with expect: nonzero reading 0 is a failed control', () => {
  const { out } = run([
    row({ id: 'ctl-zero', kind: 'control', expect: 'nonzero', figures: [36], command: 'echo 0 # $SHA' }),
    row({ id: 'ctl-ok', kind: 'control', expect: 'nonzero', figures: [36], command: 'echo 40 # $SHA' }),
  ])
  assert.match(lineFor(out, 'ctl-zero'), /\*\*control-failed\*\* — expected non-zero, read 0/)
  assert.match(out, /\*\*Controls that failed their expect:\*\* \n- ctl-zero/)
  assert.match(lineFor(out, 'ctl-ok'), /control passed/)
})

test('a no-CONTROL-FAILED-line control fails on that line, passes on silence', () => {
  const { out } = run([
    row({ id: 'fx-bad', kind: 'control', expect: 'no-CONTROL-FAILED-line', figures: [], command: 'echo "CONTROL FAILED: body fixture selected" # $SHA' }),
    row({ id: 'fx-good', kind: 'control', expect: 'no-CONTROL-FAILED-line', figures: [], command: 'true "$SHA"' }),
  ])
  assert.match(lineFor(out, 'fx-bad'), /\*\*control-failed\*\* — printed a CONTROL FAILED line/)
  assert.match(lineFor(out, 'fx-good'), /control passed/)
})

test('RG=/nonexistent refuses only the rg rows, with the reference wording; the rest still run', () => {
  const { out } = run(
    [
      row({ id: 'needs-rg', requires: ['rg'], command: '"$RG" -l retry packages | wc -l # $SHA' }),
      row({ id: 'plain', figures: [6], command: 'git ls-tree -r --name-only "$SHA" | grep -c "^packages/sdk/src/"' }),
    ],
    { env: { RG: '/nonexistent/rg' } },
  )
  assert.match(out, new RegExp(`- needs-rg \\(block 6\\) — ${refusalLine('rg').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(lineFor(out, 'needs-rg'), '', 'a refused row is not in the table')
  assert.match(lineFor(out, 'plain'), /\| 6 \| 0 \| unchanged \|/)
})

test('--scratch may name a directory that does not exist yet (the workflow passes one)', () => {
  const { status, out } = runGuard('docs/scan-remeasure.mjs', {
    files: { ...TREE, [MANIFEST]: JSON.stringify({ rows: [row({ id: 'n', figures: [6], command: 'git ls-tree -r --name-only "$SHA" | grep -c "^packages/sdk/src/"' })] }) },
    gitCommit: true,
    args: ['--sha', 'HEAD', '--scratch', 'not-yet/scan-remeasure'],
  })
  assert.equal(status, 0, out)
  assert.match(lineFor(out, 'n'), /\| 6 \| 0 \| unchanged \|/)
})

test('the commands read $SHA — the resolved commit, not a branch', () => {
  const { out } = run([row({ id: 'sha', figures: [40], command: 'printf "%s" "$SHA" | wc -c' })])
  assert.match(lineFor(out, 'sha'), /\| 40 \| 0 \| unchanged \|/)
})

// The defect this job exists for (#4611 → #4615): block 6's copy-lint perimeter
// listed files with `git ls-files '…/src/**/*.ts'`, and a pathspec `**/` never
// matches a file directly under the directory it follows. Recorded with the
// corrected `ls-tree` listing, the pre-#4615 glob reads fewer and is flagged.
test('a row copying the pre-#4615 glob against figures recorded by ls-tree is flagged', () => {
  const lsTree = 'git ls-tree -r --name-only "$SHA" -- packages/sdk/src | grep -E "\\.ts$" > "$SCRATCH/files"; wc -l < "$SCRATCH/files"; xargs grep -l "retry once" < "$SCRATCH/files" | wc -l'
  const preFix = 'git ls-files "packages/sdk/src/**/*.ts" > "$SCRATCH/files"; wc -l < "$SCRATCH/files"; xargs grep -l "retry once" < "$SCRATCH/files" | wc -l # $SHA'
  const { out } = run([
    row({ id: 'copy-lint-ls-tree', kind: 'grows', figures: [6, 3], command: lsTree }),
    row({ id: 'copy-lint-pre-4615', kind: 'grows', figures: [6, 3], command: preFix }),
  ])
  assert.match(lineFor(out, 'copy-lint-ls-tree'), /\| 6 \/ 3 \| 0 \/ 0 \| unchanged \|/)
  assert.match(lineFor(out, 'copy-lint-pre-4615'), /\| 3 \/ 1 \| -3 \/ -2 \| \*\*flagged\*\* — shrank/)
})

test('a usage error and an unreadable manifest exit 2', () => {
  const noSha = runGuard('docs/scan-remeasure.mjs', { files: { [MANIFEST]: '{"rows":[]}' }, gitCommit: true, args: [] })
  assert.equal(noSha.status, 2)
  assert.match(noSha.out, /--sha <sha> is required/)
  const bad = runGuard('docs/scan-remeasure.mjs', { files: { [MANIFEST]: '{"rows":[{"id":"x","kind":"count","command":"echo 1","figures":[1]}]}' }, gitCommit: true, args: ['--sha', 'HEAD'] })
  assert.equal(bad.status, 2)
  assert.match(bad.out, /command must be a string that reads \$SHA/)
  const ctl = runGuard('docs/scan-remeasure.mjs', { files: { [MANIFEST]: '{"rows":[{"id":"x","kind":"control","command":"echo 1 # $SHA","figures":[1]}]}' }, gitCommit: true, args: ['--sha', 'HEAD'] })
  assert.equal(ctl.status, 2)
  assert.match(ctl.out, /a control needs expect/)
})

test('unit: parseFigures refuses a non-integer line; verdict refuses a figure-count mismatch', () => {
  assert.deepEqual(parseFigures('1\n2\n'), [1, 2])
  assert.equal(parseFigures('1\nfoo\n'), null)
  assert.deepEqual(verdict({ kind: 'count', figures: [1, 2] }, { code: 0, stdout: '1\n' }), {
    status: 'failed',
    note: 'printed 1 figure(s), recorded 2',
  })
})
