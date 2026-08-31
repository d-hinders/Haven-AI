#!/usr/bin/env node
// Operator-verify close-keyword guard (#2276, extended by #2320 + #2327).
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
// ## Which surfaces GitHub actually parses (#2320)
//
// The first version of this guard read the pull-request BODY and nothing else,
// and it was wrong about its own subject: GitHub honours closing keywords in
// **commit messages that reach the default branch** too. It proved it on
// itself. PR #2314 — the pull request that introduced this file — carried a
// commit (`7f7102ff`) whose message narrated the original incident, quoting the
// keyword inside a code span in order to describe it. `dev` is the default
// branch, the pull request landed as a merge commit, the message reached `dev`
// verbatim, and GitHub closed #2268 **for the second time — by the change
// written to prevent it.** CI was green, because the body it read said
// `Refs #2276`.
//
// The scanned sources are therefore every place whose text can reach `dev`:
//
//   * the pull-request **body** — GitHub's own `closingIssuesReferences`;
//   * every **commit message** on the pull request. Both merge routes this
//     repository allows carry them to `dev`: a merge commit lands them verbatim,
//     and a squash lands them concatenated, because
//     `squash_merge_commit_message` is `COMMIT_MESSAGES`;
//   * the pull-request **title**, which reaches `dev` on BOTH of this
//     repository's merge routes, not just one. `merge_commit_message` is
//     `PR_TITLE`, so a merge commit — the route PR #2314 actually took — puts
//     the title verbatim into the merge commit's message; and
//     `squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`, so a multi-commit
//     squash makes it the subject line. Both are settings on this repository,
//     read from `GET /repos/d-hinders/Haven-AI`. Recorded in full because the
//     first draft of this comment named only the squash route, from which a
//     later reader could conclude that title-scanning becomes unnecessary if
//     squash merging is ever turned off. It would not (`haven-reviewer`).
//
// Enumerated and checked, so the next reader does not have to re-derive it:
// issue comments and review comments are **not** emitters — GitHub scopes
// closing keywords to pull-request descriptions and commit messages — and no
// automation in this repository closes an issue. Every `gh issue` call under
// `.github/`, `scripts/`, `.claude/` and `.agents/` is `list`, `edit`, `create`
// or `comment` (docs-audit, promotion-digest, db-concurrency-proof, qa-dev);
// there is no `gh issue close`, no `issues.update`, and no `actions/github-script`
// anywhere in the repository. The six workflows holding `issues: write` use it
// to create or comment. Branch names are not parsed by anything.
//
// ## The two signals, and why both
//
//   1. **Label** — a closing keyword aimed at an issue labelled `operator-verify`
//      (`.github/labels.yml`). This is the primary signal: it lives on the ISSUE,
//      so it holds no matter how the pull request is phrased, and it survives
//      a body rewrite. The skill's *Operator-verify mode* step 2 applies it.
//   2. **Self-contradiction** — a closing keyword aimed at an issue the pull
//      request ITSELF says stays open. Needs no label, no bookkeeping, and it
//      is the signal that catches the actual #2272 incident on its actual text.
//      It is the backstop for the day someone declares the mode in writing and
//      forgets the label — i.e. exactly what happened.
//
// Neither signal fires on an ordinary pull request: an author who is not in
// operator-verify mode has no label and writes no such sentence, so `Closes #N`
// stays the default and this file is silent.
//
// ## The negation asymmetry between the two halves (#2327)
//
// The two halves ask questions of a different kind, and they must read negation
// differently. Recording it here because the natural instinct is to make them
// consistent, and consistency is the bug.
//
//   * The **closing-keyword** half asks *what will GitHub do?* It must mirror
//     GitHub exactly, so it does NOT read negation: `does not close #5` really
//     does close #5, and a keyword quoted inside a fence or a blockquote closes
//     the issue just the same — that is precisely what happened in #2320. A test
//     below pins this.
//   * The **stays-open** half asks *what did the author assert?* That is a claim
//     about intent with no GitHub behaviour behind it, and negation is the whole
//     content of the sentence. It fired on PR #2326, whose body ticked
//     `Closes #2295` and said, on the same line, "Not operator-verify mode; no
//     outstanding human step." The guard failed the pull request **because the
//     author declared the mode did not apply**: one red required check and a CI
//     round trip on a pull request that had done nothing wrong.
//
// The fix is not a negation reader — reading "not" correctly is prose
// interpretation, which ship-next § *Rework caps* rule 1 puts out of scope for
// exactly this reason. It is that `operator-verify mode` was never an assertion
// in the first place. Every other phrase in the list below names the issue's
// post-merge STATE ("stays open", "must outlive the merge"); that one named a
// MODE, and naming a mode says nothing about this issue. What it uniquely
// matched was authors declaring the mode does NOT apply — which the pull-request
// template invites, since its Issue Link section offers a `Closes` / `Refs` pair
// and the natural way to justify ticking `Closes` is to say the other option is
// not it. So it is gone, and the list is state assertions only.
//
// **What that costs, stated plainly rather than waved away** (`haven-reviewer`
// raised the first draft of this paragraph for overclaiming). A bare POSITIVE
// mode-naming sentence with no state word — "#5 ships in operator-verify mode",
// and `Closes #5` further down — was caught before and is not caught now. A test
// below pins that, so it is a recorded trade rather than a silent hole. Three
// things make it the right trade, and none of them is "it never happens":
// the **label** is the primary signal and the skill requires it in this mode
// (step 2), so the sentence was only ever the backstop for an author who already
// skipped the required step; every phrasing that also asserts the STATE is still
// caught, and the skill's own operator-verify prose ("Leave the issue OPEN")
// reliably produces one; and the alternative — keeping the phrase and reading
// negation — is prose interpretation, which is out of scope and was already
// observed failing in production on PR #2326. In the uncaught case the label is
// the only guaranteed signal. That is the limit; do not read it as an absence
// of one.
//
// ## How an author quotes the keyword without firing this guard (#2320/#2327)
//
// They do not, and the guard must not offer a way, because **GitHub does not
// offer one**. Fenced code blocks and blockquotes do not help; #2320 is the
// proof. If your text contains `Close` + `s` + a parseable `#<number>` and that
// text reaches `dev`, the issue closes — so a guard that stayed quiet over a
// fence would be green on the exact bytes that closed #2268, which is the
// false-GREEN direction of the defect it exists to catch.
//
// The escape is real, not notational: **write something GitHub does not parse.**
//   * `Refs #2268` — the prescribed form, and what the report below recommends.
//   * The keyword with a non-numeric placeholder: `Closes #<n>`. The
//     pull-request template does this; so does this comment block.
//   * The number with no keyword in front of it: `#2268 was closed twice`.
//   * The keyword and the number in separate sentences.
//
// This file, its tests, its documentation and the pull request that shipped this
// change all had to use those forms, and that is the point rather than an
// inconvenience: the constraint the guard imposes is identical to the constraint
// GitHub imposes, so obeying the guard is obeying the mechanism. A guard with an
// opt-out marker would let an author assert "yes, GitHub will close this issue,
// but I say it is fine" — which is never true in operator-verify mode, and
// outside operator-verify mode the guard is silent anyway. There is no
// legitimate use for one, so there is none.
//
// ## Known limits, stated rather than implied
//
//   * A body EDITED after the last CI run is not re-checked — `pull_request`
//     here does not list the `edited` type, and adding it would re-run the whole
//     required suite on every typo fix. The keyword is written when the PR is
//     opened, which is when this runs. Commits pushed after it runs DO get a
//     fresh run, so the commit half is better covered than the body half.
//   * The label signal needs the issue's labels. Where `gh` cannot answer, the
//     guard says so loudly and still runs the text signals; in CI it fails closed
//     rather than reporting a clean bill of health.
//   * It cannot make an issue that ALREADY merged with the keyword re-open. The
//     remedy there is a human reopening it, as #2268 was — twice.
//   * A conventional-commit subject of the form `fix: #1234 something` parses as
//     a closing reference, to GitHub and to this file alike. That is GitHub's
//     behaviour, not a quirk here; `fix(scope): ...` does not.
//   * The stays-open half is scoped to logical lines naming the issue, so a pull
//     request that discusses some OTHER issue staying open is untouched.

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

