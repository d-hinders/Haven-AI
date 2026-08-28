import test from 'node:test'
import assert from 'node:assert/strict'
import { verdictFor, resolveVerificationTarget, describeDrift } from './verify-merged-head.mjs'

// The fixtures below are the REAL check-run sets from PR #2114 (2026-08-27),
// read back from `gh api repos/d-hinders/Haven-AI/commits/<sha>/check-runs`.
// They are what #2116 is about, kept here so the distinction between the two
// SHAs stays a test rather than an anecdote.

const PR_2114_CAPTURED_SHA = 'bcc23cb5'
const PR_2114_MERGED_SHA = 'af36577f1435ec96a16748ac297722200f8f1ac3'

const ok = (name) => ({ name, status: 'completed', conclusion: 'success' })
const cancelled = (name) => ({ name, status: 'completed', conclusion: 'cancelled' })

// 17 success + 1 failure + 5 cancelled = 23, as measured on bcc23cb5.
const CHECKS_ON_CAPTURED_SHA = [
  ...['Vercel Preview Comments', 'Signer checks', 'SDK checks', 'Repo CI config checks',
    'MCP checks', 'Install-path smoke', 'Doc↔code coupling', 'Docs links & style (advisory)',
    'Docs front-matter & agent skills', 'Detect changed surfaces', 'Design-system coupling (strict)',
    'Design-system coupling', 'Contract-doc coupling', 'Connect checks', 'CLI checks',
    'Banned product-copy terms', 'Apply surface labels'].map(ok),
  { name: 'Lint, Type-check & Build', status: 'completed', conclusion: 'failure' },
  ...['MCP server checks', 'Frontend checks', 'Frontend browser smoke',
    'Design visual regression', 'Backend checks'].map(cancelled),
]

// 23/23 success, as measured on af36577f — the commit that actually merged.
const CHECKS_ON_MERGED_SHA = CHECKS_ON_CAPTURED_SHA.map((r) => ok(r.name))

test('#2114: the captured SHA and the merged SHA give OPPOSITE verdicts', () => {
  // This is the whole defect in two assertions. Same PR, same moment in time,
  // two SHAs — and the answer depends entirely on which one you ask about.
  assert.equal(verdictFor(CHECKS_ON_CAPTURED_SHA).verdict, 'red')
  assert.equal(verdictFor(CHECKS_ON_MERGED_SHA).verdict, 'green')
})

test('a cancelled run is SUPERSEDED, never green — the false-green direction of #2116', () => {
  // The dangerous mirror image of #2114: the superseded run has nothing failing
  // on it, only cancellations. Folding `cancelled` into "not a failure" would
  // report GREEN here for a commit that was replaced before it merged.
  const supersededButNotFailing = [
    ok('Backend checks'),
    cancelled('Frontend checks'),
    cancelled('Lint, Type-check & Build'),
  ]
  const result = verdictFor(supersededButNotFailing)
  assert.equal(result.verdict, 'superseded')
  assert.notEqual(result.verdict, 'green')
  assert.deepEqual(result.cancelled, ['Frontend checks', 'Lint, Type-check & Build'])
})

test('an incomplete run is PENDING, not green', () => {
  assert.equal(
    verdictFor([ok('Backend checks'), { name: 'CI', status: 'in_progress', conclusion: null }]).verdict,
    'pending',
  )
})

test('zero check runs is NOT green — the #1777 parked-runs shape', () => {
  // `total_count: 0` beside runs parked at action_required. "Nothing said no"
  // is not "the blocking jobs passed".
  assert.equal(verdictFor([]).verdict, 'no-checks')
  assert.equal(verdictFor(undefined).verdict, 'no-checks')
})

test('action_required is NOT green — it is completed, so it is not pending either', () => {
  // Found by review, not by these fixtures. `action_required` is a completed
  // conclusion in none of the failing/passing/cancelled sets, so an earlier draft
  // that let the verdict DEFAULT to green reported GREEN here and omitted the run
  // from every printed bucket. A false green inside the tool built to stop false
  // greens — the exact defect class, one level down.
  const result = verdictFor([
    ok('Backend checks'),
    { name: 'Frontend checks', status: 'completed', conclusion: 'action_required' },
  ])
  assert.notEqual(result.verdict, 'green')
  assert.equal(result.verdict, 'unclassified')
  assert.deepEqual(result.unclassified, ['Frontend checks (action_required)'])
})

