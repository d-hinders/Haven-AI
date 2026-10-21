// Drives `scripts/ci/qa-failure-issue.mjs` through its real CLI entry point with
// a recording `gh` stub on PATH, and asserts which `gh` subcommands were REACHED
// in each of the three states the upsert distinguishes (#2767). A source grep for
// `issue create` would pass with the call inside a dead branch; this does not.
//
// Run with: node --test scripts/ci/qa-failure-issue.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ISSUE_TITLE, LABEL, CLASSES, MENTION_CLASSES, buildBody, buildComment, classifyLog, closeStandingIssue, computeWindow, md, mentionable, notDevReason, readFinalAttempt, readQaWindow, triggerLine, upsertStandingIssue, windowLine } from './qa-failure-issue.mjs'
import { BOT_AUTHOR } from './standing-issue-upsert.mjs'

const SCRIPT = fileURLToPath(new URL('./qa-failure-issue.mjs', import.meta.url))

/**
 * Answers the window reads (#4236) from `scn.window`. Self-contained (no
 * closure): its source is also written into the CLI stub, so the CLI and the
 * in-process tests answer from one responder. Keys are the `gh` path, so a
 * test names the call it fails or hangs by a substring of it.
 */
function respondWindow(args, scn) {
  const w = (scn && scn.window) || {}
  const key = args[0] === 'run' ? 'run list' : String(args[1])
  if ((w.fail || []).some((k) => key.includes(k))) return { fail: `HTTP 502 for ${key}` }
  if ((w.hang || []).some((k) => key.includes(k))) return { hang: true }
  if (args[0] === 'run' && args[1] === 'list') return { out: JSON.stringify(w.rows || []) }
  let m = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)\?per_page=1$/.exec(key)
  if (m) return { out: `${(w.ancestry || {})[m[1]] || 'ahead'}\n` }
  m = /\/actions\/runs\/(\d+)\/jobs$/.exec(key)
  if (m) return { out: JSON.stringify({ jobs: (w.jobs || {})[m[1]] || [] }) }
  m = /\/compare\/([0-9a-f]+\.\.\.[0-9a-f]+)$/.exec(key)
  if (m) return { out: JSON.stringify((w.compare || {})[m[1]] || { status: 'diverged', commits: [] }) }
  m = /\/commits\/([0-9a-f]+)$/.exec(key)
  if (m) return { out: JSON.stringify({ files: (w.files || {})[m[1]] || [] }) }
  return { fail: `no stub for ${key}` }
}

/**
 * A `gh` stub. Every invocation appends its argv (one JSON line) to $GH_LOG and
 * answers from the scenario in $GH_SCENARIO:
 *   - `issue list ... --state open`   → [{number: OPEN}]   or []
 *   - `issue list ... --state closed` → [{number: CLOSED}] or []
 *   - everything else                 → a plausible one-line success
 */
