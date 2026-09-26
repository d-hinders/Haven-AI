// Tests for qa-retry.mjs (#3338): the in-step retry reports itself.
// Run with: node --test scripts/ci/qa-retry.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { failingLines, scrub, retrySummary, passedOnAttempt, tally, byAttempt } from './qa-retry.mjs'

const QA_DEV = readFileSync(fileURLToPath(new URL('../../.github/workflows/qa-dev.yml', import.meta.url)), 'utf8')

// The shape run.ts prints: `• <name> … <PASS|FAIL|SKIP> — <detail>`, then `✗` lines.
const FAKE_KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh'
const ATTEMPT_1 = [
  '• within-budget-settle … PASS — settled',
  `• x402-delegation-3009-sweep … FAIL — Sweep relay failed: could not coalesce error (error={ "code": 1 }, info={ "requestUrl": "https://lb.drpc.live/base-sepolia/${FAKE_KEY}" })`,
  '• delegation-lifecycle … FAIL — activate failed (502): Could not deploy the account for this budget — try again',
  '',
  '✗ 2/14 scenario(s) failed',
].join('\n')

test('failingLines reads the harness FAIL lines and the run-level ✗ line, nothing else', () => {
  const found = failingLines(ATTEMPT_1)
  assert.deepEqual(found.map((f) => f.leg), ['x402-delegation-3009-sweep', 'delegation-lifecycle', null])
  assert.match(found[2].detail, /2\/14 scenario\(s\) failed/)
  assert.deepEqual(failingLines('• a … PASS — ok\n• b … SKIP — no identity'), [])
})

test('scrub removes every URL — a provider URL carries its key in the path', () => {
  const out = scrub(`x https://lb.drpc.live/base-sepolia/${FAKE_KEY} y "https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY}" z`)
  assert.doesNotMatch(out, new RegExp(FAKE_KEY))
  assert.equal((out.match(/<url>/g) ?? []).length, 2)
  assert.ok(scrub('a'.repeat(1000)).length <= 240)
})

test('a first-attempt pass writes nothing; a later pass lists the earlier attempts\' failures, keys scrubbed', () => {
  assert.equal(retrySummary(1, [ATTEMPT_1]), '')
  const md = retrySummary(2, [ATTEMPT_1, '• x … PASS — ok'])
  assert.match(md, /passed on attempt 2/)
  assert.match(md, /\*\*Attempt 1:\*\*/)
  assert.match(md, /`x402-delegation-3009-sweep`/)
  assert.match(md, /`delegation-lifecycle`/)
  assert.doesNotMatch(md, new RegExp(FAKE_KEY))
  assert.doesNotMatch(md, /lb\.drpc\.live/)
  // An unreadable attempt log still says so rather than vanishing.
  assert.match(retrySummary(2, ['', '']), /no failure line found/)
})

test('byAttempt orders the globbed logs numerically, not lexically', () => {
  assert.deepEqual(
    byAttempt(['qa-run.attempt-10.log', 'qa-run.attempt-2.log', 'qa-run.attempt-1.log']),
    ['qa-run.attempt-1.log', 'qa-run.attempt-2.log', 'qa-run.attempt-10.log'],
  )
})

test('passedOnAttempt and tally read the job log marker the workflow already prints', () => {
  assert.equal(passedOnAttempt('...\nmoney-flow QA passed on attempt 2/2\n'), 2)
  assert.equal(passedOnAttempt('money-flow QA passed on attempt 1/2'), 1)
  assert.equal(passedOnAttempt('no marker'), null)
  const t = tally([{ runId: 1, attempt: 1 }, { runId: 2, attempt: 2 }, { runId: 3, attempt: null }])
  assert.deepEqual([t.passes, t.firstAttempt, t.retried, t.unknown, t.retriedRuns], [3, 1, 1, 1, [2]])
})

test('qa-dev.yml: each attempt tees its own log and qa-run.log is always the FINAL attempt\'s copy', () => {
  assert.match(QA_DEV, /tee "qa-run\.attempt-\$i\.log"/)
  // Copied on both the pass and the fail path, so whichever attempt ran last is what qa-run.log holds.
  assert.equal((QA_DEV.match(/cp "qa-run\.attempt-\$i\.log" qa-run\.log/g) ?? []).length, 2)
  // The blocking completeness step still judges qa-run.log.
  assert.match(QA_DEV, /grep -q "green-with-skips:" qa-run\.log/)
  // The pass marker the count command reads is unchanged.
  assert.match(QA_DEV, /echo "money-flow QA passed on attempt \$i\/\$attempts"/)
})

test('qa-dev.yml: a later-attempt pass reports itself; the retry behaviour itself is unchanged', () => {
  assert.match(QA_DEV, /if \[ "\$i" -gt 1 \]; then[\s\S]*?node scripts\/ci\/qa-retry\.mjs summary "\$i" qa-run\.attempt-\*\.log >> "\$GITHUB_STEP_SUMMARY"/)
  assert.match(QA_DEV, /::notice title=money-flow retry::/)
  assert.match(QA_DEV, /attempts="\$\{QA_MAX_ATTEMPTS:-2\}"/)
  assert.match(QA_DEV, /if \[ "\$i" -lt "\$attempts" \]; then sleep 30; fi/)
  assert.match(QA_DEV, /echo "::error::money-flow QA failed after \$attempts attempt\(s\)"/)
})
