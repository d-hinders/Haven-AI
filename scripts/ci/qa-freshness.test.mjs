// Tests for the money-flow QA freshness gate (#1030).
//
// The first block is CHARACTERIZATION (money.md §2): it pins the behaviour of
// the inline-bash version this replaced, so the refactor is provably
// behaviour-preserving before the new rules are layered on. If one of those
// three fails, the rewrite changed something it was not supposed to.
//
// Everything after pins the NEW rules. The bias throughout is fail-closed: for
// each way the gate could be asked a question it cannot answer, there is a test
// asserting it refuses rather than passes. That direction is the whole point —
// #1030 exists because the old gate reported green while proving nothing.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, matchesGlob, moneyPathFiles, loadMoneyPathGlobs, completenessWarningFromJobs, greenRunQueryArgs, selectDiffBase, isVersionOnlyDiff, partitionVersionOnly, selectGreenRun, moneyFlowJobConclusion, EVIDENCE_EVENTS, MONEY_FLOW_JOB, GREEN_RUN_WINDOW } from './qa-freshness.mjs'

const HOUR = 3_600_000
const NOW = Date.parse('2026-07-27T12:00:00Z')
const run = (hoursAgo, headSha = 'aaa111') => ({
  createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  headSha,
})
const base = {
  sourceBranch: 'dev',
  latestGreenRun: run(2),
  changedMoneyPathFiles: [],
  nowMs: NOW,
  freshnessHours: 30,
}

