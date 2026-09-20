// Parses the claim protocol out of an issue comment so `.github/workflows/
// claim-assignee.yml` can keep GitHub's assignee field in step with it.
//
// ## Why a projection and not a replacement
//
// AGENTS.md § Cross-session agent coordination is the protocol — its only
// canonical text (#3182); nothing below restates a rule of it — and the claim
// comment stays authoritative because it carries what an assignee cannot: the
// branch (which exists long before a PR) and `touches:` (file-level, which is
// how a collision between two DIFFERENT issues gets caught — see the
// #2968/#2970 overlap on 2026-09-14, two owners, one
// `paid-mcp-completion.ts`). The assignee field is a cheap, queryable INDEX of
// that, maintained by machine so it cannot drift the way a hand-kept second
// copy would.
//
// ## The asymmetry, which is the main design decision here
//
// Claims are matched STRICTLY and releases GENEROUSLY, because the two errors
// are not equally bad:
//
//   - A missed CLAIM leaves an issue unassigned. That is the status quo today,
//     and harmless — the claim comment is still there to be read.
//   - A missed RELEASE leaves a STALE assignee: the field says someone is
//     working on something they finished, which actively misleads. Worse than
//     no field at all.
//
// So a claim must be unambiguous, while anything that reads like a release is
// taken as one — for human comments. A bot's comment is narrowed to the one
// merge-time shape (#3177, `botReleaseLine`); see that function.
//
// ## Why the marker must begin its line
//
// Philip's overlap FYI on 2026-09-14 quoted Antonio's claim inside his own
// comment:
//
//     - Ours:   🔒 CLAIM #2968 … branch feat/2968-settle-confirmation-guard
//     - Theirs: 🔒 CLAIM #2970 … PR #2971 (draft, MERGEABLE, unmerged)
//
// A parser that scanned the whole body would have assigned #2970 — Antonio's
// work — to Philip, on the strength of Philip reporting it. Requiring the
// marker to start its line (after list bullets and bold) excludes reported
// claims and keeps the ones actually being made.

import { CHANNEL_ISSUE } from './coordination-channel.mjs'

/**
 * Strip decoration so `- **RELEASE** …`, `**Released:** …` and
 * `**CLAIM** (Antonio's session): …` all parse alike. Bold markers are removed
 * everywhere on the line, not just at its head, because the historical form
 * puts them around the keyword itself.
 */
function undecorate(line) {
  return line.replace(/\*\*/g, '').replace(/^[\s*_-]*/, '').trimStart()
}

/**
 * A quoted line is someone reporting a claim, never making one.
 *
 * GitHub's "Quote reply" button produces `> 🔒 CLAIM #2970 …`, so this is the
 * DEFAULT way one session repeats another's claim. Treating it as a claim would
 * assign the quoter — and because assignment ADDS, the real owner's later
 * RELEASE removes only the real owner, leaving the quoter on the issue — with
 * nothing in the thread to explain it — until the merge-time release (#3177)
 * clears every assignee.
 */
function isQuoted(line) {
  return /^\s*>/.test(line)
}

/**
 * The issue numbers a marker line is ABOUT.
 *
 * Only the LEADING RUN of references counts — the numbers that follow the
 * keyword before any prose begins. A claim line describes its work after the
 * number, and that description routinely cites other numbers:
 *
 *   🔒 CLAIM #2044 — branch `chore/2044-vacuous-red-line-4-spies` — removing
 *   the three unfalsifiable spies from the Red Line #4 regulatory suite.
 *
 * Taking every `#N` on that line assigned #4 as well as #2044. The leading run
 * stops at the first token that is not a reference or a separator, so
 * `#1404 + #1411 + #1418 + #1393 (hela resten…)` still yields four and the
 * prose after the parenthesis yields none.
 *
 * Pull-request references are dropped first: nearly every release names the PR
 * that carried the work — `🔓 RELEASE #2945 — landed as PR #2955` — and taking
 * that as a second issue would unassign an unrelated one. Six digits max, so
 * timestamps and card ids never read as references.
 */
