// Unit tests for the repo-wide chain sweep's pure core (#1885).
// Run with: npm run docs:test
//
// The subject is `classifyBreak`: given a historical `prev → next` pair and
// the doc's line as it stands TODAY, is this a declared reset or an unrestored
// break?
//
// Every test here is written so that the BLANKET fix — "today's line carries
// `chain-reset(...)`, so excuse it" — fails at least one of them. That is the
// point of the file. #1885 exists because the blanket check is the obvious
// move and it trades a false positive for a false negative in the one tool
// built to find silent losses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBreak, declaredResetIssues } from './chain-sweep.mjs'

// The real shape, from `docs/regulatory/casp-risk-guardrails.md`, trimmed.
// `cf177982` (PR #1497, Closes #1496) compacted the line to date-only; the
// `chain-reset` marker syntax did not exist until #1843, four days later, so
// the declaration could only ever be added retroactively — to TODAY's line.
const PREV_1496 = 'last-verified: "2026-08-15" # #1482: shape-check. #1471: base-sepolia. #1366: entries move to shards.'
const NEXT_1496 = 'last-verified: "2026-08-16" # #1496: this line is date-only from now on.'
const NOW_1496 = 'last-verified: "2026-08-22" # chain-reset(#1496): this line is date-only from now on — entries are casp-changelog shards.'

test('declaredResetIssues reads the marker syntax, not the word', () => {
  assert.deepEqual(declaredResetIssues(NOW_1496), ['#1496'])
  assert.deepEqual(declaredResetIssues('last-verified: "x" # #12 clarified when a chain-reset is not needed'), [])
  assert.deepEqual(
    declaredResetIssues('last-verified: "x" # chain-reset(#12): a. chain-reset(#34): b.'),
    ['#12', '#34'],
  )
})

test('half 1: a reset declared retroactively on today\'s line is classified, not reported as a break', () => {
  const c = classifyBreak({ prevLine: PREV_1496, nextLine: NEXT_1496, nowLine: NOW_1496 })
  assert.equal(c.status, 'declared-reset')
  assert.equal(c.declaredBy, '#1496')
  assert.deepEqual(c.stillLost, ['#1482', '#1471', '#1366'])
})

test('half 2: a genuine LATER drop in that same doc is still reported', () => {
  // The masking hole, stated as a test. #1899 was chained on correctly, then
  // silently dropped — long after #1496's compaction, with nothing declaring
  // it. The doc still carries `chain-reset(#1496)` today, because a marker
  // stays on the line for good.
  //
  // A blanket `CHAIN_RESET_RE.test(nowLine)` check returns 'declared-reset'
  // here and this assertion is what fires.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-22" # #1899 re-verify: real work. chain-reset(#1496): date-only.',
    nextLine: 'last-verified: "2026-08-23" # chain-reset(#1496): date-only.',
    nowLine: 'last-verified: "2026-08-23" # chain-reset(#1496): date-only.',
  })
  assert.equal(c.status, 'unrestored', 'a declared reset must not excuse an unrelated later drop')
  assert.deepEqual(c.stillLost, ['#1899'])
  assert.equal(c.declaredBy, null)
})

test('half 2, mirrored: a genuine EARLIER drop in that same doc is still reported', () => {
  // Before the compaction, so the marker is nowhere near this pair — but it is
  // on today's line, which is all a blanket check looks at.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-14" # #1300: real work. #1200: earlier work.',
    nextLine: 'last-verified: "2026-08-15" # #1300: real work.',
    nowLine: NOW_1496,
  })
  assert.equal(c.status, 'unrestored', 'a later declared reset must not excuse an earlier drop')
  assert.deepEqual(c.stillLost, ['#1200'])
})

