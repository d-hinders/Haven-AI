// Unit suite for scripts/ci/baseline-audit.mjs (#2218).
//
// Run by ci.yml's "Repo CI config suites" step (`node --test scripts/ci/*.test.mjs`).
//
// The cases that matter are the two the workflow's behaviour hinges on, and
// they are asserted in BOTH directions, because a guard that only ever says
// "yes" and a guard that only ever says "no" are equally useless:
//
//   - an undeclared move BLOCKS (the #2217 instance, replayed with its real
//     file name and blob hashes), and
//   - the ordinary one-dispatch path does NOT block (the positive control —
//     a workflow that cries wolf gets bypassed, and being bypassed here means
//     someone runs `--update-snapshots` on their laptop instead).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  auditBaselines,
  baselineName,
  commitTrailer,
  parseExpected,
  parseMode,
  parseStatusZ,
  renderReport,
} from './baseline-audit.mjs'

const DIR = 'packages/frontend/e2e/__screenshots__/agent-panel-states.visual.spec.ts'

/** The baseline PR #2217 changed on purpose. */
const INTENDED = {
  path: `${DIR}/agentcard-banner-stranded-desktop.png`,
  status: 'modified',
  before: 'aaaaaaaaa',
  after: 'bbbbbbbbb',
}

/**
 * The baseline the same dispatch re-blessed by accident: max channel delta 1,
 * a one-pixel column at x=0, its test passing, its fixture seeding `agents: []`
 * so the changed component never rendered in it.
 */
const COLLATERAL = {
  path: `${DIR}/unmanaged-delegate-card-desktop.png`,
  status: 'modified',
  before: 'ccccccccc',
  after: 'ddddddddd',
}

test('parseMode reads `all` and fails closed to `changed` on anything else', () => {
  assert.equal(parseMode('all'), 'all')
  assert.equal(parseMode(' ALL '), 'all')
  assert.equal(parseMode('changed'), 'changed')
  // The direction of the fail-closed is the point: a typo must not silently
  // deliver the mode that blesses uncompared renders.
  assert.equal(parseMode('alll'), 'changed')
  assert.equal(parseMode(''), 'changed')
  assert.equal(parseMode(undefined), 'changed')
})

test('parseExpected normalises what a human types into a dispatch form', () => {
  assert.deepEqual(parseExpected('a.png, b.png'), ['a.png', 'b.png'])
  assert.deepEqual(parseExpected('a\nb'), ['a.png', 'b.png'])
  assert.deepEqual(parseExpected(`${DIR}/a.png`), ['a.png'])
  assert.deepEqual(parseExpected('a.png a.png'), ['a.png'])
  assert.deepEqual(parseExpected('*'), ['*'])
  assert.deepEqual(parseExpected(''), [])
  assert.deepEqual(parseExpected(undefined), [])
})

test('baselineName takes the file name off a repo path', () => {
  assert.equal(baselineName(INTENDED.path), 'agentcard-banner-stranded-desktop.png')
})

test('THE DEFECT: an undeclared move blocks the commit', () => {
  const result = auditBaselines({
    mode: 'all',
    expected: ['agentcard-banner-stranded-desktop.png'],
    changes: [INTENDED, COLLATERAL],
  })
  assert.equal(result.outcome, 'undeclared-change')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(
    result.undeclared.map((c) => baselineName(c.path)),
    ['unmanaged-delegate-card-desktop.png'],
  )
  // The report has to NAME the file — "something moved" sends the reader back
  // to the manual blob-hash diff this replaces.
  const report = renderReport({ mode: 'all', expected: ['agentcard-banner-stranded-desktop.png'], result })
  assert.match(report, /unmanaged-delegate-card-desktop\.png/)
  assert.match(report, /undeclared/)
})

test('POSITIVE CONTROL: the ordinary one-dispatch path does not block', () => {
  // `changed`, nothing declared, one baseline regenerated because it failed
  // comparison. This is what almost every dispatch looks like, and it must be
  // green with no extra inputs — otherwise the workflow gets routed around.
  const result = auditBaselines({ mode: 'changed', expected: [], changes: [INTENDED] })
  assert.equal(result.outcome, 'reported')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.undeclared, [])
})

