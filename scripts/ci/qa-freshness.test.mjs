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
import { evaluate, matchesGlob, moneyPathFiles, loadMoneyPathGlobs, completenessWarningFromJobs, greenRunQueryArgs, selectDiffBase } from './qa-freshness.mjs'

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
describe('wiring — run-list filters (#1047)', () => {
  test('evidence is ONLY dev-branch successes of qa-dev.yml, newest first', () => {
    const args = greenRunQueryArgs('d-hinders/Haven-AI')
    const arg = (flag) => args[args.indexOf(flag) + 1]
    assert.equal(arg('--workflow'), 'qa-dev.yml')
    // Always dev — a hotfix has no valid evidence of its own, and a green run
    // on any other branch exercised different code.
    assert.equal(arg('--branch'), 'dev')
    assert.equal(arg('--status'), 'success')
    assert.equal(arg('--limit'), '1')
    assert.equal(arg('--repo'), 'd-hinders/Haven-AI')
    // headSha is what the coverage diff anchors to; dropping it from the JSON
    // fields would silently turn the coverage rule into fail-closed-always.
    assert.match(arg('--json'), /headSha/)
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
