// Unit tests for the `last-verified` chain-integrity check's pure core (#1843).
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lastVerifiedLine, issueRefs, checkChain, isPromotionPR, chainEntries, headOfEntry, chainAnomalies, checkEntriesVerbatim, normalizeEntryText, chainNoteBody, MAX_CHAIN_BYTES } from './chain-integrity.mjs'

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

// ── #2477: the OPPOSITE failure — an entry appearing TWICE. The containment
// rule can only see entries going missing; `issueRefs` de-duplicates, so a
// chain that was CONCATENATED instead of interleaved loses nothing and the
// gate used to report `✓ chains intact` on a doubled chain.

test('chainEntries splits on the `Prior:` chain-word, never on raw issue refs', () => {
  const line =
    'last-verified: "2026-08-22" # #1816: §4 reuses #1800\'s port mechanism. ' +
    'Prior: #1805/#1760: a. Prior: #1800: b'
  assert.deepEqual(chainEntries(line), [
    "#1816: §4 reuses #1800's port mechanism.",
    '#1805/#1760: a.',
    '#1800: b',
  ])
})

test('chainEntries normalizes the bare `Prior #N` boundary variant', () => {
  const line = 'last-verified: "2026-08-22" # #1508: a. Prior #1508: b'
  assert.deepEqual(chainEntries(line), ['#1508: a.', '#1508: b'])
})

test('chainEntries returns [] for a line with no chain comment', () => {
  assert.deepEqual(chainEntries('last-verified: "2026-08-22"'), [])
  assert.deepEqual(chainEntries('no chain here'), [])
})

test('headOfEntry reads the leading ref CLUSTER, not refs cited in prose', () => {
  assert.equal(headOfEntry("#1816: §4 reuses #1800's mechanism"), '#1816')
  assert.equal(headOfEntry('#2100/#2101 (+#2098): re-verified'), '#2100/#2101(+#2098)')
  assert.equal(headOfEntry('#1508 (actual fix): x'), '#1508')
  assert.equal(headOfEntry('Release 0.1.31-alpha.0: x'), '0.1.31-alpha.0')
  assert.equal(headOfEntry('0.1.34-alpha.0 release: x'), '0.1.34-alpha.0')
  assert.equal(headOfEntry('no ref'), null)
})

test('a doubled chain is DETECTED (duplicate entries) where containment alone was green', () => {
  // The #2477 incident shape: the same chain CONCATENATED instead of
  // interleaved. Containment passes — nothing is dropped — which is exactly why
  // the old gate reported `✓ chains intact` on a doubled chain.
  const base = 'last-verified: "2026-08-02" # #100: a. Prior: #90: b.'
  const concatenated = 'last-verified: "2026-08-02" # #100: a. Prior: #90: b. Prior: #100: a. Prior: #90: b.'
  assert.equal(checkChain(base, concatenated).status, 'ok') // containment: green
  const r = chainAnomalies(concatenated)
  assert.equal(r.tooLarge, null)
  assert.equal(r.duplicates.length, 2)
  const byHead = Object.fromEntries(r.duplicates.map((d) => [d.head, d.count]))
  assert.equal(byHead['#100'], 2)
  assert.equal(byHead['#90'], 2)
})

test('a chain where an entry merely CITES another issue is NOT a duplicate', () => {
  // The prose-citation subtlety: #1816's entry cites #1800, which also has its
  // own chain entry. A naive split on every #NNN would count #1800 twice;
  // split on the chain-word it is one cited ref and one entry.
  const line =
    'last-verified: "2026-08-22" # #1816: §4 reuses #1800\'s port mechanism. ' +
    'Prior: #1805/#1760: a. Prior: #1800: b'
  const r = chainAnomalies(line)
  assert.equal(r.duplicates.length, 0)
})

test('two DIFFERENT entries for the same issue are NOT duplicates (text differs)', () => {
  // #1508 appears twice on the real dev chain — once as "(actual fix)", once as
  // a later re-verification. Different prose, so not a concatenation duplicate.
  const line =
    'last-verified: "2026-08-22" # #1508 (actual fix): x. Prior #1508: y'
  const r = chainAnomalies(line)
  assert.equal(r.duplicates.length, 0)
})

test('the size ceiling is a hard failure and reports bytes vs ceiling', () => {
  const small = `last-verified: "2026-08-02" # ${'x'.repeat(100)}`
  const big = `last-verified: "2026-08-02" # ${'x'.repeat(MAX_CHAIN_BYTES)}`
  assert.equal(chainAnomalies(small).tooLarge, null)
  const r = chainAnomalies(big)
  assert.ok(r.tooLarge.bytes > MAX_CHAIN_BYTES) // prefix pushes the line over the ceiling
  assert.equal(r.tooLarge.maxBytes, MAX_CHAIN_BYTES)
})

