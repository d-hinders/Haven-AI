#!/usr/bin/env node
// `last-verified` chain-integrity check (#1843, extended by #2477 and #2504).
//
// ## The defect this exists for
//
// Every other doc gate asks whether a doc was TOUCHED, or whether its
// front-matter is well-formed. None asks whether it still says what it said.
// So a deletion is the one edit that satisfies all of them: `docs:coupling`
// goes green because the doc was changed (exactly what it wanted),
// `docs:check` because the header still parses, and the staleness audit
// IMPROVES because the edit bumped `last-verified`.
//
// The incident (#1843, from PRs #1832/#1841): two PRs each prepended a note to
// `docs/contributing/ship-playbooks/frontend.md`'s `last-verified` line — the
// #1496 collision. A conflict resolution PICKED A SIDE instead of chaining,
// dropping the `#1816` entry from the chain along with the §4 paragraph it
// pointed at. Valid front-matter, coherent body, every gate green.
//
// ## The rule
//
// A `last-verified` note line is a CHAIN: one entry per issue that re-verified
// the doc, newest-first or oldest-first depending on the doc's own convention.
// The convention is "chain both notes, never choose one" (#1496), and that is
// machine-checkable without knowing which order a doc uses:
//
//   every issue reference on the PREVIOUS line must still appear on the NEW
//   one.
//
// Prepending (`#new, #old…`) and appending (`#old…, #new`) both satisfy it, so
// the check never has to know which order a given doc uses. Deleting an entry
// does not. #1843 proposed the stricter order-preserving SUBSEQUENCE; the
// measurement that rejected it is recorded on `checkChain` below.
//
// ## #2477 — the check was blind to the OPPOSITE failure
//
// The containment rule only detects entries going MISSING. A merge that
// CONCATENATED the chain instead of interleaving it (entry A then entry B,
// twice) loses nothing, so every "did we drop history" question answers yes
// and the gate reports `✓ chains intact` on a chain that has doubled. #2477's
// incident: `docs/operations/mcp-runtime-compatibility.md`'s `last-verified`
// line reached 774,483 bytes on `dev` through repeated concatenation, all of it
// invisible to the containment check.
//
// So the gate also asks a question of the CANDIDATE chain itself: does the same
// ENTRY — same leading issue ref AND same prose — appear more than once? A
// concatenating merge produces exactly that; legitimate interleaving never
// does, because every entry's prose is written once.
//
// #2637 CHANGED THE SHAPE, and it is worth being exact about what that bought,
// because the issue that asked for it predicted something else. The chain used
// to be one front-matter comment line; it is now a `verified:` block list, one
// entry per line, newest first.
//
// The prediction was that git would then merge concurrent verifications as
// ordinary line insertions. It does NOT — measured both ways round: two
// branches each inserting a different entry at the same anchor conflict in
// git's line-based merge whether the newest entry goes first or last. The
// conflict did not go away.
//
// What went away is the DAMAGE. The conflict is now the two inserted lines,
// with every other entry sitting outside the hunk as untouched context, so the
// resolution is "keep both" and no unrelated entry is in reach. In the old
// shape the identical conflict presented as one line — 37,561 bytes on
// `delegation-rail-security-model.md` — that both sides had rewritten whole,
// and hand-merging that line is precisely how #1843 dropped entries and how
// #2504 rewrote them in place. Both failures needed a human editing a chain
// they could not read; neither is reachable from a two-line hunk.
//
// The byte ceiling and its advisory band went with the old shape (#2477,
// #2562). They existed because an unbounded single line is a cost every reader
// pays; a list has no such line, and `git diff` on one added entry is one added
// line rather than a rewritten 37 KB.
//
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT, ROOT_DOCS, walk, parseFrontMatter } from './validate-frontmatter.mjs'

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // `git show <rev>:<path>` on a file that did not exist at <rev> is an
    // EXPECTED miss (a doc added by this change). Letting its `fatal:` reach
    // the log makes a passing run read like a broken one.
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * The RAW `last-verified` line from the front-matter block — not the parsed
 * scalar. `parseFrontMatter` strips the trailing ` # comment`, and the chain
 * lives entirely inside that comment, so the parsed value is exactly the half
 * this check cannot use.
 */
