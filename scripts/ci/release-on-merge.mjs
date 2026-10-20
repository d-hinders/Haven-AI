// Decides what `.github/workflows/claim-release-on-merge.yml` posts when a
// pull request merges: a `🔓 RELEASE` on every issue the PR closes, an
// unassign of everyone still assigned there, and — only when the claim was
// also posted on the coordination channel — the same line there
// (`CHANNEL_ISSUE`, from `coordination-channel.mjs`). Since #4176 it also
// releases the PR author's claim on an issue the merge only `Refs` (Path A),
// and — for `.github/workflows/claim-release-on-close.yml` — the claims on an
// issue closed with no merge behind the close (Path B). Both are below.
//
// ## Why a machine posts the release (#3177)
//
// The claim protocol in AGENTS.md § Cross-session agent coordination asks the
// author to release "every place you claimed" once the PR is up — the moment
// attention has already moved on. Measured on 2026-09-19 over #1289's comments
// with a plain `CLAIM #N` / `RELEASE #N` regex at any line position: 613 CLAIM
// lines, 60 issue numbers claimed with no matching RELEASE, 58 of them on
// issues that had closed via a PR. The projection's own `parse()` (leading
// marker, quotes and fences excluded) counts 33 unreleased on 2026-09-20 —
// the method halves the number and does not change the shape: every one is
// a stale reading. A missed release is the projection's documented failure
// mode, and the one moment the repository KNOWS the work landed is the merge.
//
// ## Who does the unassign
//
// This script, directly (`apply`). The bot's comment does NOT re-enter
// `claim-assignee.yml`: a comment posted with `GITHUB_TOKEN` never triggers an
// `issue_comment` run (GitHub's non-recursion rule — measured: the morning
// report's eleven bot comments produced zero projection runs). The parser's
// `--author-type Bot` grammar is still the contract for the day the poster is
// an App token, but nothing here depends on it.
//
// ## Why this file exists apart from the workflow
//
// Every decision that can be wrong lives here, under `node --test`, so the
// acceptance mutation in #3177 — "disable the merged filter → a closed-unmerged
// PR must NOT release" — is a red test rather than a hope. The workflow only
// fetches inputs and applies the emitted actions.
//
// ## Which issues a PR closes
//
// Candidates come from two sources, because GitHub's `closingIssuesReferences`
// (GraphQL) carries only the references it linked from the PR BODY — measured
// on PR #2314, where a closing keyword for #2268 sat in a commit message,
// closed that issue on merge, and is absent from that list. So: GitHub's list,
// (first 50) plus the closing keywords in the title and every commit message
// (paginated, up to 500 — a longer list is refused, never read in part), with the grammar `operator-verify-close-guard.mjs` already maintains for the same
// reason (`parseClosingRefs`).
//
// A candidate is RELEASED only if GitHub closed it BY THIS MERGE: the issue is
// read back and must be `closed` with `closed_at` in the window
// [`merged_at`, `merged_at` + 5 min]. Measured 2026-09-20 over the last 100
// merged PRs into `dev` (GraphQL `pullRequests(states:MERGED, baseRefName:
// "dev")` × `closingIssuesReferences { closedAt }`, gap = closedAt − mergedAt):
// 83 pairs, 81 inside the window, every one of them +1 s or +2 s — GitHub
// stamps the close one to two seconds AFTER the merge, never before, so the
// window opens exactly at the merge. The only two outliers are the two cases
// the bounds exist for: #3068 → #3055 at +2.5 days (that merge DID close it,
// at +1 s; a person reopened it two days later and #3163's merge re-closed it
// seconds later — GitHub reports only the LATEST closed_at, so a re-closed pair reads
// as an outlier in any later snapshot, which is why the count is 81 of 83 and
// not 83 of 83) and #3009 → #2966 at −2.6 h (closed before the merge, merely
// mentioned). The five minutes cover a slow close event, and the upper
// bound is what excludes an issue re-closed by hand hours or days later — it
// cannot tell a hand close INSIDE the window apart. "Referenced and closed now"
// is not enough — measured during review of this very PR (#3187), whose body
// prose at the time linked #2268 (closed 2026-09-02 by a person, unrelated):
// GitHub's merge is a silent no-op on an already-closed issue, and releasing
// it would have manufactured exactly the stale reading this exists to delete,
// on the issue and on the channel. The same rule drops a quoted keyword in commit
// prose (this repo's history has one citing another PR's closing line for
// #1496), a cross-repo reference whose digits the grammar keeps (a keyword
// aimed at other/repo#42 would read as our #42 — GitHub honours the qualifier
// and closes nothing), and the #2314 → #2268 case itself: the merge closed
// #2268 at +1 s, a person REOPENED it at +13 min and closed it by hand two days
// later, so its `closed_at` is outside the window and it is left alone — the
// human's reopen is honoured, not overwritten. A candidate that is a PULL
// REQUEST (the issues API answers for those too) is skipped. An issue GitHub
// did not close is listed under `skipped` with the reason, never released.
//
// Nothing is released at all for a merge into a non-default branch: GitHub
// closes nothing there, so a `dev → main` promotion (thirty `Closes #` commit
// lines) never releases and never spams the channel. `Refs #N` (operator-verify
// mode) is neither a keyword nor a linked reference, so the merge path leaves
// it alone — Path A below releases it.
//
// ## Path A: a `Refs`-only reference releases the author's claim (#4176)
//
// Owner decision, 2026-10-20: a merged PR whose title, body or commits say
// `Refs #N` (the close guard's grammar family, `parseRefsRefs`), and which does
// not also close #N, releases the PR AUTHOR's claim on #N at merge time — one
// `🔓 RELEASE` line naming the author on #N, the same line on the channel when
// the channel holds the author's claim of #N, and an unassign of the author
// only. The issue stays open for its operator step; other sessions' claims and
// assignees are untouched. Nothing is posted when the author holds no
// unreleased claim of #N, or #N is not open. Measured on 2026-10-20: eight
// stale claims backfilled by hand on #3193, every one from a `Refs`-only PR.
// The candidates live in `fetchRefsInputs`, NOT in `fetchCandidates`: the PR
// ownership gate imports `fetchCandidates`, and a `Refs` number there would
// fail the gate for every PR that `Refs` somebody else's issue.
//
// ## Path B: a close with no merge behind it (#4176)
//
// `.github/workflows/claim-release-on-close.yml` runs `--close-event` on
// `issues: closed`. A close a merge did not cause releases every collaborator's
// unreleased claim on the issue (`decideClose`). It defers to the merge path by
// mirroring that path's rule exactly — a closer PR (the timeline's closed
// event) merged into the default branch, `closed_at` within CLOSE_WINDOW_MS
// after `merged_at` — because both events fire within seconds and neither run
// sees the other's line in time.
//
// Limits, stated rather than guarded:
//   - `closingIssuesReferences(first:50)` truncates body-linked references at
//     fifty. The title and commit keyword scan still sees the rest, but an
//     issue linked ONLY from the body past the fiftieth is closed by GitHub,
//     not released by the merge path, and deferred by Path B as merge-closed —
//     released by neither. Path B does not re-read the PR to check.
//   - A close made with `GITHUB_TOKEN` never fires `issues: closed` (GitHub's
//     non-recursion rule), so the bot self-closes in `qa-failure-issue.mjs`,
//     `qa-balance-issue.mjs`, `dev-push-health.mjs` and `guard-freshness.mjs`
//     release nothing.
//   - A mass hand-close fans out one run per issue, and each reads the whole
//     channel (~14 REST pages at ~1,400 comments); the REST rate limit bounds
//     how many such runs fit in an hour.
//
// ## One line per thread
//
// Each run posts at most one comment per thread, naming every claimant it
// releases there. A re-run posts nothing where the thread already carries the
// line: the merge path checks its own mark for the same PR (`alreadyReleased`),
// and Paths A and B read their own per-claimant lines back through
// `claimsToRelease`, per thread.
//
// ## Who is unassigned
//
// Everyone assigned to the closed issue, not only the PR author. The assignee
// field is a projection of live claims (`claim-assignee.yml`), and no claim on
// a CLOSED issue is live — the workflow that maintains the field already skips
// claims on closed issues for the same reason. A second session's assignee
// left behind is exactly the stale reading this exists to remove.
//
// ## The channel copy
//
// Posted to the channel only if a CLAIM for that issue is anywhere in the channel,
// read with the SAME parser the projection uses, so a quoted or fenced claim
// does not count and the leading-run rule applies. Without the gate every
// merge would add a line to a ~1,400-comment thread for claims that were only
// ever made on the issue. The WHOLE thread is read (every REST page, ~14
// calls today), not a window: a claim posted weeks ago for a branch that
// merges today still gets its channel copy.