describe('characterization — behaviour of the inline-bash gate this replaced', () => {
  test('no green run at all → fail', () => {
    const r = evaluate({ ...base, latestGreenRun: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_run')
    assert.match(r.message, /No successful 'QA — money-flow \(dev\)' run found on dev/)
  })

  test('run older than FRESHNESS_HOURS → fail, with the age in the message', () => {
    const r = evaluate({ ...base, latestGreenRun: run(31) })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale')
    assert.match(r.message, /31h old \(> 30h\)/)
    // Operators grep this phrase; the refactor must not reword it.
    assert.match(r.message, /add the 'qa-override' label/)
  })

  test('run inside the window → pass', () => {
    assert.equal(evaluate({ ...base, latestGreenRun: run(29) }).ok, true)
  })

  test('exactly at the boundary passes — `-gt`, not `-ge`, as the bash used', () => {
    assert.equal(evaluate({ ...base, latestGreenRun: run(30) }).ok, true)
  })

  test('FRESHNESS_HOURS is honoured, not hardcoded', () => {
    assert.equal(evaluate({ ...base, latestGreenRun: run(40), freshnessHours: 50 }).ok, true)
    assert.equal(evaluate({ ...base, latestGreenRun: run(40), freshnessHours: 20 }).ok, false)
  })
})

describe('gap 1 — the run must have covered the promoted money-path code', () => {
  test('money-path file changed after the run → fail even though the run is fresh', () => {
    const r = evaluate({
      ...base,
      latestGreenRun: run(1, 'sha-old'),
      changedMoneyPathFiles: ['packages/backend/src/routes/payments.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'money_path_after_run')
    // The failure must name the offending file — a gate that says "no" without
    // saying what is the kind people bypass rather than diagnose.
    assert.match(r.message, /routes\/payments\.ts/)
    assert.match(r.message, /recency is not coverage/)
  })

  test('no money-path change since the run → pass (ordinary promotions stay cheap)', () => {
    assert.equal(evaluate({ ...base, changedMoneyPathFiles: [] }).ok, true)
  })

  test('uncomputable diff → fail closed, never "nothing changed"', () => {
    const r = evaluate({ ...base, changedMoneyPathFiles: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'diff_unknown')
  })

  test('staleness is checked before coverage — the older problem is reported first', () => {
    const r = evaluate({
      ...base,
      latestGreenRun: run(99),
      changedMoneyPathFiles: ['packages/backend/src/routes/payments.ts'],
    })
    assert.equal(r.code, 'stale')
  })
})

describe("gap 2 — a money-path hotfix cannot be verified, so it BLOCKS", () => {
  const hotfix = { ...base, sourceBranch: 'hotfix/urgent' }

  test('money-path hotfix blocks even with a fresh green run on dev', () => {
    // The old gate passed exactly here. So did my first attempt at the fix,
    // which accepted "a green run exists on the hotfix branch" — but qa-dev is
    // a black-box harness against a DEPLOYED backend, and a hotfix is deployed
    // nowhere until it merges. Accepting such a run would have been the same
    // lie in a new costume.
    const r = evaluate({
      ...hotfix,
      latestGreenRun: run(1),
      changedMoneyPathFiles: ['packages/backend/src/rails/allowance-module.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_money_path')
    assert.match(r.message, /deployed nowhere until it merges/)
    // The message must say how to proceed, or it just gets overridden blindly.
    assert.match(r.message, /qa-override/)
    assert.match(r.message, /allowance-module\.ts/)
  })

  test('a run on the hotfix branch itself does NOT clear it', () => {
    const r = evaluate({
      ...hotfix,
      latestGreenRun: run(0.1, 'hotfix-sha'),
      changedMoneyPathFiles: ['packages/backend/src/middleware/agentAuth.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_money_path')
  })

  test('hotfix touching no money-path file → pass, gate does not apply', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: [] })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'hotfix_no_money_path')
  })

  test('a non-money hotfix passes even with no run at all', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: [] })
    assert.equal(r.ok, true)
  })

  test('hotfix with an uncomputable diff → fail closed', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_diff_unknown')
  })
})

describe('the gate refuses to run without a real bound or a known branch', () => {
  test('non-numeric QA_FRESHNESS_HOURS → fail closed, not a silent NaN pass', () => {
    // The repo variable is editable without code review. `ageH > NaN` is false,
    // so this silently disabled the staleness rule while printing "within NaNh".
    const r = evaluate({ ...base, latestGreenRun: run(1000), freshnessHours: Number('thirty') })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'bad_freshness_hours')
  })

  test('zero or negative freshness → fail closed', () => {
    assert.equal(evaluate({ ...base, freshnessHours: 0 }).code, 'bad_freshness_hours')
    assert.equal(evaluate({ ...base, freshnessHours: -5 }).code, 'bad_freshness_hours')
  })

  test('unknown source branch → fail closed', () => {
    // The docstring promised this; it was not true. `gate` restricts the branch,
    // but this function must not depend on another job for its own correctness.
    const r = evaluate({ ...base, sourceBranch: 'feature/x' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unknown_branch')
  })
})

describe('fail-closed on malformed input', () => {
  test('unparseable run timestamp → fail, not "assume recent"', () => {
    const r = evaluate({ ...base, latestGreenRun: { createdAt: 'not-a-date', headSha: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unparseable_timestamp')
  })

  test('a future-dated run is not treated as stale', () => {
    // Clock skew between the runner and the API should not wedge a promotion.
    assert.equal(evaluate({ ...base, latestGreenRun: run(-1) }).ok, true)
  })
})

describe('glob matching', () => {
  test('exact path', () => {
    assert.equal(matchesGlob('packages/sdk/src/signer.ts', 'packages/sdk/src/signer.ts'), true)
    assert.equal(matchesGlob('packages/sdk/src/signer2.ts', 'packages/sdk/src/signer.ts'), false)
  })

  test('trailing /** matches everything beneath', () => {
    const g = 'packages/backend/src/db/migrations/**'
    assert.equal(matchesGlob('packages/backend/src/db/migrations/050_x.sql', g), true)
    assert.equal(matchesGlob('packages/backend/src/db/migrations/sub/deep.sql', g), true)
    assert.equal(matchesGlob('packages/backend/src/db/other.sql', g), false)
  })

  test('* stays within one segment', () => {
    const g = 'packages/backend/src/rails/delegation-*.ts'
    assert.equal(matchesGlob('packages/backend/src/rails/delegation-redeem.ts', g), true)
    assert.equal(matchesGlob('packages/backend/src/rails/delegation.ts', g), false)
    // The bug a naive `.*` would introduce: crossing a directory boundary.
    assert.equal(matchesGlob('packages/backend/src/rails/delegation-a/b.ts', g), false)
  })

  test('regex metacharacters in a path are literal, not patterns', () => {
    assert.equal(matchesGlob('packages/backend/src/lib/aXb.ts', 'packages/backend/src/lib/a.b.ts'), false)
  })

  test('moneyPathFiles filters a mixed change set', () => {
    const globs = loadMoneyPathGlobs()
    const hits = moneyPathFiles(
      [
        'README.md',
        'packages/backend/src/routes/payments.ts',
        'packages/frontend/src/app/page.tsx',
        'packages/backend/src/db/migrations/051_a.sql',
        'packages/backend/src/rails/delegation-redeem.ts',
      ],
      globs,
    )
    assert.deepEqual(hits, [
      'packages/backend/src/routes/payments.ts',
      'packages/backend/src/db/migrations/051_a.sql',
      'packages/backend/src/rails/delegation-redeem.ts',
    ])
  })

  test('the delegation rail and the SDK signer are covered — they were NOT in labeler.yml', () => {
    // The specific hole #1030 found: money-path PRs on the delegation rail were
    // never auto-labeled, so they never loaded money.md.
    const globs = loadMoneyPathGlobs()
    for (const f of [
      'packages/backend/src/rails/delegation-redeem.ts',
      'packages/backend/src/rails/execution-rail.ts',
      'packages/backend/src/rails/hybrid-provisioning.ts',
      'packages/backend/src/routes/agent-delegations.ts',
      'packages/sdk/src/signer.ts',
    ]) {
      assert.equal(moneyPathFiles([f], globs).length, 1, `${f} must be money-path`)
    }
  })
})

describe('completeness warning (#1044)', () => {
  test('warns when the Coverage completeness step failed', () => {
    const jobs = [{ steps: [
      { name: 'Run money-flow QA (bounded flake-retry)', conclusion: 'success' },
      { name: 'Coverage completeness', conclusion: 'failure' },
    ] }]
    assert.match(completenessWarningFromJobs(jobs) ?? '', /GREEN-WITH-SKIPS/)
  })
  test('silent on full coverage, missing step, or no jobs', () => {
    assert.equal(completenessWarningFromJobs([{ steps: [
      { name: 'Coverage completeness', conclusion: 'success' },
    ] }]), null)
    assert.equal(completenessWarningFromJobs([{ steps: [] }]), null)
    assert.equal(completenessWarningFromJobs(undefined), null)
  })
})

// #1047 part 3 — the WIRING decisions main() feeds the pure core with. The
// core was pinned; these two choices (which runs count as evidence, which SHA
// the coverage diff anchors to) were not, and both are load-bearing.
describe('wiring — run-list filters (#1047, re-pinned by #2404)', () => {
  test('evidence is qa-dev.yml successes, newest first, a bounded window — and NO branch filter', () => {
    const args = greenRunQueryArgs('d-hinders/Haven-AI')
    const arg = (flag) => args[args.indexOf(flag) + 1]
    assert.equal(arg('--workflow'), 'qa-dev.yml')
    // #2404: "on dev" is decided by selectGreenRun on the run's SHA, not by
    // `--branch`. A deployment_status run has no branch label (Railway deploys
    // a bare SHA; GitHub: GITHUB_REF is "empty if commit"), so a `--branch dev`
    // filter excludes the one run whose headSha IS the deployed commit.
    assert.equal(args.includes('--branch'), false, 'the query must not filter on branch (#2404)')
    assert.equal(arg('--status'), 'success')
    assert.equal(arg('--limit'), String(GREEN_RUN_WINDOW))
    assert.ok(GREEN_RUN_WINDOW > 1, 'the selector needs a window, not a single row')
    assert.equal(arg('--repo'), 'd-hinders/Haven-AI')
    // headSha is what the coverage diff anchors to; dropping it from the JSON
    // fields would silently turn the coverage rule into fail-closed-always.
    // event and headBranch are what the selector decides on; dropping either
    // makes it refuse every row (fail closed), which the selection tests pin.
    for (const field of ['headSha', 'createdAt', 'databaseId', 'event', 'headBranch']) {
      assert.match(arg('--json'), new RegExp(`(^|,)${field}(,|$)`), `--json must project ${field}`)
    }
  })
})

// ── Run selection (#2404) ───────────────────────────────────────────────────
//
// The gate used to ask gh for `--branch dev`. #2273's post-deploy run is fired
// by GitHub's `deployment_status` event for a Railway Deployment created
// against a BARE SHA, so it carries no branch label and that filter drops it —
// the run that tests exactly the deployed commit was the one the promotion
// gate could not see. These tests carry the "before" leg as well as the
// "after": the pre-#2404 query is replayed through a model of gh's filter so
// the defect is demonstrated, not asserted.

/**
 * A model of what `gh run list` does with the flags this gate uses, so the
 * old and new queries can be replayed over the same rows. Semantics from the
 * REST docs for GET /repos/{o}/{r}/actions/workflows/{id}/runs: `branch`
 * "Returns workflow runs associated with a branch. Use the name of the branch
 * of the push" — an equality filter on the run's head_branch, which is
 * nullable; `status` filters on conclusion for completed runs; `per_page`
 * bounds the page. `--json` projects fields. Rows arrive newest first.
 */
function simulateGhRunList(rows, args) {
  const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const branch = arg('--branch')
  const status = arg('--status')
  const limit = Number(arg('--limit') ?? rows.length)
  const fields = (arg('--json') ?? '').split(',').filter(Boolean)
  return rows
    .filter((r) => branch === undefined || r.headBranch === branch)
    .filter((r) => status === undefined || r.conclusion === status)
    .slice(0, limit)
    .map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null])))
}

/** The query as it stood before #2404 — kept verbatim as the "before" leg. */
const PRE_2404_QUERY = [
  'run', 'list', '--repo', 'd-hinders/Haven-AI', '--workflow', 'qa-dev.yml',
  '--branch', 'dev', '--status', 'success', '--limit', '1',
  '--json', 'createdAt,headSha,databaseId',
]

const T0 = Date.parse('2026-09-02T08:00:00Z')
const at = (minutesAgo) => new Date(T0 - minutesAgo * 60_000).toISOString()
const greenJobs = [{ name: MONEY_FLOW_JOB, conclusion: 'success', steps: [{ name: 'Coverage completeness', conclusion: 'success' }] }]
const skippedJobs = [
  { name: 'gate', conclusion: 'success', steps: [] },
  { name: MONEY_FLOW_JOB, conclusion: 'skipped', steps: [] },
]

// The shape #2273's trigger is expected to produce: Railway deploys a bare
// SHA, GitHub documents GITHUB_REF as "empty if commit", so no headBranch.
// UNVERIFIED against a real run as of 2026-09-02 (none exists yet); the rows
// below therefore cover BOTH the predicted shape (null / '') and the
// alternative (`dev`), and the selector must admit all three.
const deployRun = {
  databaseId: 900001, event: 'deployment_status', headBranch: null,
  headSha: 'deployed-sha', createdAt: at(10), conclusion: 'success',
}
const manualRun = {
  databaseId: 900002, event: 'workflow_dispatch', headBranch: 'dev',
  headSha: 'older-dev-sha', createdAt: at(120), conclusion: 'success',
}
const nightlyRun = {
  databaseId: 900003, event: 'schedule', headBranch: 'dev',
  headSha: 'oldest-dev-sha', createdAt: at(600), conclusion: 'success',
}
const devHistory = new Set(['deployed-sha', 'older-dev-sha', 'oldest-dev-sha'])
const io = (overrides = {}) => ({
  isAncestorOfHead: (sha) => devHistory.has(sha),
  jobsFor: () => greenJobs,
  ...overrides,
})

describe('run selection — the "before" leg: the defect was real (#2404)', () => {
  test('the pre-#2404 query cannot return a deployment_status run, because it has no branch to match', () => {
    const rows = simulateGhRunList([deployRun, manualRun, nightlyRun], PRE_2404_QUERY)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].databaseId, manualRun.databaseId, 'the old query keyed on the older manual run')
    assert.equal(rows.some((r) => r.databaseId === deployRun.databaseId), false)
  })

  test('the same is true when the deployment run carries an empty-string branch', () => {
    const rows = simulateGhRunList([{ ...deployRun, headBranch: '' }], PRE_2404_QUERY)
    assert.deepEqual(rows, [])
  })
})