function makeStub(dir) {
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n')
const scenario = JSON.parse(process.env.GH_SCENARIO || '{}')
if (args[0] === 'issue' && args[1] === 'list' && args.includes('--author')) {
  // The --green lookup (#4069): answers scenario.green verbatim, or fails.
  if (scenario.listFails) { process.stderr.write('HTTP 502\\n'); process.exit(1) }
  process.stdout.write(typeof scenario.green === 'string' ? scenario.green : JSON.stringify(scenario.green ?? []))
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'list') {
  const state = args[args.indexOf('--state') + 1]
  const n = state === 'open' ? scenario.open : scenario.closed
  process.stdout.write(JSON.stringify(n ? [{ number: n }] : []))
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'create') {
  process.stdout.write('https://github.com/d-hinders/Haven-AI/issues/999\\n')
  process.exit(0)
}
if (args[0] === 'run' || args[0] === 'api') {
  // The window reads (#4236), answered by the same responder the in-process tests use.
  const r = (${respondWindow.toString()})(args, scenario)
  if (r.hang) { setTimeout(() => process.exit(0), 25000); return }
  if (r.fail) { process.stderr.write(r.fail + '\\n'); process.exit(1) }
  process.stdout.write(r.out)
  process.exit(0)
}
process.exit(0)
`,
  )
  chmodSync(stub, 0o755)
  return stub
}

/** process.env without the Actions vars `triggerLine`/`runUrlFromEnv` read, so CI runs stay hermetic. */
function baseEnv() {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('GITHUB_') || k.startsWith('DEPLOYMENT_')) delete e[k]
  return e
}

function run(scenario, env = {}, logs = [], extraArgs = null) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-failure-issue-'))
  makeStub(dir)
  const log = join(dir, 'gh.log')
  const files = logs.map((text, i) => {
    const f = join(dir, `qa-run.attempt-${i + 1}.log`)
    writeFileSync(f, text)
    return f
  })
  const argv = extraArgs ?? [...files, join(dir, 'qa-run.attempt-*.log')]
  const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    // A hung window read must not hang the suite: past this the run is killed
    // and its status is null, which every test reads as a failure.
    timeout: 20_000,
    env: {
      ...baseEnv(),
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: log,
      GH_SCENARIO: JSON.stringify(scenario),
      TRIGGER: 'workflow_dispatch — started by tester',
      RUN_URL: 'https://github.com/d-hinders/Haven-AI/actions/runs/1',
      WHEN: '2026-09-08 12:00 UTC',
      ...env,
    },
  })
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  return { result, calls }
}

const sub = (calls, a, b) => calls.filter((c) => c[0] === a && c[1] === b)

describe('qa-failure-issue: one standing issue', () => {
  test('an open qa-failure issue is UPDATED (edit + comment), never duplicated', () => {
    const { result, calls } = run({ open: 12 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'create').length, 0, 'must not create a second issue')
    assert.equal(sub(calls, 'issue', 'reopen').length, 0)
    const edits = sub(calls, 'issue', 'edit')
    assert.equal(edits.length, 1)
    assert.equal(edits[0][2], '12')
    assert.match(edits[0][edits[0].indexOf('--body') + 1], /## Latest failure/)
    const comments = sub(calls, 'issue', 'comment')
    assert.equal(comments.length, 1)
    assert.equal(comments[0][2], '12')
    assert.match(result.stdout, /"action":"updated","number":12/)
  })

  test('a second failure on a later day updates the SAME issue — still no create', () => {
    // The state after day 1: the standing issue is open. Day 2 fails again.
    const { result, calls } = run({ open: 12 }, { WHEN: '2026-09-09 03:20 UTC' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'create').length, 0)
    assert.equal(sub(calls, 'issue', 'edit')[0][2], '12')
    const comment = sub(calls, 'issue', 'comment')[0]
    assert.match(comment[comment.indexOf('--body') + 1], /2026-09-09 03:20 UTC/)
  })

  test('a standing issue closed on green is REOPENED, not replaced', () => {
    const { result, calls } = run({ open: null, closed: 7 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'create').length, 0, 'must reopen, not create')
    const reopen = sub(calls, 'issue', 'reopen')
    assert.equal(reopen.length, 1)
    assert.equal(reopen[0][2], '7')
    assert.equal(sub(calls, 'issue', 'edit')[0][2], '7')
    assert.equal(sub(calls, 'issue', 'comment')[0][2], '7')
    // The closed lookup is title-bound so an unrelated closed qa-failure from the
    // date-titled era is not what gets reopened.
    const closedList = sub(calls, 'issue', 'list').find((c) => c.includes('closed'))
    assert.ok(closedList.some((a) => a.includes(`in:title "${ISSUE_TITLE}"`)))
    assert.match(result.stdout, /"action":"reopened","number":7/)
  })

  test('no issue at all → created ONCE under the fixed, date-free title', () => {
    const { result, calls } = run({ open: null, closed: null })
    assert.equal(result.status, 0, result.stderr)
    const creates = sub(calls, 'issue', 'create')
    assert.equal(creates.length, 1)
    const title = creates[0][creates[0].indexOf('--title') + 1]
    assert.equal(title, ISSUE_TITLE)
    assert.doesNotMatch(title, /\d{4}-\d{2}-\d{2}/, 'the standing title carries no date')
    assert.ok(creates[0].includes(LABEL))
    assert.equal(sub(calls, 'issue', 'edit').length, 0)
    assert.match(result.stdout, /"action":"created"/)
  })

  test('the label is ensured before any lookup, and its failure is tolerated', () => {
    const { calls } = run({ open: 12 })
    assert.deepEqual(calls[0].slice(0, 3), ['label', 'create', LABEL])
    // In-process: a throwing label step does not stop the upsert.
    const seen = []
    const gh = (args) => {
      seen.push(args)
      if (args[0] === 'label') throw new Error('already exists')
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 3 }])
      return ''
    }
    const out = upsertStandingIssue({ gh, trigger: 't', runUrl: 'u', when: 'w', log: () => {} })
    assert.deepEqual(out, { action: 'updated', number: 3 })
    assert.ok(seen.some((a) => a[0] === 'issue' && a[1] === 'edit'))
  })

  test('missing TRIGGER / RUN_URL refuses with exit 2 and touches gh not at all', () => {
    const { result, calls } = run({ open: 12 }, { TRIGGER: '', RUN_URL: '' })
    assert.equal(result.status, 2)
    assert.equal(calls.length, 0)
  })

  // Characterization (#4236), written before the window existed: outside
  // Actions (no GITHUB_RUN_ID) the comment is byte-for-byte what it was, the
  // body carries no window line, and the only gh calls are the upsert's own.
  test('characterization: without GITHUB_RUN_ID the comment is unchanged and no lookup beyond the upsert runs', () => {
    const { result, calls } = run({ open: 12 })
    assert.equal(result.status, 0, result.stderr)
    const comment = sub(calls, 'issue', 'comment')[0]
    assert.equal(
      comment[comment.indexOf('--body') + 1],
      '`qa-dev` failure at 2026-09-08 12:00 UTC (trigger: `workflow_dispatch — started by tester`), class `unclassified` — https://github.com/d-hinders/Haven-AI/actions/runs/1',
    )
    const edit = sub(calls, 'issue', 'edit')[0]
    assert.doesNotMatch(edit[edit.indexOf('--body') + 1], /window/i)
    assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['label create', 'issue list', 'issue edit', 'issue comment'])
  })

  test('body names the run, the trigger and the standing-issue contract', () => {
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W' })
    assert.match(body, /\*\*Trigger:\*\* `T`/)
    assert.match(body, /\*\*Run:\*\* U/)
    assert.match(body, /\*\*When:\*\* W/)
    assert.match(body, /one standing/)
  })
})

// ── Close on green (#4069) ───────────────────────────────────────────────────
const standing = (number, over = {}) => ({ number, title: ISSUE_TITLE, author: { login: BOT_AUTHOR }, state: 'OPEN', ...over })
const writes = (calls) => calls.filter((c) => !(c[0] === 'issue' && c[1] === 'list'))

describe('qa-failure-issue: --green closes the standing issue (#4069)', () => {
  test('an open standing issue is closed as completed, with one comment naming the run and trigger', () => {
    const { result, calls } = run({ green: [standing(2769)] }, {}, [], ['--green'])
    assert.equal(result.status, 0, result.stderr)
    const list = sub(calls, 'issue', 'list')
    assert.equal(list.length, 1)
    for (const [flag, value] of [['--label', LABEL], ['--state', 'open'], ['--author', BOT_AUTHOR]]) {
      assert.equal(list[0][list[0].indexOf(flag) + 1], value, flag)
    }
    const closes = sub(calls, 'issue', 'close')
    assert.equal(closes.length, 1)
    assert.equal(closes[0][2], '2769')
    assert.equal(closes[0][closes[0].indexOf('--reason') + 1], 'completed')
    const comment = closes[0][closes[0].indexOf('--comment') + 1]
    assert.match(comment, /https:\/\/github\.com\/d-hinders\/Haven-AI\/actions\/runs\/1/)
    assert.match(comment, /workflow_dispatch — started by tester/)
    assert.match(comment, /closed on green; the next failure reopens it/i)
    // The close is the only write: no edit, no reopen, no create, no label, no separate comment.
    assert.deepEqual(writes(calls).map((c) => c.slice(0, 2).join(' ')), ['issue close'])
    assert.match(result.stdout, /"action":"closed","numbers":\[2769\]/)
  })

  test('none open → no writes at all', () => {
    const { result, calls } = run({ green: [] }, {}, [], ['--green'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(writes(calls), [])
    assert.match(result.stdout, /"action":"none"/)
  })

  test('a failed lookup exits non-zero before any write', () => {
    const { result, calls } = run({ listFails: true }, {}, [], ['--green'])
    assert.notEqual(result.status, 0)
    assert.equal(sub(calls, 'issue', 'list').length, 1, 'the lookup was reached')
    assert.deepEqual(writes(calls), [])
  })

  test('an unreadable lookup (not JSON, not an array) throws before any write', () => {
    for (const green of ['<html>rate limited</html>', '{"number":2769}']) {
      const { result, calls } = run({ green }, {}, [], ['--green'])
      assert.notEqual(result.status, 0, green)
      assert.deepEqual(writes(calls), [], green)
    }
  })

  test('a closed issue, a human issue with the label, or a different title is never touched', () => {
    const others = [
      standing(2769, { state: 'CLOSED' }),
      standing(4100, { author: { login: 'd-hinders' } }),
      standing(4101, { title: `${ISSUE_TITLE} (manual)` }),
    ]
    const { result, calls } = run({ green: others }, {}, [], ['--green'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(writes(calls), [])
    // In-process too: only the bot's exact-title open issue is closed.
    const seen = []
    const gh = (args) => {
      seen.push(args)
      return args[1] === 'list' ? JSON.stringify([...others, standing(2769)]) : ''
    }
    assert.deepEqual(closeStandingIssue({ gh, trigger: 't', runUrl: 'u', when: 'w', log: () => {} }), { action: 'closed', numbers: [2769] })
    assert.deepEqual(seen.filter((a) => a[1] === 'close').map((a) => a[2]), ['2769'])
  })

  test('the trigger line and run URL are derived from the Actions env when not set explicitly', () => {
    const env = {
      TRIGGER: '', RUN_URL: '',
      GITHUB_EVENT_NAME: 'deployment_status', GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'd-hinders/Haven-AI', GITHUB_RUN_ID: '42',
      DEPLOYMENT_ID: '7', DEPLOYMENT_SHA: 'abc123', DEPLOYMENT_ENV: 'Haven AI / dev', DEPLOYMENT_CREATOR: 'railway-app[bot]',
    }
    const { result, calls } = run({ green: [standing(2769)] }, env, [], ['--green'])
    assert.equal(result.status, 0, result.stderr)
    const close = sub(calls, 'issue', 'close')[0]
    const comment = close[close.indexOf('--comment') + 1]
    assert.match(comment, /deployment_status — Railway deployment 7 of abc123 to 'Haven AI \/ dev', created by railway-app\[bot\]/)
    assert.match(comment, /actions\/runs\/42/)
    assert.equal(triggerLine({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR: 'a' }), 'workflow_dispatch — started by a')
    assert.equal(triggerLine({ GITHUB_EVENT_NAME: 'schedule' }), 'schedule')
  })

  test('qa-dev.yml closes only on a full-coverage green of dev, after Coverage completeness, without reddening the job', () => {
    const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/qa-dev.yml', import.meta.url)), 'utf8')
    const coverage = wf.indexOf('- name: Coverage completeness')
    const green = wf.indexOf('- name: Close the standing qa-failure issue on green')
    assert.ok(coverage !== -1 && green > coverage, 'the green step runs after Coverage completeness')
    const step = wf.slice(green, wf.indexOf('- name:', green + 1))
    assert.match(step, /if: success\(\) && github\.event\.inputs\.haven_api_url == '' && \(github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/dev'\)/)
    // A failed close warns and leaves the job green; the job has no continue-on-error (#3368).
    assert.match(step, /node scripts\/ci\/qa-failure-issue\.mjs --green \\\n\s*\|\| echo "::warning::/)
    assert.doesNotMatch(step, /continue-on-error/)
  })
})

// ── Classification (#3337) ───────────────────────────────────────────────────
// Fixture lines are the harness's own shapes, taken from real money-flow job
// logs (2026-09-26); keys and hosts are fake.
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const PROVIDER_MULTILINE = [
  '• x402-delegation-3009 … FAIL — Delegation-rail funding authorization failed (on-chain policy or bundler): HTTP request failed.',
  '',
  'Status: 429',
  `URL: https://base-sepolia.example-rpc.io/v2/${KEY}`,
  'Request body: {"method":"eth_getCode","params":["0xf431C31511175AE80Cef45A228b7e0C24C2fbE20","latest"]}',
  '',
  'Details: Too Many Requests',
  '• x402-delegation-3009-grace-resume … PASS — resumed',
].join('\n')
// Real shape: every real instance carries the "(delegate held …)" clause.
const PROVIDER_JSON_URL = `• x402-delegation-3009-sweep … FAIL — gasless sweep submit failed (delegate held 0.0075 USDC before, 0.0075 after): Sweep relay failed: could not coalesce error (error={ "code": 1, "message": "no available upstreams to process a request" }, info={ "requestUrl": "https://lb.example.live/base-sepolia/${KEY}" })`
// A real dRPC free-plan line (run 36104825999's shape): the evidence starts ~400 characters in.
const PROVIDER_BATCH_REAL_LENGTH = `• x402-delegation-3009-sweep … FAIL — gasless sweep submit failed (delegate held 0.0005 USDC before, 0.0005 after): Sweep relay failed: server response 500 Internal Server Error (request={  }, response={  }, error=null, info={ "requestUrl": "https://lb.example.live/base-sepolia/${KEY}", "responseBody": "[{\\"id\\":16260,\\"jsonrpc\\":\\"2.0\\",\\"error\\":{\\"message\\":\\"Batch of more than 3 requests are not allowed on free plan, to use this feature register paid account at drpc.org\\",\\"code\\":31}}]" })`
const MASKED_502 = '• delegation-lifecycle … FAIL — activate failed (502): Could not deploy the account for this budget — try again'
const PREFLIGHT = [
  'preflight — resources this run consumes:',
  '  ✗ merchant settlement wallet (gas) 0xC03F7c03d20f3DC32d3b8dAD6EeA90a3be4822c1: 0.0000298 ETH (11 settlement(s))',
  '      below the merchant\'s fail floor (warn 25/fail 12)',
  '  ✓ delegation treasury (USDC) 0x9281d7c312e67859c65f4A3449F0548ea2f90974: 4.2215 USDC',
  '',
  '✗ preflight: a resource this run consumes is below its floor. Fix it before reading anything below — the legs cannot pass without it.',
].join('\n')
// The harness prints err.message, never the error's name (thrown-error-detail.ts).
const HARNESS = '• x402-catalog-guided-purchase … FAIL — api.getAgent is not a function'
const HAVEN_4XX = '• delegation-lifecycle … FAIL — throwaway signup failed (400): email already registered'
const MERCHANT_402 = '• x402-erc7710-hosted … FAIL — hosted haven_settle_mcp_tool refused: MERCHANT_REJECTED_AFTER_FUNDING — Merchant refused to deliver the tool (HTTP 402).'