test('an unknown future conclusion is surfaced, never defaulted to green', () => {
  // The general form of the bug above: no conclusion value this tool has not been
  // taught about may reach a green verdict.
  const result = verdictFor([ok('CI'), { name: 'New Gate', status: 'completed', conclusion: 'some_future_value' }])
  assert.equal(result.verdict, 'unclassified')
  assert.deepEqual(result.unclassified, ['New Gate (some_future_value)'])
})

test('every check run lands in exactly one bucket', () => {
  const runs = [
    ok('a'), cancelled('b'),
    { name: 'c', status: 'completed', conclusion: 'failure' },
    { name: 'd', status: 'in_progress', conclusion: null },
    { name: 'e', status: 'completed', conclusion: 'action_required' },
  ]
  const r = verdictFor(runs)
  assert.equal(
    r.failed.length + r.cancelled.length + r.pending.length + r.succeeded.length + r.unclassified.length,
    runs.length,
  )
})

test('skipped and neutral conclusions do not block a green verdict', () => {
  assert.equal(
    verdictFor([ok('Backend checks'),
      { name: 'Frontend checks', status: 'completed', conclusion: 'skipped' },
      { name: 'Advisory', status: 'completed', conclusion: 'neutral' }]).verdict,
    'green',
  )
})

test('timed_out and startup_failure are red, not merely "not success"', () => {
  assert.equal(verdictFor([{ name: 'CI', status: 'completed', conclusion: 'timed_out' }]).verdict, 'red')
  assert.equal(verdictFor([{ name: 'CI', status: 'completed', conclusion: 'startup_failure' }]).verdict, 'red')
})

test('the verification target is the re-read head SHA, and the merge commit is reported beside it', () => {
  // Squash merge: #2114's merge commit 0ae544c6 has exactly ONE parent, so
  // "the merge commit's second parent" cannot recover the head here.
  const target = resolveVerificationTarget({
    state: 'MERGED',
    headRefOid: PR_2114_MERGED_SHA,
    mergeCommit: { oid: '0ae544c6ffa79ca134164a87f2ace163c27dcc28' },
  })
  assert.equal(target.sha, PR_2114_MERGED_SHA)
  assert.equal(target.merged, true)
  assert.equal(target.mergeCommit, '0ae544c6ffa79ca134164a87f2ace163c27dcc28')
})

test('a PR record with no headRefOid throws rather than verifying something else', () => {
  assert.throws(() => resolveVerificationTarget({ state: 'MERGED', mergeCommit: { oid: 'abc' } }), /headRefOid/)
})

test('#2114: drift between the captured SHA and the merged head is named, not absorbed', () => {
  const drift = describeDrift(PR_2114_CAPTURED_SHA, PR_2114_MERGED_SHA)
  assert.equal(drift.drifted, true)
  assert.match(drift.message, /STALE/)
  assert.match(drift.message, /bcc23cb5/)
  assert.match(drift.message, /af36577f/)
})

test('an abbreviated captured SHA that DOES match the merged head is not reported as drift', () => {
  const drift = describeDrift('af36577f', PR_2114_MERGED_SHA)
  assert.equal(drift.drifted, false)
  assert.equal(describeDrift(PR_2114_MERGED_SHA, PR_2114_MERGED_SHA).drifted, false)
})

test('two commits sharing an 8-char prefix are still drift', () => {
  // The branch a review finding named as untested. An earlier draft OR-ed in
  // `captured.startsWith(resolved.slice(0,8))`, which called this pair a match.
  const sameFirstEight = 'af36577f' + 'deadbeef'.repeat(4)
  assert.equal(describeDrift(sameFirstEight, PR_2114_MERGED_SHA).drifted, true)
})

test('no captured SHA means nothing to compare, and nothing is claimed', () => {
  assert.deepEqual(describeDrift(undefined, PR_2114_MERGED_SHA), { drifted: false, checked: false })
})
