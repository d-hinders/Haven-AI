import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ISSUE_TITLE,
  WATCHED_WORKFLOW,
  DERIVED_JOBS,
  CI_HEALTH_LABEL_DESCRIPTION,
  evaluate,
  failureAnnotations,
  prOf,
  renderIssueBody,
  renderSummary,
} from './dev-push-health.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AGG = 'Lint, Type-check & Build'

// A run at minute `t`, with `{ jobName: conclusion }`. The aggregator follows
// ci.yml: `failure` whenever a leaf failed or was cancelled (if: always()).
let nextId = 1000
function run(t, jobs, { conclusion, pr, attemptStartedAt } = {}) {
  const id = nextId++
  const leaves = Object.entries(jobs).map(([name, c], i) => ({ id: id * 100 + i, name, conclusion: c }))
  const aggFails = leaves.some((j) => j.conclusion === 'failure' || j.conclusion === 'cancelled')
  const derived = conclusion ?? (leaves.some((j) => j.conclusion === 'failure') ? 'failure' : 'success')
  return {
    id,
    head_sha: `sha${String(id).padStart(37, '0')}`,
    conclusion: derived,
    created_at: new Date(Date.UTC(2026, 9, 10, 9, t)).toISOString(),
    run_started_at: attemptStartedAt ?? new Date(Date.UTC(2026, 9, 10, 9, t)).toISOString(),
    head_commit: { message: `feat: change ${id}${pr ? ` (#${pr})` : ''}\n\nbody (#1)` },
    jobs: [...leaves, { id: id * 100 + 99, name: AGG, conclusion: aggFails ? 'failure' : 'success' }],
  }
}

test('1: a failed leaf job in a failure run is reported', () => {
  const r = evaluate([run(0, { MCP: 'success' }), run(1, { MCP: 'failure' }, { pr: 3855 })])
  assert.equal(r.healthy, false)
  assert.deepEqual(r.red.map((x) => x.job), ['MCP'])
})

test('2: a failed leaf job inside a CANCELLED run is reported (the #3855 shape)', () => {
  const r = evaluate([
    run(0, { MCP: 'success', Backend: 'success' }),
    run(1, { MCP: 'failure', Backend: 'cancelled' }, { conclusion: 'cancelled', pr: 3855 }),
  ])
  assert.deepEqual(r.red.map((x) => x.job), ['MCP'])
})

test('3: a fully superseded run (leaves cancelled, aggregator failure) reports nothing (run 38025222136)', () => {
  const superseded = run(1, { MCP: 'cancelled', Backend: 'cancelled' }, { conclusion: 'cancelled' })
  assert.equal(superseded.jobs.find((j) => j.name === AGG).conclusion, 'failure') // the trap is real in the fixture
  const r = evaluate([run(0, { MCP: 'success', Backend: 'success' }), superseded])
  assert.equal(r.healthy, true)
  assert.ok(DERIVED_JOBS.has(AGG))
})

test('4: a later run where the job is SKIPPED keeps it red', () => {
  const r = evaluate([run(0, { MCP: 'success' }), run(1, { MCP: 'failure' }), run(2, { MCP: 'skipped' })])
  assert.deepEqual(r.red.map((x) => x.job), ['MCP'])
})

test('5: a later run where the job succeeds clears it', () => {
  const r = evaluate([run(0, { MCP: 'failure' }), run(1, { MCP: 'skipped' }), run(2, { MCP: 'success' })])
  assert.equal(r.healthy, true)
})

test('6: a successful RE-RUN attempt of the failed run clears it', () => {
  // Same run, attempt 2: created_at unchanged, started after the next push's run.
  const rerun = run(1, { MCP: 'success' }, { attemptStartedAt: new Date(Date.UTC(2026, 9, 10, 9, 5)).toISOString() })
  rerun.run_attempt = 2
  const r = evaluate([run(0, { MCP: 'success' }), run(2, { MCP: 'failure' }), rerun])
  assert.equal(r.healthy, true)
})

test('7: a red job absent from a later completed run is dropped, not held open forever', () => {
  const later = run(2, { Renamed: 'success' })
  const r = evaluate([run(0, { MCP: 'success' }), run(1, { MCP: 'failure' }), later])
  assert.equal(r.healthy, true)
  assert.deepEqual(r.dropped.map((d) => [d.job, d.goneIn.id]), [['MCP', later.id]])
})

test('7b: absence in a CANCELLED run, or a run with no jobs, proves nothing', () => {
  const noJobs = { ...run(3, {}), jobs: [] }
  const r = evaluate([
    run(0, { MCP: 'success' }),
    run(1, { MCP: 'failure' }),
    run(2, { Other: 'cancelled' }, { conclusion: 'cancelled' }),
    noJobs,
  ])
  assert.deepEqual(r.red.map((x) => x.job), ['MCP'])
  assert.deepEqual(r.dropped, [])
})

test('8: out-of-order input gives the same result as ordered input', () => {
  const runs = [run(0, { MCP: 'success' }), run(1, { MCP: 'failure' }), run(2, { MCP: 'success' }), run(3, { MCP: 'failure' })]
  const ordered = evaluate(runs)
  const shuffled = evaluate([...runs].reverse())
  assert.deepEqual(shuffled.red.map((x) => [x.job, x.firstFailure.id]), ordered.red.map((x) => [x.job, x.firstFailure.id]))
  assert.equal(ordered.red[0].firstFailure.id, runs[3].id)
})

test('9: a range with a skipped run in between names every suspect and blames no single PR', () => {
  const pass = run(0, { MCP: 'success' }, { pr: 3870 })
  const skipped = run(1, { MCP: 'skipped' }, { pr: 3873 })
  const broke = run(2, { MCP: 'failure' }, { pr: 3855 })
  const inherited = run(3, { MCP: 'failure' }, { pr: 3875 })
  const r = evaluate([pass, skipped, broke, inherited])
  const red = r.red[0]
  assert.deepEqual(red.suspects.map((s) => s.id), [skipped.id, broke.id])
  assert.equal(red.firstFailure.id, broke.id) // never the inheriting #3875
  assert.equal(red.latestFailure.id, inherited.id)
  const body = renderIssueBody(r)
  assert.match(body, /Introduced by one of/)
  assert.match(body, /#3873/)
  assert.match(body, /#3855/)
  assert.doesNotMatch(body, /\*\*Introduced by:\*\*/)
})

test('9b: a single-commit range blames that commit\'s PR', () => {
  const r = evaluate([run(0, { MCP: 'success' }), run(1, { MCP: 'failure' }, { pr: 3855 })])
  assert.match(renderIssueBody(r), /\*\*Introduced by:\*\* `[^`]+` \(#3855\)/)
})

test('a red job with no success in the window is open-ended and blames no PR', () => {
  const r = evaluate([run(0, { MCP: 'failure' }, { pr: 3855 })])
  assert.equal(r.red[0].openEnded, true)
  const body = renderIssueBody(r)
  assert.match(body, /may be older/)
  assert.doesNotMatch(body, /\*\*Introduced by:\*\*/)
})

test('prOf reads the LAST (#NNNN) of the subject line only', () => {
  assert.equal(prOf({ head_commit: { message: 'fix: x (#3886) (#3887)\n\nsee (#1)' } }), 3887)
  assert.equal(prOf({ head_commit: { message: 'Merge branch dev\n\n(#5)' } }), null)
})

test('failureAnnotations keeps failure-level notes and drops the generic exit-code line', () => {
  const kept = failureAnnotations([
    { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    { annotation_level: 'warning', message: 'Node.js 20 is deprecated.' },
    { annotation_level: 'failure', message: 'AssertionError: The hosted tool contract changed.' },
  ])
  assert.deepEqual(kept.map((a) => a.message), ['AssertionError: The hosted tool contract changed.'])
})

test('the summary names each red job', () => {
  const r = evaluate([run(0, { MCP: 'success' }), run(1, { MCP: 'failure' }, { pr: 3855 })])
  assert.match(renderSummary(r, 2), /❌ 1 push-to-dev CI job\(s\) red[\s\S]*✗ MCP/)
})

// `workflow_run` matches the watched workflow by NAME. Renaming ci.yml's
// `name:` would silently stop the watcher — the repo's first workflow_run.
test('the watcher subscribes to ci.yml by its exact name, for completed dev runs', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  assert.equal(ci.match(/^name:\s*(.+)$/m)?.[1].trim(), WATCHED_WORKFLOW)
  const wf = readFileSync(path.join(ROOT, '.github/workflows/dev-push-health.yml'), 'utf8')
  assert.match(wf, new RegExp(`workflows:\\s*\\[\\s*${WATCHED_WORKFLOW}\\s*\\]`))
  assert.match(wf, /types:\s*\[\s*completed\s*\]/)
  assert.match(wf, /branches:\s*\[\s*dev\s*\]/)
  assert.match(wf, /github\.event\.workflow_run\.event == 'push'/)
  assert.match(wf, /cancel-in-progress:\s*false/)
  assert.match(wf, /node scripts\/ci\/dev-push-health\.mjs/)
  // Never builds or runs the triggering commit's code.
  assert.doesNotMatch(wf, /head_sha|workflow_run\.head_branch|ref:/)
})

test('the aggregator named in DERIVED_JOBS still exists in ci.yml, and is still if: always()', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  for (const name of DERIVED_JOBS) {
    const at = ci.indexOf(`name: ${name}`)
    assert.ok(at > -1, `${name} missing from ci.yml`)
    assert.match(ci.slice(at, at + 600), /if: always\(\)/)
  }
})

test('the ci-health label description matches guard-freshness verbatim (both run label create --force)', () => {
  const gf = readFileSync(path.join(ROOT, 'scripts/ci/guard-freshness.mjs'), 'utf8')
  assert.ok(gf.includes(`'${CI_HEALTH_LABEL_DESCRIPTION}'`))
  assert.ok(!gf.includes(ISSUE_TITLE), 'the two issue titles must differ')
})