import { parse, REFS_RELEASE_MARK, CLOSE_RELEASE_MARK } from './claim-assignee.mjs'
import { holderClaim, readComments, sameLogin, TRUSTED_ASSOCIATIONS } from './claim-collision.mjs'
import { CHANNEL_ISSUE } from './coordination-channel.mjs'
import { parseClosingRefs, parseRefsRefs, commitsFromGraphQL } from './operator-verify-close-guard.mjs'

export { CHANNEL_ISSUE, REFS_RELEASE_MARK, CLOSE_RELEASE_MARK }
export const AUTO_RELEASE_MARK = 'posted automatically on merge (#3177)'
/**
 * How long after `merged_at` a close still counts as this merge's. Measured
 * +1…+2 s on every legitimate pair (see the header); five minutes covers a
 * slow close event. It does NOT distinguish a hand close inside those five
 * minutes (PR #2364 → #2361 was closed by hand at +109 s, and that one had in
 * fact landed) — the bound exists to exclude a re-close hours or days later
 * (#2314 → #2268). It is not a retry budget either: the script reads each
 * candidate once, ~30 s after the merge; a close that lands later than that
 * read is skipped as "open now", never released late.
 */
export const CLOSE_WINDOW_MS = 5 * 60_000

/**
 * @param {object} o
 * @param {{number:number, merged:boolean, mergedAt?:string|null, author:string, authorType?:string, mergeCommit?:string|null, base?:string|null, defaultBranch?:string|null}} o.pr
 * @param {{number:number, assignees?:string[], state?:string, closedAt?:string|null, unreadable?:boolean, isPullRequest?:boolean}[]} o.closingIssues
 *        every candidate (linked or scanned), each READ BACK from GitHub:
 *        `state`, `closedAt`, current assignees, whether the number is a pull
 *        request; `unreadable` when that read failed (not an issue here)
 * @param {string[]} [o.channelBodies]   comment bodies on the channel issue
 * @param {number} [o.channelIssue]
 * @returns {{releases: {issue:number, body:string, unassign:string[]}[], channel: {body:string}|null, skipped: {issue:number, reason:string}[]}}
 */
export function decide({ pr, closingIssues, channelBodies = [], channelIssue = CHANNEL_ISSUE }) {
  const none = { releases: [], channel: null, skipped: [] }
  if (!pr || pr.merged !== true) return none
  if (!Number.isInteger(pr.number) || pr.number <= 0) return none
  // GitHub closes nothing on a merge into a non-default branch (a promotion).
  if (pr.defaultBranch && pr.base !== pr.defaultBranch) return none
  const mergedAtMs = Date.parse(pr.mergedAt ?? '')

  const sha = typeof pr.mergeCommit === 'string' && /^[0-9a-f]{7,40}$/i.test(pr.mergeCommit)
    ? pr.mergeCommit.slice(0, 8)
    : null
  // No merge-method word: feature PRs squash into dev, promotions merge into
  // main with a merge commit, and the event does not say which — the sha does.
  const where = [sha ? `\`${sha}\`` : null, pr.base ? `into \`${pr.base}\`` : null]
    .filter(Boolean)
    .join(', ')
  // A bot author (dependabot) was never assigned; only a person can hold a claim.
  const author = pr.authorType === undefined || pr.authorType === 'User' ? pr.author : ''

  const releases = []
  const skipped = []
  for (const issue of closingIssues ?? []) {
    const n = Number(issue?.number)
    if (!Number.isInteger(n) || n <= 0 || n === channelIssue) continue
    if (releases.some((r) => r.issue === n) || skipped.some((r) => r.issue === n)) continue
    if (issue.unreadable) {
      skipped.push({ issue: n, reason: 'could not be read (not an issue in this repository, or a transient error) — nothing released for it' })
      continue
    }
    if (issue.isPullRequest) {
      skipped.push({ issue: n, reason: 'is a pull request, not an issue — the claim protocol has nothing to release there' })
      continue
    }
    if (issue.state === undefined || issue.closedAt === undefined) {
      skipped.push({ issue: n, reason: 'no state read back from GitHub — nothing released for it' })
      continue
    }
    if (String(issue.state).toLowerCase() !== 'closed') {
      // GitHub reports it open now: the keyword sat in a code span, pointed at
      // another repository, or a person reopened it since the merge. Either
      // way its claim is live; say so and leave it.
      skipped.push({ issue: n, reason: `GitHub reports it ${issue.state} now — not closed by this merge, or reopened since; release by hand if you claimed it` })
      continue
    }
    const closedAtMs = Date.parse(issue.closedAt ?? '')
    if (!Number.isFinite(mergedAtMs) || !Number.isFinite(closedAtMs) || closedAtMs < mergedAtMs || closedAtMs > mergedAtMs + CLOSE_WINDOW_MS) {
      // Closed, but not by this merge: an already-closed issue this PR merely
      // mentioned, or one re-closed by hand later. GitHub's merge was a no-op
      // on it; so is this.
      skipped.push({ issue: n, reason: `closed ${issue.closedAt ?? 'at an unknown time'}, outside this merge's window (${pr.mergedAt ?? 'unknown'} + 5 min) — not closed by it, nothing released` })
      continue
    }
    const unassign = [...new Set([...(issue.assignees ?? []), author].filter((s) => typeof s === 'string' && s.length > 0))]
    releases.push({
      issue: n,
      body: `🔓 RELEASE #${n} — landed as PR #${pr.number}${where ? ` (${where})` : ''} — ${AUTO_RELEASE_MARK}; nothing to release by hand.`,
      unassign,
    })
  }
  if (releases.length === 0) return { ...none, skipped }

  // A claim is "on the channel" when the projection's own parser reads one
  // there — same grammar, same exclusions (quotes, fences, leading run).
  const claimedOnChannel = new Set()
  for (const body of channelBodies) {
    for (const n of parse({ body, onIssue: channelIssue, channelIssue }).claim) claimedOnChannel.add(n)
  }
  const forChannel = releases.filter((r) => claimedOnChannel.has(r.issue))
  const channel = forChannel.length
    ? { body: forChannel.map((r) => r.body).join('\n') }
    : null

  return { releases, channel, skipped }
}

