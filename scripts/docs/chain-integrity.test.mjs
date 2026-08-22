// Unit tests for the `last-verified` chain-integrity check's pure core (#1843).
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lastVerifiedLine, issueRefs, checkChain, isPromotionPR } from './chain-integrity.mjs'

const SCRIPT = fileURLToPath(new URL('./chain-integrity.mjs', import.meta.url))

/**
 * Run the CLI with a controlled environment. The CI-detection variables are
 * stripped first: inheriting them would make these assertions depend on where
 * the suite happens to be running, which is how a guard ends up untested in
 * exactly the environment it guards.
 */
function runCli(env = {}, args = []) {
  const base = { ...process.env }
  for (const k of ['GITHUB_ACTIONS', 'CI', 'GITHUB_EVENT_NAME', 'GITHUB_HEAD_REF',
    'GITHUB_BASE_REF', 'BASE_SHA', 'HEAD_SHA']) delete base[k]
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...base, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

// ── The actual incident (#1843), abridged only in the prose between the refs.
// `dev` carried #1832's chain; the conflict resolution on #1841's branch
// prepended #1797 and dropped #1816 — the entry AND the §4 paragraph it named.
const DEV_LINE =
  'last-verified: "2026-08-22" # #1797: §4 gains the viewport-coverage rule. ' +
  'Prior: #1816: §4 gains the e2e-server rule. Prior: #1805/#1760: §4 gains what ' +
  'the visual gate can and cannot see. Prior: #1800: §4 gains the capture-server rule.'
const RESOLUTION_THAT_PICKED_A_SIDE =
  'last-verified: "2026-08-22" # #1797: §4 gains the viewport-coverage rule. ' +
  'Prior: #1805/#1760: §4 gains what the visual gate can and cannot see. ' +
  'Prior: #1800: §4 gains the capture-server rule.'

test('the #1843 incident: a resolution that drops #1816 from the chain is broken', () => {
  // Base is `dev` WITHOUT #1797 (that is the entry the PR is adding).
  const base = DEV_LINE.replace('#1797: §4 gains the viewport-coverage rule. Prior: ', '')
  const r = checkChain(base, RESOLUTION_THAT_PICKED_A_SIDE)
  assert.equal(r.status, 'broken')
  assert.deepEqual(r.dropped, ['#1816'])
})

test('the legitimate chained resolution of the same conflict is fine', () => {
  const base = DEV_LINE.replace('#1797: §4 gains the viewport-coverage rule. Prior: ', '')
  assert.equal(checkChain(base, DEV_LINE).status, 'ok')
})

test('prepending a new entry keeps the chain (newest-first docs)', () => {
  const prev = 'last-verified: "2026-08-01" # #100: a. Prior: #90: b'
  const next = 'last-verified: "2026-08-02" # #110: c. Prior: #100: a. Prior: #90: b'
  assert.equal(checkChain(prev, next).status, 'ok')
})

test('appending a new entry keeps the chain (oldest-first docs)', () => {
  const prev = 'last-verified: "2026-08-01" # #90: b. Then #100: a'
  const next = 'last-verified: "2026-08-02" # #90: b. Then #100: a. Then #110: c'
  assert.equal(checkChain(prev, next).status, 'ok')
})

test('rewording a note without touching its refs is fine', () => {
  const prev = 'last-verified: "2026-08-01" # #100: verified the budget card'
  const next = 'last-verified: "2026-08-02" # #100: re-read §3 against the budget card'
  assert.equal(checkChain(prev, next).status, 'ok')
})

// The rule is CONTAINMENT, not the order-preserving subsequence #1843 proposed.
// Both of these are real lines from merged PRs (#1832, #1601) that the stricter
// rule went red on: a new note cites an older issue in its prose, the citation
// is the first occurrence of that reference, and the surviving order changes
// without anything being lost. Zero real reorderings were found against them.
test('a new note may cite an older issue before its own chain entry (#1832)', () => {
  const prev = 'last-verified: "2026-08-21" # #1805/#1760: a. Prior: #1800: b'
  const next =
    'last-verified: "2026-08-22" # #1816: §4 reuses #1800\'s port mechanism. ' +
    'Prior: #1805/#1760: a. Prior: #1800: b'
  assert.equal(checkChain(prev, next).status, 'ok')
})

test('a new note may supersede a named earlier entry that is still in the chain (#1601)', () => {
  const prev = 'last-verified: "2026-08-18" # #1591: a. Prior: #1586: b'
  const next = 'last-verified: "2026-08-19" # #1593: supersedes #1586. Prior: #1591: a. Prior: #1586: b'
  assert.equal(checkChain(prev, next).status, 'ok')
})

test('a doc with no refs on its previous line can never break', () => {
  const prev = 'last-verified: "2026-08-01" # first pass over the runbook'
  const next = 'last-verified: "2026-08-02" # rewritten from scratch'
  assert.equal(checkChain(prev, next).status, 'ok')
})

test('chain-reset allows a deliberate compaction and still reports what it dropped', () => {
  const prev = 'last-verified: "2026-08-01" # #100: a. Prior: #90: b. Prior: #80: c'
  const next = 'last-verified: "2026-08-02" # chain-reset(#1843): compacted; history in git log. #100: a'
  const r = checkChain(prev, next)
  assert.equal(r.status, 'reset')
  assert.deepEqual(r.dropped, ['#90', '#80'])
})

test('merely TALKING about a chain reset does not excuse a deletion', () => {
  // The escape hatch is the marker syntax `chain-reset(#N)`, not the word. A
  // substring match here would let prose disable the gate's one exception —
  // the same "green without asking the question" shape the gate exists to stop.
  const prev = 'last-verified: "2026-08-01" # #100: a. Prior: #90: b'
  const next = 'last-verified: "2026-08-02" # #100: clarified when a chain-reset is NOT needed'
  assert.equal(checkChain(prev, next).status, 'broken')
})

test('the chain-reset marker must be on the NEW line, not merely mentioned in prose elsewhere', () => {
  // The marker is read off the line itself precisely so it lands in the diff of
  // the file it excuses — a reason living in a PR description excuses nothing.
  const prev = 'last-verified: "2026-08-01" # #100: a. Prior: #90: b'
  const next = 'last-verified: "2026-08-02" # #100: a'
  assert.equal(checkChain(prev, next).status, 'broken')
})

test('issueRefs reads refs in order and de-duplicates', () => {
  assert.deepEqual(issueRefs('# #1805/#1760: x. Prior: #1800: y. See #1805'), [
    '#1805',
    '#1760',
    '#1800',
  ])
})

test('only a dev → main promotion is exempt; a hotfix into main is not', () => {
  assert.equal(isPromotionPR({ GITHUB_HEAD_REF: 'dev', GITHUB_BASE_REF: 'main' }), true)
  assert.equal(isPromotionPR({ GITHUB_HEAD_REF: 'hotfix/x', GITHUB_BASE_REF: 'main' }), false)
  assert.equal(isPromotionPR({ GITHUB_HEAD_REF: 'feat/x', GITHUB_BASE_REF: 'dev' }), false)
  assert.equal(isPromotionPR({}), false)
})

test('lastVerifiedLine returns the RAW line, comment included', () => {
  const doc = ['---', 'owner: "@x"', 'status: current', 'covers: []',
    'last-verified: "2026-08-02" # #100: a', '---', '', '# Title'].join('\n')
  assert.equal(lastVerifiedLine(doc), 'last-verified: "2026-08-02" # #100: a')
})

test('lastVerifiedLine stops at the closing fence and ignores the body', () => {
  const doc = ['---', 'owner: "@x"', '---', '', 'last-verified: "2026-08-02" # #100'].join('\n')
  assert.equal(lastVerifiedLine(doc), null)
})

test('lastVerifiedLine returns null for a file with no front-matter (changelog shards)', () => {
  assert.equal(lastVerifiedLine('# Just a shard\n\nsome prose'), null)
})

// ── CLI wiring. The fail-closed guarantee lives in `main()`, not in the pure
// functions above, so it needs a test that actually runs the script — a claim
// verified once by hand survives exactly until the next refactor.

test('CI with an unresolvable base FAILS rather than reporting a clean bill of health', () => {
  const r = runCli({ GITHUB_ACTIONS: 'true', BASE_SHA: '0000000000000000000000000000000000000000' })
  assert.equal(r.code, 1)
  assert.match(r.err, /BLOCKING/)
  assert.match(r.out, /NOTHING WAS CHECKED/)
})

test('a push build skips explicitly, keyed on the event and not on a missing variable', () => {
  const r = runCli({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' })
  assert.equal(r.code, 0)
  assert.match(r.out, /push build/)
})

test('an unknown CI context without a base still fails closed — it does not fall through the push skip', () => {
  const r = runCli({
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'merge_group',
    BASE_SHA: '0000000000000000000000000000000000000000',
  })
  assert.equal(r.code, 1)
  assert.match(r.err, /BLOCKING/)
})

test('a dev → main promotion exits early, before any base resolution', () => {
  const r = runCli({
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_HEAD_REF: 'dev',
    GITHUB_BASE_REF: 'main',
    BASE_SHA: '0000000000000000000000000000000000000000',
  })
  assert.equal(r.code, 0)
  assert.match(r.out, /promotion/)
})