test('POSITIVE CONTROL: sub-threshold noise alongside an intended change is green under `changed`', () => {
  // Under `changed` Playwright never rewrites the sub-threshold file, so it
  // never reaches this function. The audit must not invent a failure from the
  // intended change alone.
  const result = auditBaselines({
    mode: 'changed',
    expected: ['agentcard-banner-stranded-desktop.png'],
    changes: [INTENDED],
  })
  assert.equal(result.outcome, 'declared')
  assert.equal(result.exitCode, 0)
})

test('`all` without a declaration blocks, and hands back the list to paste', () => {
  const result = auditBaselines({ mode: 'all', expected: [], changes: [INTENDED, COLLATERAL] })
  assert.equal(result.outcome, 'undeclared-full-refresh')
  assert.equal(result.exitCode, 1)
  assert.match(result.summary, /unmanaged-delegate-card-desktop\.png/)
  assert.match(result.summary, /agentcard-banner-stranded-desktop\.png/)
})

test('`all` with an explicit `*` is the #1760 full-refresh escape and is allowed', () => {
  const result = auditBaselines({ mode: 'all', expected: ['*'], changes: [INTENDED, COLLATERAL] })
  assert.equal(result.outcome, 'declared-wildcard')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.undeclared, [])
})

test('nothing moved is green in both modes, and says what that means', () => {
  const changed = auditBaselines({ mode: 'changed', expected: [], changes: [] })
  assert.equal(changed.outcome, 'no-change')
  assert.equal(changed.exitCode, 0)
  assert.match(changed.summary, /mode `all`/)

  const all = auditBaselines({ mode: 'all', expected: [], changes: [] })
  assert.equal(all.outcome, 'no-change')
  assert.equal(all.exitCode, 0)
})

test('a declared baseline that did not move warns but does not block', () => {
  // Blocking here would discard the other declared, safe change in the same run
  // to punish an over-broad declaration.
  const result = auditBaselines({
    mode: 'changed',
    expected: ['agentcard-banner-stranded-desktop.png', 'design-system-desktop.png'],
    changes: [INTENDED],
  })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.missing, ['design-system-desktop.png'])
  assert.match(renderReport({ mode: 'changed', expected: [], result }), /did NOT move/)
})

test('added and deleted baselines are audited like any other move', () => {
  const added = { path: `${DIR}/brand-new-desktop.png`, status: 'added', before: null, after: 'eeeeeeeee' }
  const result = auditBaselines({ mode: 'changed', expected: [], changes: [added] })
  assert.equal(result.exitCode, 0)
  assert.equal(result.moved.length, 1)
  const report = renderReport({ mode: 'changed', expected: [], result })
  assert.match(report, /brand-new-desktop\.png/)
  assert.match(report, /added/)

  const blocked = auditBaselines({ mode: 'all', expected: ['something-else.png'], changes: [added] })
  assert.equal(blocked.exitCode, 1)
  assert.match(blocked.summary, /\(new\)/)
})

test('the commit trailer records the mode and the moved set', () => {
  const result = auditBaselines({ mode: 'all', expected: ['*'], changes: [INTENDED, COLLATERAL] })
  const trailer = commitTrailer({ mode: 'all', result })
  assert.match(trailer, /--update-snapshots=all/)
  assert.match(trailer, /agentcard-banner-stranded-desktop\.png/)
  assert.match(trailer, /unmanaged-delegate-card-desktop\.png/)

  const empty = commitTrailer({ mode: 'changed', result: auditBaselines({ mode: 'changed', expected: [], changes: [] }) })
  assert.match(empty, /\(none\)/)
})

test('the report carries the before/after blob hashes, not just the names', () => {
  // The audit that caught #2217 was a blob-hash diff. A report that only names
  // files would not let the next reader do what its author did.
  const result = auditBaselines({ mode: 'changed', expected: [], changes: [INTENDED] })
  const report = renderReport({ mode: 'changed', expected: [], result })
  assert.match(report, /aaaaaaaaa/)
  assert.match(report, /bbbbbbbbb/)
})

// ---------------------------------------------------------------------------
// The workflow wiring itself.
//
// The pure function above is only worth anything if the YAML actually reaches
// it with the right mode. That wiring is exactly the layer #1777 learned cannot
// be trusted to prove itself — "inline YAML only proves itself in production"
// — and the defect being fixed here WAS a single hardcoded word in this file.
// So the word is pinned. Textual assertions, deliberately: adding a YAML parser
// dependency to assert three strings would be the more fragile choice.
// ---------------------------------------------------------------------------

