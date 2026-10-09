// Drives `scripts/ci/qa-balance-issue.mjs` (#3631) through its real CLI entry
// point with a recording `gh` stub on PATH, and asserts which `gh` subcommands
// were REACHED — the qa-failure-issue.test.mjs pattern.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  bandChanges,
  buildBody,
  ISSUE_TITLE,
  LABEL,
  nextBands,
  readBands,
  selectStandingIssue,
  TOP_UP_ANCHOR,
  topUpSummary,
} from './qa-balance-issue.mjs'

const SCRIPT = fileURLToPath(new URL('./qa-balance-issue.mjs', import.meta.url))
const BOT = { login: 'app/github-actions' }
const HUMAN = { login: 'AntonioSaaranen' }
const TREASURY = '0x9281d7c312e67859c65f4A3449F0548ea2f90974'

/** A `gh` stub: logs argv (and stdin) as JSON lines; `issue list` answers $GH_ISSUES. */
function makeStub(dir) {
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
let input = ''
try { input = fs.readFileSync(0, 'utf8') } catch {}
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args, input }) + '\\n')
if (args[0] === 'issue' && args[1] === 'list') {
  if (process.env.GH_LIST_FAIL) { process.stderr.write('HTTP 502'); process.exit(1) }
  process.stdout.write(process.env.GH_ISSUES || '[]')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'create') {
  process.stdout.write('https://github.com/d-hinders/Haven-AI/issues/999\\n')
}
process.exit(0)
`,
  )
  chmodSync(stub, 0o755)
}

function row(key, band, extra = {}) {
  const meta = {
    treasury: { name: 'Delegation treasury', unit: 'USDC', token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', address: TREASURY },
    merchant: { name: 'Demo-merchant settlement wallet', unit: 'ETH', address: '0x' + 'cd'.repeat(20) },
    relayer: { name: 'Dev backend relayer (84532)', unit: 'ETH', address: '0x' + 'ab'.repeat(20) },
  }[key]
  return { key, band, balance: '0.5', basis: 'observed', burnPerDay: '0.1', runwayDays: 5, ...meta, ...extra }
}

const report = (rows, topUps) => ({ checkedAt: '2026-10-05T06:00:00.000Z', rows, history: [], configMissing: false, ...(topUps ? { topUps } : {}) })

function run({ rows, issues = [], listFail = false, topUps }) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-balance-issue-'))
  makeStub(dir)
  const log = join(dir, 'gh.log')
  const reportPath = join(dir, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report(rows, topUps)))
  const result = spawnSync(process.execPath, [SCRIPT, '--report', reportPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: log,
      GH_ISSUES: JSON.stringify(issues),
      ...(listFail ? { GH_LIST_FAIL: '1' } : {}),
      RUN_URL: 'https://github.com/d-hinders/Haven-AI/actions/runs/7',
      GITHUB_REPOSITORY: 'd-hinders/Haven-AI',
    },
  })
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  return { result, calls, verbs: calls.map((c) => c.args.slice(0, 2).join(' ')) }
}

const ok = ['treasury', 'merchant', 'relayer'].map((k) => row(k, 'ok', { runwayDays: 30 }))
const treasuryWarn = [row('treasury', 'warn'), row('merchant', 'ok'), row('relayer', 'ok')]
const standing = (state, bands = {}, number = 42) => ({
  number,
  title: ISSUE_TITLE,
  author: BOT,
  state,
  body: `x\n<!-- qa-balance-bands: ${JSON.stringify(bands)} -->\n`,
})

test('a treasury below 7 days opens the standing issue, naming address, balance, runway and the top-up link', () => {
  const { result, calls, verbs } = run({ rows: treasuryWarn })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(verbs, ['label create', 'issue list', 'issue create'])
  const create = calls.at(-1)
  assert.ok(create.args.includes(ISSUE_TITLE) && create.args.includes(LABEL))
  assert.match(create.input, new RegExp(TREASURY))
  assert.match(create.input, /\| 0\.5 USDC \|/)
  assert.match(create.input, /\| 5 days \|/)
  assert.match(create.input, /agent-qa\.md#top-up-the-delegation-treasury/)
  assert.match(create.input, /actions\/runs\/7/)
})

test('the issue body records a scrubbed faucet failure and accepted amount', () => {
  const topUp = {
    status: 'attempted', claimsMade: 2, amountReceivedAtomic: '200000000000000', stopReason: 'rate-limited',
    reason: 'faucet request failed: https://api.cdp.coinbase.com?key=SUPERSECRETKEY1234567',
  }
  const rows = [row('treasury', 'ok'), row('merchant', 'ok'), row('relayer', 'critical')]
  const { calls } = run({ rows, topUps: { relayer: topUp } })
  const body = calls.at(-1).input
  assert.match(body, /Dev backend relayer testnet faucet top-up: 2 accepted claim\(s\), 0\.0002 ETH received/)
  assert.match(body, /rate-limited/)
  assert.doesNotMatch(body, /SUPERSECRETKEY/)
  assert.doesNotMatch(body, /api\.cdp\.coinbase\.com/)
})

test('missing CDP credentials is an informational top-up line, not an unknown row', () => {
  const topUp = { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'missing-credentials' }
  const rows = [row('treasury', 'ok'), row('merchant', 'ok'), row('relayer', 'critical')]
  const { calls } = run({ rows, topUps: { merchant: topUp, relayer: topUp } })
  assert.match(calls.at(-1).input, /Demo-merchant settlement wallet testnet faucet top-up: skipped: no CDP credentials/)
  assert.match(calls.at(-1).input, /Dev backend relayer testnet faucet top-up: skipped: no CDP credentials/)
  assert.doesNotMatch(calls.at(-1).input, /unknown/)
})

test('a post-top-up relayer reading of ok does not open the standing issue', () => {
  const topUp = { status: 'attempted', claimsMade: 250, amountReceivedAtomic: '25000000000000000', stopReason: 'target-requests-complete' }
  const { verbs } = run({ rows: ok, topUps: { relayer: topUp } })
  assert.deepEqual(verbs, ['label create', 'issue list'])
})

test('the body shows one top-up line per wallet, merchant first, each naming its wallet and skip reason (#3836)', () => {
  const topUps = {
    relayer: { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'not-needed', reason: 'the relayer was not `warn` or `critical`' },
    merchant: { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'wrong-chain', reason: 'merchant /healthz reports chain 8453, not 84532' },
  }
  const body = buildBody(report(treasuryWarn, topUps), { runUrl: 'u', repo: 'd-hinders/Haven-AI', bands: {} })
  const lines = body.split('\n').filter((l) => /testnet faucet top-up/.test(l))
  assert.deepEqual(lines, [
    'Demo-merchant settlement wallet testnet faucet top-up: not requested — merchant /healthz reports chain 8453, not 84532.',
    'Dev backend relayer testnet faucet top-up: not requested — the relayer was not `warn` or `critical`.',
  ])
  assert.doesNotMatch(body, /accepted claim/)
})

test('a skip without a reason still gets its own wording, never the attempted-claims line', () => {
  for (const [stopReason, text] of [['not-needed', 'not needed'], ['wrong-chain', 'not on Base Sepolia'], ['invalid-address', 'not an address']]) {
    const line = topUpSummary('merchant', { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason })
    assert.match(line, new RegExp(`not requested — .*${text}`), stopReason)
    assert.doesNotMatch(line, /accepted claim/, stopReason)
  }
})

test('a closed standing issue is reopened, not duplicated, and a band change comments once', () => {
  const { verbs, calls } = run({ rows: treasuryWarn, issues: [standing('CLOSED', { treasury: 'ok', merchant: 'ok', relayer: 'ok' })] })
  assert.deepEqual(verbs, ['label create', 'issue list', 'issue reopen', 'issue edit', 'issue comment'])
  assert.match(calls.at(-1).args.join(' '), /Delegation treasury: ok → \*\*warn\*\*/)
})

test('two runs with unchanged bands edit the body and post no comment', () => {
  const { verbs } = run({ rows: treasuryWarn, issues: [standing('OPEN', { treasury: 'warn', merchant: 'ok', relayer: 'ok' })] })
  assert.deepEqual(verbs, ['label create', 'issue list', 'issue edit'])
})

test('a band change on an open issue (warn → critical) posts exactly one comment', () => {
  const rows = [row('treasury', 'critical'), row('merchant', 'ok'), row('relayer', 'ok')]
  const { verbs } = run({ rows, issues: [standing('OPEN', { treasury: 'warn', merchant: 'ok', relayer: 'ok' })] })
  assert.deepEqual(verbs, ['label create', 'issue list', 'issue edit', 'issue comment'])
})

test('every wallet ok or unknown closes the open issue with a final comment, and opens nothing', () => {
  const rows = [row('treasury', 'ok'), row('merchant', 'unknown', { balance: undefined, reason: '/healthz returned HTTP 503' }), row('relayer', 'ok')]
  const { verbs, calls } = run({ rows, issues: [standing('OPEN', { treasury: 'warn', merchant: 'ok', relayer: 'ok' })] })
  assert.deepEqual(verbs, ['label create', 'issue list', 'issue edit', 'issue comment', 'issue close'])
  assert.match(calls.find((c) => c.args[1] === 'comment').args.join(' '), /Closing/)
})

test('all ok with no open issue does nothing; a read failure (unknown) never opens the issue', () => {
  assert.deepEqual(run({ rows: ok }).verbs, ['label create', 'issue list'])
  const unknownOnly = ['treasury', 'merchant', 'relayer'].map((k) => row(k, 'unknown', { balance: undefined, reason: 'read failed: rpc down' }))
  const { result, verbs } = run({ rows: unknownOnly })
  assert.equal(result.status, 0)
  assert.deepEqual(verbs, ['label create', 'issue list'])
})

test('a human issue with the same label, or a title containing the words, is never edited or closed', () => {
  const human = { number: 7, title: ISSUE_TITLE, author: HUMAN, state: 'OPEN', body: '' }
  const lookalike = { number: 8, title: `${ISSUE_TITLE} — investigation notes`, author: BOT, state: 'OPEN', body: '' }
  // Alarm: the script creates its own issue beside them.
  const alarm = run({ rows: treasuryWarn, issues: [human, lookalike] })
  assert.deepEqual(alarm.verbs, ['label create', 'issue list', 'issue create'])
  // All clear: neither is closed.
  const clear = run({ rows: ok, issues: [human, lookalike] })
  assert.deepEqual(clear.verbs, ['label create', 'issue list'])
})

test('a failed lookup fails closed: exit 1 and no write', () => {
  const { result, verbs } = run({ rows: treasuryWarn, listFail: true })
  assert.equal(result.status, 1)
  assert.deepEqual(verbs, ['label create', 'issue list'])
})

test('selection prefers the open standing issue, then the lowest closed one', () => {
  const issues = [standing('CLOSED', {}, 10), standing('OPEN', {}, 20), standing('CLOSED', {}, 5)]
  assert.equal(selectStandingIssue(issues).number, 20)
  assert.equal(selectStandingIssue([standing('CLOSED', {}, 10), standing('CLOSED', {}, 5)]).number, 5)
  assert.equal(selectStandingIssue([]), null)
})

test('band memory: an unknown wallet keeps its last known band, and is never a change', () => {
  const rows = [row('treasury', 'unknown'), row('merchant', 'warn'), row('relayer', 'ok')]
  assert.deepEqual(nextBands({ treasury: 'critical' }, rows), { treasury: 'critical', merchant: 'warn', relayer: 'ok' })
  assert.deepEqual(
    bandChanges({ treasury: 'critical', merchant: 'ok' }, rows).map((c) => c.key),
    ['merchant'],
  )
  const body = buildBody(report(rows), { runUrl: 'u', repo: 'd-hinders/Haven-AI', bands: { treasury: 'critical', merchant: 'warn', relayer: 'ok' } })
  assert.deepEqual(readBands(body), { treasury: 'critical', merchant: 'warn', relayer: 'ok' })
  assert.deepEqual(readBands('no marker here'), {})
})

test('every top-up link resolves to a heading in agent-qa.md (the body cannot link to a missing anchor)', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/operations/agent-qa.md', import.meta.url)), 'utf8')
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-')
  const anchors = new Set([...doc.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1])))
  for (const anchor of [...Object.values(TOP_UP_ANCHOR), 'qa-wallet-balances-standing-issue']) {
    assert.ok(anchors.has(anchor), `agent-qa.md has no heading for #${anchor}`)
  }
})

