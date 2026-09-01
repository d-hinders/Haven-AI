import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ROOT,
  DAY_MS,
  SCHEDULED_GUARDS,
  ISSUE_TITLE,
  evaluate,
  newestTimestamp,
  renderIssueBody,
  renderSummary,
  selectQualifyingRuns,
} from './guard-freshness.mjs'

const NOW = Date.parse('2026-08-30T12:00:00Z')
const agoDays = (d) => new Date(NOW - d * DAY_MS).toISOString()
const GUARD = SCHEDULED_GUARDS[0]

const fresh = { [GUARD.workflow]: { fileExists: true, lastSuccessAt: agoDays(0.4), lastRunAt: agoDays(0.4) } }

test('a nightly that ran last night is fresh', () => {
  const result = evaluate({ guards: [GUARD], observations: fresh, now: NOW })
  assert.equal(result.healthy, true)
  assert.deepEqual(result.findings, [])
})

test('two consecutive misses are tolerated; the third is not', () => {
  // The budget is deliberately wider than the cadence — see the comment on
  // maxAgeDays. A reporter that fires on one Actions blip gets muted.
  const at = (d) => evaluate({ guards: [GUARD], observations: { [GUARD.workflow]: { fileExists: true, lastSuccessAt: agoDays(d), lastRunAt: agoDays(d) } }, now: NOW })
  assert.equal(at(2.9).healthy, true)
  assert.equal(at(3.1).healthy, false)
  assert.equal(at(3.1).findings[0].kind, 'stale')
})

test('a RENAMED or deleted workflow is a finding, not silence', () => {
  const result = evaluate({
    guards: [GUARD],
    observations: { [GUARD.workflow]: { fileExists: false, lastSuccessAt: agoDays(0.2), lastRunAt: agoDays(0.2) } },
    now: NOW,
  })
  // Note the trap this closes: the run history is FRESH here. Renaming the file
  // leaves yesterday's successful runs in the API forever, so an age-only check
  // would report green on a guard that can never run again.
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'missing-file')
})

test('a guard that has run but NEVER succeeded is red', () => {
  const result = evaluate({
    guards: [GUARD],
    observations: { [GUARD.workflow]: { fileExists: true, lastSuccessAt: null, lastRunAt: agoDays(0.1) } },
    now: NOW,
  })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-succeeded')
})

test('a guard Actions has never heard of is red', () => {
  const result = evaluate({
    guards: [GUARD],
    observations: { [GUARD.workflow]: { fileExists: true, lastSuccessAt: null, lastRunAt: null } },
    now: NOW,
  })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-run')
})