const WORKFLOW = fs.readFileSync(new URL('../../.github/workflows/update-visual-baselines.yml', import.meta.url), 'utf8')

test('the regeneration step takes its mode from the dispatch input, never a literal', () => {
  assert.match(WORKFLOW, /--update-snapshots="\$UPDATE_MODE"/)
  // The regression in one line: a hardcoded `all` anywhere in a `run:`.
  assert.doesNotMatch(WORKFLOW, /--update-snapshots=all\b/)
  // And it must arrive through env, not interpolated into the shell. `type:
  // choice` is enforced by the dispatch UI, not by the API, so an interpolated
  // `mode` is an arbitrary caller-supplied string inside a `run:` body.
  assert.doesNotMatch(WORKFLOW, /run:.*--update-snapshots=\$\{\{/)
  assert.match(WORKFLOW, /UPDATE_MODE: \$\{\{ inputs\.mode \}\}/)
})

test('the DEFAULT mode is `changed` — the safe one', () => {
  // The whole of #2218 is which of the two words is the default. If a future
  // edit flips it back, this is the line that says so.
  const modeBlock = WORKFLOW.slice(WORKFLOW.indexOf('      mode:'), WORKFLOW.indexOf('      expected:'))
  assert.match(modeBlock, /default: changed/)
  assert.match(modeBlock, /options: \[changed, all\]/)
})

test('the audit runs BEFORE the commit step, or it audits nothing', () => {
  // Order is the guard. An audit that runs after the push reports a fact about
  // something already on the branch.
  const audit = WORKFLOW.indexOf('node scripts/ci/baseline-audit.mjs')
  const commit = WORKFLOW.indexOf('name: Commit baselines to the branch')
  assert.ok(audit > 0, 'the audit step must exist')
  assert.ok(commit > 0, 'the commit step must exist')
  assert.ok(audit < commit, 'the audit must precede the commit')
})

test('the audit step is wired to both inputs', () => {
  assert.match(WORKFLOW, /UPDATE_MODE: \$\{\{ inputs\.mode \}\}/)
  assert.match(WORKFLOW, /EXPECTED_BASELINES: \$\{\{ inputs\.expected \}\}/)
})

// ---------------------------------------------------------------------------
// The `-z` status stream. Found in review, and worth a suite rather than a
// comment: it is the one place this script reads something it did not write.
// ---------------------------------------------------------------------------

test('parseStatusZ reads one record per field for ordinary statuses', () => {
  assert.deepEqual(parseStatusZ(' M a/b.png\0?? c/d.png\0'), [
    { code: ' M', path: 'a/b.png' },
    { code: '??', path: 'c/d.png' },
  ])
})

test('parseStatusZ does not invent a change out of a rename source path', () => {
  // The two-field form: `R  new\0old\0`. The source path carries no `XY `
  // prefix, so a naive slice(0,2)/slice(3) reads `ol` as a status and `d/x.png`
  // minus three characters as a path — a phantom `.png` entry that would be
  // audited as an undeclared move and block a commit on nothing.
  const parsed = parseStatusZ('R  new/x.png\0old/x.png\0 M other.png\0')
  assert.deepEqual(parsed, [
    { code: 'R ', path: 'new/x.png' },
    { code: ' M', path: 'other.png' },
  ])
  assert.equal(parsed.length, 2, 'the rename source must not become a third record')
})

test('parseStatusZ treats a copy the same way as a rename', () => {
  assert.deepEqual(parseStatusZ('C  new/x.png\0src/x.png\0'), [{ code: 'C ', path: 'new/x.png' }])
})

test('parseStatusZ tolerates an empty stream and a missing trailing NUL', () => {
  assert.deepEqual(parseStatusZ(''), [])
  assert.deepEqual(parseStatusZ(undefined), [])
  assert.deepEqual(parseStatusZ(' M a.png'), [{ code: ' M', path: 'a.png' }])
})

test('parseStatusZ leaves paths with spaces intact — `-z` does not quote them', () => {
  // The reason `-z` is used at all: without it git quotes and escapes unusual
  // paths, and the audit would report a name that does not exist on disk.
  assert.deepEqual(parseStatusZ(' M a dir/b c.png\0'), [{ code: ' M', path: 'a dir/b c.png' }])
})