describe('run selection — the "after" leg (#2404)', () => {
  test('the new query, replayed through the same model, hands the selector the deployment run and it is chosen', () => {
    const rows = simulateGhRunList([deployRun, manualRun, nightlyRun], greenRunQueryArgs('d-hinders/Haven-AI'))
    const { run } = selectGreenRun(rows, io())
    assert.ok(run, 'a run must be selected')
    assert.equal(run.databaseId, deployRun.databaseId, `expected the deployment_status run ${deployRun.databaseId} to be selected, got ${run.databaseId}`)
    assert.equal(run.headSha, 'deployed-sha')
  })

  test('a deployment_status run is admitted whatever GitHub records as its branch: null, empty, or dev', () => {
    for (const headBranch of [null, '', 'dev', undefined]) {
      const { run } = selectGreenRun([{ ...deployRun, headBranch }], io())
      assert.equal(run?.databaseId, deployRun.databaseId, `headBranch=${JSON.stringify(headBranch)}`)
    }
  })

  test('schedule and workflow_dispatch runs on dev are still admitted — nothing narrowed on the legs that worked', () => {
    assert.equal(selectGreenRun([manualRun], io()).run?.databaseId, manualRun.databaseId)
    assert.equal(selectGreenRun([nightlyRun], io()).run?.databaseId, nightlyRun.databaseId)
  })

  test('newest admitted run wins across different commits', () => {
    // The manual run is newer than the nightly here; the deployment run is absent.
    const { run } = selectGreenRun([nightlyRun, manualRun], io())
    assert.equal(run.databaseId, manualRun.databaseId)
  })

  test('at the SAME commit, deployment_status is preferred over a newer manual re-dispatch', () => {
    // The tie-break changes which run at a commit anchors the diff — the one
    // whose headSha is the deployed commit by construction — never which
    // commit. Order in the input is newest-first, as gh returns it.
    const redispatch = { ...manualRun, databaseId: 900004, headSha: 'deployed-sha', createdAt: at(5) }
    const { run } = selectGreenRun([redispatch, deployRun], io())
    assert.equal(run.databaseId, deployRun.databaseId)
  })

  test('a NEWER manual dispatch at a newer commit beats an older deployment run — provenance is a tie-break, not an override', () => {
    // The documented way a red qa-failure is cleared is a re-dispatch after the
    // fix lands. Preferring the older post-deploy run here would refuse that
    // route and make qa-override the way through (#2164, one gate over).
    const later = { ...manualRun, databaseId: 900005, headSha: 'deployed-sha', createdAt: at(1) }
    const olderDeploy = { ...deployRun, headSha: 'older-dev-sha', createdAt: at(60) }
    const { run } = selectGreenRun([later, olderDeploy], io())
    assert.equal(run.databaseId, later.databaseId)
  })

  test('a REFUSED row at an older commit never drags that commit ahead of a newer one with real evidence', () => {
    // Review finding on the first version: commits were ranked by the newest
    // row at each SHA, refused rows included, so a repository_dispatch fired
    // a minute ago at an old commit put that commit first and its (older,
    // legitimate) nightly run was chosen over a newer commit's dispatch.
    // Which commit anchors the diff must be decided by admitted rows alone.
    const decoy = { ...manualRun, databaseId: 900010, event: 'repository_dispatch', headSha: 'older-dev-sha', createdAt: at(1) }
    const legitOld = { ...nightlyRun, databaseId: 900011, headSha: 'older-dev-sha', createdAt: at(50) }
    const legitNew = { ...manualRun, databaseId: 900012, headSha: 'deployed-sha', createdAt: at(20) }
    const { run, refused } = selectGreenRun([decoy, legitNew, legitOld], io())
    assert.equal(run.databaseId, legitNew.databaseId)
    assert.deepEqual(refused.map((r) => r.databaseId), [decoy.databaseId])
    // Same shape with a gate-skipped deployment_status run as the decoy.
    const skippedDecoy = { ...deployRun, databaseId: 900013, headSha: 'older-dev-sha', createdAt: at(1) }
    const picked = selectGreenRun([skippedDecoy, legitNew, legitOld], io({
      jobsFor: (id) => (id === skippedDecoy.databaseId ? skippedJobs : greenJobs),
    }))
    assert.equal(picked.run.databaseId, legitNew.databaseId)
  })

  test('the tie-break candidate must itself pass every rule — a gate-skipped deployment run cannot displace the manual run at its commit', () => {
    const redispatch = { ...manualRun, databaseId: 900014, headSha: 'deployed-sha', createdAt: at(5) }
    const { run } = selectGreenRun([redispatch, deployRun], io({
      jobsFor: (id) => (id === deployRun.databaseId ? skippedJobs : greenJobs),
    }))
    assert.equal(run.databaseId, redispatch.databaseId)
  })

  test('the selector returns the admitted run\'s jobs so the completeness warning reads the same list', () => {
    const { jobs } = selectGreenRun([deployRun], io())
    assert.equal(completenessWarningFromJobs(jobs), null)
    const partial = [{ name: MONEY_FLOW_JOB, conclusion: 'success', steps: [{ name: 'Coverage completeness', conclusion: 'failure' }] }]
    const { jobs: partialJobs } = selectGreenRun([deployRun], io({ jobsFor: () => partial }))
    assert.match(completenessWarningFromJobs(partialJobs) ?? '', /GREEN-WITH-SKIPS/)
  })
})