export function lastVerifiedLine(raw) {
  if (!raw.startsWith('---')) return null
  const lines = raw.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return null // end of front-matter
    if (/^last-verified:/.test(lines[i])) return lines[i]
  }
  return null
}

/** Issue references (`#123`) in source order, de-duplicated. */
export function issueRefs(line) {
  const seen = new Set()
  const out = []
  for (const m of line.matchAll(/#(\d+)/g)) {
    const ref = `#${m[1]}`
    if (seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

/**
 * THE ENTRY TEXT of a chain line, split on the convention's own separator.
 *
 * A `last-verified` chain is a sequence of ENTRIES — one re-verification note
 * per issue — joined by the `Prior:` chain-word: "#1816: … Prior: #1800: …".
 * The separator is the chain's own structure, NOT every `#NNN`: an entry's
 * prose routinely cites other issues ("#1816: §4 reuses #1800's mechanism"),
 * so splitting on every ref would invent entries and mis-fire the duplicate
 * check on citations that were never separate entries.
 *
 * Two boundary variants exist in the wild:
 *   - `Prior: #2242` — the dominant form.
 *   - `Prior #2242` — a bare variant seen in the older tail (#1508), which
 *     only differs by the missing colon, so it is normalized before splitting.
 *
 * The pre-convention tail of some chains (entries from before the `Prior:`
 * separator took hold) is crammed without separators; those old entries stay
 * inside one segment. That is a deliberate limit, not a quiet bug — a
 * concatenation that duplicates the chain duplicates its segments verbatim,
 * so a doubled crammed tail is still caught as a byte-identical duplicate.
 */
export function chainNoteBody(line) {
  const m = line.match(/^last-verified:\s*"[^"]*"\s*(#\s?)(.*)$/)
  if (!m) return ''
  let body = m[2]
  // The structural `# ` that opens the comment can itself be lost to an edit —
  // `docs/architecture/00-overview.md` carried `"2026-08-25"  #1992: …` for one
  // commit in August, the marker replaced by a space. Without this branch the
  // regex above eats the FIRST ENTRY's own `#` as if it were the marker, the
  // body reads `1992: …` where the base read `#1992: …`, and #2504's
  // containment check reports an altered entry against text that is
  // byte-identical. That is a false positive found by review, and it would have
  // sent triage looking for a rewrite that never happened. A `#` immediately
  // followed by a digit was never the marker: markers are followed by a space.
  if (m[1] === '#' && /^\d/.test(body)) body = `#${body}`
  return body.replace(/\bPrior\s+#/g, 'Prior: #') // bare "Prior #N" boundary variant
}

export function chainEntries(line) {
  const body = chainNoteBody(line)
  if (!body) return []
  return body
    .split(/\s+Prior:\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The entry's head — the leading ref CLUSTER for issue entries ("#2100/#2101
 * (+#2098)"), or the release token for release entries ("0.1.31-alpha.0").
 * The issue's subtlety: an entry's leading ref is its IDENTITY; refs cited in
 * its prose belong to OTHER entries and must not make this entry look
 * duplicated. headOf reads only the ref at the very start of the entry text.
 */
export function headOfEntry(entry) {
  const m = entry.match(/^#(\d+)((?:\/#\d+)*)(\s*\(\s*\+\s*#\d+(?:\s*\/\s*#\d+)*\s*\))?/)
  if (m) return `#${m[1]}${m[2] || ''}${m[3] ? m[3].replace(/\s+/g, '') : ''}`
  const rel = entry.match(/^(?:Release\s+)?([0-9]\.[0-9][^\s:]*)/)
  if (rel) return rel[1]
  return null
}

/**
 * The escape hatch is the documented MARKER SYNTAX, not the word. A bare
 * `/chain-reset\b/` would let a note that merely discusses chain resets in
 * prose ("clarified when a chain-reset is not needed") excuse a real deletion —
 * the gate reporting green without asking its question, inside the one branch
 * built to be an exception. The issue number is required so the exception has
 * an owner.
 */
export const CHAIN_RESET_RE = /chain-reset\(#\d+\)/

/**
 * Read a doc's chain in EITHER shape (#2637).
 *
 * The chain used to be one front-matter comment line that every PR prepended
 * to. It is now a `verified:` block list, newest first, one entry per line —
 * which is what lets git merge two concurrent verifications as ordinary line
 * insertions instead of a conflict about nothing (#1496).
 *
 * This reader accepts both, and that is not a courtesy: the checks below
 * compare a BASE against a HEAD, and across the migration the base is the old
 * shape while the head is the new one. A reader that understood only one shape
 * would have to special-case the transition; understanding both means the
 * comparison is the same comparison it always was, and every PR opened before
 * the migration keeps working after it.
 *
 * Returns `{ shape, date, entries }`, entries newest-first in both shapes.
 */
export function readChain(raw) {
  const parsed = parseFrontMatter(raw)
  if (parsed.ok && Array.isArray(parsed.data.verified)) {
    return {
      shape: 'list',
      date: parsed.data['last-verified'] ?? null,
      entries: parsed.data.verified.filter(Boolean),
    }
  }
  const line = lastVerifiedLine(raw)
  if (!line) return { shape: null, date: null, entries: [] }
  const m = line.match(/^last-verified:\s*"([^"]*)"/)
  return { shape: 'line', date: m ? m[1] : null, entries: chainEntries(line) }
}

/**
 * A doc's chain as ONE string, whichever shape it is stored in (#2637).
 *
 * The history tools — `chain-sweep.mjs` and `chain-integrity-backtest.mjs` —
 * replay commits from before the migration as well as after it, and every
 * function they lean on (`issueRefs`, `checkChain`, `CHAIN_RESET_RE`,
 * `declaredResetIssues`) is a substring or ref operation over the old line.
 * Rather than teach each of them two shapes, this presents the list shape in
 * the legacy join so all of them stay correct with no change.
 *
 * Without it those tools read a migrated doc as `last-verified: "<date>"` with
 * no refs at all, and report the migration commit as having dropped every
 * entry in the repository — a permanent false BROKEN across ~78 docs, since
 * history does not change. Found in review, not by a test, because the tools
 * have no fixture spanning the migration.
 */
export function chainTextOf(raw) {
  const c = readChain(raw)
  if (c.shape === null) return null
  if (c.shape === 'line') return lastVerifiedLine(raw)
  return c.entries.length ? `last-verified: "${c.date ?? ''}" # ${c.entries.join(' Prior: ')}` : null
}

/** Every issue ref appearing anywhere in a chain's entries. */
export function entriesRefs(entries) {
  return new Set(entries.flatMap((e) => issueRefs(e)))
}

/**
 * The three checks, as ONE pass over entry SETS (#2637).
 *
 * Before the list shape these were three functions reading one long string:
 * `checkChain` diffed issue refs, `chainAnomalies` counted repeated segments,
 * `checkEntriesVerbatim` asked whether each base entry still appeared inside
 * the head's text. All three existed in that form because the entries were not
 * separable — they were segments of a line, recovered by splitting on the
 * `Prior:` chain-word. One entry per line makes them separable, so the same
 * three questions become set operations and the answers get sharper:
 *
 *  - **dropped** (#1843) — a base entry is gone AND none of its refs survive.
 *  - **altered** (#2504) — a base entry is gone but its ref is still there, so
 *    the entry was rewritten rather than removed. The distinction is the same
 *    one the old pair drew; it is now decided in one place instead of two.
 *  - **duplicated** (#2477) — the head lists one entry twice, which is what a
 *    merge that CONCATENATED two chains produces instead of interleaving them.
 *
 * `chain-reset(#N)` still excuses losses, and still only in the documented
 * marker form: a note that merely discusses resets in prose must not excuse a
 * real deletion.
 */
export function checkChainEntries(prevEntries, nextEntries) {
  const nextNorm = nextEntries.map(normalizeEntryText)
  const nextSet = new Set(nextNorm)
  const survivingRefs = entriesRefs(nextEntries)
  const reset = nextEntries.some((e) => CHAIN_RESET_RE.test(e))

  const dropped = []
  const altered = []
  if (!reset) {
    for (const entry of prevEntries) {
      if (nextSet.has(normalizeEntryText(entry))) continue
      const head = headOfEntry(entry)
      const refs = head ? head.match(/#\d+/g) : null
      if (refs && refs.some((r) => survivingRefs.has(r))) {
        altered.push({ head, excerpt: entry.slice(0, 96) })
      } else {
        dropped.push(head ?? entry.slice(0, 48))
      }
    }
  }

  const counts = new Map()
  for (const n of nextNorm) counts.set(n, (counts.get(n) || 0) + 1)
  const duplicates = []
  for (const [text, count] of counts) {
    if (count < 2) continue
    duplicates.push({ head: headOfEntry(text), count, excerpt: text.slice(0, 96) })
  }
  duplicates.sort((a, b) => b.count - a.count)

  return { dropped, altered, duplicates, reset }
}

/**
 * Pure core. Given the previous and current raw `last-verified` lines, decide
 * whether the chain survived.
 *
 * Returns { status: 'ok' | 'reset' | 'broken', dropped }.
 *  - 'ok'      — nothing lost (or nothing to lose).
 *  - 'reset'   — entries lost, but the line carries `chain-reset(...)`: allowed
 *                and reported.
 *  - 'broken'  — entries lost silently. This is the failure.
 *
 * CONTAINMENT, not the order-preserving subsequence #1843 proposed. The
 * stricter rule was written, then backtested over every feature PR merged into
 * `dev` since the chaining convention took hold (re-run it yourself with
 * `chain-integrity-backtest.mjs`): it caught **zero** additional real defects and
 * produced **two** false positives — #1832 and #1601 — for the same benign
 * reason. A new note routinely CITES an older issue in its prose ("#1816: …
 * reuses #1800's mechanism"), so that older reference appears once at the front
 * and once in its own chain entry. De-duplicating to the first occurrence then
 * makes the surviving order differ from the previous line's, and the check
 * reports a reordering that never happened.
 *
 * Ordering was never the defect anyway: the incident dropped an entry. A rule
 * that fires on both is one nobody can act on, and it would have gone red on
 * the very resolution that FIXED #1843's incident.
 */
export function checkChain(prevLine, nextLine) {
  const prev = issueRefs(prevLine)
  const next = issueRefs(nextLine)
  if (prev.length === 0) return { status: 'ok', dropped: [] }
  const dropped = prev.filter((r) => !next.includes(r))
  if (dropped.length === 0) return { status: 'ok', dropped: [] }
  if (CHAIN_RESET_RE.test(nextLine)) return { status: 'reset', dropped }
  return { status: 'broken', dropped }
}

/**
 * Size-ceiling backstop (#2477). The chain line is one line in a front-matter
 * comment — nearly every parser that reads the doc reads the whole line, so a
 * runaway chain shows up as startup cost on every tool and every agent session
 * long before anyone reads the entries. A concatenating merge doubles the line
 * at once, exactly the growth nothing else in this check is shaped to notice.
 *
 * 64 KiB is just under 1.5× the largest healthy chain in the repo today
 * (docs/product/design-system.md, 44.8 KB) and would have gone red on the
 * actual incident curve: the mcp-runtime-compatibility chain sat at 34 KB when
 * it was clean (2026-08-27), and the first concatenating merge took it to
 * 172 KB in a single commit (2026-08-28). A chain that legitimately grows past
 * it is itself a decision worth making on purpose, and there is no plain-word
 * escape hatch: `chain-reset(#N)` is documented for compaction, and a reset
 * does not make a doubled line smaller than the ceiling.
 */
/**
 * The third failure mode (#2504): an entry that SURVIVES by reference but not
 * by text.
 *
 * `checkChain` asks whether each prior issue ref is still present, and
 * `chainAnomalies` asks whether any entry appears twice. Neither asks whether
 * the entry that is present still says what it said. A base-refresh conflict on
 * the `last-verified` scalar is resolved by hand, and a hand resolution can
 * keep the ref while rewriting, truncating or re-wording the prose behind it —
 * at which point the chain still passes both existing checks while the record
 * of what was verified, and what was explicitly NOT verified, has quietly
 * changed. A provenance chain whose entries can be edited in place is not
 * provenance.
 *
 * The rule is CONTAINMENT of the entry TEXT, deliberately not a subsequence or
 * an ordering rule. That stricter shape was written for #1843, backtested, and
 * rejected: zero additional real defects, two false positives (#1832, #1601)
 * from entries that legitimately cite each other. Interleaving reorders
 * entries on purpose — the incoming side's newest entry lands ahead of ours —
 * so an order-sensitive rule would go red on the very resolution this check
 * exists to require.
 *
 * Entries reported DROPPED by `checkChain` are excluded here. A deletion is
 * already named by that check, and reporting one defect under two names splits
 * the reader's attention between a real cause and its echo. What is left is
 * exactly the alteration case: the ref is still on the line, the text is not.
 *
 * `chain-reset(#N)` is honoured as it is everywhere else — a declared
 * compaction rewrites entries on purpose and says so.
 *
 * Returns { altered: [{ head, excerpt }] }.
 */
/**
 * The comparison form for #2504's containment test.
 *
 * "Byte-verbatim" is the rule the convention states, and it is very nearly the
 * rule this check enforces — but the replay over merged history turned up one
 * hit that was a full stop deleted from the end of an entry, against real
 * losses of chain text. A gate that goes red over a trailing period teaches
 * people to route around it, while a real loss is a change of MEANING that no
 * amount of whitespace or terminal punctuation can disguise: text that ends
 * early still fails containment after this normalisation.
 *
 * The replay, its window and what each hit turned out to be are recorded once,
 * in `docs/contributing/docs-quality-system.md` § `last-verified` chain
 * integrity. This comment carried its own copy of that account and was wrong
 * about two of the three hits for three commits running — the reason the
 * figures now live in one place.
 *
 * So: collapse internal whitespace runs, and ignore trailing whitespace and a
 * single terminal `.` — nothing else. Any change to a word is still a finding.
 */
export function normalizeEntryText(text) {
  return text.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim()
}

// RETAINED, NOT WIRED (#2637). `main()` now asks this question through
// `checkChainEntries`, which decides altered-vs-dropped in one pass over entry
// sets. This line-based form stays because `chain-integrity-backtest.mjs`
// replays it over history and its own unit tests pin the #2504 tolerance; it is
// NOT part of the live gate path, so do not read a change here as changing what
// CI enforces.
export function checkEntriesVerbatim(prevLine, nextLine) {
  if (CHAIN_RESET_RE.test(nextLine)) return { altered: [] }
  const body = normalizeEntryText(chainNoteBody(nextLine))
  if (!body) return { altered: [] }
  const survivingRefs = new Set(issueRefs(nextLine))
  const altered = []
  for (const entry of chainEntries(prevLine)) {
    if (body.includes(normalizeEntryText(entry))) continue
    const head = headOfEntry(entry)
    // A dropped entry is checkChain's finding, not this one. An entry whose
    // head is a release token rather than an issue ref has no ref to check, so
    // it is judged on its text alone.
    const refs = head ? head.match(/#\d+/g) : null
    if (refs && !refs.some((r) => survivingRefs.has(r))) continue
    altered.push({ head, excerpt: entry.slice(0, 96) })
  }
  return { altered }
}

function isDocPath(p) {
  if (!p.endsWith('.md')) return false
  return p.startsWith('docs/') || ROOT_DOCS.includes(p)
}

/**
 * Resolve the commit the candidate change should be compared against.
 *
 * BASE_SHA (CI) or --base= wins; otherwise `origin/dev`. Always reduced to the
 * MERGE BASE with HEAD: a two-dot comparison against a moving base branch
 * reports every doc `dev` advanced without you as a chain you broke — the same
 * flaw the coupling gate's three-dot range avoids.
 */
export function resolveBase() {
  const explicit = arg('base') || process.env.BASE_SHA
  // HEAD_SHA (CI) pins the comparison to the PR's own branch tip. Without it
  // the candidate side is the WORKING TREE, so a local run is valid before the
  // commit — which is when the skill runs it.
  const head = arg('head') || process.env.HEAD_SHA || null
  const ref = explicit || 'origin/dev'
  try {
    return { base: git(['merge-base', ref, head || 'HEAD']).trim(), head, ref }
  } catch {
    return { base: null, head, ref }
  }
}

/**
 * A `dev → main` promotion pull request carries nothing of its own: all but
 * the direct-push and admin-merge exceptions this repo documents elsewhere,
 * every commit in it already passed this check on the `dev` pull request that
 * introduced it, and its diff is weeks of history no promoter can act on. Left
 * in, it would go red on any chain edited before this check existed and block
 * the release path for archaeology — the same reason #1337 lets a provably
 * empty change-set through the coupling gate.
 *
 * Narrow on purpose: only `dev → main`. A `hotfix/*` into `main` is real work
 * and stays checked.
 */
export function isPromotionPR(env = process.env) {
  return env.GITHUB_HEAD_REF === 'dev' && env.GITHUB_BASE_REF === 'main'
}

async function main() {
  // #2562: the band is independent of the diff, so it runs BEFORE every early
  // return below. Those returns all mean "this change cannot be judged against
  // a base"; none of them means the docs on disk are fine, and the whole point
  // of the band is to be seen by someone who is not mid-PR.

  if (isPromotionPR()) {
    console.log('Chain integrity: dev → main promotion — already checked on each dev PR.')
    return
  }
  // `docs.yml` also runs on `push` to main/dev, where there is no pull request
  // and so no base to compare against. Say so and stop, rather than falling
  // back to `origin/dev` — on a push run that fallback compares a branch with
  // itself at best, and turns the run red for a missing remote ref at worst.
  // The rule is enforced on the pull request, which is the only place it can be
  // acted on.
  //
  // Keyed on the EVENT, not on "BASE_SHA happens to be unset". Inferring the
  // skip from a missing variable makes every future CI context that forgets to
  // wire it (a `merge_group` trigger, this job copied into another workflow)
  // exit 0 as "skipped" instead of hitting the fail-closed branch below.
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    console.log('Chain integrity: push build, no pull-request base — skipped.')
    return
  }
  const { base, head, ref } = resolveBase()
  if (!base) {
    // A missing base is a check that did not run, never a clean bill of health.
    // Locally that is a normal shallow/detached situation and it says so; in CI
    // it means the workflow stopped providing history, which must fail closed
    // rather than pass quietly (the #1076 shape).
    const inCI = Boolean(process.env.GITHUB_ACTIONS || process.env.CI)
    console.log(`Chain integrity: no base ref (${ref}) — NOTHING WAS CHECKED.`)
    if (inCI) {
      console.error(
        '\nBLOCKING: running in CI without a resolvable base. The job needs ' +
        '`fetch-depth: 0` and BASE_SHA set.',
      )
      process.exit(1)
    }
    return
  }

  // The candidate set is what THIS change touched, never what the base branch
  // moved on without it. In CI that is the three-dot range base…head; locally
  // `git diff <base>` against the working tree plus untracked files, so
  // committed, staged and unstaged work all count.
  //
  // This distinction is load-bearing, not tidiness: a PR checked out as the
  // merge ref contains every doc `dev` advanced since the fork point, and
  // comparing those against the merge base would judge one PR by another PR's
  // chain edit — and by any broken chain already ON `dev`, forever.
  const changed = new Set(
    git(['diff', '--name-only', ...(head ? [`${base}...${head}`] : [base])])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  // Untracked files only matter on the local path: a CI checkout is a commit,
  // so there are none, and asking would be noise rather than a missed file.
  if (!head) {
    for (const f of git(['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)) {
      changed.add(f)
    }
  }

  const failures = []
  const resets = []
  let compared = 0

  for (const rel of [...changed].filter(isDocPath).sort()) {
    let prevRaw
    try {
      prevRaw = git(['show', `${base}:${rel}`], { quiet: true })
    } catch {
      continue // new doc — no previous chain to preserve
    }
    let nextRaw
    if (head) {
      try {
        nextRaw = git(['show', `${head}:${rel}`], { quiet: true })
      } catch {
        continue // deleted doc — out of scope
      }
    } else {
      if (!existsSync(join(REPO_ROOT, rel))) continue // deleted doc — out of scope
      nextRaw = await readFile(join(REPO_ROOT, rel), 'utf8')
    }
    // #2637: read BOTH shapes. Across the migration the base is the old
    // single-line chain and the head is the `verified:` list, so a reader that
    // understood one shape would report every entry as dropped.
    const prev = readChain(prevRaw)
    const next = readChain(nextRaw)
    if (prev.shape === null || next.shape === null) continue
    if (prev.shape === next.shape && prev.entries.join('\u0000') === next.entries.join('\u0000')) continue
    compared++
    const r = checkChainEntries(prev.entries, next.entries)
    if (r.reset && r.dropped.length === 0 && r.altered.length === 0) {
      // A declared compaction still reports what it removed.
      const gone = prev.entries
        .filter((e) => !next.entries.map(normalizeEntryText).includes(normalizeEntryText(e)))
        .map((e) => headOfEntry(e) ?? e.slice(0, 32))
      if (gone.length) resets.push({ rel, dropped: gone })
    }
    if (r.dropped.length) failures.push({ rel, kind: 'dropped', dropped: r.dropped })
    if (r.altered.length) failures.push({ rel, kind: 'altered', altered: r.altered })
    if (r.duplicates.length) failures.push({ rel, kind: 'duplicated', duplicates: r.duplicates })
  }

  for (const r of resets) {
    console.log(
      `Chain integrity: ${r.rel} declares chain-reset — dropped ${r.dropped.join(', ')}.`,
    )
  }

  if (failures.length) {
    const failedDocs = new Set(failures.map((f) => f.rel))
    console.error(`\n✗ \`last-verified\` chain unhealthy in ${failedDocs.size} doc(s):\n`)
    for (const f of failures) {
      if (f.kind === 'duplicated') {
        const det = f.duplicates.map((d) => `${d.head} ×${d.count}`).slice(0, 8).join(', ')
        console.error(`  - ${f.rel}: ${det}${f.duplicates.length > 8 ? ' …' : ''} — same entry (leading ref + prose) appears more than once`)
      } else if (f.kind === 'altered') {
        const det = f.altered.map((a) => a.head ?? '(entry)').slice(0, 8).join(', ')
        console.error(`  - ${f.rel}: ${det}${f.altered.length > 8 ? ' …' : ''} — entry still referenced, but its text changed`)
        for (const a of f.altered.slice(0, 3)) console.error(`      was: ${a.excerpt}${a.excerpt.length === 96 ? '…' : ''}`)
      } else {
        console.error(`  - ${f.rel}: dropped ${f.dropped.join(', ')} from the chain`)
      }
    }
    console.error(
      '\nAn entry that keeps its ref while its text changes is not a surviving ' +
      'entry: a chain records what was verified and what was explicitly NOT, so ' +
      'editing that prose in place rewrites the record rather than extending it ' +
      '(#2504). Resolving a base refresh, INTERLEAVE — newest first, every prior ' +
      'entry byte-verbatim behind `Prior:`, no ref dropped and none doubled — ' +
      'rather than taking one side. To correct what an entry claimed, add a new ' +
      'entry that says how it was wrong; do not overwrite it.\n',
    )
    console.error(
      '\nA `last-verified` note line is a chain, one entry per issue that verified ' +
      'the doc. Two notes on that line are two findings about the file, not two ' +
      'drafts of one — chain them, never choose one (#1496). If you are resolving ' +
      'a conflict, restore the entry AND the paragraph it points at: the entry ' +
      'going missing usually means prose went with it (#1843).\n' +
      'The chain must hold each entry ONCE: a merge that concatenated the chain ' +
      'instead of interleaving it doubles entries that were never two findings, ' +
      'the line grows without bound, and every reader pays the cost (#2477). ' +
      'Deduplicating a provenance chain needs a rule for which copy survives — ' +
      'that repair is a decision, not something this gate performs on its own.\n' +
      'A genuinely intended compaction says so in an entry: '+
      '`verified:` → `  - "chain-reset(#<issue>): <why>"`.\n',
    )
    process.exit(1)
  }

  console.log(
    `✓ \`last-verified\` chains intact (${compared} changed doc(s) compared against ${base.slice(0, 8)}).`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Fail closed: a broken gate that passes is the defect one layer up.
    console.error('chain-integrity error:', err)
    process.exit(1)
  })
}
