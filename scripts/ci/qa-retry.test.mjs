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
  // CRLF logs parse the same, and an indented run-level ✗ line still counts.
  assert.deepEqual(failingLines('• a … FAIL — boom\r\n'), [{ leg: 'a', detail: 'boom' }])
  assert.deepEqual(failingLines('  ✗ 1/14 scenario(s) failed'), [{ leg: null, detail: '1/14 scenario(s) failed' }])
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

test('scrub covers every URL form and key-labelled values, each rule on its own', () => {
  for (const leak of [
    `wss://base-sepolia.g.alchemy.com/v2/${FAKE_KEY}`,
    `ws://node/${FAKE_KEY}`, // scheme rule only: no TLD, so the scheme-less rule cannot help
    `lb.drpc.live/base-sepolia/${FAKE_KEY}`, // scheme-less rule only
    `base-sepolia.infura.io/v3/${FAKE_KEY}`,
    `https:\\/\\/node\\/v2\\/${FAKE_KEY}`, // JSON-escaped, no TLD: that alternative only
    `https%3a%2f%2fnode%2f${FAKE_KEY}`, // percent-encoded, no TLD: that alternative only
    `apiKey: ${FAKE_KEY}`,
    `"api_key":"${FAKE_KEY}"`,
    `token=${FAKE_KEY}`,
    `DRPC_API_KEY=${FAKE_KEY}`, // label after an underscore
    `private_key=${FAKE_KEY}`, // snake_case: the bare `key` label, after the underscore
    `privateKey: ${FAKE_KEY}`,
    `accessToken: ${FAKE_KEY}`, // camelCase: only the access[_-]?token alternative reaches this
    `secret: ${FAKE_KEY}`,
    `Authorization: Bearer ${FAKE_KEY}`,
  ]) assert.doesNotMatch(scrub(`err (${leak}) end`), /AbCdEf/, leak)
})

test('scrub leaves identifiers readable — they are the diagnosis', () => {
  const hash = `0x${'ab'.repeat(32)}`
  for (const readable of [
    `x402-delegation-3009-sweep failed, tx ${hash}`,
    'execution reverted: ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
    'QA_DELEGATION_DELEGATE_PRIVATE_KEY not set',
    'x402-erc7710-over-budget-rejected: x402_retry_rejected_after_funding',
    'mcp__haven-signer__haven_sign_x402 refused (ERC20InsufficientBalance)',
    'payment 3f2b8c1e-9a4d-4e6f-8b7a-2c1d0e9f8a7b stuck',
    'Unsupported token: USDT', // a short labelled word is not a key
    'secret: not set',
  ]) assert.equal(scrub(readable), readable)
})

test('scrub bounds its input: a pathological line returns fast and capped', () => {
  const t0 = Date.now()
  const out = scrub('a-b.'.repeat(10000)) // 40k chars: ~15 s unbounded (round-3 review), a few ms bounded
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
  assert.ok(out.length <= 240)
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
  // Only the attempts BEFORE the passing one are listed.
  assert.doesNotMatch(md, /\*\*Attempt 2:\*\*/)
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

test('countRuns skips a gate-skipped run (the common case) without reading its logs', () => {
  const logCalls = []
  // The shape the jobs API returns for a gate-skipped deployment_status run (2026-09-25).
  const skipped = [{ id: 1, name: 'gate', conclusion: 'success' }, { id: 2, name: 'money-flow', conclusion: 'skipped' }]
  const ran = [{ id: 3, name: 'gate', conclusion: 'success' }, { id: 4, name: 'money-flow', conclusion: 'success' }]
  const gh = (args) => {
    if (args[1] === '-X') return JSON.stringify({ total: 2, ids: [10, 20] })
    if (args[1].endsWith('/jobs')) return JSON.stringify(args[1].includes('/runs/10/') ? skipped : ran)
    logCalls.push(args[1])
    return 'money-flow QA passed on attempt 1/2'
  }
  const t = countRuns('2026-09-25', { gh, repo: 'o/r', until: '2026-09-25' })
  assert.deepEqual([t.passes, t.firstAttempt, t.unknown], [1, 1, 0])
  assert.deepEqual(logCalls, ['repos/o/r/actions/jobs/4/logs'])
})

test('qa-dev.yml: the money-flow job has no display name, so the API reports it as `money-flow`', () => {
  const job = /^  money-flow:\n([\s\S]*?)\n    steps:/m.exec(QA_DEV)
  assert.ok(job, 'money-flow job block not found')
  assert.doesNotMatch(job[1], /^    name:/m)
})

test('countRuns pages through a real-sized day (215 runs = 100 + 100 + 15)', () => {
  const pages = []
  const gh = (args) => {
    if (args[1] === '-X') {
      const page = Number(args[args.indexOf('-F', args.indexOf('per_page=100')) + 1].split('=')[1])
      pages.push(page)
      const n = [100, 100, 15][page - 1] ?? 0
      return JSON.stringify({ total: 215, ids: Array.from({ length: n }, (_, k) => page * 1000 + k) })
    }
    if (args[1].endsWith('/jobs')) return JSON.stringify([{ id: 9, name: 'money-flow', conclusion: 'success' }])
    return 'money-flow QA passed on attempt 1/2'
  }
  const t = countRuns('2026-09-25', { gh, repo: 'o/r', until: '2026-09-25' })
  assert.deepEqual(pages, [1, 2, 3])
  assert.deepEqual([t.passes, t.firstAttempt], [215, 215])
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
