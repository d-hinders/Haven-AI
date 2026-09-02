import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ROOT,
  DAY_MS,
  SCHEDULED_GUARDS,
  ISSUE_TITLE,
  RAILWAY_DEV_ENVIRONMENT,
  RAILWAY_DEPLOY_CREATOR,
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

test('the registry actually scopes events, and branches OR provenance', () => {
  // Deleting a field would make selectQualifyingRuns pass everything. Branch
  // scoping is the default arm; a guard may drop it only by binding runs to
  // something stronger (#2273: a Railway deployment of the run's exact SHA).
  for (const guard of SCHEDULED_GUARDS) {
    assert.ok(Array.isArray(guard.countedEvents) && guard.countedEvents.length > 0, guard.workflow)
    assert.ok(!guard.countedEvents.includes('pull_request'), `${guard.workflow} counts PR runs`)
    const scopedByBranch = Array.isArray(guard.countedBranches) && guard.countedBranches.length > 0
    const scopedByProvenance =
      guard.provenance && typeof guard.provenance.environment === 'string' && guard.provenance.environment.length > 0 &&
      typeof guard.provenance.creator === 'string' && guard.provenance.creator.length > 0
    assert.ok(scopedByBranch || scopedByProvenance, `${guard.workflow} scopes neither branch nor provenance`)
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
// #2268 → #2273 — the post-deploy trigger on qa-dev.yml, now `deployment_status`.
//
// The defect: qa-dev.yml declared three triggers, two fired, and the third had
// never fired once. What must be true of this entry is therefore mostly about
// what does NOT clear it — and, since #2271, that a run somebody started by
// hand cannot impersonate one Railway's deploy started.
// ---------------------------------------------------------------------------

const QA = SCHEDULED_GUARDS.find((g) => g.workflow === 'qa-dev.yml')

const DEPLOYED_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
// What readDeploymentIndex() returns: full sha → creator login, for the dev env.
const RAILWAY_INDEX = { [DEPLOYED_SHA]: RAILWAY_DEPLOY_CREATOR }

const qaRun = (over = {}) => ({
  status: 'completed',
  conclusion: 'success',
  event: 'deployment_status',
  // A Railway deployment is created against a bare SHA, so GITHUB_REF is empty
  // and the run has no head branch. This is the real shape, not a simplification.
  headBranch: null,
  headSha: DEPLOYED_SHA,
  updatedAt: agoDays(0.2),
  ...over,
})

const qaObs = (runs, index = RAILWAY_INDEX) => {
  const qualifying = selectQualifyingRuns(runs, QA, index)
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
  assert.deepEqual(QA.countedEvents, ['deployment_status'])
  assert.equal(QA.countedBranches, null)
  assert.deepEqual(QA.provenance, { environment: RAILWAY_DEV_ENVIRONMENT, creator: RAILWAY_DEPLOY_CREATOR })
})

test('POSITIVE CONTROL: a recent Railway-deployed run leaves the guard silent', () => {
  // Without this, a guard that fires on everything passes every test above.
  // An alarm nobody can turn off by fixing the thing is one that gets muted,
  // which is indistinguishable from having no alarm.
  assert.equal(selectQualifyingRuns([qaRun()], QA, RAILWAY_INDEX).length, 1)
  const result = evaluate({ guards: [QA], observations: qaObs([qaRun()]), now: NOW })
  assert.equal(result.healthy, true)
  assert.deepEqual(result.findings, [])
})

test('the NIGHTLY and the MANUAL dispatch do not vouch for the post-deploy trigger', () => {
  // The load-bearing assertion of #2268. Both of these are alive and green on
  // this exact workflow file, every single day. Counting either would have
  // reported the dead trigger healthy for the whole two months it was dead —
  // reproducing the original defect inside its own guard.
  //
  // Both runs sit at the DEPLOYED sha on purpose: a manual dispatch at dev's tip
  // right after a deploy has exactly the sha Railway deployed, so the sha
  // lookup alone would pass them. Only the event check separates them.
  const runs = [
    qaRun({ event: 'schedule', headBranch: 'dev', updatedAt: agoDays(0.05) }),
    qaRun({ event: 'workflow_dispatch', headBranch: 'dev', updatedAt: agoDays(0.05) }),
  ]
  assert.deepEqual(selectQualifyingRuns(runs, QA, RAILWAY_INDEX), [])

  const result = evaluate({ guards: [QA], observations: qaObs(runs), now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-run')
})

test('#2271: a repository_dispatch — the old curl-able route — does not count either', () => {
  // The event the old entry counted, and the one `gh api .../dispatches` still
  // produces on any repo. qa-dev.yml no longer declares it, but the guard must
  // not depend on that: a re-added trigger must not re-open the hole.
  const runs = [qaRun({ event: 'repository_dispatch', headBranch: 'dev' })]
  assert.deepEqual(selectQualifyingRuns(runs, QA, RAILWAY_INDEX), [])
})

test('#2271: a deployment_status run for a SHA Railway never deployed does not count', () => {
  // A human can create a Deployment through the API with their own token; the
  // resulting run is a genuine deployment_status event. What they cannot do is
  // make the Deployments API say `railway-app[bot]` created it.
  const humanIndex = { [OTHER_SHA]: 'some-human' }
  assert.deepEqual(selectQualifyingRuns([qaRun({ headSha: OTHER_SHA })], QA, humanIndex), [])
  // …and a SHA the index has never seen at all.
  assert.deepEqual(selectQualifyingRuns([qaRun({ headSha: OTHER_SHA })], QA, RAILWAY_INDEX), [])
})

test('#2271: a MISSING deployment index fails closed — nothing qualifies', () => {
  // "Could not look it up" must never read as "Railway deployed it". The IO
  // wrapper throws into `unobserved` on API failure; this covers the pure half.
  assert.deepEqual(selectQualifyingRuns([qaRun()], QA, undefined), [])
  assert.deepEqual(selectQualifyingRuns([qaRun()], QA, {}), [])
  assert.deepEqual(selectQualifyingRuns([qaRun({ headSha: undefined })], QA, RAILWAY_INDEX), [])
})

test('a run the gate job SKIPPED is not the guard having run', () => {
  // Every in_progress status and every re-stated `success` starts a run that
  // qa-dev.yml's gate job skips in seconds. Those are not evidence the harness
  // ran; counting them would date lastRunAt off nothing and turn a gate that
  // refuses everything into `never-succeeded` instead of `never-run`.
  const runs = [qaRun({ conclusion: 'skipped' })]
  assert.deepEqual(selectQualifyingRuns(runs, QA, RAILWAY_INDEX), [])
  const result = evaluate({ guards: [QA], observations: qaObs(runs), now: NOW })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-run')
})

test('a trigger that has NEVER fired reads as never-run, not as fresh', () => {
  // The actual state of the world on 2026-08-31: 156 qa-dev.yml runs, zero of
  // them post-deploy — and the state of the world on the day #2273 merges,
  // until the first real Railway deploy produces a run.
  const result = evaluate({
    guards: [QA],
    observations: { [QA.workflow]: { fileExists: true, triggerPresent: true, lastSuccessAt: null, lastRunAt: null } },
    now: NOW,
  })
  assert.equal(result.healthy, false)
  assert.equal(result.findings[0].kind, 'never-run')
})

test('a post-deploy run that arrives but FAILS is not a working trigger either', () => {
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
  // The trap, one level in from missing-file: removing `deployment_status`
  // from qa-dev.yml leaves every past post-deploy run in the Actions API
  // forever, so an age-only check reports green on a trigger that can never
  // fire again.
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

test('the post-deploy restart instruction sends the reader to the Deployments API, not to a dispatch', () => {
  // `gh workflow run qa-dev.yml` fires a workflow_dispatch and `gh api
  // .../dispatches` a repository_dispatch; the guard counts neither, so both
  // "obvious" commands are precisely the ones that leave the finding standing.
  // The #2268 entry used to name the dispatch as the confirmation step — that
  // is the #2271 hole in the guard's own remediation text.
  const { findings } = evaluate({
    guards: [QA],
    observations: { [QA.workflow]: { fileExists: true, triggerPresent: true, lastSuccessAt: null, lastRunAt: null } },
    now: NOW,
  })
  const body = renderIssueBody(findings)
  assert.doesNotMatch(body, /gh workflow run qa-dev\.yml/)
  assert.doesNotMatch(body, /event_type=dev-deployed/)
  assert.doesNotMatch(body, /Post-deploy trigger \(webhook setup\)/)
  assert.match(body, /Railway/)
  assert.match(body, /repos\/d-hinders\/Haven-AI\/deployments/)
  assert.match(body, /--event deployment_status/)
  assert.ok(body.includes(RAILWAY_DEV_ENVIRONMENT))
})

// ---------------------------------------------------------------------------
// The workflow half of #2273. The registry's `requiredTrigger` pins that the
// event is still declared; these pin that the GATE still filters and dedupes,
// and that its two Railway-side literals are the guard's constants — the two
// files can only drift apart by failing here.
// ---------------------------------------------------------------------------

const QA_DEV_YML = readFileSync(path.join(ROOT, '.github/workflows/qa-dev.yml'), 'utf8')

test('qa-dev.yml declares deployment_status and no longer declares the dead repository_dispatch', () => {
  assert.match(QA_DEV_YML, /^\s*deployment_status:\s*$/m)
  // Removed, not kept "as a fallback": Railway cannot send it (#2268), and
  // keeping it keeps alive the one route a curl can use to produce a run that
  // looks post-deploy (#2271).
  assert.doesNotMatch(QA_DEV_YML, /^\s*repository_dispatch:/m)
  assert.doesNotMatch(QA_DEV_YML, /^\s*types:\s*\[\s*dev-deployed/m)
})

test('qa-dev.yml gates on the same environment and creator the guard proves provenance against', () => {
  assert.ok(QA_DEV_YML.includes(`RAILWAY_DEV_ENVIRONMENT: '${RAILWAY_DEV_ENVIRONMENT}'`), 'gate env literal drifted from the guard constant')
  assert.ok(QA_DEV_YML.includes(`RAILWAY_DEPLOY_CREATOR: '${RAILWAY_DEPLOY_CREATOR}'`), 'gate creator literal drifted from the guard constant')
  // The three refusals, in the gate script itself.
  assert.match(QA_DEV_YML, /\[ "\$STATUS_STATE" = "success" \] \|\| skip/)
  assert.match(QA_DEV_YML, /\[ "\$DEPLOYMENT_ENV" = "\$RAILWAY_DEV_ENVIRONMENT" \] \|\| skip/)
  assert.match(QA_DEV_YML, /\[ "\$DEPLOYMENT_CREATOR" = "\$RAILWAY_DEPLOY_CREATOR" \] \|\| skip/)
})

test('qa-dev.yml de-duplicates against the NEWEST deployment, and fails closed when it cannot read it', () => {
  // Every dev deployment emits `success` twice (measured 2026-09-02 on twelve
  // consecutive deployments); without this the money-moving harness queues twice.
  assert.match(QA_DEV_YML, /repos\/\$\{GITHUB_REPOSITORY\}\/deployments/)
  assert.match(QA_DEV_YML, /-F per_page=1 --jq '\.\[0\]\.id/)
  assert.match(QA_DEV_YML, /\[ "\$NEWEST" = "\$DEPLOYMENT_ID" \] \|\| skip/)
  assert.match(QA_DEV_YML, /\[ -n "\$NEWEST" \] \|\| \{ echo "::error::/)
  assert.match(QA_DEV_YML, /^\s*deployments:\s*read\s*$/m)
})

test('qa-dev.yml runs the money job only on the gate verdict, with the concurrency group on that job', () => {
  assert.match(QA_DEV_YML, /^\s*needs:\s*gate\s*$/m)
  assert.match(QA_DEV_YML, /^\s*if:\s*needs\.gate\.outputs\.run == 'true'\s*$/m)
  // Job-level, so a skipped run never holds the group; and no workflow-level
  // group left behind to queue the skipped runs anyway.
  const jobsAt = QA_DEV_YML.indexOf('\njobs:')
  assert.ok(jobsAt > 0)
  assert.doesNotMatch(QA_DEV_YML.slice(0, jobsAt), /^\s*concurrency:/m, 'a workflow-level concurrency group is back')
  assert.match(QA_DEV_YML.slice(jobsAt), /group:\s*qa-dev-money-flow\s*\n\s*cancel-in-progress:\s*false/)
})

test('qa-dev.yml records deployment provenance in the failure issue (#2271)', () => {
  assert.match(QA_DEV_YML, /TRIGGER="deployment_status — Railway deployment \$\{DEPLOYMENT_ID\} of \$\{DEPLOYMENT_SHA\} to '\$\{DEPLOYMENT_ENV\}', created by \$\{DEPLOYMENT_CREATOR\}"/)
  assert.match(QA_DEV_YML, /TRIGGER="workflow_dispatch — started by \$\{GITHUB_ACTOR\}"/)
})

test('guard-freshness.yml can read the Deployments API the provenance check needs', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/guard-freshness.yml'), 'utf8')
  assert.match(wf, /^\s*deployments:\s*read/m)
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