function refsOn(line, keyword) {
  let rest = line.replace(/\b(?:PR|pull request)\s*#\d{1,6}\b/gi, ' ')

  if (keyword) {
    const at = rest.search(keyword)
    if (at === -1) return []
    rest = rest.slice(at).replace(keyword, '')
    // `CLAIM (Antonio's session): #1348 — …` — a parenthesised session
    // qualifier and its colon sit between the keyword and the number.
    rest = rest.replace(/^\s*\([^)]*\)\s*:?/, '')
  }

  const out = []
  // Consume `#N`, separated by + , & or the word "and", and nothing else.
  const run = /^[\s:—–-]*#(\d{1,6})\b/
  for (;;) {
    const m = rest.match(run)
    if (!m) break
    const n = Number(m[1])
    if (!out.includes(n)) out.push(n)
    rest = rest.slice(m[0].length).replace(/^\s*(?:[+,&]|and\b)\s*/i, '')
  }
  return out
}

/**
 * Does this line OPEN a claim? Strict: the padlock must lead, or the historical
 * bold `**CLAIM**` form must. A line that merely mentions a claim does not.
 */
function claimLine(line) {
  const t = undecorate(line)
  // The bare-word arm is the historical `**CLAIM** (Antonio's session):` form,
  // which survives undecorate as `CLAIM`. Requiring uppercase keeps every
  // corpus case and drops ordinary prose like "Claim checks pass now."
  return /^🔒\s*claim\b/i.test(t) || /^CLAIM\b/.test(t)
}

/**
 * Does this line announce a release? Generous, per the asymmetry above: the
 * open padlock, or the word leading the line, or an issue reference leading a
 * line that goes on to say RELEASE — `#2680 (…): **RELEASE** — PR #2754` — or
 * a withdrawal (`withdrawnLine`, #3182). The ref-leading arm is reserved for
 * the word RELEASE, which the corpus uses that way; `#3005 — WITHDRAWN,
 * collided` is deliberately not a release (WITHDRAWN has no such use).
 */
