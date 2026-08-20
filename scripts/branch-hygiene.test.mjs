import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, summarize } from './branch-hygiene.mjs'

test('a resync into a work branch is counted, and names the branch that went stale', () => {
  assert.deepEqual(
    classify("Merge branch 'dev' into claude/connect-agent-modal-ux-d34ghg"),
    { kind: 'resync', branch: 'claude/connect-agent-modal-ux-d34ghg' },
  )
})

test('a SAME-NAME remote merge is the two-writers hazard, not ordinary integration', () => {
  // This is the shape AGENTS.md warns about: one branch name, two writers.
  assert.deepEqual(
    classify("Merge remote-tracking branch 'origin/claude/foo' into claude/foo"),
    { kind: 'divergence', branch: 'claude/foo' },
  )
})

test('a `git pull origin dev` resync counts the same as `git merge dev`', () => {
  // Real history carries both shapes. Missing this one undercounts the exact
  // thing the report exists to measure — found by review, not by reasoning.
  assert.deepEqual(
    classify("Merge remote-tracking branch 'origin/dev' into feature/thing"),
    { kind: 'resync', branch: 'feature/thing' },
  )
  // And the shape a pull takes with no tracking name configured.
  assert.deepEqual(
    classify("Merge branch 'dev' of https://github.com/d-hinders/Haven-AI into feat/x"),
    { kind: 'resync', branch: 'feat/x' },
  )
})

test('MUTATION PROOF: `main` into a branch is NOT a stale-under-dev resync', () => {
  // The script's first bug: an unanchored source made every main-into-branch
  // merge a "resync" — 89 of them in this repo — and put `dev` itself in a
  // table of work branches that outlived their PR. Merging main is release
  // reconciliation, a different act with a different cause.
  assert.equal(classify("Merge branch 'main' into dev"), null)
  assert.equal(classify("Merge branch 'main' into feature/thing"), null)
  assert.equal(classify("Merge remote-tracking branch 'origin/main' into feature/thing"), null)
})

test('dev and main are never reported as branches that went stale', () => {
  assert.equal(classify("Merge branch 'dev' into main"), null)
})

test('an ordinary squash-merge subject is not a finding', () => {
  assert.equal(classify('fix(auth): equalise login cost (#1646) (#1656)'), null)
  assert.equal(classify("Merge pull request #12 from d-hinders/feature/x"), null)
})

test('MUTATION-SENSITIVE: a subject that only MENTIONS the phrase is not a resync', () => {
  // Drop the `^` anchor and a doc change explaining the rule starts counting
  // as a violation of it. This is the shape `git log --grep` gets wrong, which
  // is why the report reads subjects itself.
  assert.equal(
    classify("docs: explain why Merge branch 'dev' into a work branch is bad"),
    null,
  )
})

test('summarize groups by branch, so a 6-PR branch reads as one problem not six', () => {
  const report = summarize([
    "Merge branch 'dev' into claude/long-lived",
    "Merge branch 'dev' into claude/long-lived",
    "Merge remote-tracking branch 'origin/claude/long-lived' into claude/long-lived",
    "Merge branch 'dev' into fix/other",
    'feat(x): something ordinary (#1)',
  ])

  assert.equal(report.total, 5)
  assert.equal(report.resyncs, 3)
  assert.equal(report.divergences, 1)
  assert.equal(report.branches.length, 2)
  // Ordered worst-first: the branch to talk about is the one at the top.
  assert.deepEqual(report.branches[0], {
    branch: 'claude/long-lived',
    resync: 2,
    divergence: 1,
  })
})

test('a clean window reports zero and lists no branches — the #1500 target state', () => {
  const report = summarize(['feat(a): one (#1)', 'fix(b): two (#2)'])
  assert.equal(report.resyncs, 0)
  assert.equal(report.divergences, 0)
  assert.deepEqual(report.branches, [])
})
