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

import { ISSUE_TITLE, LABEL, CLASSES, buildBody, buildComment, classifyLog, md, readFinalAttempt, upsertStandingIssue } from './qa-failure-issue.mjs'

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
    assert.deepEqual(CLASSES, ['provider', 'preflight', 'harness', 'haven', 'unclassified'])
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