function releaseLine(line) {
  const t = undecorate(line)
  if (/^🔓/.test(t)) return true
  if (/^releas(e|ed)\b/i.test(t)) return true
  if (/^#\d{1,6}\b/.test(t) && /\breleas(e|ed)\b/i.test(t)) return true
  if (withdrawnLine(t)) return true
  return false
}

/**
 * `↩️ WITHDRAWN #N — <why>` is a release (#3182): the writer gives up a claim
 * they should not have made — a collision, a duplicate — and says why. Before
 * this line the marker was in use (three times on the channel by 2026-09-15)
 * but unparsed, so a withdrawn claim kept its assignee until someone also
 * posted `🔓 RELEASE`. The word may carry any leading emoji (`↩️`, the
 * historical `⚠️ WITHDRAWN — RELEASE #2117`) or none; a line that merely
 * contains the word mid-sentence ("claim WITHDRAWN AS SUPERSEDED" after a
 * `🔓 RELEASE`) is already a release by the padlock and is not matched here.
 * Takes the UNDECORATED line.
 */
function withdrawnLine(t) {
  return /^[^\w#\s]{0,4}\s*withdrawn\b/i.test(t)
}

/**
 * The one shape of bot comment the projection honours (#3177): the merge-time
 * release posted by `claim-release-on-merge.yml`, which always names the PR
 * that landed the work. A bot cannot claim — it owns no work — and a bot
 * release that names no PR is not the workflow's, so both are ignored. Human
 * comments are unaffected: this predicate is consulted only for `authorType
 * === 'Bot'`.
 */
export function botReleaseLine(line) {
  return releaseLine(line) && /\bPR\s*#\d{1,6}\b/i.test(undecorate(line))
}

/**
 * Parse one comment.
 *
 * @param {object} o
 * @param {string} o.body               the comment text
 * @param {number|null} [o.onIssue]     the issue the comment was posted on
 * @param {number} [o.channelIssue]     the standing coordination channel (`coordination-channel.mjs`)
 * @param {string} [o.authorType]       GitHub's `user.type`; 'Bot' narrows the
 *                                      grammar to the merge-time release only
 * @returns {{claim: number[], release: number[]}} issue numbers, disjoint —
 *          a number that both claims and releases in one comment counts as a
 *          release, since that is the safe direction.
 */
export function parse({ body, onIssue = null, channelIssue = CHANNEL_ISSUE, authorType = 'User' }) {
  const claim = []
  const release = []
  const fromBot = authorType === 'Bot'

  let inFence = false

  for (const line of String(body ?? '').split('\n')) {
    // A marker inside a code fence is documentation of the protocol, not a use
    // of it — any comment explaining the format by example would otherwise
    // assign its author.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || isQuoted(line)) continue

    // A bot may only release, and only in the merge-time shape. The bare-issue
    // fallback below is also closed to it: a bot line that names no issue says
    // nothing the projection should act on.
    const isClaim = fromBot ? false : claimLine(line)
    const isRelease = fromBot ? botReleaseLine(line) : releaseLine(line)
    if (!isClaim && !isRelease) continue

    // Release lines may lead with the issue (`#2680 (…): RELEASE — PR #2754`),
    // in which case the run starts at the line head rather than after a keyword.
    const clean = undecorate(line)
    const leadsWithRef = /^#\d{1,6}\b/.test(clean)
    const keyword = leadsWithRef ? null : isRelease ? /releas(e|ed)\b:?/i : /claim\b/i
    let refs
    if (!leadsWithRef && isRelease && withdrawnLine(clean)) {
      // A withdrawal puts its number after the word (`↩️ WITHDRAWN #3005 — …`).
      // Only when nothing follows the word is the number looked for after
      // RELEASE (the historical `⚠️ WITHDRAWN — RELEASE #2117`). The order
      // matters: the reason prose after the number routinely says "released"
      // ("… Philip already released this one"), and searching after that word
      // first would find nothing and leave the stale assignee in place —
      // measured in review of #3182.
      refs = refsOn(clean, /withdrawn\b:?/i)
      if (refs.length === 0) refs = refsOn(clean, keyword)
    } else {
      refs = refsOn(clean, keyword)
    }

    // A marker made ON its own issue may not restate the number:
    // "🔒 CLAIM — branch feat/x — touches: …" posted on #2947.
    //
    // The fallback is NOT open to generously-matched releases. `releaseLine`
    // deliberately matches any line leading with the word, so a sentence like
    // "Release 0.1.21 promoting tonight" — about a version, carrying no issue
    // number — would otherwise unassign the issue it was posted on, erasing a
    // live claim. That is the exact failure this module exists to avoid, and it
    // would fire on the owner, whose claim it erases. An explicit 🔓 is a
    // deliberate use of the protocol and keeps the fallback.
    // `↩` with or without the U+FE0F presentation selector, as keyboards differ.
    const mayFallBack = !fromBot && (isClaim || /^\s*(?:🔓|↩\uFE0F?)/.test(undecorate(line)))
    if (refs.length === 0 && mayFallBack && onIssue && onIssue !== channelIssue) refs = [onIssue]

    for (const n of refs) {
      if (n === channelIssue) continue // never assign the standing thread
      if (isRelease) {
        if (!release.includes(n)) release.push(n)
      } else if (!claim.includes(n)) {
        claim.push(n)
      }
    }
  }

  // Release wins: a comment that claims one issue and releases another is
  // ordinary, but a number appearing on both sides means the writer said
  // something ambiguous, and unassigning is the direction that cannot mislead.
  return { claim: claim.filter((n) => !release.includes(n)), release }
}

// ---------------------------------------------------------------------------
// CLI — reads the comment from a file (never argv, so no quoting hazard) and
// prints one `claim=<n>` / `release=<n>` line per issue for the shell to read.
// Exit 0 always when the input is readable: a comment that says nothing about
// claims is the common case, not an error.
//
//   node scripts/ci/claim-assignee.mjs --body comment.txt [--on-issue 2947] [--author-type Bot]
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const { readFileSync } = await import('node:fs')
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }

  const bodyPath = arg('body')
  if (!bodyPath) {
    console.error('usage: claim-assignee.mjs --body <file> [--on-issue N]')
    process.exit(2)
  }

  const onIssueRaw = arg('on-issue')
  const onIssue = onIssueRaw && /^\d+$/.test(onIssueRaw) ? Number(onIssueRaw) : null
  const authorType = arg('author-type', 'User')
  const { claim, release } = parse({ body: readFileSync(bodyPath, 'utf8'), onIssue, authorType })

  const lines = [...claim.map((n) => `claim=${n}`), ...release.map((n) => `release=${n}`)]
  process.stdout.write(lines.length ? `${lines.join('\n')}\n` : '')
}