describe('qa-failure-issue: failure classes (#3337)', () => {
  test('every provider signature classes a leg on its own', () => {
    for (const detail of [
      'authorize failed (502): could not coalesce error (error={ "code": -32016 })',
      'authorize failed (502): the node said: over rate limit',
      'authorize failed (502): Too Many Requests',
      'Sweep relay failed: {"message":"Request timeout on the free plan","code":30}',
      'Sweep relay failed: {"message":"please upgrade to paid plan","code":30}',
      // The real escaped shape of a relayed viem error (run 35435198631, attempt 1).
      'fresh-agent authorize failed (502): {"details":"HTTP request failed.\\n\\nStatus: 429\\nURL: https://base-sepolia.example-rpc.io/v2/x"}',
      // #2511's reference shape (run 33796886018), with RPC Request failed removed.
      'activate failed (502): {"details":"request failed.\\n\\nURL: https://sepolia.base.org\\nRequest body: {}"}',
      'settleX402Erc7710 failed: Could not deploy the delegate account — retry the authorize: RPC Request failed.',
      'Sweep relay failed: {"message":"Batch of more than 3 requests are not allowed on free plan"}',
      'Sweep relay failed: {"message":"No label `flashblocks`"}',
      'Sweep relay failed: {"message":"Request timeout on the free plan, please upgrade to paid plan","code":30}',
      'sweep failed: HTTP request failed. URL: https://sepolia.base.org Status: 503',
    ]) assert.equal(classifyLog(`• x402-delegation-3009-sweep … FAIL — ${detail}`).runClass, 'provider', detail)
  })

  test('a leg block stops at the next leg: a provider signature under leg b never classes leg a', () => {
    const r = classifyLog([MASKED_502, PROVIDER_MULTILINE].join('\n'))
    assert.deepEqual(r.legs.map((l) => [l.leg, l.class]), [['delegation-lifecycle', 'unclassified'], ['x402-delegation-3009', 'provider']])
  })

  test('precedence: provider wins over haven and over harness in the same leg', () => {
    assert.equal(classifyLog('• a … FAIL — signup failed (400): upstream said Status: 429').legs[0].class, 'provider')
    assert.equal(classifyLog('• a … FAIL — client.x is not a function after no available upstreams').legs[0].class, 'provider')
  })

  test('each harness message shape classes a leg on its own', () => {
    for (const detail of ['api.getAgent is not a function', 'fetchQuote is not defined', 'Cannot read properties of undefined (reading \'id\')', 'Cannot set properties of null (setting \'x\')']) {
      assert.equal(classifyLog(`• a … FAIL — ${detail}`).runClass, 'harness', detail)
    }
  })

  test('a leg block also stops at the run summary and at report-table rows', () => {
    // Run 35435198631: the report row `| x402-erc7710-fresh-agent | … |` carries Status: 429.
    const withRow = [MASKED_502, '', '| delegation-lifecycle | activates | **FAIL** | Status: 429 |'].join('\n')
    assert.equal(classifyLog(withRow).legs[0].class, 'unclassified')
    const withSummary = [MASKED_502, '✗ 1/14 scenario(s) failed', 'Status: 429'].join('\n')
    assert.equal(classifyLog(withSummary).legs[0].class, 'unclassified')
  })

  test('CRLF logs classify the same', () => {
    assert.deepEqual(classifyLog(PROVIDER_MULTILINE.replace(/\n/g, '\r\n')).legs.map((l) => l.class), ['provider'])
  })

  test('scrub happens BEFORE the cut: a label and its value are never separated into a bare secret', () => {
    const SECRET = 'FAKEFAKEFAKEFAKEFAKE0123456789'
    for (const labelled of [`Authorization: Bearer ${SECRET}`, `password = ${SECRET}`, `"apiKey": "${SECRET}"`]) {
      // The label sits just outside the 80-character look-back; the value just inside it.
      const line = `• leg … FAIL — relay failed ${'w'.repeat(200)} ${labelled} ${'x'.repeat(66)} over rate limit`
      const [leg] = classifyLog(line).legs
      assert.equal(leg.class, 'provider')
      for (let i = 0; i + 8 <= SECRET.length; i++) assert.ok(!leg.signature.includes(SECRET.slice(i, i + 8)), `${labelled}: ${SECRET.slice(i, i + 8)}`)
    }
  })

  test('a secret split by the scrub window\'s own edge never reaches the excerpt, even after URLs shrink', () => {
    const SECRET = 'FAKEFAKEFAKEFAKEFAKE0123456789'
    for (const label of ['Authorization: Bearer', 'password =', '"apiKey":']) {
      // URLs fill exactly the 1000 characters between the secret and the match, so
      // the window's front edge (match − 1000) lands on the secret's first character
      // — and they scrub down to a few `<url>`s, pulling the secret into the excerpt.
      const head = `• leg … FAIL — relay failed ${'w'.repeat(300)} ${label} `
      const fill = 1000 - SECRET.length - 2 // the space after the secret, and before the match
      const urls = []
      let used = 0
      while (fill - used > 120) {
        urls.push(`https://h${urls.length}.example.io/${'p'.repeat(80)}`)
        used += urls.at(-1).length + 1
      }
      urls.push(`https://last.example.io/${'q'.repeat(fill - used - 'https://last.example.io/'.length)}`)
      const line = `${head}${SECRET} ${urls.join(' ')} over rate limit`
      assert.equal(line.indexOf('over rate limit') - 1000, line.indexOf(SECRET), 'geometry: the edge must land on the secret')
      const [leg] = classifyLog(line).legs
      assert.equal(leg.class, 'provider')
      for (let i = 0; i + 8 <= SECRET.length; i++) assert.ok(!leg.signature.includes(SECRET.slice(i, i + 8)), `${label}: ${SECRET.slice(i, i + 8)}`)
    }
  })

  test('the back edge too: a value the window cuts short (too short to look like a key) never shows', () => {
    const SECRET = 'FAKEFAKEFAKEFAKEFAKE0123456789'
    for (const label of ['Authorization: Bearer', 'password =', '"apiKey":']) {
      const head = `• leg … FAIL — relay failed over rate limit `
      const at = head.indexOf('over rate limit')
      // URLs fill the gap so the back edge (match + 1000) lands 10 characters into the secret.
      const fill = at + 1000 - 10 - head.length - label.length - 2 // total length of the joined URLs
      const urls = []
      let used = 0
      while (fill - used > 120) {
        urls.push(`https://h${urls.length}.example.io/${'p'.repeat(80)}`)
        used += urls.at(-1).length + 1
      }
      urls.push(`https://last.example.io/${'q'.repeat(fill - used - 'https://last.example.io/'.length)}`)
      const line = `${head}${urls.join(' ')} ${label} ${SECRET} tail`
      assert.equal(at + 1000, line.indexOf(SECRET) + 10, 'geometry: the edge must cut the secret')
      const [leg] = classifyLog(line).legs
      for (let i = 0; i + 8 <= SECRET.length; i++) assert.ok(!leg.signature.includes(SECRET.slice(i, i + 8)), `${label}: ${SECRET.slice(i, i + 8)}`)
    }
  })

  // Round 3: a single geometry proved nothing. Sweep the window's edge across
  // EVERY character of each label/value shape, on both paths.
  const V = 'SEKRETVALUE0123456789abcdef'
  const SHAPES = [
    `password=${V}`, `password = ${V}`, `zz password = ${V}`, `Authorization: Bearer ${V}`,
    `Authorization : Bearer ${V}`, `x y Bearer ${V}`, `"password" : "${V}"`, `zz "password" : "${V}"`,
    `zz yy "apiKey": "${V}"`,
  ]
  const leaks = (sig) => { for (let i = 0; i + 8 <= V.length; i++) if (sig.includes(V.slice(i, i + 8))) return V.slice(i, i + 8); return null }

  test('excerpt: no cut position of the window\'s front edge uncovers a secret (every shape, every offset)', () => {
    for (const shape of SHAPES) {
      for (let c = 0; c <= shape.length; c++) {
        // The window starts c characters into the shape; ~1000 characters of URL collapse to <url>.
        const line = `• leg … FAIL — ${'f'.repeat(1500)} ${shape} https://example.com/${'a'.repeat(978 + c - shape.length)} no available upstreams tail`
        const [leg] = classifyLog(line).legs
        assert.equal(leg.class, 'provider')
        assert.equal(leaks(leg.signature), null, `${shape} @${c}: ${leg.signature}`)
      }
    }
  })

  test('the edge trim never drops the match itself: a match inside the window\'s first token keeps its evidence', () => {
    const [leg] = classifyLog(`• leg … FAIL — ${'f'.repeat(1500)}no available upstreams tail`).legs
    assert.equal(leg.class, 'provider')
    assert.match(leg.signature, /no available upstreams/)
  })

  test('whole-line paths: no cut position of the length bound uncovers a secret (every shape, every offset)', () => {
    for (const shape of SHAPES) {
      for (let c = 0; c <= shape.length; c++) {
        // The 2000-character bound falls c characters into the shape (an unclassified leg).
        const prefix = '• leg … FAIL — Could not deploy https://example.com/'
        const line = `${prefix}${'u'.repeat(2000 - c - prefix.length - 1)} ${shape} tail`
        assert.equal(2000 - line.indexOf(shape), c, 'geometry')
        const [leg] = classifyLog(line).legs
        assert.equal(leg.class, 'unclassified')
        assert.equal(leaks(leg.signature), null, `${shape} @${c}: ${leg.signature}`)
      }
    }
    // Round 3's P2 reproduction: a value just past scrub()'s old 1024-character slice.
    const p2 = classifyLog(`• leg … FAIL — Could not deploy https://example.com/${'u'.repeat(950)} password=${V}\n| s`)
    assert.equal(leaks(p2.legs[0].signature), null, p2.legs[0].signature)
  })

  test('markup is escaped everywhere a signature lands, and only classified legs are named in earlier attempts', () => {
    assert.equal(md('a & <b>'), 'a &amp; &lt;b&gt;')
    const logs = { 'qa-run.attempt-1.log': [PROVIDER_JSON_URL, MASKED_502].join('\n'), 'qa-run.attempt-2.log': MASKED_502 }
    const r = readFinalAttempt(Object.keys(logs), (f) => logs[f])
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification: r })
    const line = body.split('\n').find((l) => l.startsWith('Earlier attempt 1'))
    assert.match(line, /`x402-delegation-3009-sweep` provider/)
    assert.doesNotMatch(line, /`delegation-lifecycle`/) // unclassified legs are not named
    assert.doesNotMatch(line, /[^`]<(url|redacted)>/)
    // A single-class earlier attempt carries its leg's signature, markup escaped.
    const single = { 'qa-run.attempt-1.log': PROVIDER_JSON_URL, 'qa-run.attempt-2.log': MASKED_502 }
    const r1 = readFinalAttempt(Object.keys(single), (f) => single[f])
    const line1 = buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification: r1 }).split('\n').find((l) => l.startsWith('Earlier attempt 1'))
    assert.match(line1, /&lt;url&gt;/)
  })

  test('an excerpt marks both cut ends with an ellipsis and keeps the leg prefix', () => {
    const [leg] = classifyLog(`${PROVIDER_BATCH_REAL_LENGTH} and then ${'z '.repeat(200)}`).legs
    assert.match(leg.signature, /^• x402-delegation-3009-sweep … FAIL — … /)
    assert.match(leg.signature, / …$/)
    assert.ok(leg.signature.length <= 320)
  })

  test('the crash, run-line and continuation-prefix paths are scrubbed too (round 4 review)', () => {
    const K = 'FAKEKEYFAKEKEYFAKEKEY0123'
    const crash = classifyLog(`✗ harness crashed: fetch https://lb.example.live/base-sepolia/${K} is not a function`)
    assert.doesNotMatch(crash.signature, new RegExp(K))
    const runLine = classifyLog(`• a … PASS — ok\n✗ strict: skipped leg via https://lb.example.live/${K}`)
    assert.doesNotMatch(runLine.signature, new RegExp(K))
    const cont = classifyLog(`• a … FAIL — relay https://lb.example.live/${K} failed\nStatus: 429`)
    assert.equal(cont.legs[0].class, 'provider')
    assert.doesNotMatch(cont.legs[0].signature, new RegExp(K))
  })

  test('the body escapes signature markup so <url> stays visible in the rendered issue', () => {
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification: classifyLog(PROVIDER_JSON_URL) })
    assert.match(body, /&lt;url&gt;/)
    assert.doesNotMatch(body, /[^`]<url>/)
  })

  test('haven is the leg\'s own call only: a "failed (4xx)" after a relayed refusal is not Haven\'s', () => {
    assert.equal(classifyLog('• x402-erc7710-hosted … FAIL — hosted tool refused (MERCHANT_REJECTED): the merchant call failed (402)').runClass, 'unclassified')
  })

  test('harness: a relayed body quoting "TypeError" is not a harness error; a harness crash is run-level', () => {
    assert.equal(classifyLog('• x … FAIL — fresh-agent authorize failed (500): {"details":"TypeError: fetch failed"}').runClass, 'unclassified')
    const crash = classifyLog('\n✗ harness crashed: Cannot read properties of undefined (reading \'id\')')
    assert.equal(crash.runClass, 'harness')
    assert.deepEqual(crash.legs, [])
  })

  test('the unclassified and preflight paths are scrubbed too (they are most real runs)', () => {
    const unclassified = classifyLog(`• x402-erc7710-fresh-agent … FAIL — authorize failed (502): {"details":"server response 500", "requestUrl": "https://lb.example.live/base-sepolia/${KEY}"}`)
    assert.equal(unclassified.runClass, 'unclassified')
    assert.doesNotMatch(unclassified.legs[0].signature, new RegExp(KEY))
    const preflight = classifyLog(`  ✗ observer RPC https://lb.example.live/base-sepolia/${KEY} unreachable\n\n✗ preflight: a resource this run consumes is below its floor.`)
    assert.equal(preflight.runClass, 'preflight')
    assert.doesNotMatch(preflight.signature, new RegExp(KEY))
  })

  test('a continuation-line hit keeps its step; a pipe cannot break the table; an issue number does not link', () => {
    const [leg] = classifyLog(PROVIDER_MULTILINE).legs
    assert.match(leg.signature, /^• x402-delegation-3009 … FAIL — Delegation-rail.* → Status: 429/)
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification: classifyLog('• a … FAIL — expected a | b, see the #1310 fix') })
    assert.match(body, /expected a \\\| b/)
    assert.doesNotMatch(body, /(^|[^\u2060])#1310/)
  })

  test('a Coverage-completeness failure (no failing leg) carries the green-with-skips marker as its signature', () => {
    const r = classifyLog('• a … PASS — ok\n\n⚠ green-with-skips: 1 leg(s) skipped')
    assert.match(r.signature, /green-with-skips:/)
  })

  test('earlier attempts are reported with their run class, so a first-attempt provider leg is not lost', () => {
    const logs = { 'qa-run.attempt-1.log': PROVIDER_JSON_URL, 'qa-run.attempt-2.log': MASKED_502 }
    const r = readFinalAttempt(Object.keys(logs), (f) => logs[f])
    assert.equal(r.runClass, 'unclassified')
    assert.deepEqual(r.earlier.map((e) => [e.attempt, e.runClass]), [[1, 'provider']])
    assert.match(buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification: r }), /Earlier attempt 1: `provider`.*\(`x402-delegation-3009-sweep` provider\)/)
    // The comment is the thread's history: earlier attempts are recorded there too.
    assert.match(buildComment({ trigger: 'T', runUrl: 'U', when: 'W', classification: r }), /earlier: attempt 1 `provider`/)
  })

  test('a provider signature on a continuation line classes the leg (Status: 429 after "HTTP request failed.")', () => {
    const r = classifyLog(PROVIDER_MULTILINE)
    assert.equal(r.runClass, 'provider')
    assert.deepEqual(r.legs.map((l) => [l.leg, l.class]), [['x402-delegation-3009', 'provider']])
    assert.match(r.legs[0].signature, /Status: 429/)
  })

  test('each class has a fixture, and the masked backend 502 is unclassified — never guessed', () => {
    assert.equal(classifyLog(PROVIDER_JSON_URL).runClass, 'provider')
    assert.equal(classifyLog(HARNESS).runClass, 'harness')
    assert.equal(classifyLog(HAVEN_4XX).runClass, 'haven')
    assert.equal(classifyLog(MASKED_502).runClass, 'unclassified')
    // A merchant's 402 relayed through a hosted-tool refusal is not Haven's 4xx.
    assert.equal(classifyLog(MERCHANT_402).runClass, 'unclassified')
    assert.deepEqual(CLASSES, ['provider', 'preflight', 'harness', 'rate_limit', 'haven', 'unclassified'])
  })

  test('the signature shows the evidence even when it sits past character 200 of the line', () => {
    assert.ok(PROVIDER_BATCH_REAL_LENGTH.indexOf('Batch of more than') > 300, 'fixture must be real-length')
    const [leg] = classifyLog(PROVIDER_BATCH_REAL_LENGTH).legs
    assert.equal(leg.class, 'provider')
    assert.match(leg.signature, /Batch of more than 3 requests/)
    assert.match(leg.signature, /^• x402-delegation-3009-sweep … FAIL — /)
    assert.doesNotMatch(leg.signature, new RegExp(KEY))
  })

  test('an excerpt whose window starts inside a URL widens to the whole URL, so no key fragment survives', () => {
    // The match sits ~100 characters after the key starts, so a raw 80-character
    // look-back would start in the middle of the key.
    const line = `• x402-delegation-3009-sweep … FAIL — relay failed ${'x'.repeat(250)} requestUrl=https://lb.example.live/base-sepolia/${KEY} ${'y'.repeat(60)} "no available upstreams"`
    assert.ok(line.indexOf('no available') - 80 > line.indexOf(KEY) && line.indexOf('no available') - 80 < line.indexOf(KEY) + KEY.length, 'look-back must land inside the key')
    const [leg] = classifyLog(line).legs
    assert.match(leg.signature, /no available upstreams/)
    for (let i = 0; i + 8 <= KEY.length; i++) assert.ok(!leg.signature.includes(KEY.slice(i, i + 8)), `key fragment ${KEY.slice(i, i + 8)}`)
  })

  test('#2511: a 502 body quoting the public Base Sepolia endpoint is provider, and the URL is still scrubbed', () => {
    const log = '• x402-erc7710-fresh-agent … FAIL — fresh-agent authorize failed (502): {"error":"Could not deploy the delegate account","details":"HTTP request failed. URL: https://sepolia.base.org Status: 503"}'
    const r = classifyLog(log)
    assert.equal(r.runClass, 'provider')
    assert.doesNotMatch(r.legs[0].signature, /sepolia\.base\.org/)
  })

  test('a preflight refusal is run-level: no legs, and the failing resource is the signature', () => {
    const r = classifyLog(PREFLIGHT)
    assert.equal(r.runClass, 'preflight')
    assert.deepEqual(r.legs, [])
    assert.match(r.signature, /merchant settlement wallet \(gas\)/)
  })

  test('no failing leg: the run-level ✗ line is the signature (strict mode refusing skips)', () => {
    const r = classifyLog('• a … SKIP — no identity\n\n✗ QA_REQUIRE_ALL_LEGS=1: refusing to report green with unexercised legs')
    assert.equal(r.runClass, 'unclassified')
    assert.match(r.signature, /QA_REQUIRE_ALL_LEGS=1: refusing/)
  })

  test('legs that disagree make a mixed run with a count per class, so a provider leg stays visible', () => {
    const r = classifyLog([PROVIDER_JSON_URL, MASKED_502, MASKED_502.replace('delegation-lifecycle', 'x402-erc7710-fresh-agent')].join('\n'))
    assert.equal(r.runClass, 'mixed')
    assert.equal(r.signature, 'provider ×1, unclassified ×2')
  })

  test('no URL and no key reaches the body or the comment, including a JSON "requestUrl"', () => {
    for (const log of [PROVIDER_MULTILINE, PROVIDER_JSON_URL]) {
      const classification = classifyLog(log)
      const text = buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification }) + buildComment({ trigger: 'T', runUrl: 'U', when: 'W', classification })
      assert.doesNotMatch(text, new RegExp(KEY))
      assert.doesNotMatch(text, /example-rpc|example\.live/)
    }
  })

  test('the template "transient flake, re-dispatch" sentence is gone from the body', () => {
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W' })
    assert.doesNotMatch(body, /transient testnet\/RPC/i)
    assert.doesNotMatch(body, /cleared by re-dispatching/i)
    assert.match(body, /Classify the\s+failure/)
  })

  test('the final attempt is the one classified; an unreadable or missing log falls back, then to "no harness log"', () => {
    const logs = { 'qa-run.attempt-1.log': MASKED_502, 'qa-run.attempt-2.log': PROVIDER_JSON_URL }
    const read = (f) => {
      if (!(f in logs)) throw new Error('ENOENT')
      return logs[f]
    }
    assert.equal(readFinalAttempt(['qa-run.attempt-2.log', 'qa-run.attempt-1.log'], read).runClass, 'provider')
    assert.equal(readFinalAttempt(['qa-run.attempt-1.log', 'qa-run.attempt-*.log'], read).runClass, 'unclassified')
    assert.equal(readFinalAttempt(['qa-run.attempt-*.log'], read), null)
    assert.match(buildBody({ trigger: 'T', runUrl: 'U', when: 'W', classification: null }), /no harness log/)
  })

  test('CLI: the attempt logs passed as arguments reach the issue body and comment', () => {
    const { result, calls } = run({ open: 12 }, {}, [MASKED_502, PROVIDER_MULTILINE])
    assert.equal(result.status, 0, result.stderr)
    const edit = sub(calls, 'issue', 'edit')[0]
    const body = edit[edit.indexOf('--body') + 1]
    assert.match(body, /\*\*Run:\*\* `provider`/)
    assert.match(body, /\| `x402-delegation-3009` \| `provider` \|/)
    assert.doesNotMatch(body, new RegExp(KEY))
    const comment = sub(calls, 'issue', 'comment')[0]
    assert.match(comment[comment.indexOf('--body') + 1], /class `provider`/)
  })

  test('qa-dev.yml passes the attempt logs to the failure step, in the money-flow job that wrote them', () => {
    const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/qa-dev.yml', import.meta.url)), 'utf8')
    assert.match(wf, /node scripts\/ci\/qa-failure-issue\.mjs qa-run\.attempt-\*\.log/)
    assert.match(wf, /tee "qa-run\.attempt-\$i\.log"/)
  })

  test('CLI: with no harness log (the run failed earlier) the issue is still filed, unclassified', () => {
    const { result, calls } = run({ open: 12 }, {}, [])
    assert.equal(result.status, 0, result.stderr)
    const edit = sub(calls, 'issue', 'edit')[0]
    assert.match(edit[edit.indexOf('--body') + 1], /`unclassified` — no harness log/)
  })
})