describe('run selection — fails closed (#2404)', () => {
  test('a run whose commit is NOT in the promoted history is refused, whatever its event', () => {
    for (const event of EVIDENCE_EVENTS) {
      const feature = { ...deployRun, event, headBranch: event === 'deployment_status' ? null : 'dev', headSha: 'feature-sha' }
      const { run, refused } = selectGreenRun([feature], io())
      assert.equal(run, null, `${event} run on a non-dev commit must be refused`)
      assert.match(refused[0].reason, /not an ancestor/)
    }
  })

  test('an ancestry check that cannot answer (null) refuses — never "assume on dev"', () => {
    const { run, refused } = selectGreenRun([deployRun], io({ isAncestorOfHead: () => null }))
    assert.equal(run, null)
    assert.match(refused[0].reason, /could not establish/)
  })

  test('a branch-labelled event off dev is refused even when its commit is on dev', () => {
    // A workflow_dispatch on feature/x whose tip later merged into dev: the
    // commit is in the history, but the pre-#2404 rule for labelled events
    // ("--branch dev") is kept as-is, so the label still has to say dev.
    const offDev = { ...manualRun, headBranch: 'feature/x' }
    const { run, refused } = selectGreenRun([offDev], io())
    assert.equal(run, null)
    assert.match(refused[0].reason, /on 'feature\/x', not dev/)
  })

  test('a repository_dispatch run is refused — the event #2273 removed because a curl could produce it (#2271)', () => {
    const curl = { ...manualRun, event: 'repository_dispatch' }
    const { run, refused } = selectGreenRun([curl], io())
    assert.equal(run, null)
    assert.match(refused[0].reason, /repository_dispatch/)
  })

  test('push and pull_request runs are refused, and a row with no event is refused', () => {
    for (const event of ['push', 'pull_request', undefined, null]) {
      const { run } = selectGreenRun([{ ...manualRun, event }], io())
      assert.equal(run, null, `event=${String(event)}`)
    }
  })

  test('THE GATE-SKIPPED CASE: a deployment_status run whose money-flow job was skipped is refused', () => {
    // #2273 gates the money-flow job behind a cheap `gate` job. For the
    // in_progress status and Railway's re-stated `success`, the harness is
    // skipped — and a run with jobs {gate: success, money-flow: skipped} has
    // run-level conclusion `success` (measured on ci.yml runs, 2026-09-02).
    // `--status success` delivers it; only the job check refuses it.
    const { run, refused } = selectGreenRun([deployRun], io({ jobsFor: () => skippedJobs }))
    assert.equal(run, null)
    assert.match(refused[0].reason, /'money-flow' job concluded 'skipped'/)
  })

  test('the job check applies to every event, not only deployment_status', () => {
    for (const row of [manualRun, nightlyRun]) {
      assert.equal(selectGreenRun([row], io({ jobsFor: () => skippedJobs })).run, null)
    }
  })

  test('an unreadable job list refuses the run — a jobs-API hiccup is not a green harness', () => {
    assert.equal(selectGreenRun([deployRun], io({ jobsFor: () => null })).run, null)
    assert.equal(selectGreenRun([deployRun], io({ jobsFor: () => { throw new Error('502') } })).run, null)
    assert.equal(selectGreenRun([deployRun], io({ jobsFor: () => [] })).run, null)
  })

  test('a refused newest run falls through to the next admissible one, and the refusal is recorded', () => {
    const { run, refused } = selectGreenRun([deployRun, manualRun], io({
      jobsFor: (id) => (id === deployRun.databaseId ? skippedJobs : greenJobs),
    }))
    assert.equal(run.databaseId, manualRun.databaseId)
    assert.equal(refused.length, 1)
    assert.equal(refused[0].databaseId, deployRun.databaseId)
  })

  test('a row with no headSha is refused', () => {
    for (const headSha of [undefined, null, '']) {
      assert.equal(selectGreenRun([{ ...deployRun, headSha }], io()).run, null)
    }
  })

  test('an empty window yields no run, not a throw', () => {
    assert.deepEqual(selectGreenRun([], io()), { run: null, jobs: null, refused: [] })
    assert.equal(selectGreenRun(undefined, io()).run, null)
  })

  test('moneyFlowJobConclusion reads the named job only', () => {
    assert.equal(moneyFlowJobConclusion(greenJobs), 'success')
    assert.equal(moneyFlowJobConclusion(skippedJobs), 'skipped')
    assert.equal(moneyFlowJobConclusion([{ name: 'gate', conclusion: 'success' }]), null)
    assert.equal(moneyFlowJobConclusion(null), null)
  })

  test('COVERAGE STILL BLOCKS: an admitted deployment_status run whose commit predates a money-path change does not pass evaluate()', () => {
    // Admitting the run is not the same as trusting it for everything: the
    // gap-1 rule is unchanged, so a deployed-SHA run that never saw a
    // money-path commit still refuses the promotion — whatever its event.
    for (const event of EVIDENCE_EVENTS) {
      const r = evaluate({
        ...base,
        latestGreenRun: { ...deployRun, event, createdAt: new Date(NOW - HOUR).toISOString() },
        changedMoneyPathFiles: ['packages/backend/src/routes/x402.ts'],
      })
      assert.equal(r.ok, false, `${event} run must not excuse an uncovered money-path change`)
      assert.equal(r.code, 'money_path_after_run')
      assert.match(r.message, /routes\/x402\.ts/)
    }
  })
})

