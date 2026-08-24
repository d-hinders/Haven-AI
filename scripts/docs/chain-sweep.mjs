// Repo-wide sweep for PRE-EXISTING `last-verified` chain breaks (#1876).
//
// `scripts/docs/chain-integrity.mjs` is DIFF-SCOPED: it only compares docs a
// change touched, so a break already sitting on `dev` is examined by nothing.
// This replays the same exported containment rule over every doc's own history
// and reports the drops whose references are STILL missing today.
//
//   node scripts/docs/chain-sweep.mjs [--since=YYYY-MM-DD] [--ref=<git ref>]
//
// --since defaults to the day the chaining convention took hold (#1496).
// Before it, REPLACING the note was the convention, so every doc reads as
// broken and the signal is zero — the same retroactivity limit
// chain-integrity-backtest.mjs records.
//
// --ref defaults to `origin/dev`: the tree whose docs are swept and whose
// `last-verified` lines count as "today". It is settable so the sweep can be
// pointed at a branch — which is how its own test proves the classification
// below on real history rather than on hand-written strings.
//
// ## Declared resets are CLASSIFIED, not suppressed (#1885)
//
// A compaction declared with `chain-reset(#N)` is invisible to a naive replay:
// the marker sits on TODAY's line, while the replay tests `CHAIN_RESET_RE`
// against the line as it stood at the compacting commit — which has no marker
// and, history being immutable, never will. So the two #1496 docs were
// reported as unrestored breaks in every run, forever, and the next reader
// re-did #1882's triage to reach the same "not a defect" answer (#1884 proved
// this with output rather than argument).
//
// The obvious fix — honour `CHAIN_RESET_RE` on the doc's CURRENT line — is
// wrong, and being wrong quietly is the failure mode this whole subsystem
// exists to prevent. One declared compaction would excuse EVERY break in that
// doc's history, before and after it, including an unrelated genuine drop. A
// false negative in the one tool built to find silent losses is a worse defect
// than the false positive it tidies away.
//
// So the reset is bound to the ONE commit it describes: the commit that
// INTRODUCED the declaration — either by writing the marker itself, or, for
// the pre-#1843 compactions whose syntax did not exist yet, by being the
// commit that compacted the chain down to the declaring issue's entry alone.
// Every other break in the doc was authored by some other issue and stays
// reported.
//
// "Introduced" is the load-bearing word, not belt-and-braces. The marker
// persists on the line for good, so a genuine drop made a week LATER still has
// the marker on both sides of its pair — and `checkChain` still calls it
// `reset`. Anything short of "introduced here" therefore excuses the whole
// file's future, which is the blanket check wearing a disguise.
//
// A declaration that matches no break is reported too, as an unmatched
// declaration. A marker with nothing to excuse is either a typo or a chain
// that was already repaired, and a silently inert escape hatch is how the next
// one gets trusted without being checked.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lastVerifiedLine, issueRefs, checkChain, CHAIN_RESET_RE } from './chain-integrity.mjs'
import { REPO_ROOT, ROOT_DOCS } from './validate-frontmatter.mjs'

/**
 * Every `chain-reset(#N)` declaration on a line, in source order.
 *
 * Built from `CHAIN_RESET_RE.source` rather than a second literal so the
 * MARKER SYNTAX has exactly one definition. `chain-integrity.mjs` documents
 * why the issue number is part of that syntax: an exception needs an owner,
 * and a bare `/chain-reset\b/` would let prose about resets excuse a deletion.
 */
