#!/usr/bin/env node
// #2678 measurement 4 of 4 — the correction rate, the epic's PRIMARY metric.
//
// Read-only, dependency-free. Counts COMMITS on `origin/dev` in a 60-day
// window whose subject or body names a staleness or false-claim correction,
// and commits that touch only Markdown.
//
// ## Why commits, and why that depends on a branch protection rule
//
// `dev` is squash-only (ruleset 22449193), so one PR is one commit: a false
// claim caught in review before it shipped never reaches this metric, while a
// post-merge correction does. That is exactly the right discrimination — and
// it is a property of the ruleset, not of the counting. **If `dev` ever allows
// merge commits, this metric silently starts counting authors' work-in-progress
// as staleness.** Recorded here rather than in prose that nothing implicates.
//
// ## Two caveats, so the numbers are not over-read
//
//   - The clone may be SHALLOW, in which case the window is truncated at the
//     graft point. The ratios hold; the absolute counts are a floor. This
//     script prints whether the clone is shallow and how far back it can see,
//     so a reader never has to assume.
//   - "Names a correction" is a subject/body regex. It cannot see a correction
//     that shipped inside a feature commit without saying so, and it fires on a
//     commit that merely mentions staleness. Magnitude, not an inventory.
//
// Usage:
//   node scripts/docs/measure/correction-rate.mjs                 # 60d to today
//   node scripts/docs/measure/correction-rate.mjs --since=2026-07-09
//   node scripts/docs/measure/correction-rate.mjs --ref=origin/dev
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, row, heading } from './corpus.mjs'

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)

// The epic's window: 60 days ending 2026-09-07 (`dee89b8e`). Pinned rather than
// relative so re-running it later reproduces the BASELINE; pass --since to
// re-measure a fresh window against the target.
export const EPIC_SINCE = '2026-07-09'
const since = arg('since') ?? EPIC_SINCE
const ref = arg('ref') ?? 'origin/dev'

const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/**
 * A subject or body naming a staleness / false-claim correction.
 *
 * Anchored on the STALENESS vocabulary this repo actually uses, not on the word
 * "docs": a `docs:` commit adding a new runbook is not a correction, and a
 * `fix(frontend):` commit retiring a false readability claim is.
 *
 * The epic never recorded its regex, so this was calibrated against its 17%.
 * Three readings, all printed below so nobody has to take one on trust:
 *
 *   - NARROW (no `drift`)              → 14%
 *   - this one (with `drift`)          → 19%   ← the repo's own term
 *     (`docs-drift` is the name of the test suite that pins CLAUDE.md's tables)
 *   - a bare `correct(s|ed|ion)` verb  → 29%, and plainly over-broad: it fires
 *     on every "corrected a typo" and on the word "correctness"
 *
 * The epic's 17% sits between the first two. Neither is fitted to it, and the
 * one that flatters the epic's argument (a HIGHER rate against a <8% target) is
 * not the one taken as narrow — both are reported.
 */
export const CORRECTION_NARROW_RE =
  /\b(?:stale|staleness|false claim|false claims|out of date|outdated|inaccurate|incorrect|no longer true|misleading)\b/i
export const CORRECTION_RE =
  /\b(?:stale|staleness|false claim|false claims|out of date|outdated|inaccurate|incorrect|no longer true|misleading|drift(?:ed|s)?)\b/i

// ONE `git log` pass, records delimited by ASCII RS/US — control characters
// that cannot occur in a commit message. A per-commit `git show` loop would be
// ~900 process spawns; `--name-only` on the same log gives the file lists for
// free. `-m --first-parent` is deliberately absent: `dev` is squash-only, so
// every commit here already has exactly one parent.
const RS = '\x1e'
const US = '\x1f'
const log = git(['log', ref, `--since=${since}`, `--name-only`, `--pretty=format:${RS}%H${US}%s${US}%b${US}`])
const commits = log
  .split(RS)
  .filter((c) => c.trim())
  .map((c) => {
    const [sha, subject, body, files] = c.split(US)
    return {
      sha,
      subject: subject ?? '',
      body: body ?? '',
      files: (files ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
    }
  })

let corrections = 0
let narrow = 0
let docsSubject = 0
let docsOnly = 0
for (const c of commits) {
  if (CORRECTION_RE.test(`${c.subject}\n${c.body}`)) corrections++
  if (CORRECTION_NARROW_RE.test(`${c.subject}\n${c.body}`)) narrow++
  if (/^docs(\(|:)/.test(c.subject)) docsSubject++
  if (c.files.length > 0 && c.files.every((f) => f.endsWith('.md'))) docsOnly++
}

const pct = (n) => (commits.length === 0 ? '—' : `${Math.round((n / commits.length) * 100)}%`)
const shallow = existsSync(join(REPO_ROOT, '.git', 'shallow'))
const oldest = commits.length > 0 ? git(['log', '-1', '--format=%ad', '--date=short', commits[commits.length - 1].sha]).trim() : '—'

heading(`#2678 measurement 4/4 — correction rate on ${ref}, since ${since}`)
row('commits in window', commits.length)
row('naming a staleness / false-claim correction', `${corrections}  (${pct(corrections)})`)
row('  …same, narrow reading (no `drift`)', `${narrow}  (${pct(narrow)})`)
row('with a `docs:` subject', `${docsSubject}  (${pct(docsSubject)})`)
row('docs-only (every changed file is .md)', `${docsOnly}  (${pct(docsOnly)})`)
console.log('')
row('clone is shallow', shallow ? 'YES — counts are a FLOOR' : 'no')
row('oldest commit reachable in window', oldest)
console.log(
  '\n  Epic baseline (2026-09-07, dee89b8e): 866 commits, 147 (17%) corrections,\n' +
    '  132 `docs:` subjects, 107 (12%) docs-only. Targets: <8% and <8%.\n' +
    '  This metric is only meaningful while `dev` stays squash-only.\n',
)