describe('wiring — diff-base selection (#1047)', () => {
  test('an ordinary branch anchors to the green run commit; merge-base is not consulted', () => {
    let mergeBaseCalls = 0
    const base = selectDiffBase({
      sourceBranch: 'dev',
      latestGreenRun: { headSha: 'run-sha' },
      resolveMergeBaseWithMain: () => {
        mergeBaseCalls += 1
        return 'wrong'
      },
    })
    assert.equal(base, 'run-sha')
    assert.equal(mergeBaseCalls, 0)
  })

  test('a hotfix anchors to its merge-base with main, never the run commit', () => {
    const base = selectDiffBase({
      sourceBranch: 'hotfix/urgent',
      latestGreenRun: { headSha: 'run-sha' },
      resolveMergeBaseWithMain: () => 'mb-sha',
    })
    assert.equal(base, 'mb-sha')
  })

  test('no green run -> null anchor -> the caller fails closed', () => {
    const base = selectDiffBase({
      sourceBranch: 'dev',
      latestGreenRun: null,
      resolveMergeBaseWithMain: () => 'unused',
    })
    assert.equal(base, null)
  })

  test('an unresolvable hotfix merge-base stays null — never a silent fallback to the run', () => {
    const base = selectDiffBase({
      sourceBranch: 'hotfix/urgent',
      latestGreenRun: { headSha: 'run-sha' },
      resolveMergeBaseWithMain: () => null,
    })
    assert.equal(base, null)
  })
})

