// Unit tests for the `last-verified` chain-integrity check's pure core (#1843).
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lastVerifiedLine, issueRefs, checkChain, isPromotionPR, chainEntries, headOfEntry, checkEntriesVerbatim, normalizeEntryText, chainNoteBody, readChain, entriesRefs, checkChainEntries } from './chain-integrity.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('#2504: a prior entry truncated is a finding — the real defect the replay found', () => {
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

// ---------------------------------------------------------------------------
// #2637: the list shape. One entry per line, newest first.
//
// The three checks are unchanged in what they ASK — nothing dropped (#1843),
// nothing duplicated (#2477), every surviving entry verbatim (#2504) — and
// changed in how they answer: set operations over entry lines instead of
// substring work on one long string.
// ---------------------------------------------------------------------------

const LIST_DOC = (entries, date = '2026-09-08') =>
  ['---', 'owner: "@d-hinders"', 'status: current', `last-verified: "${date}"`, 'verified:']
    .concat(entries.map((e) => `  - ${JSON.stringify(e)}`))
    .concat(['---', '', '# Body'])
    .join('\n')

const E1 = '#2533: EDITED — three claims this diff made false. Scope: §3.'
const E2 = '#2445: re-read §3 and §7 against the rail seam.'
const E3 = '#2321: added the sixteenth required context.'

test('#2637: readChain reads the list shape, newest first', () => {
  const c = readChain(LIST_DOC([E1, E2, E3]))
  assert.equal(c.shape, 'list')
  assert.equal(c.date, '2026-09-08')
  assert.deepEqual(c.entries, [E1, E2, E3])
})

test('#2637: readChain still reads a LEGACY single-line chain — the migration transition', () => {
  // Across the migration the base is the old shape and the head is the new
  // one. If this stopped working, every PR open at migration time would report
  // its whole chain as dropped.
  const legacy = ['---', 'owner: "@d-hinders"', `last-verified: "2026-09-01" # ${E1} Prior: ${E2}`, '---'].join('\n')
  const c = readChain(legacy)
  assert.equal(c.shape, 'line')
  assert.deepEqual(c.entries, [E1, E2])
})

test('#2637: a legacy base and a list head compare as EQUAL when nothing was lost', () => {
  const legacy = ['---', `last-verified: "2026-09-01" # ${E1} Prior: ${E2}`, '---'].join('\n')
  const r = checkChainEntries(readChain(legacy).entries, readChain(LIST_DOC([E1, E2])).entries)
  assert.deepEqual(r.dropped, [])
  assert.deepEqual(r.altered, [])
  assert.deepEqual(r.duplicates, [])
})

test('#2637: DROPPED — an entry removed outright is a finding', () => {
  const r = checkChainEntries([E1, E2, E3], [E1, E3])
  assert.deepEqual(r.dropped, ['#2445'])
  assert.deepEqual(r.altered, [])
})

test('#2637: DUPLICATED — the same entry listed twice (a concatenating merge)', () => {
  const r = checkChainEntries([E1, E2], [E1, E2, E1])
  assert.equal(r.duplicates.length, 1)
  assert.equal(r.duplicates[0].head, '#2533')
  assert.equal(r.duplicates[0].count, 2)
})

test('#2637: ALTERED — the ref survives but the prose was rewritten', () => {
  // The distinction that matters: this is NOT a drop, because #2533 is still
  // there. A chain records what was verified and what was explicitly not, so
  // editing that text in place rewrites the record (#2504).
  const r = checkChainEntries([E1, E2], ['#2533: EDITED — two claims. Scope: §3.', E2])
  assert.deepEqual(r.dropped, [])
  assert.equal(r.altered.length, 1)
  assert.equal(r.altered[0].head, '#2533')
})

test('#2637: an entry that merely CITES another issue is not a duplicate of it', () => {
  const citing = '#2601: §4 reuses #2533’s mechanism, verified against the same fixture.'
  const r = checkChainEntries([E1], [citing, E1])
  assert.deepEqual(r.duplicates, [])
  assert.deepEqual(r.dropped, [])
})

test('#2637: chain-reset still excuses a compaction, and only in the marker form', () => {
  const reset = 'chain-reset(#2637): compacted, keeping the newest entries.'
  assert.deepEqual(checkChainEntries([E1, E2, E3], [reset]).dropped, [])
  // Prose about resets must not excuse a real deletion.
  const prose = 'clarified when a chain-reset is not needed'
  assert.deepEqual(checkChainEntries([E1, E2, E3], [prose]).dropped, ['#2533', '#2445', '#2321'])
})

test('#2637: entriesRefs collects refs across entries', () => {
  assert.deepEqual([...entriesRefs([E1, E2])].sort(), ['#2445', '#2533'])
})

