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

import { ISSUE_TITLE, LABEL, CLASSES, buildBody, buildComment, classifyLog, readFinalAttempt, upsertStandingIssue } from './qa-failure-issue.mjs'

const SCRIPT = fileURLToPath(new URL('./qa-failure-issue.mjs', import.meta.url))

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
process.exit(0)
`,
  )
  chmodSync(stub, 0o755)
  return stub
}

function run(scenario, env = {}, logs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-failure-issue-'))
  makeStub(dir)
  const log = join(dir, 'gh.log')
  const files = logs.map((text, i) => {
    const f = join(dir, `qa-run.attempt-${i + 1}.log`)
    writeFileSync(f, text)
    return f
  })
  const result = spawnSync(process.execPath, [SCRIPT, ...files, join(dir, 'qa-run.attempt-*.log')], {
    encoding: 'utf8',
    env: {
      ...process.env,
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

  test('body names the run, the trigger and the standing-issue contract', () => {
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W' })
    assert.match(body, /\*\*Trigger:\*\* `T`/)
    assert.match(body, /\*\*Run:\*\* U/)
    assert.match(body, /\*\*When:\*\* W/)
    assert.match(body, /one standing/)
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
const PROVIDER_JSON_URL = `• x402-delegation-3009-sweep … FAIL — gasless sweep submit failed: Sweep relay failed: could not coalesce error (error={ "code": 1, "message": "no available upstreams to process a request" }, info={ "requestUrl": "https://lb.example.live/base-sepolia/${KEY}" })`
const MASKED_502 = '• delegation-lifecycle … FAIL — activate failed (502): Could not deploy the account for this budget — try again'
const PREFLIGHT = [
  'preflight — resources this run consumes:',
  '  ✗ merchant settlement wallet (gas) 0xC03F7c03d20f3DC32d3b8dAD6EeA90a3be4822c1: 0.0000298 ETH (11 settlement(s))',
  '      below the merchant\'s fail floor (warn 25/fail 12)',
  '  ✓ delegation treasury (USDC) 0x9281d7c312e67859c65f4A3449F0548ea2f90974: 4.2215 USDC',
  '',
  '✗ preflight: a resource this run consumes is below its floor. Fix it before reading anything below — the legs cannot pass without it.',
].join('\n')
const HARNESS = "• x402-catalog-guided-purchase … FAIL — TypeError: Cannot read properties of undefined (reading 'amount')"
const HAVEN_4XX = '• delegation-lifecycle … FAIL — throwaway signup failed (400): email already registered'
const MERCHANT_402 = '• x402-erc7710-hosted … FAIL — hosted haven_settle_mcp_tool refused: MERCHANT_REJECTED_AFTER_FUNDING — Merchant refused to deliver the tool (HTTP 402).'

describe('qa-failure-issue: failure classes (#3337)', () => {
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
    assert.deepEqual(CLASSES, ['provider', 'preflight', 'harness', 'haven', 'unclassified'])
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
