#!/usr/bin/env node
// `last-verified` chain-integrity check (#1843).
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
// appears in the run log instead of vanishing.
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
    if (result.status === 'broken') failures.push({ rel, ...result })
    if (result.status === 'reset') resets.push({ rel, ...result })
  }

  for (const r of resets) {
    console.log(
      `Chain integrity: ${r.rel} declares chain-reset — dropped ${r.dropped.join(', ')}.`,
    )
  }

  if (failures.length) {
    console.error(`\n✗ \`last-verified\` chain broken in ${failures.length} doc(s):\n`)
    for (const f of failures) {
      console.error(`  - ${f.rel}: dropped ${f.dropped.join(', ')} from the chain`)
    }
    console.error(
      '\nA `last-verified` note line is a chain, one entry per issue that verified ' +
      'the doc. Two notes on that line are two findings about the file, not two ' +
      'drafts of one — chain them, never choose one (#1496). If you are resolving ' +
      'a conflict, restore the entry AND the paragraph it points at: the entry ' +
      'going missing usually means prose went with it (#1843).\n' +
      'A genuinely intended compaction says so on the line: ' +
      '`last-verified: "…" # chain-reset(#<issue>): <why>`.\n',
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
