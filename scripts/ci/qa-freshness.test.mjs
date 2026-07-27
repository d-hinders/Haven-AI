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
import { evaluate, matchesGlob, moneyPathFiles, loadMoneyPathGlobs } from './qa-freshness.mjs'

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

describe('gap 2 — hotfix/* is judged on its own evidence, not dev\'s', () => {
  const hotfix = { ...base, sourceBranch: 'hotfix/urgent' }

  test('money-path hotfix with no run of its own → fail', () => {
    const r = evaluate({
      ...hotfix,
      latestGreenRun: null,
      changedMoneyPathFiles: ['packages/backend/src/lib/allowance-module.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_no_run')
    assert.match(r.message, /evidence about different code/)
  })

  test('a green run on DEV does not rescue a money-path hotfix', () => {
    // The old gate passed exactly here: fresh dev run + hotfix = green, while
    // the hotfix code had never been tested. This is the dangerous case.
    const r = evaluate({
      ...hotfix,
      latestGreenRun: null,
      changedMoneyPathFiles: ['packages/backend/src/middleware/agentAuth.ts'],
    })
    assert.equal(r.ok, false)
  })

  test('hotfix touching no money-path file → pass, gate does not apply', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: [] })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'hotfix_no_money_path')
  })

  test('hotfix with its OWN fresh green run and no later money-path change → pass', () => {
    assert.equal(evaluate({ ...hotfix, latestGreenRun: run(1), changedMoneyPathFiles: [] }).ok, true)
  })

  test('hotfix with its own run but STALE → still fails on staleness', () => {
    // Must carry a money-path change, or the no-money-path early return fires
    // first and the staleness rule is never reached. That ordering is correct
    // (the gate does not apply at all to a non-money hotfix) but it makes the
    // obvious version of this test pass for the wrong reason.
    const r = evaluate({
      ...hotfix,
      latestGreenRun: run(99),
      changedMoneyPathFiles: ['packages/backend/src/routes/payments.ts'],
    })
    assert.equal(r.code, 'stale')
  })

  test('a non-money hotfix passes even with a badly stale run — gate does not apply', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: run(999), changedMoneyPathFiles: [] })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'hotfix_no_money_path')
  })

  test('hotfix with an uncomputable diff → fail closed', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_diff_unknown')
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
    const g = 'packages/backend/src/lib/delegation-*.ts'
    assert.equal(matchesGlob('packages/backend/src/lib/delegation-redeem.ts', g), true)
    assert.equal(matchesGlob('packages/backend/src/lib/delegation.ts', g), false)
    // The bug a naive `.*` would introduce: crossing a directory boundary.
    assert.equal(matchesGlob('packages/backend/src/lib/delegation-a/b.ts', g), false)
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
        'packages/backend/src/lib/delegation-redeem.ts',
      ],
      globs,
    )
    assert.deepEqual(hits, [
      'packages/backend/src/routes/payments.ts',
      'packages/backend/src/db/migrations/051_a.sql',
      'packages/backend/src/lib/delegation-redeem.ts',
    ])
  })

  test('the delegation rail and the SDK signer are covered — they were NOT in labeler.yml', () => {
    // The specific hole #1030 found: money-path PRs on the delegation rail were
    // never auto-labeled, so they never loaded money.md.
    const globs = loadMoneyPathGlobs()
    for (const f of [
      'packages/backend/src/lib/delegation-redeem.ts',
      'packages/backend/src/lib/execution-rail.ts',
      'packages/backend/src/lib/hybrid-provisioning.ts',
      'packages/backend/src/routes/agent-delegations.ts',
      'packages/sdk/src/signer.ts',
    ]) {
      assert.equal(moneyPathFiles([f], globs).length, 1, `${f} must be money-path`)
    }
  })
})