test('a keyed provider URL in a reason never reaches the body or the close comment (#3631 review H1)', () => {
  const leak = 'read failed: server response 403 (info={"requestUrl":"https://base-sepolia.g.alchemy.com/v2/SUPERSECRETKEY1234567?dkey=SUPERSECRETKEY1234567"})'
  const rows = [row('treasury', 'unknown', { balance: undefined, reason: leak }), row('merchant', 'warn'), row('relayer', 'ok')]
  const open = run({ rows })
  assert.ok(!open.calls.some((c) => JSON.stringify(c).includes('SUPERSECRETKEY')), 'key leaked into the created issue')
  const closing = [row('treasury', 'unknown', { balance: undefined, reason: leak }), row('merchant', 'ok'), row('relayer', 'ok')]
  const close = run({ rows: closing, issues: [standing('OPEN', { treasury: 'warn', merchant: 'warn', relayer: 'ok' })] })
  assert.deepEqual(close.verbs, ['label create', 'issue list', 'issue edit', 'issue comment', 'issue close'])
  assert.ok(!close.calls.some((c) => JSON.stringify(c).includes('SUPERSECRETKEY')), 'key leaked into the close')
  assert.match(close.calls.find((c) => c.args[1] === 'comment').args.join(' '), /known to be/)
})