// ---------------------------------------------------------------------------
// The per-claimant releases (#4176): Path A, a merged `Refs`-only reference,
// and Path B, a close with no merge behind it. Both release named claimants'
// claims — never "the issue" — so both share one rule for "whose claim is
// still unreleased, on which thread".
// ---------------------------------------------------------------------------

const isTrustedPerson = (c) => TRUSTED_ASSOCIATIONS.has(String(c?.authorAssociation ?? '').toUpperCase()) && String(c?.authorType ?? 'User') !== 'Bot'
const isBotComment = (c) => String(c?.authorType ?? 'User') === 'Bot'

/**
 * Which claimants of `issue` still hold an unreleased claim, per thread.
 *
 * A claimant is a collaborator (OWNER / MEMBER / COLLABORATOR — the holder
 * rule's `TRUSTED_ASSOCIATIONS`), and a person, who posted a claim of `issue`
 * on the issue or on the channel; `only` narrows that to the logins given
 * (Path A: the PR author). Their claim is released on a thread when, after
 * their newest claim:
 *   - THEY posted a release or withdrawal of it, on either thread (their own
 *     `🔓 RELEASE` / `↩️ WITHDRAWN` — `holderClaim`'s rule); or
 *   - a bot line on THAT thread names them in a per-claimant shape (the
 *     previous run of this script — the idempotency check, per thread, so a
 *     run that posted on the issue and failed on the channel re-posts only the
 *     channel line); or
 *   - the merge-time line (#3177) for `issue` is on THAT thread (it released
 *     every claim before it; a later close of a reopened issue must not
 *     release them twice).
 *
 * @param {object} o
 * @param {number} o.issue
 * @param {{author:string, body:string, createdAt:string, onIssue:number, authorAssociation?:string, authorType?:string}[]} o.comments
 *        the issue's comments and the channel's, as `readComments` returns them
 * @param {string[]|null} [o.only]
 * @returns {{onIssue: string[], onChannel: string[]}} the claimants to name on
 *          each thread (the channel only for claimants whose claim is THERE)
 */
export function claimsToRelease({ issue, comments, only = null, channelIssue = CHANNEL_ISSUE }) {
  const all = comments ?? []
  const claimants = new Map() // lower-cased login → { login, onChannel }
  for (const c of all) {
    if (!c?.author || !isTrustedPerson(c)) continue
    if (only && !only.some((o) => sameLogin(o, c.author))) continue
    if (!parse({ body: c.body, onIssue: c.onIssue ?? null, channelIssue }).claim.includes(issue)) continue
    const key = c.author.toLowerCase()
    const prev = claimants.get(key) ?? { login: c.author, onChannel: false }
    claimants.set(key, { ...prev, onChannel: prev.onChannel || c.onIssue === channelIssue })
  }

  const unreleasedOn = (login, thread) => {
    const view = all.filter((c) => (sameLogin(c.author, login) && isTrustedPerson(c)) || (isBotComment(c) && c.onIssue === thread))
    const h = holderClaim({ holder: login, issue, comments: view, channelIssue })
    if (!h.claim || h.releasedAfter) return false
    const claimMs = Date.parse(h.claim.createdAt)
    const mergeReleased = view.some((c) => isBotComment(c) && String(c.body ?? '').includes(AUTO_RELEASE_MARK)
      && parse({ body: c.body, onIssue: thread, channelIssue, authorType: 'Bot' }).release.includes(issue)
      && Date.parse(c.createdAt) > claimMs)
    return !mergeReleased
  }

  const onIssue = []
  const onChannel = []
  for (const { login, onChannel: claimedOnChannel } of claimants.values()) {
    if (unreleasedOn(login, issue)) onIssue.push(login)
    if (claimedOnChannel && unreleasedOn(login, channelIssue)) onChannel.push(login)
  }
  return { onIssue, onChannel }
}

const claimantList = (logins) => `${logins.length === 1 ? 'claim' : 'claims'} of ${logins.map((l) => `\`${l}\``).join(', ')}`

/** Path A's line. Pinned by test; `botReleaseClaimants` parses it. */
export function refsReleaseLine({ issue, author, pr, where }) {
  return `🔓 RELEASE #${issue} — ${claimantList([author])} — PR #${pr} merged${where ? ` (${where})` : ''} and references the issue with \`Refs\`, so it stays open for its operator step — ${REFS_RELEASE_MARK}.`
}

