#!/usr/bin/env node
// `last-verified` chain-integrity check (#1843, extended by #2477).
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
// So the gate now also asks two questions of the CANDIDATE line itself
// (`chainAnomalies`):
//
//   1. does the same ENTRY — same leading issue ref AND same prose — appear
//      more than once? (A concatenating merge produces exactly that; legitimate
//      interleaving never does, because every entry's prose is written once.)
//   2. does the raw line exceed `MAX_CHAIN_BYTES` (64 KiB)? A cheap backstop:
//      duplication shows up as growth long before anyone reads the entries.
//
// Both are hard failures (exit 1), reported like the existing "broken" status.
//
// Deliberately narrow: this is not a general "did prose disappear" detector.
// It targets the one line where a lost entry is provable rather than guessed,
// and it stays silent everywhere else. See docs/contributing/docs-quality-system.md.
//
// ## Escape hatch — named and logged, never silent
//
// A chain that genuinely needs compacting says so ON the line:
//
//   last-verified: "2026-08-22" # chain-reset(#1843): <why> …
//
// The check then passes and PRINTS the dropped references, so the deletion
// appears in the run log instead of vanishing. The escape hatch covers a
// DROP — compaction — not duplication: a concatenated chain that stays over
// the byte ceiling is still reported, because a reset does not make a doubled
// line smaller.
//
// Usage:
//   npm run docs:chain                       # part of `npm run docs:check`
//   BASE_SHA=… HEAD_SHA=… node scripts/docs/chain-integrity.mjs   # CI
//   node scripts/docs/chain-integrity.mjs --base=<ref>

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT, ROOT_DOCS } from './validate-frontmatter.mjs'

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
export function chainEntries(line) {
  const m = line.match(/^last-verified:\s*"[^"]*"\s*#\s?(.*)$/)
  if (!m) return []
  return m[1]
    .replace(/\bPrior\s+#/g, 'Prior: #') // bare "Prior #N" boundary variant
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
export const MAX_CHAIN_BYTES = 64 * 1024

/**
 * Pure core for the #2477 direction: the OPPOSITE failure of #1843, one entry
 * appearing twice where the check's containment rule can only see losses.
 *
 * `checkChain` compares ref PRESENCE, and `issueRefs` de-duplicates to first
 * occurrence — so a merge that CONCATENATED the chain (entry A then entry B,
 * twice) loses nothing, every "did we drop history" question answers yes, and
 * the gate reported `✓ chains intact` on a chain that had doubled. This check
 * asks the other question: does the candidate line contain the same ENTRY — the
 * same leading issue ref AND the same prose — more than once?
 *
 * Entries are split the way the chain is actually structured (`chainEntries`):
 * on the `Prior:` chain-word, never on raw `#NNN` — an entry's prose routinely
 * cites other issues, and a citation is not a separate entry. Two entries are
 * duplicates only when their FULL text (leading ref + prose) is byte-identical,
 * which is exactly what a concatenating merge produces and what legitimate
 * interleaving never does: every entry's prose is written once, per issue.
 *
 * Returns { duplicates: [{ head, count, excerpt }], tooLarge: null | { bytes,
 * maxBytes } }.
 *  - duplicates — entries whose text occurs > 1× on the line, with the entry's
 *                 head (leading ref cluster, or release token) and occurrence
 *                 count.
 *  - tooLarge   — the raw line length over the ceiling.
 */
export function chainAnomalies(line, maxBytes = MAX_CHAIN_BYTES) {
  const counts = new Map()
  for (const entry of chainEntries(line)) {
    counts.set(entry, (counts.get(entry) || 0) + 1)
  }
  const duplicates = []
  for (const [text, count] of counts) {
    if (count < 2) continue
    duplicates.push({ head: headOfEntry(text), count, excerpt: text.slice(0, 96) })
  }
  duplicates.sort((a, b) => b.count - a.count)
  return {
    duplicates,
    tooLarge: line.length > maxBytes ? { bytes: line.length, maxBytes } : null,
  }
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
    const prevLine = lastVerifiedLine(prevRaw)
    const nextLine = lastVerifiedLine(nextRaw)
    if (!prevLine || !nextLine) continue
    if (prevLine === nextLine) continue
    compared++
    const result = checkChain(prevLine, nextLine)
    if (result.status === 'broken') failures.push({ rel, kind: 'dropped', ...result })
    if (result.status === 'reset') resets.push({ rel, ...result })
    // #2477: the opposite failure — an entry appearing twice (a chain that was
    // CONCATENATED instead of interleaved), plus the size-ceiling backstop.
    // `chainAnomalies` judges the CANDIDATE line itself, not a prev→next
    // difference: a concatenating merge produces a line that is broken on its
    // own, and no "did we drop anything" comparison can see it.
    const anomalies = chainAnomalies(nextLine)
    if (anomalies.duplicates.length) failures.push({ rel, kind: 'duplicated', duplicates: anomalies.duplicates })
    if (anomalies.tooLarge) failures.push({ rel, kind: 'oversize', ...anomalies.tooLarge })
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
      } else if (f.kind === 'oversize') {
        console.error(`  - ${f.rel}: chain line is ${f.bytes} bytes — over the ${f.maxBytes}-byte ceiling`)
      } else {
        console.error(`  - ${f.rel}: dropped ${f.dropped.join(', ')} from the chain`)
      }
    }
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
      'A genuinely intended compaction says so on the line: ' +
      '`last-verified: "…" # chain-reset(#<issue>): <why>`. ' +
      'A line that simply exceeds the byte ceiling has no plain-word escape: it ' +
      'must actually be reduced.\n',
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