test('an UNOBSERVED guard is a finding — "could not tell" is not "fine"', () => {
  const result = evaluate({ guards: [GUARD], observations: {}, now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'unobserved')
})

test('an unparseable timestamp does not read as fresh', () => {
  const result = evaluate({
    guards: [GUARD],
    observations: { [GUARD.workflow]: { fileExists: true, lastSuccessAt: 'yesterday-ish', lastRunAt: null } },
    now: NOW,
  })
  assert.equal(result.healthy, false)
})

test('the issue body names the guard, the cause, the stakes and the restart command', () => {
  const { findings } = evaluate({
    guards: [GUARD],
    observations: { [GUARD.workflow]: { fileExists: true, lastSuccessAt: agoDays(9), lastRunAt: agoDays(9) } },
    now: NOW,
  })
  const body = renderIssueBody(findings, { runUrl: 'https://example.invalid/run/1' })
  assert.ok(body.includes(GUARD.workflow))
  assert.ok(body.includes(GUARD.label))
  assert.match(body, /gh workflow run/)
  assert.match(body, /60-day inactivity/)
  assert.match(body, /9\.0 days ago/)
})

test('the summary reports on healthy runs too, so silence never means unknown', () => {
  const text = renderSummary(evaluate({ guards: [GUARD], observations: fresh, now: NOW }), fresh, [GUARD], NOW)
  assert.match(text, /Every scheduled guard is fresh/)
  assert.ok(text.includes(GUARD.workflow))
  assert.match(text, /last success 0\.4d ago/)
})

// ---------------------------------------------------------------------------
// Which runs count. This is the arm a PR run could otherwise silence.
// ---------------------------------------------------------------------------

const run = (over = {}) => ({
  status: 'completed',
  conclusion: 'success',
  event: 'schedule',
  headBranch: 'dev',
  updatedAt: agoDays(0.4),
  ...over,
})

test('a PULL_REQUEST run never counts as the guard having run', () => {
  // The finding this closes (review of PR #2222): db-concurrency-proof.yml also
  // has a paths-filtered pull_request trigger, and those paths are exactly the
  // files someone edits while working ON the guard. Counting those successes
  // would let a broken cron be masked indefinitely — and worse, a PR run can be
  // green on a branch that deliberately breaks the code, which is how this very
  // job was red-tested.
  const runs = [run({ event: 'pull_request', headBranch: 'fix/whatever' })]
  assert.deepEqual(selectQualifyingRuns(runs, GUARD), [])
})

test('a broken cron is NOT masked by a fresh green PR run', () => {
  // End to end through evaluate(), because the two halves passing separately is
  // not the claim.
  const runs = [
    run({ event: 'schedule', updatedAt: agoDays(11) }),
    run({ event: 'pull_request', headBranch: 'fix/x', updatedAt: agoDays(0.1) }),
  ]
  const qualifying = selectQualifyingRuns(runs, GUARD)
  const observations = {
    [GUARD.workflow]: {
      fileExists: true,
      lastSuccessAt: newestTimestamp(qualifying.filter((r) => r.conclusion === 'success')),
      lastRunAt: newestTimestamp(qualifying),
    },
  }
  const result = evaluate({ guards: [GUARD], observations, now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'stale')
})

test('a pull_request run whose head branch IS `dev` still does not count', () => {
  // The mutation that exposed this: disabling the event filter survived the
  // whole suite, because every pull_request fixture also had a feature-branch
  // head, so the BRANCH filter was silently doing the work. This is the real
  // case — a `dev → main` promotion PR has head branch `dev`, and this
  // workflow's paths filter can match it. Only the event check separates it
  // from a genuine scheduled run.
  const runs = [run({ event: 'pull_request', headBranch: 'dev' })]
  assert.deepEqual(selectQualifyingRuns(runs, GUARD), [])
})

test('a WORKFLOW_DISPATCH on a default branch does count', () => {
  // A deliberate manual re-run against dev really does prove the thing, and
  // refusing it would leave no way to clear the issue after a fix.
  assert.equal(selectQualifyingRuns([run({ event: 'workflow_dispatch' })], GUARD).length, 1)
  assert.equal(selectQualifyingRuns([run({ event: 'workflow_dispatch', headBranch: 'main' })], GUARD).length, 1)
})

test('a dispatch on a FEATURE branch does not count', () => {
  assert.deepEqual(
    selectQualifyingRuns([run({ event: 'workflow_dispatch', headBranch: 'fix/2208-x' })], GUARD),
    [],
  )
})

test('an in-progress run does not count as a run', () => {
  assert.deepEqual(selectQualifyingRuns([run({ status: 'in_progress' })], GUARD), [])
})

test('the registry actually scopes events and branches', () => {
  // Deleting either field would make selectQualifyingRuns pass everything.
  for (const guard of SCHEDULED_GUARDS) {
    assert.ok(Array.isArray(guard.countedEvents) && guard.countedEvents.length > 0, guard.workflow)
    assert.ok(!guard.countedEvents.includes('pull_request'), `${guard.workflow} counts PR runs`)
    assert.ok(Array.isArray(guard.countedBranches) && guard.countedBranches.length > 0, guard.workflow)
  }
})

test('newestTimestamp picks the newest and tolerates junk', () => {
  assert.equal(newestTimestamp([]), null)
  assert.equal(newestTimestamp(undefined), null)
  assert.equal(newestTimestamp([{}, { updatedAt: '' }]), null)
  assert.equal(
    newestTimestamp([{ updatedAt: '2026-08-01T00:00:00Z' }, { updatedAt: '2026-08-29T00:00:00Z' }]),
    '2026-08-29T00:00:00Z',
  )
  // createdAt is the fallback, not an override.
  assert.equal(
    newestTimestamp([{ createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z' }]),
    '2026-08-03T00:00:00Z',
  )
})

// ---------------------------------------------------------------------------
// Registry couplings. A registry that drifts from the repo silently stops
// covering things, which is the same class of defect one level up.
// ---------------------------------------------------------------------------

test('every registered guard names a workflow that exists', () => {
  for (const guard of SCHEDULED_GUARDS) {
    assert.ok(
      existsSync(path.join(ROOT, '.github', 'workflows', guard.workflow)),
      `guard-freshness registers ${guard.workflow}, which does not exist`,
    )
  }
})

test('every registered guard still DECLARES the trigger it is watching', () => {
  // Widened from "has a schedule:" in #2268, which registered a guard that is
  // not a schedule at all. The check that matters is not "is it a cron" but
  // "can the thing this entry watches still fire" — and that is per-guard,
  // which is what `requiredTrigger` is for.
  //
  // This is the fast half of the two-layer design. Delete the trigger from the
  // workflow and THIS goes red on the pull request; the reporter's own
  // `missing-trigger` finding covers the case where it is deleted on `dev`
  // without anyone running the suite.
  for (const guard of SCHEDULED_GUARDS) {
    assert.ok(guard.requiredTrigger instanceof RegExp, `${guard.workflow} declares no requiredTrigger`)
    const source = readFileSync(path.join(ROOT, '.github', 'workflows', guard.workflow), 'utf8')
    assert.match(
      source,
      guard.requiredTrigger,
      `${guard.workflow} no longer declares ${guard.requiredTrigger} — the guard cannot fire`,
    )
  }
})

test('every registered guard says how a human restarts it', () => {
  for (const guard of SCHEDULED_GUARDS) {
    assert.equal(typeof guard.restart, 'string', `${guard.workflow} has no restart instruction`)
    assert.ok(guard.restart.length > 20, guard.workflow)
  }
})

// ---------------------------------------------------------------------------
// #2268 — the post-deploy `dev-deployed` trigger on qa-dev.yml.
//
// The defect: qa-dev.yml declares three triggers, two fire, and the third had
// never fired once. What must be true of this entry is therefore mostly about
// what does NOT clear it.
// ---------------------------------------------------------------------------

const QA = SCHEDULED_GUARDS.find((g) => g.workflow === 'qa-dev.yml')

const qaRun = (over = {}) => ({
  status: 'completed',
  conclusion: 'success',
  event: 'repository_dispatch',
  headBranch: 'dev',
  updatedAt: agoDays(0.2),
  ...over,
})

const qaObs = (runs) => {
  const qualifying = selectQualifyingRuns(runs, QA)
  return {
    [QA.workflow]: {
      fileExists: true,
      triggerPresent: true,
      lastSuccessAt: newestTimestamp(qualifying.filter((r) => r.conclusion === 'success')),
      lastRunAt: newestTimestamp(qualifying),
    },
  }
}

test('the post-deploy trigger is registered at all', () => {
  assert.ok(QA, 'qa-dev.yml is not in the registry — #2268 regressed')
  assert.deepEqual(QA.countedEvents, ['repository_dispatch'])
  assert.deepEqual(QA.countedBranches, ['dev'])
})

test('POSITIVE CONTROL: a recent dev-deployed dispatch leaves the guard silent', () => {
  // Without this, a guard that fires on everything passes every test above.
  // An alarm nobody can turn off by fixing the thing is one that gets muted,
  // which is indistinguishable from having no alarm.
  const result = evaluate({ guards: [QA], observations: qaObs([qaRun()]), now: NOW })
  assert.equal(result.healthy, true)
  assert.deepEqual(result.findings, [])
})

test('the NIGHTLY and the MANUAL dispatch do not vouch for the post-deploy trigger', () => {
  // The load-bearing assertion of #2268. Both of these are alive and green on
  // this exact workflow file, every single day. Counting either would have
  // reported the dead trigger healthy for the whole two months it was dead —
  // reproducing the original defect inside its own guard.
  const runs = [
    qaRun({ event: 'schedule', updatedAt: agoDays(0.05) }),
    qaRun({ event: 'workflow_dispatch', updatedAt: agoDays(0.05) }),
  ]
  assert.deepEqual(selectQualifyingRuns(runs, QA), [])

  const result = evaluate({ guards: [QA], observations: qaObs(runs), now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-run')
})

test('a trigger that has NEVER fired reads as never-run, not as fresh', () => {
  // The actual state of the world on 2026-08-31: 156 qa-dev.yml runs, zero of
  // them repository_dispatch.
  const result = evaluate({
    guards: [QA],
    observations: { [QA.workflow]: { fileExists: true, triggerPresent: true, lastSuccessAt: null, lastRunAt: null } },
    now: NOW,
  })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-run')
})

test('a dispatch that arrives but FAILS is not a working trigger either', () => {
  const result = evaluate({ guards: [QA], observations: qaObs([qaRun({ conclusion: 'failure' })]), now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-succeeded')
})

test('the post-deploy budget tolerates a quiet weekend but not a dead week', () => {
  const at = (d) => evaluate({ guards: [QA], observations: qaObs([qaRun({ updatedAt: agoDays(d) })]), now: NOW })
  assert.equal(at(3.9).healthy, true)
  assert.equal(at(4.1).healthy, false)
  assert.equal(at(4.1).findings[0].kind, 'stale')
})

test('a DELETED trigger is a finding even while the run history is fresh', () => {
  // The trap, one level in from missing-file: removing `repository_dispatch`
  // from qa-dev.yml leaves every past dispatch run in the Actions API forever,
  // so an age-only check reports green on a trigger that can never fire again.
  const result = evaluate({
    guards: [QA],
    observations: {
      [QA.workflow]: { fileExists: true, triggerPresent: false, lastSuccessAt: agoDays(0.1), lastRunAt: agoDays(0.1) },
    },
    now: NOW,
  })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'missing-trigger')
  assert.match(result.findings[0].detail, /cannot fire/)
})

test('the post-deploy restart instruction does not send the reader to gh workflow run', () => {
  // `gh workflow run qa-dev.yml` fires a workflow_dispatch, which this guard
  // deliberately does not count — so the obvious command is precisely the one
  // that leaves the finding standing. The generic hint would have said it.
  const { findings } = evaluate({
    guards: [QA],
    observations: { [QA.workflow]: { fileExists: true, triggerPresent: true, lastSuccessAt: null, lastRunAt: null } },
    now: NOW,
  })
  const body = renderIssueBody(findings)
  assert.doesNotMatch(body, /gh workflow run qa-dev\.yml/)
  assert.match(body, /Railway/)
  assert.match(body, /event_type=dev-deployed/)
})

test('the two guards are reported independently — one dead does not hide the other', () => {
  const observations = {
    'db-concurrency-proof.yml': { fileExists: true, triggerPresent: true, lastSuccessAt: agoDays(0.4), lastRunAt: agoDays(0.4) },
    'qa-dev.yml': { fileExists: true, triggerPresent: true, lastSuccessAt: null, lastRunAt: null },
  }
  const result = evaluate({ observations, now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].guard.workflow, 'qa-dev.yml')

  const text = renderSummary(result, observations, SCHEDULED_GUARDS, NOW)
  assert.match(text, /✓ db-concurrency-proof\.yml/)
  assert.match(text, /✗ qa-dev\.yml/)
})

test('the reporter runs on push, not only on a schedule of its own', () => {
  // The whole point: a cron watching a cron dies with it. Two crons fail
  // together from repo-level causes (schedule disablement after 60 days of
  // inactivity, a default-branch change), so the load-bearing trigger must be
  // one the repo cannot stop emitting while it is being worked on.
  const wf = readFileSync(path.join(ROOT, '.github/workflows/guard-freshness.yml'), 'utf8')
  assert.match(wf, /^\s*push:/m)
  assert.match(wf, /branches:\s*\[main,\s*dev\]/)
  assert.ok(wf.includes('scripts/ci/guard-freshness.mjs'))
  assert.match(wf, /actions:\s*read/)
})

test('the issue title is a constant the reporter can find again', () => {
  // Upsert-by-title: a drifting title would orphan the open issue and create a
  // second one on every push.
  assert.equal(typeof ISSUE_TITLE, 'string')
  assert.ok(ISSUE_TITLE.length > 0)
})