// The claim this whole shape change rests on, proved with a real `git merge`
// rather than asserted: two PRs each adding their own verification entry.
//
// #1496 recorded three such conflicts in one day, each pure ceremony — the two
// sides never disagreed about anything, they just both prepended to the same
// physical line. One entry per line makes each side an ordinary line insertion.
function mergeTwoWays(makeDoc, mineEntry, theirsEntry) {
  const root = mkdtempSync(join(tmpdir(), 'chain-merge-'))
  const g = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'T')
  const file = join(root, 'doc.md')
  writeFileSync(file, makeDoc([]))
  g('add', '-A'); g('commit', '-qm', 'base')
  g('checkout', '-q', '-b', 'theirs')
  writeFileSync(file, makeDoc([theirsEntry]))
  g('add', '-A'); g('commit', '-qm', 'theirs')
  g('checkout', '-q', 'main')
  writeFileSync(file, makeDoc([mineEntry]))
  g('add', '-A'); g('commit', '-qm', 'mine')
  const merge = g('merge', 'theirs', '-m', 'merge')
  const text = readFileSync(file, 'utf8')
  rmSync(root, { recursive: true, force: true })
  return { conflicted: merge.status !== 0 || /^<{7}/m.test(text), text }
}

test('#2637: two concurrent verifications STILL CONFLICT — and the conflict is now trivial', () => {
  // MEASURED, and it corrects #2637's own premise. The issue said git would
  // merge concurrent entries "as ordinary line insertions". It does not: both
  // sides insert a different line at the same anchor, which conflicts in git's
  // line-based merge, and it conflicts in BOTH orderings (newest-first and
  // oldest-last were both tried). The shape change does not remove the
  // conflict.
  //
  // What it removes is the DAMAGE. The conflict hunk is the two inserted lines
  // with every other entry as untouched context, so the resolution is "keep
  // both" and an unrelated entry cannot be lost on the way. In the old shape
  // the identical conflict was one 37,561-byte line that both sides had
  // rewritten whole — hand-merging that is how #1843 dropped entries and how
  // #2504 rewrote them in place.
  const NEW = '#2701: re-read §2 against the new gate.'
  const MINE = '#2700: re-read §5 and bumped nothing else.'
  const OLD_ENTRY = '#2533: EDITED — three claims this diff made false. Scope: §3.'
  const r = mergeTwoWays((extra) => LIST_DOC([...extra, OLD_ENTRY]), MINE, NEW)
  assert.equal(r.conflicted, true, 'measured: a same-anchor insertion conflicts in the list shape too')

  // The part that is the actual win: the untouched entries survive as context
  // outside the conflict markers, so no other entry is at risk in the resolve.
  assert.ok(r.text.includes(OLD_ENTRY), 'unrelated entries stay outside the conflict hunk')
  const hunk = r.text.split('\n').filter((l) => /^[<>=]{7}/.test(l))
  assert.equal(hunk.length, 3, 'exactly one conflict hunk')

  // And resolving it the obvious way — keep both — passes every check.
  const resolved = LIST_DOC([MINE, NEW, OLD_ENTRY])
  const c = checkChainEntries([OLD_ENTRY], readChain(resolved).entries)
  assert.deepEqual(c.dropped, [])
  assert.deepEqual(c.altered, [])
  assert.deepEqual(c.duplicates, [])
})

test('#2637: the OLD shape conflicts on the same edit, over one enormous line', () => {
  // The contrast that carries the argument. Same two edits, old shape: also a
  // conflict — but the conflicting region is the whole chain, not two lines.
  const legacyDoc = (extra) =>
    ['---', 'owner: "@d-hinders"',
     `last-verified: "2026-09-08" # ${[...extra, '#2533: EDITED — three claims.'].join(' Prior: ')}`,
     '---', '', '# Body'].join('\n')
  const r = mergeTwoWays(legacyDoc, '#2700: re-read §5.', '#2701: re-read §2.')
  assert.equal(r.conflicted, true)
  // Both sides' versions of the ENTIRE chain are in the hunk — that is the
  // thing a human then hand-merges, and the reason entries went missing.
  const conflicting = r.text.split('\n').filter((l) => l.startsWith('last-verified:'))
  assert.equal(conflicting.length, 2, 'the whole chain appears twice, once per side')
})

test('#2637: a MULTI-REF head with only one ref surviving is ALTERED, not dropped', () => {
  // The `.some` vs `.every` case. `headOfEntry` supports a ref cluster
  // (`#2100/#2101 (+#2098)`), and partial survival is the only shape where the
  // two differ: `.every` would reclassify this as a drop. Review found that no
  // test constructed it, so the mutant survived all 230 — this is that test.
  // PARTIAL survival is the discriminating shape: the entry is gone, and only
  // ONE of its three head refs still appears anywhere in the chain — cited in
  // someone else's prose. `.some` reads that as rewritten (altered); `.every`
  // reads it as removed (dropped). A fixture where all three survive cannot
  // tell them apart, which is why the first attempt at this test passed the
  // mutant.
  const multi = '#2100/#2101 (+#2098): the three-part landing, verified together.'
  const citesOne = '#2445: re-read §3, which #2100 introduced.'
  const r = checkChainEntries([multi], [citesOne])
  assert.deepEqual(r.dropped, [], 'one surviving ref means rewritten, not removed')
  assert.equal(r.altered.length, 1)
  assert.equal(r.altered[0].head, '#2100/#2101(+#2098)')
})