/** Path B's line. Names no PR. Pinned by test; `botReleaseClaimants` parses it. */
export function closeReleaseLine({ issue, claimants, closer }) {
  return `🔓 RELEASE #${issue} — ${claimantList(claimants)} — the issue was closed${closer ? ` by \`${closer}\`` : ''} with no merge behind the close, so no claim on it is live — ${CLOSE_RELEASE_MARK}.`
}

/**
 * Path A (owner decision, 2026-10-20): a PR merged into the default branch that
 * references an issue with `Refs` and does not close it releases the PR
 * AUTHOR's claim on it — only theirs — and unassigns the author only. The
 * issue stays open for its operator step; other sessions' claims and
 * assignees are untouched.
 *
 * @param {object} o
 * @param {object} o.pr                 as for `decide`
 * @param {{number:number, state?:string, assignees?:string[], isPullRequest?:boolean, unreadable?:boolean}[]} o.refsIssues
 *        from `fetchRefsInputs` — closing candidates already excluded
 * @param {Record<number, object[]>} o.commentsByIssue  each open issue's comments (`readComments`)
 * @param {object[]} [o.channelComments] the channel's comments (`readComments`)
 * @returns {{releases: {issue:number, body:string|null, unassign:string[]}[], channel: {body:string}|null, skipped: {issue:number, reason:string}[]}}
 *          `body: null` means that thread already carries this release (a re-run)
 */
export function decideRefs({ pr, refsIssues, commentsByIssue = {}, channelComments = [], channelIssue = CHANNEL_ISSUE }) {
  const none = { releases: [], channel: null, skipped: [] }
  if (!pr || pr.merged !== true) return none
  if (!Number.isInteger(pr.number) || pr.number <= 0) return none
  if (pr.defaultBranch && pr.base !== pr.defaultBranch) return none
  // A bot author (dependabot) holds no claim.
  if (!(pr.authorType === undefined || pr.authorType === 'User') || !pr.author) return none

  const sha = typeof pr.mergeCommit === 'string' && /^[0-9a-f]{7,40}$/i.test(pr.mergeCommit) ? pr.mergeCommit.slice(0, 8) : null
  const where = [sha ? `\`${sha}\`` : null, pr.base ? `into \`${pr.base}\`` : null].filter(Boolean).join(', ')

  const releases = []
  const skipped = []
  const channelLines = []
  for (const issue of refsIssues ?? []) {
    const n = Number(issue?.number)
    if (!Number.isInteger(n) || n <= 0 || n === channelIssue) continue
    if (releases.some((r) => r.issue === n) || skipped.some((r) => r.issue === n)) continue
    if (issue.unreadable) {
      skipped.push({ issue: n, reason: 'could not be read (not an issue in this repository, or a transient error) — nothing released for it' })
      continue
    }
    if (issue.isPullRequest) {
      skipped.push({ issue: n, reason: 'is a pull request, not an issue — nothing to release there' })
      continue
    }
    if (String(issue.state ?? '').toLowerCase() !== 'open') {
      skipped.push({ issue: n, reason: `GitHub reports it ${issue.state ?? 'unknown'} — a \`Refs\` release is for an issue that stays open; a closed one was released when it closed` })
      continue
    }
    const comments = [...(commentsByIssue[n] ?? []), ...(channelComments ?? [])]
    const { onIssue, onChannel } = claimsToRelease({ issue: n, comments, only: [pr.author], channelIssue })
    if (onIssue.length === 0 && onChannel.length === 0) {
      skipped.push({ issue: n, reason: `no unreleased claim of it by ${pr.author} — nothing to release` })
      continue
    }
    const body = refsReleaseLine({ issue: n, author: pr.author, pr: pr.number, where })
    releases.push({ issue: n, body: onIssue.length ? body : null, unassign: [pr.author] })
    if (onChannel.length) channelLines.push(body)
  }
  return { releases, channel: channelLines.length ? { body: channelLines.join('\n') } : null, skipped }
}

/**
 * Path B: an issue closed with no merge behind the close releases every
 * collaborator's unreleased claim on it, and — only when it released one —
 * unassigns everyone still assigned (no claim on a CLOSED issue is live; the
 * merge path's rule). With no claim to release it posts nothing and leaves the
 * assignees alone: an unassign is always explained by a release line beside
 * it, and an assignee nobody claimed is a person's tracking decision.
 *
 * It DEFERS to the merge path by mirroring that path's exact rule: an issue
 * whose close was caused by a pull request (the timeline's closed event names
 * it as the closer) merged into the default branch, with `closed_at` within
 * [`merged_at`, `merged_at` + CLOSE_WINDOW_MS], is the merge path's — both
 * events fire within seconds and neither run would see the other's line in
 * time. Every other close (by hand, by a direct commit, by a merge outside the
 * window) is this path's.
 *
 * Only a collaborator's close counts. GitHub lets two kinds of account close
 * an issue: a collaborator with triage access or more, and the issue's own
 * author. A close by the author is honoured only when the author is a
 * collaborator (`author_association`); a close by anyone else needed triage
 * access to happen at all. A bot or App close is not a hand close and is
 * skipped (a `GITHUB_TOKEN` close never fires this event anyway).
 *
 * @param {object} o
 * @param {{number:number, state:string, closedAt:string|null, assignees:string[], author:string, authorAssociation:string, isPullRequest?:boolean}} o.issue
 *        read back from GitHub, except `author` / `authorAssociation`, which
 *        come from the event
 * @param {{login:string, type:string}} o.sender     who closed it (the event's `sender`)
 * @param {{kind:'PullRequest', number:number, merged:boolean, mergedAt:string|null, baseRefName:string|null, repository:string|null}|{kind:'Commit'}|{unreadable:true}|null} o.closer
 *        the latest closed event's closer, from the issue timeline
 * @param {string|null} o.defaultBranch
 * @param {string|null} [o.repo]        owner/name — a closer PR must be in it
 * @param {object[]} o.comments         the issue's comments and the channel's (`readComments`)
 * @returns {{releases: {issue:number, body:string|null, unassign:string[]}[], channel: {body:string}|null, skipped: {issue:number, reason:string}[]}}
 */
