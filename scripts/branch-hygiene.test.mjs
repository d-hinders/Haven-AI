import test from 'node:test'
import assert from 'node:assert/strict'
import { classify } from './branch-hygiene.mjs'

test('a resync into a work branch is counted, and names the branch that went stale', () => {
  assert.deepEqual(
    classify("Merge branch 'dev' into claude/connect-agent-modal-ux-d34ghg"),
    { kind: 'resync', branch: 'claude/connect-agent-modal-ux-d34ghg' },
  )
})

test('a SAME-NAME remote merge is the two-writers hazard, not ordinary integration', () => {
  // This is the shape AGENTS.md warns about: one branch name, two writers.
  assert.deepEqual(
    classify("Merge remote-tracking branch 'origin/claude/foo' into claude/foo"),
    { kind: 'divergence', branch: 'claude/foo' },
  )
})

test('a `git pull origin dev` resync counts the same as `git merge dev`', () => {
  // Real history carries both shapes. Missing this one undercounts the exact
  // thing the report exists to measure — found by review, not by reasoning.
  assert.deepEqual(
    classify("Merge remote-tracking branch 'origin/dev' into feature/thing"),
    { kind: 'resync', branch: 'feature/thing' },
  )
  // And the shape a pull takes with no tracking name configured.
  assert.deepEqual(
    classify("Merge branch 'dev' of https://github.com/d-hinders/Haven-AI into feat/x"),
    { kind: 'resync', branch: 'feat/x' },
  )
})

test('classify(): `main` into a branch is not a resync SUBJECT (the count itself is pinned below, #3228)', () => {
  // The script's first bug: an unanchored source made every main-into-branch
  // merge a "resync" — 89 of them in this repo — and put `dev` itself in a
  // table of work branches that outlived their PR. Merging main is release
  // reconciliation, a different act with a different cause.
  assert.equal(classify("Merge branch 'main' into dev"), null)
  assert.equal(classify("Merge branch 'main' into feature/thing"), null)
  assert.equal(classify("Merge remote-tracking branch 'origin/main' into feature/thing"), null)
})

test('dev and main are never reported as branches that went stale', () => {
  assert.equal(classify("Merge branch 'dev' into main"), null)
})

test('an ordinary squash-merge subject is not a finding', () => {
  assert.equal(classify('fix(auth): equalise login cost (#1646) (#1656)'), null)
  assert.equal(classify("Merge pull request #12 from d-hinders/feature/x"), null)
})

test('MUTATION-SENSITIVE: a subject that only MENTIONS the phrase is not a resync', () => {
  // Drop the `^` anchor and a doc change explaining the rule starts counting
  // as a violation of it. This is the shape `git log --grep` gets wrong, which
  // is why the report reads subjects itself.
  assert.equal(
    classify("docs: explain why Merge branch 'dev' into a work branch is bad"),
    null,
  )
})

// ── #3228: counted from merged PRs' own commits, not from dev's history ──────

import { summarizePullRequests, parseArgs } from './branch-hygiene.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'branch-hygiene.mjs')

/** Runs the real entry point on a fixture, the way a reader runs the report. */
function runOnFixture(fixture, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'branch-hygiene-'))
  const file = join(dir, 'prs.json')
  writeFileSync(file, JSON.stringify(fixture))
  return spawnSync(process.execPath, [SCRIPT, '--since=2026-09-08', '--until=2026-09-23', `--from-json=${file}`, ...extra], {
    encoding: 'utf8',
  })
}

const DEV_TIP = 'd'.repeat(40)
const pr = (number, headRefName, commits) => ({ number, headRefName, commits })
const commit = (oid, subject, parents) => ({ oid, subject, parents })

test('a merge whose parent is dev history is a resync, whatever its subject says', () => {
  // Hand-written subjects are common in PR commits ("Merge origin/dev into x",
  // "merge dev (73a7beaa) into x"); a subject regex missed them over
  // 2026-09-08 → 09-23 (19 of 48). The parent is the fact.
  const report = summarizePullRequests(
    [
      pr(1, 'feat/a', [
        commit('a1', 'feat: work', ['base']),
        commit('a2', 'merge dev (73a7beaa) into feat/a', ['a1', DEV_TIP]),
      ]),
    ],
    (oid) => oid === DEV_TIP,
  )
  assert.equal(report.resyncs, 1)
  assert.deepEqual(report.branches, [{ branch: 'feat/a', resync: 1, divergence: 0, prs: [1] }])
})