// A line that says, in the author's own words, that THIS ISSUE outlives the
// merge. Deliberately a small, literal list of STATE assertions: anything that
// needs the guard to INTERPRET a sentence is out of scope (ship-next § Rework
// caps, rule 1), and anything that merely names the mode rather than asserting
// the state was the #2327 false positive. See the negation-asymmetry section
// above before adding to this list.
const STAYS_OPEN_PHRASES = [
  /\bstays?\s+open\b/i,
  /\bstay\s+open\b/i,
  /\bremains?\s+open\b/i,
  /\bleav(?:e|es|ing)\s+(?:this\s+|the\s+)?issue\s+(?:#\d+\s+)?open\b/i,
  /\bkept?\s+open\b/i,
  /\bmust\s+outlive\s+the\s+merge\b/i,
  /\bdo(?:es)?\s+not\s+close\s+(?:this\s+|the\s+)?(?:issue|it|#\d+)\b/i,
]

/** Every issue number this text asks GitHub to close, deduplicated, in order. */
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

// Markdown line starts that begin a NEW block rather than continuing the
// previous sentence: list bullets, ordered items, table rows, quotes, headings,
// fences, rules.
//
// A heading is `#` FOLLOWED BY WHITESPACE (ATX). The first version tested a bare
// `#`, which made every hard-wrapped line beginning with an issue reference —
// `#2268, in its RELEASE comment and in its own body, then ended with` — look
// like a heading and stop the unwrapping. That is the commonest wrap point there
// is in this repository's prose, and it is why the real `7f7102ff` fixture did
// not register until this was corrected: a synthetic string would never have
// found it.
const BLOCK_START = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}(?:\s|$)|[|>]|```|---|===)/

/**
 * Logical sentences, with hard wraps undone.
 *
 * Markdown hard-wraps at ~80 columns, so "…#2268 will not be closed by this
 * merge; it\nstays open until…" puts the number and the assertion on different
 * physical lines. Line scoping missed exactly that — reproduced by
 * `haven-reviewer` on this file's own review: a false negative in the one
 * signal that needs no label, i.e. the backstop for the case that happened.
 * Commit messages wrap at 72 and make it more common, not less.
 *
 * Wrapped continuations are joined; a new Markdown block is never joined to the
 * line above it, and neither is anything after sentence-final punctuation. That
 * keeps the scope tight enough to avoid the opposite failure — a pull request
 * that merely DISCUSSES operator-verify mode for some other issue, including
 * the one that introduced this guard. A check that fires on its own
 * documentation gets muted.
 */
export function logicalLines(body) {
  const out = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const previous = out[out.length - 1]
    const continues =
      line !== '' &&
      previous !== undefined &&
      previous !== '' &&
      !BLOCK_START.test(line) &&
      !/[.!?:]$/.test(previous)
    if (continues) out[out.length - 1] = `${previous} ${line}`
    else out.push(line)
  }
  return out
}

/** Sentences that both mention `#<issue>` and assert it stays open. */
export function staysOpenEvidence(body, issue) {
  const mentions = new RegExp(`#${issue}\\b`)
  return logicalLines(body).filter((line) => mentions.test(line) && assertsStaysOpen(line))
}

/**
 * Every text on a pull request whose closing keywords can reach the default
 * branch, in the order a report should name them.
 *
 * `describe` is written to complete the sentence "…#N — <describe> says: …", so
 * a reader is told WHICH surface to go and edit. On #2320 that mattered: the
 * body was correct and the commit message was not, and a report saying only
 * "this pull request says" would have sent the author to rewrite the wrong one.
 *
 * @param {{body?: string, title?: string, commits?: {oid?: string, message?: string}[]}} pr
 */
export function pullRequestSources({ body, title, commits = [] }) {
  const sources = []
  if (title) sources.push({ kind: 'title', describe: "this pull request's title", text: title })
  if (body) sources.push({ kind: 'body', describe: 'this pull-request body', text: body })
  for (const commit of commits) {
    const short = String(commit.oid ?? '').slice(0, 8)
    sources.push({
      kind: 'commit',
      describe: short ? `commit ${short}'s message` : 'a commit message',
      text: commit.message ?? '',
    })
  }
  return sources
}

/**
 * @param {{
 *   body?: string,
 *   title?: string,
 *   commits?: {oid?: string, message?: string}[],
 *   closingRefs?: number[],
 *   labelsByIssue?: Record<number, string[]>,
 * }} input
 * @returns {{issue: number, signal: 'label'|'self-contradiction', evidence: string}[]}
 */
export function findViolations({ body, title, commits = [], closingRefs, labelsByIssue = {} }) {
  const sources = pullRequestSources({ body, title, commits })

  // The union across every emitter, plus whatever GitHub's own parse supplied.
  // A closing reference is a closing reference wherever it is written; the
  // source only matters for telling the author where to go and fix it.
  const refs = allClosingRefs({ body, title, commits, closingRefs })

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
    // Deliberately across ALL sources rather than only the one holding the
    // keyword: "the body promises #N stays open, a commit closes it" is the
    // same defect as either one alone, and it is the shape #2320 produced.
    let found
    for (const source of sources) {
      const lines = staysOpenEvidence(source.text, issue)
      if (lines.length > 0) {
        found = { source, line: lines[0] }
        break
      }
    }
    if (found) {
      violations.push({
        issue,
        signal: 'self-contradiction',
        evidence: `${found.source.describe} says: "${found.line}"`,
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
    'survive it. It is honoured in the pull-request body, in every commit message',
    'that reaches the default branch, and — via the squash subject — in the title.',
    'Reference it without a closing keyword instead:',
    '',
    ...violations.map((v) => `  Closes #${v.issue}  ->  Refs #${v.issue}`),
    '',
    'To write ABOUT the keyword without emitting it, use a form GitHub does not',
    'parse: `Refs #<n>`, a non-numeric placeholder (`Closes #<n>`), or the number',
    'with no keyword in front of it. A code fence does NOT help — GitHub parses',
    'fenced text too, which is how #2268 was closed a second time (#2320).',
    '',
    'See .agents/skills/ship-next/SKILL.md § Commit And Pull Request, step 7.',
    'If the issue is NOT in operator-verify mode, remove the `operator-verify`',
    'label (or the sentence quoted above) rather than silencing this check.',
  )
  return lines.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// One page of commits, asked for by GraphQL rather than by `gh pr view`.
//
// `gh pr view --json commits` exposes only `messageHeadline` and `messageBody`,
// and `messageHeadline` is **truncated at 70 characters** with an ellipsis, the
// remainder relocated to the FRONT of `messageBody`, also ellipsis-wrapped. So
// rejoining the two does not reconstruct the message: it splits the subject line
// mid-token and inserts a paragraph break that was never there. A commit subject
// of `fix(ci): make the retry loop stop doubling background sync Closes #1234`
// comes back as `...sync C…` + `…loses #1234`, and the keyword vanishes from a
// message GitHub will still act on — a silent false GREEN in exactly the
// mechanism #2320 exists to close, and one no error handling can catch because
// the `gh` call succeeded. Raised by `haven-reviewer` on this change and
// reproduced against this repository's own `7f7102ff` (headline 70 chars ending
// `(#2…`, body beginning `…276)`).
//
// The `commit { message }` field is the untruncated original, so the guard reads
// the same bytes GitHub parses.
const COMMITS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      commits(first: 100, after: $cursor) {
        nodes { commit { oid message } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

/**
 * Flatten a `commits` connection into the shape `findViolations` consumes.
 * Pure, so the truncation regression above is testable without the network.
 */
export function commitsFromGraphQL(connection) {
  return (connection?.nodes ?? [])
    .map((n) => n?.commit)
    .filter(Boolean)
    .map((c) => ({ oid: c.oid, message: c.message ?? '' }))
}

function readCommits(pr, owner, name) {
  const commits = []
  let cursor = null
  // Bounded: GitHub caps a pull request at 250 commits, so five pages is the
  // ceiling and the loop cannot run away on a malformed `pageInfo`.
  for (let page = 0; page < 5; page += 1) {
    const args = [
      'api', 'graphql',
      '-f', `query=${COMMITS_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `pr=${pr}`,
    ]
    if (cursor) args.push('-F', `cursor=${cursor}`)
    const connection = JSON.parse(gh(args)).data.repository.pullRequest.commits
    commits.push(...commitsFromGraphQL(connection))
    if (!connection.pageInfo?.hasNextPage) return commits
    cursor = connection.pageInfo.endCursor
  }
  // Fail CLOSED rather than silently reading a prefix of the commit list.
  throw new Error('more than 500 commits on this pull request; refusing to read a partial list')
}

function readPullRequest(pr) {
  // `closingIssuesReferences` is GitHub's OWN parse of the body — the same
  // computation that will run at merge time. Preferring it over the local regex
  // means the guard is asking the mechanism, not re-implementing it; the regex
  // stays as the offline path, as a cross-check, and as the ONLY reading
  // available for the commit and title sources, which that field does not cover.
  const view = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'body,title,closingIssuesReferences']))
  const repo = JSON.parse(gh(['repo', 'view', '--json', 'owner,name']))
  const commits = readCommits(pr, repo.owner.login, repo.name)
  return {
    body: view.body ?? '',
    title: view.title ?? '',
    commits,
    closingRefs: (view.closingIssuesReferences ?? []).map((r) => r.number),
  }
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

  let input = {}
  let labelsByIssue = {}

  if (bodyFile) {
    const body = readFileSync(bodyFile, 'utf8')
    input = { body }
    const labelled = (arg('--operator-verify-issues') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean)
    labelsByIssue = Object.fromEntries(labelled.map((n) => [n, [OPERATOR_VERIFY_LABEL]]))
  } else if (pr) {
    try {
      input = readPullRequest(pr)
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
      labelsByIssue = readLabels(allClosingRefs(input))
    } catch (error) {
      const message = `operator-verify close guard: could not read issue labels (${error.message.trim()})`
      if (inCI) {
        console.error(`✖ ${message}`)
        return 1
      }
      console.warn(`⚠ ${message} — label signal skipped; text signals still ran.`)
    }
  } else {
    console.error('usage: operator-verify-close-guard.mjs (--pr <number> | --body-file <path>)')
    return 2
  }

  const violations = findViolations({ ...input, labelsByIssue })
  if (violations.length > 0) {
    console.error(renderReport(violations))
    return 1
  }
  const refs = allClosingRefs(input)
  console.log(
    refs.length === 0
      ? '✓ operator-verify close guard: no closing keyword in this pull request (body, title or commits).'
      : `✓ operator-verify close guard: ${refs.map((n) => `#${n}`).join(', ')} — none held open for an operator step.`,
  )
  return 0
}

/** The union of closing references across every emitter on the pull request. */
export function allClosingRefs({ body, title, commits = [], closingRefs = [] }) {
  const refs = [...closingRefs]
  for (const source of pullRequestSources({ body, title, commits })) {
    for (const n of parseClosingRefs(source.text)) if (!refs.includes(n)) refs.push(n)
  }
  return refs
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