export function declaredResetIssues(line) {
  const out = []
  const seen = new Set()
  for (const m of line.matchAll(new RegExp(CHAIN_RESET_RE.source, 'g'))) {
    const ref = m[0].slice(m[0].indexOf('#'), -1)
    if (seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

/**
 * Pure core. Classify one historical `prev → next` pair against the doc's
 * CURRENT line.
 *
 * Returns { status, stillLost, declaredBy }.
 *  - 'ok'              — nothing dropped, or everything dropped is back today.
 *  - 'declared-reset'  — still lost, and a `chain-reset` declaration is bound
 *                        to THIS commit. Reported, counted separately, not a
 *                        defect.
 *  - 'unrestored'      — still lost with nothing declaring it. The finding.
 */
export function classifyBreak({ prevLine, nextLine, nowLine }) {
  const r = checkChain(prevLine, nextLine)
  if (r.status === 'ok') return { status: 'ok', stillLost: [], declaredBy: null }

  // Only what is STILL lost — a later commit may have restored it. Compare
  // against parsed refs, never `nowLine.includes(ref)`: a raw substring test
  // lets `#1447` on the line vouch for a dropped `#144`, so a genuinely lost
  // short ref would be silently omitted from the report (#1883).
  const nowRefs = issueRefs(nowLine)
  const stillLost = r.dropped.filter((ref) => !nowRefs.includes(ref))
  if (!stillLost.length) return { status: 'ok', stillLost: [], declaredBy: null }

  // A declaration excuses this commit only if the DECLARATION WAS INTRODUCED
  // HERE. `checkChain`'s own `reset` status is not usable for that and must
  // not be short-circuited to: the marker stays on the line for good, so on
  // every LATER commit the historical `next` line still carries it and
  // `checkChain` still says `reset`. Trusting it re-opens the blanket hole in
  // disguise — which is exactly how the first draft of this function passed
  // its "declared reset" test and failed its masking test.
  const prevRefs = issueRefs(prevLine)
  const nextRefs = issueRefs(nextLine)
  const introducedHere = (issue) => {
    // (a) This commit wrote the marker: declared BY the commit, at the time.
    const marker = `chain-reset(${issue})`
    if (nextLine.includes(marker) && !prevLine.includes(marker)) return true
    // (b) The marker arrived later (the pre-#1843 compactions, whose syntax
    // did not exist yet), so nothing on the historical line can name it. The
    // binding is then the COMPACTION SHAPE itself: the commit that replaced
    // the chain with the declaring issue's entry alone, leaving `#N` as the
    // line's only reference.
    //
    // "First commit to cite #N" was the first attempt and is WRONG — review
    // found the hole and it is reproduced verbatim in the test suite. This
    // repo's notes routinely cite an older issue in prose ("#1500: … plan
    // tracked in #1496"), which `issueRefs` cannot tell from an entry. So an
    // unrelated commit that merely MENTIONED #1496 while silently dropping
    // #200 became the commit #1496's declaration excused, and the drop
    // vanished from the report. A prose mention always sits alongside the
    // entries it did not delete, so requiring `#N` to stand alone is exactly
    // what a mention cannot satisfy.
    //
    // Deliberately narrow, and it fails toward REPORTING: a partial
    // compaction does not match, so it is listed as unrestored AND as an
    // unmatched declaration — a human-readable "your marker did not bind",
    // never silence.
    return nextRefs.length === 1 && nextRefs[0] === issue && !prevRefs.includes(issue)
  }
  const candidates = [...new Set([...declaredResetIssues(nextLine), ...declaredResetIssues(nowLine)])]
  const declaredBy = candidates.find(introducedHere)
  if (declaredBy) return { status: 'declared-reset', stillLost, declaredBy }

  return { status: 'unrestored', stillLost, declaredBy: null }
}

// Slice at the FIRST `=`, never `split('=').pop()`: that helper was safe while
// the only argument was a date, and silently truncates `--ref=release=1.0` to
// `1.0` — a ref that does not resolve, an empty doc list, and a clean-looking
// run that checked nothing.
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`))
  return hit === undefined ? d : hit.slice(n.length + 3)
}
const g = (a) => { try { return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null } }

function main() {
  const since = arg('since', '2026-08-15')
  const ref = arg('ref', 'origin/dev')

  const docs = (g(['ls-tree', '-r', '--name-only', ref]) || '').split('\n')
    .filter((p) => p.endsWith('.md') && (p.startsWith('docs/') || ROOT_DOCS.includes(p)))

  const unrestoredDocs = []
  const resetDocs = []
  const unmatched = []
  let scanned = 0
  for (const rel of docs) {
    const nowLine = lastVerifiedLine(g(['show', `${ref}:${rel}`]) || '')
    if (!nowLine) continue
    scanned++
    // No `--follow`: see the residual note at the foot of this file.
    const revs = (g(['log', '--format=%H %ad', '--date=short', `--since=${since}`, ref, '--', rel]) || '')
      .trim().split('\n').filter(Boolean).map((l) => l.split(' '))
    const hits = []
    const resets = []
    for (let i = 0; i < revs.length; i++) {
      const [rev, date] = revs[i]
      const nextLine = lastVerifiedLine(g(['show', `${rev}:${rel}`]) || '')
      const prevRaw = g(['show', `${rev}^:${rel}`])
      const prevLine = prevRaw && lastVerifiedLine(prevRaw)
      if (!prevLine || !nextLine || prevLine === nextLine) continue
      const c = classifyBreak({ prevLine, nextLine, nowLine })
      if (c.status === 'unrestored') hits.push({ rev: rev.slice(0, 8), date, stillLost: c.stillLost })
      if (c.status === 'declared-reset') resets.push({ rev: rev.slice(0, 8), date, ...c })
    }
    if (hits.length) unrestoredDocs.push({ rel, hits })
    if (resets.length) resetDocs.push({ rel, resets })
    // A declaration on today's line that excused nothing. Not a failure —
    // but never silent, or the next inert marker is trusted unchecked.
    const matched = new Set(resets.map((r) => r.declaredBy))
    for (const issue of declaredResetIssues(nowLine)) {
      if (!matched.has(issue)) unmatched.push({ rel, issue })
    }
  }

  for (const d of unrestoredDocs) {
    console.log(`\n✗ ${d.rel}`)
    for (const h of d.hits) console.log(`    dropped ${h.stillLost.join(', ')} at ${h.rev} (${h.date}) — still missing`)
  }
  for (const d of resetDocs) {
    console.log(`\nℹ ${d.rel}`)
    for (const r of d.resets) {
      console.log(`    declared reset (${r.declaredBy}) at ${r.rev} (${r.date}) — dropped ${r.stillLost.join(', ')}`)
    }
  }
  for (const u of unmatched) {
    console.log(`\n? ${u.rel}\n    chain-reset(${u.issue}) declared on today's line matches no break since ${since}`)
  }
  console.log(
    `\n${unrestoredDocs.length} doc(s) carry an unrestored chain break since ${since}, ` +
    `${resetDocs.length} declared reset, of ${scanned} with a last-verified line (${ref}).`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

// ## Residual: no `--follow` (#1884, re-decided in #1885)
//
// `git log … -- <path>` stops at a rename, so a doc renamed INSIDE the
// --since window hides the breaks it took under its old path. The same
// limitation as the sibling `chain-integrity-backtest.mjs`.
//
// It stays, deliberately. `--follow` alone would make this WORSE, not better:
// it would add pre-rename revisions to `revs`, and the `git show <rev>:<rel>`
// / `<rev>^:<rel>` lookups below use TODAY's path, which does not exist at
// those revisions — so every added revision resolves to null, is skipped, and
// the run gains cost and a false air of completeness while finding nothing. A
// real fix has to track the old path per commit (`--follow --name-status`, or
// a rename map) and rewrite both lookups, which is a different change from
// this one. Measured before deferring: `git log --diff-filter=R -M
// --since=2026-08-15 origin/dev -- docs/` reports ZERO renames, so the gap is
// currently empty rather than merely tolerated.
