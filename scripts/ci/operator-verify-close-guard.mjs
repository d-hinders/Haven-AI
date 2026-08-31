#!/usr/bin/env node
// Operator-verify close-keyword guard (#2276).
//
// ## What it stops
//
// `Closes #<n>` is a GitHub keyword, not prose: when a pull request based on the
// default branch (`dev` here) merges, GitHub closes every issue it names,
// whatever the body says elsewhere. So the ship-next skill's *operator-verify
// mode* — "leave the issue OPEN, a human still has to run the live step" — is
// unenforceable by writing, and it failed the first time it was used:
//
//   PR #2272 stated the issue stays open THREE times (an operator checklist on
//   #2268 saying "Leaving this issue OPEN until it is done", a 🔓 RELEASE
//   comment, and its own body: "#2268 stays open for it"), then ended with
//   `Closes #2268`. The merge closed #2268 at 08:24:37. Three statements of
//   intent, one keyword, and the keyword won.
//
// The wrong outcome is **quiet and looks like success**: a closed issue after a
// merged PR is the normal picture, so nobody re-checks it. That is why this is a
// check and not another paragraph — a convention that nothing verifies is the
// same class of defect as a test that cannot fail.
//
// ## The two signals, and why both
//
//   1. **Label** — a closing keyword aimed at an issue labelled `operator-verify`
//      (`.github/labels.yml`). This is the primary signal: it lives on the ISSUE,
//      so it holds no matter how the pull-request body is phrased, and it survives
//      a body rewrite. The skill's *Operator-verify mode* step 2 applies it.
//   2. **Self-contradiction** — a closing keyword aimed at an issue the body
//      ITSELF says stays open. Needs no label, no API and no bookkeeping, and it
//      is the signal that catches the actual #2272 incident on its actual text.
//      It is the backstop for the day someone declares the mode in writing and
//      forgets the label — i.e. exactly what happened.
//
// Neither signal fires on an ordinary pull request: an author who is not in
// operator-verify mode has no label and writes no such sentence, so `Closes #N`
// stays the default and this file is silent.
//
// ## Known limits, stated rather than implied
//
//   * A body EDITED after the last CI run is not re-checked — `pull_request`
//     here does not list the `edited` type, and adding it would re-run the whole
//     required suite on every typo fix. The keyword is written when the PR is
//     opened, which is when this runs.
//   * The label signal needs the issue's labels. Where `gh` cannot answer, the
//     guard says so loudly and still runs the body signal; in CI it fails closed
//     rather than reporting a clean bill of health.
//   * It cannot make an issue that ALREADY merged with the keyword re-open. The
//     remedy there is a human reopening it, as #2268 was.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const OPERATOR_VERIFY_LABEL = 'operator-verify'

// GitHub's own closing-keyword set, verbatim from its docs. Matching a keyword
// GitHub does not honour would be a false positive; missing one it does honour
// is a false zero, which is the direction that matters here.
const CLOSING_KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)'
const CLOSING_REF = new RegExp(
  `\\b${CLOSING_KEYWORD}\\b\\s*:?\\s*(?:https?://github\\.com/[\\w.-]+/[\\w.-]+/issues/|[\\w.-]+/[\\w.-]+#|#)(\\d+)`,
  'gi',
)