// #3541: Haven's own per-agent x402 hourly cap. The six phrasings are verbatim
// FAIL lines from run 36840685285 attempt 1, which #2769 recorded as
// "mixed — haven ×1, unclassified ×9".
describe('qa-failure-issue: rate_limit class (#3541)', () => {
  const CAP = 'Rate limit exceeded: max 100 x402 payments per hour'
  const PHRASINGS = {
    'authorize failed (429)': `• x402-erc7710-settle … FAIL — authorize failed (429): {"error":"${CAP}","retry_after_seconds":60}`,
    'SDK settleX402Erc7710': `• x402-erc7710-sdk … FAIL — settleX402Erc7710 failed: ${CAP}`,
    'hosted API_ERROR': `• x402-hosted-mcp-signer … FAIL — hosted haven_pay_mcp_tool refused: API_ERROR — haven_pay_mcp_tool failed (API_ERROR): ${CAP}`,
    'bare FAIL (3009 / sweep)': `• x402-delegation-3009-sweep … FAIL — ${CAP}`,
    '(HTTP 429: …) control leg': `• x402-over-budget-rejected … FAIL — control: a within-budget 3009 authorize was NOT offered as signable (HTTP 429: ${CAP}) — a refusal below would prove nothing`,
    '(HTTP 429): {…} grace-resume': `• x402-delegation-3009-grace-resume … FAIL — authorize did not return a delegation-rail funding payload (HTTP 429): {"error":"${CAP}","retry_after_seconds":60}`,
  }

  for (const [name, line] of Object.entries(PHRASINGS)) {
    test(`classes the ${name} phrasing as rate_limit`, () => {
      const r = classifyLog(line)
      assert.equal(r.runClass, 'rate_limit')
      assert.match(r.legs[0].signature, /Rate limit exceeded: max 100 x402 payments per hour/)
    })
  }

  test('the whole attempt is one rate_limit run, not "mixed — haven ×1, unclassified ×9"', () => {
    const r = classifyLog(Object.values(PHRASINGS).join('\n'))
    assert.equal(r.runClass, 'rate_limit')
    assert.equal(r.legs.length, 6)
  })

  test('takes precedence over haven: the "failed (429)" phrasing is not a product signal', () => {
    assert.equal(classifyLog(PHRASINGS['authorize failed (429)']).runClass, 'rate_limit')
  })

  test("Haven's other limiters are excluded, and where each lands is pinned", () => {
    // moneyPathRateLimit (60/min): @fastify/rate-limit throws
    // `Rate limit exceeded, retry in 1 minute` with statusCode 429, and Haven's
    // httpErrorHandler sends `{ error: message, statusCode }`. Through the
    // harness's own client that is a `failed (429)` → `haven`; through the
    // SDK the status is gone → `unclassified`. Never this class.
    const moneyPathClient = '• x402-erc7710-settle … FAIL — authorize failed (429): {"error":"Rate limit exceeded, retry in 1 minute","statusCode":429}'
    assert.equal(classifyLog(moneyPathClient).runClass, 'haven')
    const moneyPathSdk = '• x402-erc7710-sdk … FAIL — settleX402Erc7710 failed: Rate limit exceeded, retry in 1 minute'
    assert.equal(classifyLog(moneyPathSdk).runClass, 'unclassified')
    // RelayerBudgetExceededError: the authorize route's hybrid_deploy refusal
    // (delegation-authorize.ts, 429 `{ error: err.message }`) through the
    // client is `haven`; the sweep scenario's own wording carries no status,
    // so it is `unclassified`.
    const deploy = 'Relayer budget exceeded: more than 10 hybrid_deploy operations in 1440 minutes. This protects the shared gas sponsor — wait and retry, or contact Haven if this is organic volume.'
    const viaClient = `• x402-erc7710-settle … FAIL — authorize failed (429): {"error":"${deploy}"}`
    assert.equal(classifyLog(viaClient).runClass, 'haven')
    const sweep = 'Relayer budget exceeded: more than 30 sweep operations in 60 minutes. This protects the shared gas sponsor — wait and retry, or contact Haven if this is organic volume.'
    const viaSweep = `• x402-delegation-3009-sweep … FAIL — gasless sweep submit failed (delegate held 0.5 USDC before, 0.5 after): ${sweep}`
    assert.equal(classifyLog(viaSweep).runClass, 'unclassified')
  })

  test('the body names the class and its remedy', () => {
    const body = buildBody({ trigger: 'workflow_dispatch', runUrl: 'https://example.invalid/run', when: 'now', classification: classifyLog(PHRASINGS['bare FAIL (3009 / sweep)']) })
    assert.match(body, /`rate_limit`/)
    assert.match(body, /space out hand dispatches/)
  })
})