test("a parent that is the PR's OWN commit is never dev, even when dev has it now", () => {
  // Before the squash-only ruleset a PR was merge-merged, so its branch
  // commits became dev history. A merge of two of the PR's own commits is not
  // a resync — it is reported as an other merge.
  const report = summarizePullRequests(
    [pr(2, 'feat/b', [commit('b1', 'x', ['base']), commit('b2', 'y', ['base']), commit('b3', 'merge b1 into b2', ['b2', 'b1'])])],
    () => true,
  )
  assert.equal(report.resyncs, 0)
  assert.equal(report.otherMerges, 1)
})

test('the same-name subject wins over the parent test — a branch reused across PRs (#1417)', () => {
  // origin/<b>'s tip was an EARLIER PR's commit: outside this PR and on dev.
  const report = summarizePullRequests(
    [pr(1417, 'claude/reused', [
      commit('c1', 'feat: more', ['base']),
      commit('c2', "Merge remote-tracking branch 'origin/claude/reused' into claude/reused", ['c1', 'earlier-pr-tip']),
    ])],
    (oid) => oid === 'earlier-pr-tip',
  )
  assert.equal(report.divergences, 1)
  assert.equal(report.resyncs, 0)
})

test('MUTATION PROOF: a sync-back is recognised by its content, whatever the branch is called', () => {
  // 6 of 9 real sync-backs had names no pattern listed (#1965
  // codex/sync-main-20260824, #1268 chore/sync-main-after-1267, …); each
  // carries main's promotion merge, one parent of which is on dev.
  const report = summarizePullRequests(
    [
      pr(1965, 'codex/sync-main-20260824', [
        commit('s1', 'Merge pull request #1964 from d-hinders/dev', ['main-before', DEV_TIP]),
        commit('s2', "Merge branch 'main' into codex/sync-main-20260824", ['s1', DEV_TIP]),
      ]),
      pr(5, 'main', [commit('s3', 'anything', ['x', DEV_TIP])]),
      // #2162: named sync/…, and its promotion landed as ONE commit.
      pr(2162, 'sync/main-into-dev-0.1.31', [commit('s4', "Merge branch 'dev' into sync/main-into-dev-0.1.31", ['x', DEV_TIP])]),
      // #1785: an unlisted name, carrying a single-commit promotion.
      pr(1785, 'claude/ship-next-1719-8mj5i4', [
        commit('s5', 'Promote dev → main: release 0.1.29-alpha.0 + 63 commits', ['m']),
        commit('s6', 'merge', ['s5', DEV_TIP]),
      ]),
    ],
    (oid) => oid === DEV_TIP,
  )
  assert.equal(report.prs, 0)
  assert.equal(report.syncBacks, 4)
  assert.equal(report.resyncs, 0)
})

test('MUTATION PROOF: `main` merged into a work branch is not counted as a resync', () => {
  // main's tip is on dev and outside the PR, so the parent test alone would
  // count it — the subject decides this one.
  const report = summarizePullRequests(
    [pr(6, 'feature/thing', [
      commit('t1', 'feat: x', ['base']),
      commit('t2', "Merge remote-tracking branch 'origin/main' into feature/thing", ['t1', DEV_TIP]),
      commit('t3', 'merge origin/main into feature/thing', ['t2', DEV_TIP]),
    ])],
    (oid) => oid === DEV_TIP,
  )
  assert.equal(report.resyncs, 0)
  assert.equal(report.mainMerges, 2)
  // A branch merely NAMED like main-ish is not main: 'maintenance' merged in
  // is not a main merge, so its dev-side parent still makes it a resync.
  assert.equal(
    summarizePullRequests([pr(7, 'feat/x', [commit('u1', 'x', ['b']), commit('u2', "Merge branch 'maintenance' into feat/x", ['u1', DEV_TIP])])], (o) => o === DEV_TIP).resyncs,
    1,
  )
})