test('chain-reset does NOT excuse a chain over the size ceiling', () => {
  // The escape hatch is for compaction (a DROP). A doubled line that stays over
  // the ceiling is still a growth problem a reset does not fix.
  const big = `last-verified: "2026-08-02" # chain-reset(#1843): compacted. ${'x'.repeat(MAX_CHAIN_BYTES)}`
  assert.ok(chainAnomalies(big).tooLarge.bytes > MAX_CHAIN_BYTES)
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

// ---------------------------------------------------------------------------
// #2504 — an entry that survives by REFERENCE but not by TEXT.
//
// The two existing checks answer "is every prior ref still here" and "is any
// entry here twice". Neither asks whether the entry that is here still says
// what it said, which is precisely what a hand-resolved base refresh can get
// wrong.
//
// The tolerance these tests pin was set by replaying the rule over merged
// history. The replay, its window and what each hit turned out to be are
// recorded once, in `docs/contributing/docs-quality-system.md` §
// `last-verified` chain integrity — not restated here. An earlier draft of this
// comment carried its own copy of those figures and went stale against the
// corrected account within one commit, which is the drift this whole change is
// about.
// ---------------------------------------------------------------------------

const BASE_CHAIN =
  'last-verified: "2026-09-01" # #300: the alpha claim re-read against `src/a.ts` and corrected. ' +
  'Prior: #200: the beta paragraph verified; nothing else re-read.'

test('#2504: an unchanged chain is clean', () => {
  assert.deepEqual(checkEntriesVerbatim(BASE_CHAIN, BASE_CHAIN).altered, [])
})

test('#2504: ONE word changed inside a prior entry is a finding, named by its ref', () => {
  const next = BASE_CHAIN.replace('the beta paragraph verified', 'the beta paragraph checked')
  const { altered } = checkEntriesVerbatim(BASE_CHAIN, next)
  assert.equal(altered.length, 1)
  assert.equal(altered[0].head, '#200')
})

test('#2504: a prior entry truncated mid-sentence is a finding — the real defect the replay found', () => {
  const next = BASE_CHAIN.replace(
    'the beta paragraph verified; nothing else re-read.',
    'the beta paragraph verified.',
  )
  assert.equal(checkEntriesVerbatim(BASE_CHAIN, next).altered[0].head, '#200')
})

test('#2504: an entry DELETED while its ref survives as a citation is caught — checkChain cannot see this', () => {
  const next =
    'last-verified: "2026-09-02" # #400: follow-up to #200 and #300. ' +
    'Prior: #300: the alpha claim re-read against `src/a.ts` and corrected.'
  // The ref check passes: #200 is still on the line, inside #400's prose.
  assert.equal(checkChain(BASE_CHAIN, next).status, 'ok')
  // The text check does not.
  assert.equal(checkEntriesVerbatim(BASE_CHAIN, next).altered[0].head, '#200')
})

test('#2504: a deleted trailing period and collapsed whitespace are NOT findings', () => {
  const period = BASE_CHAIN.replace('and corrected.', 'and corrected')
  assert.deepEqual(checkEntriesVerbatim(BASE_CHAIN, period).altered, [])
  const spaces = BASE_CHAIN.replace('Prior: #200: the beta', 'Prior: #200:  the   beta')
  assert.deepEqual(checkEntriesVerbatim(BASE_CHAIN, spaces).altered, [])
})

test('#2504: a declared chain-reset rewrites entries on purpose and is exempt', () => {
  const next =
    'last-verified: "2026-09-02" # chain-reset(#999): compacted. ' +
    '#300: the alpha claim re-read against `src/a.ts` and corrected.'
  assert.deepEqual(checkEntriesVerbatim(BASE_CHAIN, next).altered, [])
})

test('#2504: normalizeEntryText touches whitespace and a terminal period, nothing else', () => {
  assert.equal(normalizeEntryText('  a   b .'), 'a b')
  assert.equal(normalizeEntryText('a b.'), 'a b')
  assert.equal(normalizeEntryText('a. b.'), 'a. b')
})

test('#2504: a LOST `# ` comment marker is not read as an altered entry (review finding)', () => {
  // docs/architecture/00-overview.md carried this exact shape for one commit:
  // the structural marker replaced by a space, every entry byte-identical.
  // Read naively the regex eats #1992's own `#` and the containment check
  // reports a rewrite that never happened.
  const prev = 'last-verified: "2026-08-25" # #1992: the two-rails line was false. Prior: #1900: earlier note.'
  const next = 'last-verified: "2026-08-25"  #1992: the two-rails line was false. Prior: #1900: earlier note.'
  assert.deepEqual(checkEntriesVerbatim(prev, next).altered, [])
  assert.equal(chainNoteBody(next).startsWith('#1992:'), true)
})

test('#2504: a marker followed by a space still opens the comment (release-token entries)', () => {
  const line = 'last-verified: "2026-09-01" # 0.1.31-alpha.0: published from this branch.'
  assert.equal(chainNoteBody(line), '0.1.31-alpha.0: published from this branch.')
})