// ── The last-green → first-red window (#4236) ────────────────────────────────
// The fixture is the 2026-10-20 episode, read from the live API (run list,
// jobs, compare and commit files) at 2026-10-21: green run 39419894807 at
// 84f347f0a, red run 39421603625 at aa818795d, one PR between (#4144), 12 of
// its 14 files under packages/qa-agent/. The rows keep the decoys that episode
// really had: gate-only `in_progress` runs at both SHAs, a 6 s gate-skipped
// success, and a red run created AFTER the failing one.
const GREEN_SHA = '84f347f0a15004dd385510886a1fbfd262558461'
const RED_SHA = 'aa818795df264505e455a1224bbdddadcf97d8b0'
const OLDER_SHA = '70cee1d51f6a68e9372fb34495c4bfbcd066d03d'
const LATER_SHA = 'bde4d598e43415337bf8520bdd3319d3c9c21726'
const RED_ID = 39421603625
const GREEN_ID = 39419894807
const deployRow = (id, sha, createdAt, updatedAt, conclusion, state = 'success', status = 'completed') => ({
  databaseId: id, headSha: sha, event: 'deployment_status', headBranch: 'dev', status, conclusion,
  createdAt, startedAt: createdAt, updatedAt,
  displayTitle: `post-deploy ${sha} → Haven AI / dev (${state})`,
})
const FIXTURE_ROWS = [
  deployRow(39423256338, LATER_SHA, '2026-10-20T12:34:03Z', '2026-10-20T12:45:32Z', 'failure'),
  deployRow(RED_ID, RED_SHA, '2026-10-20T12:21:15Z', '2026-10-20T12:31:22Z', '', 'success', 'in_progress'),
  deployRow(39421375894, GREEN_SHA, '2026-10-20T12:19:26Z', '2026-10-20T12:19:32Z', 'success', 'in_progress'),
  deployRow(39421285101, RED_SHA, '2026-10-20T12:18:40Z', '2026-10-20T12:18:46Z', 'success', 'in_progress'),
  deployRow(GREEN_ID, GREEN_SHA, '2026-10-20T12:07:26Z', '2026-10-20T12:12:39Z', 'success'),
  deployRow(39419560133, OLDER_SHA, '2026-10-20T12:04:44Z', '2026-10-20T12:04:50Z', 'success'),
  deployRow(39418972077, OLDER_SHA, '2026-10-20T12:00:05Z', '2026-10-20T12:08:26Z', 'success'),
]
const FILES_4144 = [
  'docs/architecture/04-x402-payment-sequence.md', 'docs/operations/agent-qa.md',
  'packages/qa-agent/src/lib/haven-api.ts', 'packages/qa-agent/src/lib/hosted-mcp.ts',
  'packages/qa-agent/src/lib/settlement-record.test.ts', 'packages/qa-agent/src/lib/settlement-record.ts',
  'packages/qa-agent/src/scenarios/x402-catalog-guided-purchase.test.ts', 'packages/qa-agent/src/scenarios/x402-catalog-guided-purchase.ts',
  'packages/qa-agent/src/scenarios/x402-delegation-3009-grace-resume.test.ts', 'packages/qa-agent/src/scenarios/x402-delegation-3009-grace-resume.ts',
  'packages/qa-agent/src/scenarios/x402-delegation-3009.test.ts', 'packages/qa-agent/src/scenarios/x402-delegation-3009.ts',
  'packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.test.ts', 'packages/qa-agent/src/scenarios/x402-hosted-mcp-signer.ts',
]
const commit = (sha, parents, message, login = 'AntonioSaaranen', type = 'User') => ({ sha, parents, login, type, name: login, message })
const MF = (conclusion) => [{ name: 'gate', conclusion: 'success' }, { name: 'money-flow', conclusion }]
const fixture = (over = {}) => ({
  rows: FIXTURE_ROWS,
  jobs: { [GREEN_ID]: MF('success'), 39418972077: MF('success') },
  compare: {
    [`${GREEN_SHA}...${RED_SHA}`]: {
      status: 'ahead', total_commits: 1,
      commits: [commit(RED_SHA, [GREEN_SHA], 'test(qa-agent): EIP-3009 legs assert Haven recorded the merchant settlement (#4144)\n\nbody (#4119)')],
    },
  },
  files: { [RED_SHA]: FILES_4144 },
  ...over,
})
const FIXTURE_LINE = 'window: last green `84f347f0a` (run 39419894807) → first red `aa818795d` (run 39421603625): 1 PR — #4144 by AntonioSaaranen (touches no money-path file; touches the harness)'
const FIXTURE_MENTION = FIXTURE_LINE.replace('by AntonioSaaranen', 'by @AntonioSaaranen')
const ACTIONS_ENV = {
  GITHUB_RUN_ID: String(RED_ID), GITHUB_REPOSITORY: 'd-hinders/Haven-AI', GITHUB_EVENT_NAME: 'deployment_status',
  GITHUB_SHA: RED_SHA, GITHUB_REF: 'refs/heads/dev',
}