export function decideClose({ issue, sender, closer, defaultBranch, repo = null, comments, channelIssue = CHANNEL_ISSUE }) {
  const n = Number(issue?.number)
  const skip = (reason) => ({ releases: [], channel: null, skipped: Number.isInteger(n) && n > 0 ? [{ issue: n, reason }] : [] })
  if (!Number.isInteger(n) || n <= 0) return { releases: [], channel: null, skipped: [] }
  if (n === channelIssue) return skip('is the coordination channel — never released')
  if (issue.isPullRequest) return skip('is a pull request — the merge path owns those')
  if (String(issue.state ?? '').toLowerCase() !== 'closed') return skip(`GitHub reports it ${issue.state ?? 'unknown'} now — reopened since the close, so its claims are live`)

  if (String(sender?.type ?? '') !== 'User') return skip(`closed by ${sender?.login ?? 'an unknown account'} (${sender?.type ?? 'no type'}), not by a person — not a hand close`)
  if (sameLogin(sender.login, issue.author) && !TRUSTED_ASSOCIATIONS.has(String(issue.authorAssociation ?? '').toUpperCase())) {
    return skip(`closed by its own author ${sender.login}, who is not a collaborator (${issue.authorAssociation ?? 'NONE'}) — a collaborator's claim is not released on that close`)
  }

  if (closer === undefined || closer?.unreadable) return skip('the timeline\'s closed event could not be read — a merge-caused close cannot be ruled out, so nothing is released (the merge path may own it)')
  if (closer?.kind === 'PullRequest' && closer.merged === true && (!repo || !closer.repository || String(closer.repository).toLowerCase() === String(repo).toLowerCase())) {
    // The merge path's rule, verbatim: a merge into a non-default branch closes
    // nothing there, and the window opens AT the merge.
    const intoDefault = !defaultBranch || closer.baseRefName === defaultBranch
    const mergedAtMs = Date.parse(closer.mergedAt ?? '')
    const closedAtMs = Date.parse(issue.closedAt ?? '')
    const inWindow = Number.isFinite(mergedAtMs) && Number.isFinite(closedAtMs) && closedAtMs >= mergedAtMs && closedAtMs <= mergedAtMs + CLOSE_WINDOW_MS
    if (intoDefault && inWindow) return skip(`closed by the merge of PR #${closer.number} into \`${closer.baseRefName}\` (${closer.mergedAt}) — the merge path releases it`)
  }

  const { onIssue, onChannel } = claimsToRelease({ issue: n, comments, channelIssue })
  if (onIssue.length === 0 && onChannel.length === 0) return skip('no unreleased collaborator claim on it — nothing posted, assignees left as they are')
  const unassign = [...new Set((issue.assignees ?? []).filter((s) => typeof s === 'string' && s.length > 0))]
  return {
    releases: [{ issue: n, body: onIssue.length ? closeReleaseLine({ issue: n, claimants: onIssue, closer: sender.login }) : null, unassign }],
    channel: onChannel.length ? { body: closeReleaseLine({ issue: n, claimants: onChannel, closer: sender.login }) } : null,
    skipped: [],
  }
}

// ---------------------------------------------------------------------------
// Fetch and apply — `gh` is injected so the tests drive these with a recorder.
// ---------------------------------------------------------------------------

/** Default runner: `gh` on PATH, GH_TOKEN from the environment. */
export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    // 64 MiB: the whole channel is ~4 MB today and the default 1 MiB buffer
    // failed with ENOBUFS on the first live dry run (logged, exit 0 — but a
    // channel copy never posted is the defect this exists to remove).
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
}

// `first:50` is a hard cap on linked references; a PR linking more than fifty
// issues is not a shape this repository produces (the scan below still sees
// every commit), stated so the truncation is a decision and not a surprise.
// Path B defers on a merge-caused close without checking this list, so a
// body-only link past the fiftieth is released by neither path (header).
const CLOSING_QUERY = 'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ title closingIssuesReferences(first:50){ nodes{ number } } } } }'
const COMMITS_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ commits(first:100,after:$cursor){ nodes{ commit{ oid message } } pageInfo{ hasNextPage endCursor } } } } }'

/**
 * `gh api --jq` leaves stdout EMPTY when GraphQL answers with errors (they go
 * to stderr). Empty is therefore a failed read, never "no results": treating
 * it as null would turn an outage into a silent empty decision — the false
 * zero this file must not produce. A real empty result is `[]` or `null` text.
 */
function parseJsonStrict(text, what) {
  const t = String(text ?? '').trim()
  if (t === '') throw new Error(`${what}: gh returned no output (GraphQL/REST error — see stderr)`)
  return JSON.parse(t)
}

/**
 * The candidate reads. A failed read of the PR itself throws — the CLI turns
 * that into a logged, exit-0 "nothing released", never a red run. A failed
 * read of ONE candidate issue marks that candidate `unreadable` and the rest
 * proceed: a commit citing a `fixes` keyword for a number that is not an issue
 * here must not cancel the release of the issue the PR actually closed.
 *
 * @param {object} o
 * @param {(args:string[], opts?:object)=>Promise<string>} o.gh
 * @param {string} o.repo             owner/name
 * @param {number} o.prNumber
 */
export async function fetchCandidates({ gh, repo, prNumber }) {
  const [owner, name] = repo.split('/')
  const vars = ['-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prNumber}`]

  const linked = parseJsonStrict(await gh(['api', 'graphql', ...vars, '-f', `query=${CLOSING_QUERY}`, '--jq', '.data.repository.pullRequest']), 'closing references')
  // Candidate numbers, in order: GitHub's linked references first, then the
  // title and every commit message through the close guard's grammar.
  const candidates = []
  for (const node of linked?.closingIssuesReferences?.nodes ?? []) {
    const n = Number(node.number)
    if (Number.isInteger(n) && !candidates.includes(n)) candidates.push(n)
  }
  const texts = [linked?.title ?? '', ...(await readCommitMessages({ gh, vars }))]
  for (const text of texts) {
    for (const n of parseClosingRefs(text)) if (!candidates.includes(n)) candidates.push(n)
  }
  return { closingIssues: await readBack({ gh, repo, numbers: candidates }) }
}

/**
 * Every commit message on the PR, paginated (up to 500). Fails CLOSED rather
 * than read a prefix of the commit list — the close guard's rule for the same
 * loop (500 is well above GitHub's 250 cap).
 */
async function readCommitMessages({ gh, vars }) {
  const messages = []
  let cursor = null
  for (let page = 0; page < 5; page += 1) {
    const args = ['api', 'graphql', ...vars, '-f', `query=${COMMITS_QUERY}`, '--jq', '.data.repository.pullRequest.commits']
    if (cursor) args.push('-F', `cursor=${cursor}`)
    const connection = parseJsonStrict(await gh(args), 'commit messages')
    for (const c of commitsFromGraphQL(connection)) messages.push(c.message)
    if (!connection?.pageInfo?.hasNextPage) return messages
    cursor = connection.pageInfo.endCursor
  }
  throw new Error('more than 500 commits on this pull request; refusing to read a partial list')
}

/** Read EVERY candidate back: state, when it closed, who is assigned now. */
async function readBack({ gh, repo, numbers }) {
  const out = []
  for (const n of numbers) {
    try {
      const issue = parseJsonStrict(await gh(['api', `repos/${repo}/issues/${n}`]), `issue #${n}`)
      out.push({
        number: n,
        assignees: (issue?.assignees ?? []).map((a) => a.login),
        state: issue?.state ?? 'unknown',
        closedAt: issue?.closed_at ?? null,
        ...(issue?.pull_request ? { isPullRequest: true } : {}),
      })
    } catch {
      out.push({ number: n, assignees: [], unreadable: true })
    }
  }
  return out
}

const REFS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ title body } } }'