test('the entry point counts a fixture resync and names the PR', () => {
  const out = runOnFixture({
    prs: [pr(3196, 'sync-3019', [commit('e1', 'feat: x', ['base']), commit('e2', "Merge remote-tracking branch 'origin/dev' into HEAD", ['e1', DEV_TIP])])],
    onDev: [DEV_TIP],
  })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /stale-branch resyncs: {6}1/)
  assert.match(out.stdout, /sync-3019 \(#3196\) — 1 resync/)
})

test('MUTATION PROOF: a window with no merged PR refuses instead of printing the target state', () => {
  // The bug #3228 fixed: the dev-history meter printed "✓ … target state"
  // over a window whose resyncs it could no longer see. An empty read is not
  // a clean one.
  const out = runOnFixture({ prs: [], onDev: [] })
  assert.equal(out.status, 1)
  assert.doesNotMatch(out.stdout, /target state/)
  assert.match(out.stderr, /nothing was measured/)
})

test('a clean window with PRs prints the target state and how many PRs it read', () => {
  const out = runOnFixture({ prs: [pr(9, 'feat/clean', [commit('f1', 'feat: y', ['base'])])], onDev: [] })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /across 1 PRs\. This is the target state/)
})

test('a space-separated flag is refused, never silently defaulted', () => {
  // `--since 2026-09-08` used to fall back to the 7-day default without a word.
  assert.throws(() => parseArgs(['--since', '2026-09-08']), /--since=<value>/)
  assert.throws(() => parseArgs(['--until=last week']), /YYYY-MM-DD/)
  assert.equal(parseArgs(['--since=2026-09-08']).since, '2026-09-08')
  const out = spawnSync(process.execPath, [SCRIPT, '--since', '2026-09-08'], { encoding: 'utf8' })
  assert.equal(out.status, 2)
})

test('the report groups by branch, so a branch reused across PRs reads as one problem not several', () => {
  const report = summarizePullRequests(
    [
      pr(10, 'claude/long-lived', [commit('g1', 'x', ['base']), commit('g2', 'merge', ['g1', DEV_TIP])]),
      pr(11, 'claude/long-lived', [
        commit('g3', 'y', ['base']),
        commit('g4', 'merge', ['g3', DEV_TIP]),
        commit('g5', "Merge remote-tracking branch 'origin/claude/long-lived' into claude/long-lived", ['g4', 'g3']),
      ]),
      pr(12, 'fix/other', [commit('h1', 'z', ['base']), commit('h2', 'merge', ['h1', DEV_TIP])]),
      pr(13, 'feat/clean', [commit('k1', 'feat(x): something ordinary (#1)', ['base'])]),
    ],
    (oid) => oid === DEV_TIP,
  )
  assert.equal(report.prs, 4)
  assert.equal(report.resyncs, 3)
  assert.equal(report.divergences, 1)
  assert.equal(report.branches.length, 2)
  // Ordered worst-first: the branch to talk about is the one at the top.
  assert.deepEqual(report.branches[0], { branch: 'claude/long-lived', resync: 2, divergence: 1, prs: [10, 11] })
})

test('a clean window reports zero and lists no branches — the #1500 target state', () => {
  const report = summarizePullRequests([pr(14, 'feat/a', [commit('m1', 'feat(a): one (#1)', ['base'])])], () => true)
  assert.equal(report.resyncs, 0)
  assert.equal(report.divergences, 0)
  assert.deepEqual(report.branches, [])
})

test('MUTATION PROOF: without a resolvable origin/dev the report refuses instead of reading every resync as "other"', () => {
  // Outside a clone (or with no origin/dev) every ancestry check fails, and
  // the first cut of #3228 then printed the target state over 0 resyncs.
  const dir = mkdtempSync(join(tmpdir(), 'branch-hygiene-nogit-'))
  const out = spawnSync(process.execPath, [SCRIPT, '--since=2026-09-16'], { encoding: 'utf8', cwd: dir })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /origin\/dev does not resolve/)
  assert.doesNotMatch(out.stdout, /target state/)
})

test('merges it cannot classify withhold the target-state verdict', () => {
  const out = runOnFixture({
    prs: [pr(3107, 'wip', [commit('w1', 'x', ['base']), commit('w2', "Merge commit '58e181d6' into wip-remote-tip", ['w1', 'elsewhere'])])],
    onDev: [],
  })
  // No verdict is not a clean result, so it must not exit 0 (#3228 round 2).
  assert.equal(out.status, 1, out.stderr)
  assert.doesNotMatch(out.stdout, /target state/)
  assert.match(out.stdout, /could not be classified — no verdict/)
})