/** In-process `gh` for the window: the shared responder, recording every call. */
function fakeGh(window, calls = []) {
  const gh = (args) => {
    calls.push(args)
    const r = respondWindow(args, { window })
    if (r.fail || r.hang) throw Object.assign(new Error(r.fail ?? 'hang'), { stderr: r.fail ?? '' })
    return r.out
  }
  return gh
}
const current = (over = {}) => ({ id: RED_ID, sha: RED_SHA, event: 'deployment_status', ...over })
const windowOf = (window, opts = {}) => computeWindow({ gh: fakeGh(window, opts.calls), repo: 'd-hinders/Haven-AI', current: current(opts.current), ...opts.budget })
const lastParagraph = (call) => call[call.indexOf('--body') + 1].split('\n\n').at(-1)
const bodyOf = (call) => call[call.indexOf('--body') + 1]
const bodyWindow = (call) => bodyOf(call).split('\n').find((l) => l.startsWith('- **Window:**'))

describe('qa-failure-issue: the last-green → first-red window (#4236)', () => {
  test('CLI, reopen: the fixture names #4144, its author and what it touches — mentioned once, in the reopen comment', () => {
    const { result, calls } = run({ open: null, closed: 2769, window: fixture() }, ACTIONS_ENV, [MASKED_502])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'reopen').length, 1)
    assert.equal(lastParagraph(sub(calls, 'issue', 'comment')[0]), FIXTURE_MENTION)
    // The body carries the same window, with no `@`: the body is rewritten on every failure.
    assert.equal(bodyWindow(sub(calls, 'issue', 'edit')[0]), `- **Window:** ${FIXTURE_LINE.replace(/^window: /, '')}`)
    // preFilterHarnessCandidates runs before any jobs read: the gate-only
    // `in_progress` decoys and the 6 s gate-skipped success are never read.
    assert.deepEqual(calls.filter((c) => /\/runs\/(39421375894|39421285101|39419560133)\/jobs/.test(c[1] ?? '')), [])
    assert.equal(calls.filter((c) => /\/jobs$/.test(c[1] ?? '')).length, 1, 'one jobs read: the green')
    // The window is read after the label is ensured and before the issue lookups.
    assert.deepEqual(calls[0].slice(0, 3), ['label', 'create', LABEL])
    assert.ok(calls.findIndex((c) => c[0] === 'run') < calls.findIndex((c) => c[0] === 'issue'))
  })

  test('CLI, a later failure while the issue is open: the window is recomputed and the author named without @', () => {
    const { result, calls } = run({ open: 2769, window: fixture() }, ACTIONS_ENV, [MASKED_502])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'run', 'list').length, 1, 'recomputed from the API, not read back from the body')
    assert.equal(lastParagraph(sub(calls, 'issue', 'comment')[0]), FIXTURE_LINE)
    assert.doesNotMatch(bodyOf(sub(calls, 'issue', 'edit')[0]), /@AntonioSaaranen/)
  })

  test('CLI, create: the mention is in the body of the new issue', () => {
    const { result, calls } = run({ open: null, closed: null, window: fixture() }, ACTIONS_ENV, [MASKED_502])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(bodyWindow(sub(calls, 'issue', 'create')[0]), `- **Window:** ${FIXTURE_MENTION.replace(/^window: /, '')}`)
  })

  test('CLI: a gh call that exits non-zero yields "window: unavailable", and the reopen and comment still happen', () => {
    const { result, calls } = run({ open: null, closed: 2769, window: fixture({ fail: ['/jobs'] }) }, ACTIONS_ENV, [MASKED_502])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'reopen').length, 1)
    assert.equal(
      lastParagraph(sub(calls, 'issue', 'comment')[0]),
      'window: unavailable (`gh api repos/d-hinders/Haven-AI/actions/runs/39419894807/jobs` failed: HTTP 502 for repos/d-hinders/Haven-AI/actions/runs/39419894807/jobs)',
    )
  })

  test('CLI: a gh call that hangs past its time bound yields "window: unavailable", and the reopen and comment still happen', () => {
    const t0 = Date.now()
    const { result, calls } = run(
      { open: null, closed: 2769, window: fixture({ hang: ['run list'] }) },
      { ...ACTIONS_ENV, QA_FAILURE_WINDOW_CALL_TIMEOUT_MS: '2000' },
      [MASKED_502],
    )
    assert.equal(result.status, 0, result.stderr)
    assert.ok(Date.now() - t0 < 15_000, 'bounded by the per-call timeout, not by the stub')
    assert.equal(sub(calls, 'issue', 'reopen').length, 1)
    assert.equal(lastParagraph(sub(calls, 'issue', 'comment')[0]), 'window: unavailable (`gh run list` timed out after 2 s)')
  })

  test('CLI: a failing run that is not dev\'s reads "window: not a dev run" and makes no window call', () => {
    for (const [env, why] of [
      [{ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feat/x' }, "workflow_dispatch from 'refs/heads/feat/x'"],
      [{ GITHUB_EVENT_NAME: 'workflow_dispatch', QA_HAVEN_API_URL_OVERRIDE: 'https://x.up.railway.app' }, 'dispatch with a haven_api_url override'],
      [{ GITHUB_EVENT_NAME: 'repository_dispatch' }, "event 'repository_dispatch'"],
    ]) {
      const { result, calls } = run({ open: null, closed: 2769, window: fixture() }, { ...ACTIONS_ENV, ...env }, [MASKED_502])
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(calls.filter((c) => c[0] === 'run' || c[0] === 'api'), [], why)
      assert.equal(lastParagraph(sub(calls, 'issue', 'comment')[0]), `window: not a dev run (${why}) — nothing computed, nobody mentioned`)
    }
  })

  test('no GITHUB_RUN_ID: no window and no window call (in-process too)', () => {
    let called = 0
    assert.equal(readQaWindow({ ...ACTIONS_ENV, GITHUB_RUN_ID: '' }, { gh: () => { called += 1; return '[]' } }), null)
    assert.equal(called, 0)
    assert.equal(notDevReason({ GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/dev' }), null)
  })

  test('a run whose money-flow job was skipped (run-level success) is not the last green', () => {
    const SKIP = 39420000001
    const rows = [...FIXTURE_ROWS, { ...deployRow(SKIP, RED_SHA, '2026-10-20T12:15:00Z', '2026-10-20T12:17:00Z', 'success') }]
    const w = windowOf(fixture({ rows, jobs: { [GREEN_ID]: MF('success'), [SKIP]: MF('skipped') } }))
    assert.equal(w.status, 'ok')
    assert.deepEqual([w.lastGreen.id, w.firstRed.id], [GREEN_ID, RED_ID])
  })

  test('a run created after the failing one is never read (a re-run attempt keeps its old created_at)', () => {
    // A green at the failing commit, created after it: as last green it would
    // make the window empty (compare `identical`), so it must not be a candidate.
    const AFTER = 39430000000
    const rows = [deployRow(AFTER, RED_SHA, '2026-10-20T13:00:00Z', '2026-10-20T13:06:00Z', 'success'), ...FIXTURE_ROWS]
    const calls = []
    const w = windowOf(fixture({ rows, jobs: { [GREEN_ID]: MF('success'), [AFTER]: MF('success') } }), { calls })
    assert.equal(windowLine(w), FIXTURE_LINE)
    assert.deepEqual(calls.filter((c) => String(c[1]).includes(`/runs/${AFTER}/`)), [])
  })

  test('a run-level success with no money-flow job is not the last green', () => {
    const NOJOB = 39420000002
    const rows = [...FIXTURE_ROWS, deployRow(NOJOB, RED_SHA, '2026-10-20T12:15:00Z', '2026-10-20T12:17:00Z', 'success')]
    const w = windowOf(fixture({ rows, jobs: { [GREEN_ID]: MF('success'), [NOJOB]: [{ name: 'gate', conclusion: 'success' }] } }))
    assert.deepEqual([w.lastGreen.id, w.firstRed.id], [GREEN_ID, RED_ID])
  })

  test('a green feature-branch dispatch between a dev green and a dev red is skipped', () => {
    const FEAT = 39420000003
    const feat = { ...deployRow(FEAT, RED_SHA, '2026-10-20T12:15:00Z', '2026-10-20T12:20:00Z', 'success'), event: 'workflow_dispatch', headBranch: 'feat/x', displayTitle: 'QA — money-flow (dev)' }
    const w = windowOf(fixture({ rows: [...FIXTURE_ROWS, feat], jobs: { [GREEN_ID]: MF('success'), [FEAT]: MF('success') } }))
    assert.deepEqual([w.lastGreen.id, w.firstRed.id], [GREEN_ID, RED_ID])
  })

  test('a green at a commit outside the failing commit\'s history is skipped', () => {
    const OFF = 39420000004
    const OFF_SHA = 'ffffffffffffffffffffffffffffffffffffffff'
    const rows = [...FIXTURE_ROWS, deployRow(OFF, OFF_SHA, '2026-10-20T12:15:00Z', '2026-10-20T12:20:00Z', 'success')]
    const w = windowOf(fixture({ rows, jobs: { [GREEN_ID]: MF('success'), [OFF]: MF('success') }, ancestry: { [OFF_SHA]: 'diverged' } }))
    assert.deepEqual([w.lastGreen.id, w.firstRed.id], [GREEN_ID, RED_ID])
  })

  test('a later red in the same episode names the same window: first red is the oldest dev red after the green', () => {
    // Replayed from run 39423256338 (bde4d598e, 12:34): by then RED_ID had completed red.
    const rows = FIXTURE_ROWS.map((r) => (r.databaseId === RED_ID ? { ...r, status: 'completed', conclusion: 'failure' } : r))
    const w = windowOf(fixture({ rows, jobs: { [GREEN_ID]: MF('success'), [RED_ID]: MF('failure') } }), { current: { id: 39423256338, sha: LATER_SHA } })
    assert.equal(windowLine(w), FIXTURE_LINE)
  })

  test('the PRs are the first-parent chain: a merged branch\'s own commits are not listed; several PRs mention nobody', () => {
    const A = 'a'.repeat(40), SIDE = 'b'.repeat(40), M = 'c'.repeat(40)
    const compare = {
      status: 'ahead', total_commits: 4,
      commits: [
        commit(A, [GREEN_SHA], 'feat(backend): one (#5001)', 'alice'),
        commit(SIDE, [GREEN_SHA], 'wip on a branch', 'bob'),
        commit(M, [A, SIDE], 'Merge pull request #5002 from x/y', 'bob'),
        commit(RED_SHA, [M], 'test(qa-agent): three (#5003)', 'carol'),
      ],
    }
    const files = { [A]: ['packages/backend/src/routes/payments.ts'], [M]: ['packages/frontend/src/app/page.tsx'], [RED_SHA]: ['packages/qa-agent/src/run.ts'] }
    const w = windowOf(fixture({ compare: { [`${GREEN_SHA}...${RED_SHA}`]: compare }, files }))
    assert.equal(
      windowLine(w, { mention: true }),
      'window: last green `84f347f0a` (run 39419894807) → first red `aa818795d` (run 39421603625): 3 PRs — ' +
        '#5001 by alice (touches 1 money-path file: `packages/backend/src/routes/payments.ts`; does not touch the harness); ' +
        '`ccccccccc` (no PR in subject) by bob (touches no money-path file; does not touch the harness); ' +
        '#5003 by carol (touches no money-path file; touches the harness)',
    )
    assert.equal(mentionable(w, 'unclassified'), false)
  })

  test('a compare status other than ahead, or a chain that leaves the compare page, is unavailable', () => {
    const key = `${GREEN_SHA}...${RED_SHA}`
    const diverged = windowOf(fixture({ compare: { [key]: { status: 'diverged', total_commits: 1, commits: [commit(RED_SHA, [GREEN_SHA], 'x (#1)')] } } }))
    assert.equal(windowLine(diverged), "window: unavailable (compare 84f347f0a...aa818795d is 'diverged', not 'ahead')")
    const cut = windowOf(fixture({ compare: { [key]: { status: 'ahead', total_commits: 400, commits: [commit(RED_SHA, ['d'.repeat(40)], 'x (#1)')] } } }))
    assert.equal(windowLine(cut), 'window: unavailable (the first-parent chain leaves the compare page (400 commits; the API lists at most 250))')
  })

  test('the mention is gated on the run class and on what the single PR touches (captain decision 2026-10-21)', () => {
    const w = windowOf(fixture())
    for (const cls of CLASSES) assert.equal(mentionable(w, cls), MENTION_CLASSES.has(cls), cls)
    assert.deepEqual([...MENTION_CLASSES].sort(), ['harness', 'haven', 'unclassified'])
    const frontend = windowOf(fixture({ files: { [RED_SHA]: ['packages/frontend/src/app/page.tsx'] } }))
    assert.equal(mentionable(frontend, 'unclassified'), false, 'a one-PR window touching only the frontend')
    const money = windowOf(fixture({ files: { [RED_SHA]: ['packages/backend/src/routes/payments.ts'] } }))
    assert.equal(mentionable(money, 'haven'), true, 'a one-PR window touching a money-path file')
    const bot = windowOf(fixture({ compare: { [`${GREEN_SHA}...${RED_SHA}`]: { status: 'ahead', total_commits: 1, commits: [commit(RED_SHA, [GREEN_SHA], 'chore: bump (#9)', 'dependabot[bot]', 'Bot')] } } }))
    assert.equal(mentionable(bot, 'unclassified'), false, 'a bot author')
    assert.equal(mentionable({ status: 'unavailable', reason: 'x' }, 'unclassified'), false)
  })

  test('in the upsert: a provider-class or frontend-only one-PR window reopens with no @', () => {
    const issueGh = (seen) => (args) => {
      seen.push(args)
      if (args[1] === 'list') return JSON.stringify(args.includes('closed') ? [{ number: 2769 }] : [])
      return ''
    }
    for (const [window, classification] of [
      [fixture(), classifyLog(PROVIDER_MULTILINE)],
      [fixture({ files: { [RED_SHA]: ['packages/frontend/src/app/page.tsx'] } }), classifyLog(MASKED_502)],
    ]) {
      const seen = []
      upsertStandingIssue({ gh: issueGh(seen), trigger: 't', runUrl: 'u', when: 'w', classification, readWindow: () => windowOf(window), log: () => {} })
      const comment = seen.find((a) => a[1] === 'comment')
      assert.match(lastParagraph(comment), /^window: last green .* by AntonioSaaranen \(/)
      assert.doesNotMatch(lastParagraph(comment), /@/)
    }
  })

  test('a readWindow that throws is one unavailable line; the comment still lands', () => {
    const seen = []
    const gh = (args) => (seen.push(args), args[1] === 'list' ? JSON.stringify([{ number: 3 }]) : '')
    upsertStandingIssue({ gh, trigger: 't', runUrl: 'u', when: 'w', readWindow: () => { throw new Error('boom') }, log: () => {} })
    assert.equal(lastParagraph(seen.find((a) => a[1] === 'comment')), 'window: unavailable (boom)')
  })

  test('the lookup budget: past it the window is open-ended (calls) and PR files are marked unread', () => {
    // Every row a long red: no green inside a 4-call budget.
    const reds = Array.from({ length: 6 }, (_, i) => deployRow(39400000000 + i, `${i}`.repeat(40), `2026-10-20T0${i}:00:00Z`, `2026-10-20T0${i}:05:00Z`, 'failure'))
    const jobs = Object.fromEntries(reds.map((r) => [r.databaseId, MF('failure')]))
    const w = windowOf({ rows: [...FIXTURE_ROWS.slice(0, 2), ...reds], jobs }, { budget: { calls: 4 } })
    assert.equal(
      windowLine(w),
      'window: open-ended — no admitted money-flow success within the lookup budget (4 calls); first red so far `555555555` (run 39400000005), so the break may be older',
    )
    // Time, not calls: a clock that jumps past the budget stops the walk the same way.
    let t = 0
    const slow = computeWindow({ gh: fakeGh(fixture()), repo: 'r', current: current(), now: () => (t += 50_000), ms: 120_000 })
    assert.equal(slow.status, 'open-ended')
    // Budget spent after the compare: the PR is listed, its files unread, nobody mentioned.
    const late = windowOf(fixture(), { budget: { calls: 4 } })
    assert.equal(late.prs[0].note, 'files not read: lookup budget spent')
    assert.match(windowLine(late), /#4144 by AntonioSaaranen \(files not read: lookup budget spent\)$/)
    assert.equal(mentionable(late, 'unclassified'), false)
  })

  test('endpoints: a deployment_status green is preferred at the same commit; a schedule endpoint is labelled', () => {
    const SCHED = 39420000005
    const sched = { ...deployRow(SCHED, GREEN_SHA, '2026-10-20T12:14:00Z', '2026-10-20T12:18:00Z', 'success'), event: 'schedule', displayTitle: 'QA — money-flow (dev)' }
    const w = windowOf(fixture({ rows: [...FIXTURE_ROWS, sched], jobs: { [GREEN_ID]: MF('success'), [SCHED]: MF('success') } }))
    assert.equal(w.lastGreen.id, GREEN_ID, 'the post-deploy run at the same SHA wins the tie')
    const onlySched = windowOf(fixture({ rows: [...FIXTURE_ROWS.filter((r) => r.databaseId !== GREEN_ID), sched], jobs: { [SCHED]: MF('success') } }), { current: { event: 'schedule' } })
    assert.equal(
      windowLine(onlySched),
      'window: last green `84f347f0a` (run 39420000005) (schedule; dev tip, deploy not verified) → first red `aa818795d` (run 39421603625) (schedule; dev tip, deploy not verified): 1 PR — #4144 by AntonioSaaranen (touches no money-path file; touches the harness)',
    )
  })

  test('qa-dev.yml: the money-flow job restates its grants with actions: read; the failure step passes the override through env', () => {
    const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/qa-dev.yml', import.meta.url)), 'utf8')
    const job = wf.slice(wf.indexOf('\n  money-flow:\n'))
    assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}deployments: read\n {6}actions: read\n/)
    assert.doesNotMatch(wf, /pull-requests:/)
    // The top-level block is unchanged, so the gate job gains nothing.
    assert.match(wf, /\npermissions:\n {2}contents: read\n {2}issues: write\n(?: {2}#[^\n]*\n)* {2}deployments: read\n\njobs:/)
    const step = wf.slice(wf.indexOf('- name: Update the standing qa-failure issue'))
    assert.match(step, /QA_HAVEN_API_URL_OVERRIDE: \$\{\{ github\.event\.inputs\.haven_api_url \}\}/)
  })
})