/**
 * Path A's candidates (#4176): the issues the PR references with `Refs` in its
 * title, body or any commit message, MINUS every closing candidate (`exclude`,
 * the numbers `fetchCandidates` returned) — an issue the PR also closes is the
 * merge path's, so each issue is released by one path only. Read back like the
 * closing candidates, and for each OPEN one, its comments with authors.
 *
 * A separate function on purpose: `pr-ownership-gate.mjs` imports
 * `fetchCandidates`, and a `Refs` number in that set would fail the gate for
 * every PR that `Refs` somebody else's issue — the escape the gate itself
 * recommends.
 */
export async function fetchRefsInputs({ gh, repo, prNumber, exclude = [] }) {
  const [owner, name] = repo.split('/')
  const vars = ['-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prNumber}`]
  const pr = parseJsonStrict(await gh(['api', 'graphql', ...vars, '-f', `query=${REFS_QUERY}`, '--jq', '.data.repository.pullRequest']), 'title and body')
  const texts = [pr?.title ?? '', pr?.body ?? '', ...(await readCommitMessages({ gh, vars }))]
  const numbers = []
  for (const text of texts) {
    for (const n of parseRefsRefs(text, { repo })) if (!numbers.includes(n) && !exclude.includes(n)) numbers.push(n)
  }
  const refsIssues = await readBack({ gh, repo, numbers })
  const commentsByIssue = {}
  for (const issue of refsIssues) {
    if (issue.unreadable || issue.isPullRequest || String(issue.state).toLowerCase() !== 'open' || issue.number === CHANNEL_ISSUE) continue
    commentsByIssue[issue.number] = await readComments({ gh, repo, issue: issue.number })
  }
  return { refsIssues, commentsByIssue }
}

/**
 * The whole channel, not a window: a claim posted weeks ago for a branch that
 * merges today still gets its channel copy. ~14 calls at today's size — read
 * only once the decision has something to release.
 */
export async function fetchChannel({ gh, repo, channelIssue = CHANNEL_ISSUE }) {
  const pages = parseJsonStrict(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${channelIssue}/comments?per_page=100`]), 'channel comments') ?? []
  const channelBodies = []
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const c of Array.isArray(page) ? page : []) channelBodies.push(String(c.body ?? ''))
  }
  return { channelBodies }
}

const CLOSE_QUERY = 'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){ state closedAt assignees(first:100){ nodes{ login } } timelineItems(itemTypes:[CLOSED_EVENT], last:1){ nodes{ ... on ClosedEvent{ createdAt closer{ __typename ... on PullRequest{ number merged mergedAt baseRefName repository{ nameWithOwner } } } } } } } } }'

/**
 * Path B's reads: the issue read back (state, `closedAt`, assignees) with the
 * closer of its LATEST closed event — the pull request or commit GitHub
 * recorded as causing the close, null for a hand close — from the issue
 * timeline, never by re-reading a PR; then the issue's comments and the
 * channel's, with authors. A failed issue read throws (the CLI logs and
 * releases nothing); a timeline with no closed event yet reads as
 * `{ unreadable: true }`, which `decideClose` refuses to release on.
 */
export async function fetchCloseInputs({ gh, repo, issueNumber, channelIssue = CHANNEL_ISSUE }) {
  const [owner, name] = repo.split('/')
  const vars = ['-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${issueNumber}`]
  const node = parseJsonStrict(await gh(['api', 'graphql', ...vars, '-f', `query=${CLOSE_QUERY}`, '--jq', '.data.repository.issue']), `issue #${issueNumber}`)
  const event = node?.timelineItems?.nodes?.[0] ?? null
  let closer
  if (!event) closer = { unreadable: true }
  else if (!event.closer) closer = null
  else if (event.closer.__typename === 'PullRequest') {
    closer = {
      kind: 'PullRequest',
      number: event.closer.number,
      merged: event.closer.merged === true,
      mergedAt: event.closer.mergedAt ?? null,
      baseRefName: event.closer.baseRefName ?? null,
      repository: event.closer.repository?.nameWithOwner ?? null,
    }
  } else closer = { kind: String(event.closer.__typename ?? 'unknown') }
  const issue = {
    number: issueNumber,
    state: String(node?.state ?? 'unknown').toLowerCase(),
    closedAt: node?.closedAt ?? null,
    assignees: (node?.assignees?.nodes ?? []).map((a) => a.login),
  }
  const comments = [...(await readComments({ gh, repo, issue: issueNumber }))]
  if (issueNumber !== channelIssue) comments.push(...(await readComments({ gh, repo, issue: channelIssue })))
  return { issue, closer, comments }
}

/**
 * Apply a per-claimant decision (`decideRefs` / `decideClose`). One comment per
 * thread at most; `body: null` (the thread already carries it) posts nothing.
 * The unassign is naturally idempotent. With `channel: false` the channel line
 * is left to the caller — the merge run posts the merge path's and Path A's
 * channel lines as ONE comment (`apply`'s `channelExtra`). Every write is
 * independent; a refusal is logged, never thrown.
 */
export async function applyPerClaimant(decision, { gh, repo, channelIssue = CHANNEL_ISSUE, channel = true, log = console.log }) {
  const done = []
  for (const s of decision.skipped ?? []) log(`  left #${s.issue} alone: ${s.reason}`)
  for (const rel of decision.releases ?? []) {
    if (rel.body) {
      try {
        await gh(['issue', 'comment', String(rel.issue), '--repo', repo, '-F', '-'], { input: rel.body })
        log(`  released #${rel.issue}`)
        done.push({ kind: 'comment', issue: rel.issue })
      } catch (e) {
        log(`  could not comment on #${rel.issue} (skipped): ${e?.message ?? e}`)
      }
    } else {
      log(`  #${rel.issue} already carries this release — not posting twice`)
    }
    for (const login of rel.unassign ?? []) {
      try {
        await gh(['issue', 'edit', String(rel.issue), '--repo', repo, '--remove-assignee', login])
        log(`  unassigned #${rel.issue} from @${login}`)
        done.push({ kind: 'unassign', issue: rel.issue, login })
      } catch (e) {
        log(`  could not unassign @${login} from #${rel.issue} (skipped): ${e?.message ?? e}`)
      }
    }
  }
  if (channel && decision.channel) {
    try {
      await gh(['issue', 'comment', String(channelIssue), '--repo', repo, '-F', '-'], { input: decision.channel.body })
      log(`  released on the channel (#${channelIssue})`)
      done.push({ kind: 'channel', issue: channelIssue })
    } catch (e) {
      log(`  could not comment on #${channelIssue} (skipped): ${e?.message ?? e}`)
    }
  }
  return done
}

/** Compatibility wrapper: both reads. */
export async function fetchInputs({ gh, repo, prNumber, channelIssue = CHANNEL_ISSUE }) {
  const { closingIssues } = await fetchCandidates({ gh, repo, prNumber })
  const { channelBodies } = await fetchChannel({ gh, repo, channelIssue })
  return { closingIssues, channelBodies }
}

/**
 * Has this merge's release already been posted on that thread? A re-run of the
 * workflow (`gh run rerun`) must not post it twice. Read failures answer
 * "no", so a transient error degrades to one duplicate line, never to a
 * missed release.
 */
async function alreadyReleased({ gh, repo, issue, prNumber, bodies = null }) {
  const carries = (body) => body.includes(AUTO_RELEASE_MARK) && new RegExp(`landed as PR #${prNumber}\\b`).test(body)
  // The channel's bodies were fetched for the decision moments ago — no
  // second 14-page read for the same thread.
  if (Array.isArray(bodies)) return bodies.some((b) => carries(String(b ?? '')))
  try {
    const pages = parseJsonStrict(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?per_page=100`]), 'existing comments') ?? []
    for (const page of Array.isArray(pages) ? pages : []) {
      for (const c of Array.isArray(page) ? page : []) if (carries(String(c.body ?? ''))) return true
    }
  } catch {
    // Fail OPEN: an unreadable thread answers "not yet posted". One duplicate
    // line on a transient error is the cheap failure; a silently suppressed
    // release is the expensive one (tested with a recorder that throws here).
  }
  return false
}

/**
 * Apply a decision. Every write is attempted independently and a refusal is
 * logged, never thrown — the workflow must not fail the build over a comment.
 * Bodies go through stdin (`-F -`), never argv. Idempotent: a thread that
 * already carries this merge's release gets no second comment (the unassign
 * is naturally idempotent).
 */
export async function apply(decision, { gh, repo, prNumber, channelIssue = CHANNEL_ISSUE, channelBodies = null, channelExtra = null, log = console.log }) {
  const done = []
  for (const s of decision.skipped ?? []) log(`  left #${s.issue} alone: ${s.reason}`)
  for (const rel of decision.releases) {
    if (await alreadyReleased({ gh, repo, issue: rel.issue, prNumber })) {
      log(`  #${rel.issue} already carries this merge's release — not posting twice`)
    } else {
      try {
        await gh(['issue', 'comment', String(rel.issue), '--repo', repo, '-F', '-'], { input: rel.body })
        log(`  released #${rel.issue}`)
        done.push({ kind: 'comment', issue: rel.issue })
      } catch (e) {
        log(`  could not comment on #${rel.issue} (skipped): ${e?.message ?? e}`)
      }
    }
    for (const login of rel.unassign) {
      try {
        await gh(['issue', 'edit', String(rel.issue), '--repo', repo, '--remove-assignee', login])
        log(`  unassigned #${rel.issue} from @${login}`)
        done.push({ kind: 'unassign', issue: rel.issue, login })
      } catch (e) {
        log(`  could not unassign @${login} from #${rel.issue} (skipped): ${e?.message ?? e}`)
      }
    }
  }
  // One channel comment per run (#4176): the merge path's lines and Path A's
  // (`channelExtra`, already de-duplicated by `decideRefs`) go out together.
  const channelLines = []
  if (decision.channel) {
    if (await alreadyReleased({ gh, repo, issue: channelIssue, prNumber, bodies: channelBodies })) {
      log(`  #${channelIssue} already carries this merge's release — not posting twice`)
    } else {
      channelLines.push(decision.channel.body)
    }
  }
  if (channelExtra) channelLines.push(channelExtra)
  if (channelLines.length) {
    try {
      await gh(['issue', 'comment', String(channelIssue), '--repo', repo, '-F', '-'], { input: channelLines.join('\n') })
      log(`  released on the channel (#${channelIssue})`)
      done.push({ kind: 'channel', issue: channelIssue })
    } catch (e) {
      log(`  could not comment on #${channelIssue} (skipped): ${e?.message ?? e}`)
    }
  }
  return done
}

/** The PR fields the decision needs, from a REST/webhook `pull_request` object. */
export function prFromPayload(ev) {
  return {
    number: Number(ev?.number),
    merged: ev?.merged === true,
    mergedAt: ev?.merged_at ?? null,
    author: ev?.user?.login ?? '',
    authorType: ev?.user?.type ?? 'User',
    mergeCommit: ev?.merge_commit_sha ?? null,
    base: ev?.base?.ref ?? null,
    defaultBranch: ev?.base?.repo?.default_branch ?? null,
  }
}

/**
 * One merge run's reads and decisions: the merge path (#3177) and Path A
 * (#4176). Path A's reads are independent: if they fail, the merge path still
 * runs and the failure is logged and carried as `refs.error`.
 */
export async function prepareMerge({ pr, gh, repo, channelIssue = CHANNEL_ISSUE, log = console.log }) {
  const { closingIssues } = await fetchCandidates({ gh, repo, prNumber: pr.number })
  const first = decide({ pr, closingIssues, channelIssue })
  let refsInputs = { refsIssues: [], commentsByIssue: {} }
  let refsError = null
  if (pr.authorType === undefined || pr.authorType === 'User') {
    try {
      refsInputs = await fetchRefsInputs({ gh, repo, prNumber: pr.number, exclude: closingIssues.map((c) => c.number) })
    } catch (e) {
      refsError = String(e?.message ?? e)
      log(`could not read this merge's \`Refs\` references — no \`Refs\` release (release by hand if you claimed): ${refsError}`)
    }
  }
  // The channel (~14 calls) is read only when there is something to decide on.
  const needChannel = first.releases.length > 0 || Object.keys(refsInputs.commentsByIssue).length > 0
  const channelComments = needChannel ? await readComments({ gh, repo, issue: channelIssue }) : []
  const channelBodies = channelComments.map((c) => c.body)
  const decision = decide({ pr, closingIssues, channelBodies, channelIssue })
  const refs = { ...decideRefs({ pr, ...refsInputs, channelComments, channelIssue }), ...(refsError ? { error: refsError } : {}) }
  return { decision, refs, channelBodies }
}

/**
 * Post what `prepareMerge` decided. The channel lines of both paths go out as
 * ONE comment (`apply`'s `channelExtra`); Path A's issue threads after.
 */
export async function applyMerge({ decision, refs, channelBodies }, { gh, repo, prNumber, channelIssue = CHANNEL_ISSUE, log = console.log }) {
  const channelExtra = refs?.channel?.body ?? null
  const done = []
  if (decision.releases.length === 0 && decision.skipped.length === 0 && !channelExtra) log('This merge closed no issue — nothing to release.')
  else done.push(...(await apply(decision, { gh, repo, prNumber, channelIssue, channelBodies, channelExtra, log })))
  if (refs && (refs.releases.length || refs.skipped.length)) done.push(...(await applyPerClaimant(refs, { gh, repo, channelIssue, channel: false, log })))
  return done
}

/**
 * One close run (Path B, the `issues: closed` job). `ev` is the event payload.
 * A close by a bot or App is decided from the payload alone and reads nothing.
 */
export async function prepareClose({ ev, gh, repo, channelIssue = CHANNEL_ISSUE }) {
  const number = Number(ev?.issue?.number)
  const sender = { login: ev?.sender?.login ?? '', type: ev?.sender?.type ?? '' }
  const defaultBranch = ev?.repository?.default_branch ?? null
  const fromPayload = { number, state: 'closed', isPullRequest: Boolean(ev?.issue?.pull_request), author: ev?.issue?.user?.login ?? '', authorAssociation: ev?.issue?.author_association ?? 'NONE' }
  if (!Number.isInteger(number) || number <= 0 || fromPayload.isPullRequest || number === channelIssue || sender.type !== 'User') {
    return decideClose({ issue: fromPayload, sender, closer: null, defaultBranch, repo, comments: [], channelIssue })
  }
  const { issue, closer, comments } = await fetchCloseInputs({ gh, repo, issueNumber: number, channelIssue })
  return decideClose({ issue: { ...issue, author: fromPayload.author, authorAssociation: fromPayload.authorAssociation }, sender, closer, defaultBranch, repo, comments, channelIssue })
}

// ---------------------------------------------------------------------------
// CLI — inputs are FILES (never argv), because two of them carry public
// comment text and one carries a PR body. Prints one JSON document; with
// `--apply` it also posts. Exit 0 always once the arguments parse: a merge that
// closed nothing, or a GitHub read that failed, is logged, not a red run.
//
//   Merge:     node scripts/ci/release-on-merge.mjs --event "$GITHUB_EVENT_PATH" --apply
//              (reads .pull_request from the event, fetches the rest with gh;
//              the document carries Path A's decision under `refs`)
//   Close:     node scripts/ci/release-on-merge.mjs --close-event "$GITHUB_EVENT_PATH" --apply
//              (an `issues: closed` payload — Path B)
//   Offline:   node scripts/ci/release-on-merge.mjs --pr pr.json --closing closing.json [--channel channel.json]
//
// pr.json      : a `pull_request` object (event payload or REST)
// closing.json : candidates as read back — [{ number, state, closed_at, assignees: [{ login }] }]
// channel.json : REST issue comments — [{ body }]
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    // realpath both sides: /tmp is a symlink on macOS and the plain
    // `file://${argv[1]}` comparison other CI scripts use silently answered
    // "not main" there — a script that prints nothing and exits 0.
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

// Wrapped in a function so the branches can `return` (top-level `return` is a
// SyntaxError in an ES module) and so the process ends by itself — never
// `process.exit(0)` after a stdout write, which drops the buffered document
// when stdout is a pipe.
if (isMain) await (async () => {
  const { readFileSync } = await import('node:fs')
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const has = (name) => process.argv.includes(`--${name}`)
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

  const eventPath = arg('event')
  const closeEventPath = arg('close-event')
  const prPath = arg('pr')
  const closingPath = arg('closing')
  if (!eventPath && !closeEventPath && !(prPath && closingPath)) {
    console.error('usage: release-on-merge.mjs --event <file> [--apply] | --close-event <file> [--apply] | --pr <file> --closing <file> [--channel <file>]')
    process.exit(2)
  }

  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  let pr
  let closingIssues
  let channelBodies
  if (closeEventPath) {
    let printed = false
    try {
      const ev = readJson(closeEventPath)
      const gh = ghRunner()
      const decision = await prepareClose({ ev, gh, repo })
      process.stdout.write(`${JSON.stringify(decision)}\n`)
      printed = true
      if (has('apply')) await applyPerClaimant(decision, { gh, repo })
      return
    } catch (e) {
      console.log(`could not read this close's event, the issue's timeline or its comments — nothing released (release by hand if you claimed): ${e?.message ?? e}`)
      if (!printed) process.stdout.write(`${JSON.stringify({ releases: [], channel: null, skipped: [] })}\n`)
      return
    }
  }
  if (eventPath) {
    let printed = false
    try {
      const ev = readJson(eventPath)
      pr = prFromPayload(ev.pull_request ?? ev)
      if (pr.merged !== true || (pr.defaultBranch && pr.base !== pr.defaultBranch)) {
        // Decide before fetching: an unmerged close, or a merge into a
        // non-default branch, never reads anything.
        process.stdout.write(`${JSON.stringify(decide({ pr, closingIssues: [] }))}\n`)
        printed = true
        return
      }
      const gh = ghRunner()
      // Decide (and print) first, then apply: one JSON document per run.
      const prepared = await prepareMerge({ pr, gh, repo })
      process.stdout.write(`${JSON.stringify({ ...prepared.decision, refs: prepared.refs })}\n`)
      printed = true
      if (has('apply')) await applyMerge(prepared, { gh, repo, prNumber: pr.number })
      return
    } catch (e) {
      console.log(`could not read this merge's event, closing references or the channel — nothing released (release by hand if you claimed): ${e?.message ?? e}`)
      // One JSON document per run: if the decision was already printed, the
      // failure happened while applying it and is in the log above.
      if (!printed) process.stdout.write(`${JSON.stringify({ releases: [], channel: null, skipped: [] })}\n`)
      return
    }
  } else {
    // Offline shape: each candidate as the workflow would have read it back —
    // { number, state, closed_at, assignees: [{ login }] }.
    pr = prFromPayload(readJson(prPath))
    closingIssues = (readJson(closingPath) ?? []).map((node) => ({
      number: Number(node.number),
      assignees: (node.assignees?.nodes ?? node.assignees ?? []).map((a) => (typeof a === 'string' ? a : a.login)),
      ...(node.state !== undefined ? { state: node.state } : {}),
      ...(node.closed_at !== undefined ? { closedAt: node.closed_at } : {}),
      ...(node.pull_request ? { isPullRequest: true } : {}),
    }))
    const channelPath = arg('channel')
    channelBodies = channelPath ? (readJson(channelPath) ?? []).map((c) => String(c.body ?? '')) : []
  }

  // Offline path (tests, dry runs): decide only, never apply.
  process.stdout.write(`${JSON.stringify(decide({ pr, closingIssues, channelBodies }))}\n`)
})()