// ── Version-only money-path diffs (#2164) ───────────────────────────────────
//
// Every release bump rewrites SIGNER_VERSION into packages/signer/src/server.ts
// — a money-path file — after the last green run, so the gate refused every
// release by construction and qa-override became the route. These pin the
// narrow exception, and the bias is the same as everywhere else in this file:
// each test that could go the permissive way asserts it does not.

const signerVersionBump = `diff --git a/packages/signer/src/server.ts b/packages/signer/src/server.ts
--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const SIGNER_VERSION = '0.1.31-alpha.0'
`

const packageJsonBump = `diff --git a/packages/signer/package.json b/packages/signer/package.json
--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -3 +3 @@
-  "version": "0.1.30-alpha.0",
+  "version": "0.1.31-alpha.0",
@@ -20 +20 @@
-    "@haven_ai/sdk": "0.1.30-alpha.0",
+    "@haven_ai/sdk": "0.1.31-alpha.0",
`

describe('isVersionOnlyDiff (#2164)', () => {
  test('a real SIGNER_VERSION bump is version-only', () => {
    assert.equal(isVersionOnlyDiff(signerVersionBump), true)
  })

  test('a package.json version + internal pin bump is version-only', () => {
    assert.equal(isVersionOnlyDiff(packageJsonBump), true)
  })

  test('a real HOSTED_SERVER_VERSION bump is version-only (#2300)', () => {
    // #2300 put packages/mcp-server/src/** on the perimeter, and release-bump
    // writes HOSTED_SERVER_VERSION into packages/mcp-server/src/server.ts on
    // every cut — the identical #2164 shape, one package over. Without this
    // constant in the allowlist every release promotion would refuse by
    // construction again and qa-override would become the route. Mutation:
    // drop HOSTED_SERVER_VERSION from RELEASE_BUMP_VERSION_CONSTANTS and this
    // fails while the "unowned constant" case below stays green — the two
    // together pin that the allowlist is exactly the intersection of
    // release-bump's SOURCE_VERSION_CONSTANTS with the runtime globs.
    const hostedServerVersionBump = `diff --git a/packages/mcp-server/src/server.ts b/packages/mcp-server/src/server.ts
--- a/packages/mcp-server/src/server.ts
+++ b/packages/mcp-server/src/server.ts
@@ -13 +13 @@
-export const HOSTED_SERVER_VERSION = '0.1.34-alpha.0'
+export const HOSTED_SERVER_VERSION = '0.1.35-alpha.0'
`
    assert.equal(isVersionOnlyDiff(hostedServerVersionBump), true)
  })

  test('the constants release-bump writes into non-perimeter packages are NOT excused (#2300)', () => {
    // MCP_VERSION (packages/mcp/), CONNECTOR_VERSION (packages/connect/) and
    // CLI_VERSION (packages/cli/) are real release-bump constants, but their
    // files sit on no runtime glob, so the gate never sees them and the
    // allowlist must not grow to "everything release-bump writes". Guards the
    // widening that the #2300 addition makes tempting.
    for (const name of ['MCP_VERSION', 'CONNECTOR_VERSION', 'CLI_VERSION']) {
      const bump = `--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-export const ${name} = '0.1.34-alpha.0'
+export const ${name} = '0.1.35-alpha.0'
`
      assert.equal(isVersionOnlyDiff(bump), false, `${name} must not be excused`)
    }
  })

  test('THE CASE A PATH EXCLUSION GETS WRONG: a behavioural line in the same commit as a bump still counts', () => {
    // This is the whole reason the rule is content-based. Excusing
    // packages/signer/** by path would wave this through.
    const mixed = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const SIGNER_VERSION = '0.1.31-alpha.0'
@@ -40 +40 @@
-  if (!verifySignature(hash, signature, delegateAddress)) {
+  if (false) {
`
    assert.equal(isVersionOnlyDiff(mixed), false)
  })

  test('a behavioural change alone counts', () => {
    const behavioural = `--- a/packages/signer/src/core.ts
+++ b/packages/signer/src/core.ts
@@ -40 +40 @@
-  const delegateAddress = addressFromKey(delegateKey)
+  const delegateAddress = OVERRIDE
`
    assert.equal(isVersionOnlyDiff(behavioural), false)
  })

  test('a non-semver value on a _VERSION constant is NOT excused', () => {
    // Guards the allowlist from widening into "any assignment to anything
    // ending in _VERSION".
    const sneaky = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const SIGNER_VERSION = process.env.ANYTHING
`
    assert.equal(isVersionOnlyDiff(sneaky), false)
  })

  test('a comment-only edit is NOT excused — this function answers one question', () => {
    const comment = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -11 +11 @@
-// self-reported version
+// self-reported version, owned by release-bump.mjs
`
    assert.equal(isVersionOnlyDiff(comment), false)
  })

  // ── The three cases a per-line shape check let through (review finding) ────
  // Each of these is well-shaped on every line and would have been excused by
  // shape matching alone. They are refused because the SYMBOL removed must
  // equal the symbol added.

  test('a deletion of the version constant, with nothing replacing it, is NOT excused', () => {
    const deletionOnly = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +11,0 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
`
    assert.equal(isVersionOnlyDiff(deletionOnly), false)
  })

  test('a dependency IDENTITY swap is NOT excused — it retargets what the signer depends on', () => {
    // Both lines match the dep shape; only the pairing check catches that the
    // package name changed rather than its version.
    const swap = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -20 +20 @@
-    "@haven_ai/sdk": "0.1.30-alpha.0",
+    "@haven_ai/mcp": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(swap), false)
  })

  test('a rename of the version constant is NOT excused', () => {
    const rename = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const ATTACKER_VERSION = '0.1.31-alpha.0'
`
    assert.equal(isVersionOnlyDiff(rename), false)
  })

  test('a _VERSION constant release-bump does not own is NOT excused', () => {
    // The allowlist names SIGNER_VERSION literally rather than matching
    // [A-Z0-9_]*_VERSION, so an unowned constant is refused even when paired.
    const unowned = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SOMETHING_VERSION = '0.1.30-alpha.0'
+export const SOMETHING_VERSION = '0.1.31-alpha.0'
`
    assert.equal(isVersionOnlyDiff(unowned), false)
  })

  test('a pure ADDITION of a version line is NOT excused', () => {
    const addition = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -20,0 +21 @@
+    "@haven_ai/mcp": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(addition), false)
  })

  test('a multi-symbol in-place bump IS excused — pairing is a multiset, not an order', () => {
    const reordered = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -3,2 +3,2 @@
-  "version": "0.1.30-alpha.0",
-    "@haven_ai/sdk": "0.1.30-alpha.0",
+    "@haven_ai/sdk": "0.1.31-alpha.0",
+  "version": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(reordered), true)
  })

  test('a dependency MOVED between sections is NOT excused, though it nets to zero file-wide', () => {
    // Round-two review finding: `@haven_ai/sdk` leaves `dependencies` in one
    // hunk and appears in `devDependencies` in another. File-wide multiset
    // equality excuses this; per-hunk equality refuses it. It changes what
    // ships when @haven_ai/signer is installed.
    const sectionMove = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -19,2 +19,1 @@
   "dependencies": {
-    "@haven_ai/sdk": "0.1.30-alpha.0",
@@ -30,1 +29,2 @@
   "devDependencies": {
+    "@haven_ai/sdk": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(sectionMove), false)
  })

  test('a real two-hunk bump IS still excused — each hunk balances on its own', () => {
    // Guards the per-hunk rule from being too strict: this is what
    // release-bump.mjs actually writes to a package.json.
    assert.equal(isVersionOnlyDiff(packageJsonBump), true)
  })

  test('a diff with no hunk header fails closed', () => {
    const headersOnly = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
`
    assert.equal(isVersionOnlyDiff(headersOnly), false)
  })

  test('empty, blank and non-string diffs fail closed', () => {
    for (const bad of ['', '   \n', null, undefined, 42]) {
      assert.equal(isVersionOnlyDiff(bad), false)
    }
  })

  test('a diff with only headers and context fails closed — no changed lines is not a pass', () => {
    const noChanges = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -3 +3 @@
   "name": "@haven_ai/signer",
`
    assert.equal(isVersionOnlyDiff(noChanges), false)
  })
})