// A line that says, in the author's own words, that this issue outlives the
// merge. Deliberately a small, literal list: anything that needs the guard to
// INTERPRET a sentence is out of scope (ship-next § Rework caps, rule 1).
const STAYS_OPEN_PHRASES = [
  /\bstays?\s+open\b/i,
  /\bstay\s+open\b/i,
  /\bremains?\s+open\b/i,
  /\bleav(?:e|es|ing)\s+(?:this\s+|the\s+)?issue\s+(?:#\d+\s+)?open\b/i,
  /\bkept?\s+open\b/i,
  /\bmust\s+outlive\s+the\s+merge\b/i,
  /\bdo(?:es)?\s+not\s+close\s+(?:this\s+|the\s+)?(?:issue|it|#\d+)\b/i,
  /\boperator[-\s]verify\s+mode\b/i,
]

/** Every issue number this body asks GitHub to close, deduplicated, in order. */
export function parseClosingRefs(body) {
  const seen = []
  for (const match of String(body ?? '').matchAll(CLOSING_REF)) {
    const n = Number(match[1])
    if (!seen.includes(n)) seen.push(n)
  }
  return seen
}

/** Does this one line assert that the issue stays open? */
export function assertsStaysOpen(line) {
  return STAYS_OPEN_PHRASES.some((re) => re.test(line))
}

/**
 * Lines that both mention `#<issue>` and assert it stays open.
 *
 * Scoped to a single line on purpose. A body-wide "does it mention
 * operator-verify anywhere" test would flag every pull request that merely
 * DISCUSSES the mode — including the one that introduced this guard — and a
 * check that fires on its own documentation gets muted.
 */
export function staysOpenEvidence(body, issue) {
  const mentions = new RegExp(`#${issue}\\b`)
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => mentions.test(line) && assertsStaysOpen(line))
}

/**
 * @param {{body: string, closingRefs?: number[], labelsByIssue?: Record<number, string[]>}} input
 * @returns {{issue: number, signal: 'label'|'self-contradiction', evidence: string}[]}
 */
export function findViolations({ body, closingRefs, labelsByIssue = {} }) {
  const refs = closingRefs ?? parseClosingRefs(body)
  const violations = []
  for (const issue of refs) {
    const labels = labelsByIssue[issue] ?? []
    if (labels.includes(OPERATOR_VERIFY_LABEL)) {
      violations.push({
        issue,
        signal: 'label',
        evidence: `issue #${issue} carries the \`${OPERATOR_VERIFY_LABEL}\` label`,
      })
      continue
    }
    const lines = staysOpenEvidence(body, issue)
    if (lines.length > 0) {
      violations.push({
        issue,
        signal: 'self-contradiction',
        evidence: `this pull-request body says: "${lines[0]}"`,
      })
    }
  }
  return violations
}

export function renderReport(violations) {
  const lines = ['✖ Closing keyword aimed at an issue that must outlive the merge.', '']
  for (const v of violations) {
    lines.push(`  #${v.issue} — ${v.evidence}`)
  }
  lines.push(
    '',
    '`Closes #<n>` is a GitHub keyword: on merge it closes the issue whatever the',
    'body says elsewhere, so a sentence promising the issue stays open does not',
    'survive it. Reference it without a closing keyword instead:',
    '',
    ...violations.map((v) => `  Closes #${v.issue}  ->  Refs #${v.issue}`),
    '',
    'See .agents/skills/ship-next/SKILL.md § Commit And Pull Request, step 7.',
    'If the issue is NOT in operator-verify mode, remove the `operator-verify`',
    'label (or the sentence quoted above) rather than silencing this check.',
  )
  return lines.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function readPullRequest(pr) {
  // `closingIssuesReferences` is GitHub's OWN parse of the body — the same
  // computation that will run at merge time. Preferring it over the local regex
  // means the guard is asking the mechanism, not re-implementing it; the regex
  // stays as the offline path and as a cross-check.
  const view = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'body,closingIssuesReferences']))
  const refs = (view.closingIssuesReferences ?? []).map((r) => r.number)
  const local = parseClosingRefs(view.body)
  return { body: view.body ?? '', closingRefs: [...new Set([...refs, ...local])] }
}

function readLabels(issues) {
  const labelsByIssue = {}
  for (const issue of issues) {
    const view = JSON.parse(gh(['issue', 'view', String(issue), '--json', 'labels']))
    labelsByIssue[issue] = (view.labels ?? []).map((l) => l.name)
  }
  return labelsByIssue
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const inCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true'
  const pr = arg('--pr')
  const bodyFile = arg('--body-file')

  let body = ''
  let closingRefs
  let labelsByIssue = {}

  if (bodyFile) {
    body = readFileSync(bodyFile, 'utf8')
    closingRefs = parseClosingRefs(body)
    const labelled = (arg('--operator-verify-issues') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean)
    labelsByIssue = Object.fromEntries(labelled.map((n) => [n, [OPERATOR_VERIFY_LABEL]]))
  } else if (pr) {
    try {
      const view = readPullRequest(pr)
      body = view.body
      closingRefs = view.closingRefs
    } catch (error) {
      // Fail CLOSED in CI. A guard that reports "nothing found" when it could
      // not look is the false-GREEN direction of the very defect it guards.
      const message = `operator-verify close guard: could not read PR #${pr} via gh (${error.message.trim()})`
      if (inCI) {
        console.error(`✖ ${message}`)
        return 1
      }
      console.warn(`⚠ ${message} — skipping locally; CI will run it for real.`)
      return 0
    }
    try {
      labelsByIssue = readLabels(closingRefs)
    } catch (error) {
      const message = `operator-verify close guard: could not read issue labels (${error.message.trim()})`
      if (inCI) {
        console.error(`✖ ${message}`)
        return 1
      }
      console.warn(`⚠ ${message} — label signal skipped; body signal still ran.`)
    }
  } else {
    console.error('usage: operator-verify-close-guard.mjs (--pr <number> | --body-file <path>)')
    return 2
  }

  const violations = findViolations({ body, closingRefs, labelsByIssue })
  if (violations.length > 0) {
    console.error(renderReport(violations))
    return 1
  }
  const refs = closingRefs ?? []
  console.log(
    refs.length === 0
      ? '✓ operator-verify close guard: no closing keyword in this pull-request body.'
      : `✓ operator-verify close guard: ${refs.map((n) => `#${n}`).join(', ')} — none held open for an operator step.`,
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
