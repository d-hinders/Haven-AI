// Tests for qa-retry.mjs (#3338): the in-step retry reports itself.
// Run with: node --test scripts/ci/qa-retry.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { failingLines, scrub, retrySummary, passedOnAttempt, tally, byAttempt, summaryFromFiles, daysFrom, countRuns } from './qa-retry.mjs'

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

test('failingLines also reads the run-report row, so a live line split by stderr still names its leg (once)', () => {
  const split = [
    '• delegation-lifecycle … [signer] warning on stderr',
    'FAIL — activate failed (502)',
    '| delegation-lifecycle | a budget activates | **FAIL** | activate failed (502) |',
    '| within-budget-settle | settles | pass | settled |',
  ].join('\n')
  assert.deepEqual(failingLines(split), [{ leg: 'delegation-lifecycle', detail: 'activate failed (502)' }])
  // Both forms present: listed once.
  assert.equal(failingLines(`${ATTEMPT_1}\n| delegation-lifecycle | x | **FAIL** | activate failed |`).filter((f) => f.leg === 'delegation-lifecycle').length, 1)
})

test('scrub removes every URL — a provider URL carries its key in the path', () => {
  const out = scrub(`x https://lb.drpc.live/base-sepolia/${FAKE_KEY} y "https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY}" z`)
  assert.doesNotMatch(out, new RegExp(FAKE_KEY))
  assert.equal((out.match(/<url>/g) ?? []).length, 2)
  assert.ok(scrub('a'.repeat(1000)).length <= 240)
})

test('scrub covers every URL form and a bare key, and leaves leg names and tx hashes readable', () => {
  for (const leak of [
    `wss://base-sepolia.g.alchemy.com/v2/${FAKE_KEY}`,
    `ws://node/${FAKE_KEY}`,
    `lb.drpc.live/base-sepolia/${FAKE_KEY}`,
    `base-sepolia.infura.io/v3/${FAKE_KEY}`,
    `https:\\/\\/lb.drpc.live\\/base\\/${FAKE_KEY}`,
    `https%3A%2F%2Flb.drpc.live%2Fbase%2F${FAKE_KEY}`,
    `apiKey: ${FAKE_KEY}`,
    'key 0123456789abcdef0123456789abcdef',
  ]) assert.doesNotMatch(scrub(`err (${leak}) end`), /AbCdEf|0123456789abcdef/, leak)
  // Each URL layer holds on its own: a lower-case key the long-token backstop
  // would let through is still removed with the URL around it.
  const lowKey = 'abcdefghijklmnopqrstuvwx'
  for (const url of [`lb.drpc.live/base-sepolia/${lowKey}`, `wss://node/${lowKey}`, `https%3a%2f%2fnode%2f${lowKey}`]) {
    assert.doesNotMatch(scrub(`err ${url} end`), new RegExp(lowKey), url)
  }
  assert.equal(scrub(lowKey), lowKey) // the backstop alone keeps it: the URL rules above did the work
  const hash = `0x${'ab'.repeat(32)}`
  assert.equal(scrub(`x402-delegation-3009-sweep failed, tx ${hash}`), `x402-delegation-3009-sweep failed, tx ${hash}`)
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

test('byAttempt orders the globbed logs numerically, not lexically — and the CLI path uses it', () => {
  assert.deepEqual(
    byAttempt(['qa-run.attempt-10.log', 'qa-run.attempt-2.log', 'qa-run.attempt-1.log']),
    ['qa-run.attempt-1.log', 'qa-run.attempt-2.log', 'qa-run.attempt-10.log'],
  )
  const files = Array.from({ length: 10 }, (_, i) => `qa-run.attempt-${i + 1}.log`).sort() // the shell glob's order
  const md = summaryFromFiles(10, files, (f) => `• leg${/(\d+)\.log$/.exec(f)[1]} … FAIL — boom`)
  for (let i = 1; i <= 9; i++) assert.match(md, new RegExp(`\\*\\*Attempt ${i}:\\*\\* \\n  - \`leg${i}\``))
  // An unreadable log degrades to the "no failure line" row instead of throwing.
  assert.match(summaryFromFiles(2, ['qa-run.attempt-1.log'], () => { throw new Error('ENOENT') }), /no failure line found/)
})

test('countRuns queries one UTC day at a time and refuses a day the API cap truncated', () => {
  assert.deepEqual(daysFrom('2026-09-29', '2026-10-01'), ['2026-09-29', '2026-09-30', '2026-10-01'])
  const calls = []
  const fakeGh = (total, ids) => (args) => {
    calls.push(args.join(' '))
    if (args[1] === '-X') return JSON.stringify({ total, ids })
    if (args[1].endsWith('/jobs')) return JSON.stringify([{ id: 9, name: 'money-flow', conclusion: 'success' }])
    return 'money-flow QA passed on attempt 2/2'
  }
  const t = countRuns('2026-09-25', { gh: fakeGh(1, [7]), repo: 'o/r', until: '2026-09-26' })
  assert.deepEqual([t.passes, t.retried], [2, 2])
  assert.ok(calls.some((c) => c.includes('created=2026-09-25')) && calls.some((c) => c.includes('created=2026-09-26')))
  assert.ok(!calls.some((c) => c.includes('created=>=')))
  assert.throws(() => countRuns('2026-09-25', { gh: fakeGh(1500, [1, 2]), repo: 'o/r', until: '2026-09-25' }), /fetched 2 of 1500/)
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
  assert.match(QA_DEV, /if \[ "\$i" -gt 1 \]; then[\s\S]*?node scripts\/ci\/qa-retry\.mjs summary "\$i" qa-run\.attempt-\*\.log >> "\$GITHUB_STEP_SUMMARY" \|\| true/)
  assert.match(QA_DEV, /::notice title=money-flow retry::/)
  assert.match(QA_DEV, /attempts="\$\{QA_MAX_ATTEMPTS:-2\}"/)
  assert.match(QA_DEV, /if \[ "\$i" -lt "\$attempts" \]; then sleep 30; fi/)
  assert.match(QA_DEV, /echo "::error::money-flow QA failed after \$attempts attempt\(s\)"/)
})