describe('partitionVersionOnly (#2164)', () => {
  test('splits a release bump away from behavioural money-path work', () => {
    const diffs = {
      'packages/signer/src/server.ts': signerVersionBump,
      'packages/signer/package.json': packageJsonBump,
      'packages/backend/src/modules/x402/settle.ts': `--- a/x
+++ b/x
@@ -1 +1 @@
-const a = 1
+const a = 2
`,
    }
    const { behavioural, versionOnly } = partitionVersionOnly(Object.keys(diffs), (f) => diffs[f])
    assert.deepEqual(versionOnly, ['packages/signer/src/server.ts', 'packages/signer/package.json'])
    assert.deepEqual(behavioural, ['packages/backend/src/modules/x402/settle.ts'])
  })

  test('an unreadable diff is treated as BEHAVIOURAL, never excused', () => {
    const { behavioural, versionOnly } = partitionVersionOnly(['packages/signer/src/server.ts'], () => null)
    assert.deepEqual(behavioural, ['packages/signer/src/server.ts'])
    assert.deepEqual(versionOnly, [])
  })

  test('a diffFor that throws is treated as BEHAVIOURAL', () => {
    const { behavioural, versionOnly } = partitionVersionOnly(['packages/signer/src/server.ts'], () => {
      throw new Error('git exploded')
    })
    assert.deepEqual(behavioural, ['packages/signer/src/server.ts'])
    assert.deepEqual(versionOnly, [])
  })

  test('a full release bump leaves NOTHING behavioural — the #2164 outcome', () => {
    const { behavioural } = partitionVersionOnly(
      ['packages/signer/src/server.ts', 'packages/signer/package.json'],
      (f) => (f.endsWith('.json') ? packageJsonBump : signerVersionBump),
    )
    assert.deepEqual(behavioural, [])
  })
})