test('a reset declared BY the commit itself binds to that commit', () => {
  // Post-#1843: the marker syntax exists, so the compacting commit writes it.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-22" # #1800: a. #1700: b.',
    nextLine: 'last-verified: "2026-08-23" # chain-reset(#1850): compacted, see shards.',
    nowLine: 'last-verified: "2026-08-24" # #1860 re-verify: c. chain-reset(#1850): compacted, see shards.',
  })
  assert.equal(c.status, 'declared-reset')
  assert.equal(c.declaredBy, '#1850')
})

test('...and does NOT bind to the next commit, where the marker is merely still present', () => {
  // The specific defect a first draft of `classifyBreak` shipped: it trusted
  // `checkChain`'s `reset` status, which is true on EVERY pair whose `next`
  // line carries a marker — i.e. forever after the declaration. Caught by
  // mutation against real history, pinned here.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-23" # #1860 re-verify: c. chain-reset(#1850): compacted, see shards.',
    nextLine: 'last-verified: "2026-08-24" # chain-reset(#1850): compacted, see shards.',
    nowLine: 'last-verified: "2026-08-24" # chain-reset(#1850): compacted, see shards.',
  })
  assert.equal(c.status, 'unrestored', 'a persisting marker is not a fresh declaration')
  assert.deepEqual(c.stillLost, ['#1860'])
})

test('half 2, review counterexample: a PROSE mention of the declaring issue excuses nothing', () => {
  // Found by `haven-reviewer` against the first implementation, which bound a
  // retroactive declaration to "the first commit to cite #N". `issueRefs`
  // cannot tell an entry from a citation, and this repo's notes cite older
  // issues in prose constantly (`chain-integrity.mjs` documents that habit as
  // the reason the check is containment rather than a subsequence).
  //
  // So this commit — which performed NO compaction, merely name-checked #1496
  // while silently dropping #200 — was reported as a declared reset. Verbatim
  // from the review, and it returned
  // { status: 'declared-reset', stillLost: ['#200'], declaredBy: '#1496' }.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-01-01" # #100: base. #200: extra.',
    nextLine: 'last-verified: "2026-02-01" # #1500: rewritten, plan tracked in #1496 for later cleanup. #100: base.',
    nowLine: 'last-verified: "2026-03-01" # chain-reset(#1496): unrelated real compaction, see shards. #1500: rewritten, plan tracked in #1496 for later cleanup. #100: base.',
  })
  assert.equal(c.status, 'unrestored', 'a prose citation is not a compaction')
  assert.deepEqual(c.stillLost, ['#200'])
  assert.equal(c.declaredBy, null)
})

test('a partial compaction does not bind — it fails toward reporting', () => {
  // #N survives but so does #1300, so this is not "compacted to #N alone".
  // Reported as unrestored; `main()` additionally prints the declaration as
  // unmatched. Narrow and loud beats broad and quiet.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-15" # #1300: kept. #1200: dropped.',
    nextLine: 'last-verified: "2026-08-16" # #1496: partial compaction. #1300: kept.',
    nowLine: 'last-verified: "2026-08-22" # chain-reset(#1496): partial compaction.',
  })
  assert.equal(c.status, 'unrestored')
  assert.deepEqual(c.stillLost, ['#1200'])
})

test('a drop restored by a later commit is ok, declaration or not', () => {
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-20" # #1500: a. #1400: b.',
    nextLine: 'last-verified: "2026-08-21" # #1500: a.',
    nowLine: 'last-verified: "2026-08-22" # #1500: a. #1400: b, restored.',
  })
  assert.equal(c.status, 'ok')
  assert.deepEqual(c.stillLost, [])
})

test('still-lost is decided on parsed refs, never a substring of today\'s line (#1883)', () => {
  // `#1447` on today's line must not vouch for a dropped `#144`.
  const c = classifyBreak({
    prevLine: 'last-verified: "2026-08-20" # #1447: a. #144: b.',
    nextLine: 'last-verified: "2026-08-21" # #1447: a.',
    nowLine: 'last-verified: "2026-08-22" # #1447: a.',
  })
  assert.equal(c.status, 'unrestored')
  assert.deepEqual(c.stillLost, ['#144'])
})
