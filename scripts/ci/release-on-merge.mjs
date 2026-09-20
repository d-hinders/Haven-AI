// Decides what `.github/workflows/claim-release-on-merge.yml` posts when a
// pull request merges: a `🔓 RELEASE` on every issue the PR closes, an
// unassign of everyone still assigned there, and — only when the claim was
// also posted on the coordination channel — the same line on #1289.
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
// [`merged_at`, `merged_at` + 5 min]. Measured on eight merge→close pairs
// (#3186/#3134, #2314/#2276, #3175/#3170, …): GitHub stamps the close one to
// three seconds AFTER the merge, never before, so the window opens exactly at
// the merge; the five minutes cover a slow close event, and the upper bound is
// what excludes an issue re-closed by hand later. "Referenced and closed now"
// is not enough — measured during review of this very PR (#3187), whose body
// prose at the time linked #2268 (closed 2026-09-02 by a person, unrelated):
// GitHub's merge is a silent no-op on an already-closed issue, and releasing
// it would have manufactured exactly the stale reading this exists to delete,
// on the issue and on #1289. The same rule drops a quoted keyword in commit
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
// lines) never releases and never spams #1289. `Refs #N` (operator-verify
// mode) is neither a keyword nor a linked reference, so an issue kept open for
// a human step keeps its claim.
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
// Posted to #1289 only if a CLAIM for that issue is anywhere in the channel,
// read with the SAME parser the projection uses, so a quoted or fenced claim
// does not count and the leading-run rule applies. Without the gate every
// merge would add a line to a ~1,400-comment thread for claims that were only
// ever made on the issue. The WHOLE thread is read (every REST page, ~14
// calls today), not a window: a claim posted weeks ago for a branch that
// merges today still gets its channel copy.

import { parse } from './claim-assignee.mjs'
import { parseClosingRefs, commitsFromGraphQL } from './operator-verify-close-guard.mjs'

export const CHANNEL_ISSUE = 1289
export const AUTO_RELEASE_MARK = 'posted automatically on merge (#3177)'
/**
 * How long after `merged_at` a close still counts as this merge's. Measured
 * +1…+3 s on eight real pairs; five minutes covers a slow close event without
 * admitting an issue re-closed by hand later the same day.
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
  const texts = [linked?.title ?? '']
  let cursor = null
  let exhausted = false
  for (let page = 0; page < 5; page += 1) {
    const args = ['api', 'graphql', ...vars, '-f', `query=${COMMITS_QUERY}`, '--jq', '.data.repository.pullRequest.commits']
    if (cursor) args.push('-F', `cursor=${cursor}`)
    const connection = parseJsonStrict(await gh(args), 'commit messages')
    for (const c of commitsFromGraphQL(connection)) texts.push(c.message)
    if (!connection?.pageInfo?.hasNextPage) {
      exhausted = true
      break
    }
    cursor = connection.pageInfo.endCursor
  }
  // Fail CLOSED rather than read a prefix of the commit list — the close
  // guard's rule for the same loop (500 is well above GitHub's 250 cap).
  if (!exhausted) throw new Error('more than 500 commits on this pull request; refusing to read a partial list')
  for (const text of texts) {
    for (const n of parseClosingRefs(text)) if (!candidates.includes(n)) candidates.push(n)
  }

  // Read EVERY candidate back: state, when it closed, who is assigned now.
  const closingIssues = []
  for (const n of candidates) {
    try {
      const issue = parseJsonStrict(await gh(['api', `repos/${repo}/issues/${n}`]), `issue #${n}`)
      closingIssues.push({
        number: n,
        assignees: (issue?.assignees ?? []).map((a) => a.login),
        state: issue?.state ?? 'unknown',
        closedAt: issue?.closed_at ?? null,
        ...(issue?.pull_request ? { isPullRequest: true } : {}),
      })
    } catch {
      closingIssues.push({ number: n, assignees: [], unreadable: true })
    }
  }
  return { closingIssues }
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
async function alreadyReleased({ gh, repo, issue, prNumber }) {
  try {
    const pages = parseJsonStrict(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?per_page=100`]), 'existing comments') ?? []
    for (const page of Array.isArray(pages) ? pages : []) {
      for (const c of Array.isArray(page) ? page : []) {
        const body = String(c.body ?? '')
        if (body.includes(AUTO_RELEASE_MARK) && new RegExp(`landed as PR #${prNumber}\\b`).test(body)) return true
      }
    }
  } catch {
    // fall through
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
export async function apply(decision, { gh, repo, prNumber, channelIssue = CHANNEL_ISSUE, log = console.log }) {
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
  if (decision.channel) {
    if (await alreadyReleased({ gh, repo, issue: channelIssue, prNumber })) {
      log(`  #${channelIssue} already carries this merge's release — not posting twice`)
      return done
    }
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

// ---------------------------------------------------------------------------
// CLI — inputs are FILES (never argv), because two of them carry public
// comment text and one carries a PR body. Prints one JSON document; with
// `--apply` it also posts. Exit 0 always once the arguments parse: a merge that
// closed nothing, or a GitHub read that failed, is logged, not a red run.
//
//   Workflow:  node scripts/ci/release-on-merge.mjs --event "$GITHUB_EVENT_PATH" --apply
//              (reads .pull_request from the event, fetches the rest with gh)
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

if (isMain) {
  const { readFileSync } = await import('node:fs')
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const has = (name) => process.argv.includes(`--${name}`)
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

  const eventPath = arg('event')
  const prPath = arg('pr')
  const closingPath = arg('closing')
  if (!eventPath && !(prPath && closingPath)) {
    console.error('usage: release-on-merge.mjs --event <file> [--apply] | --pr <file> --closing <file> [--channel <file>]')
    process.exit(2)
  }

  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  let pr
  let closingIssues
  let channelBodies
  if (eventPath) {
    try {
      const ev = readJson(eventPath)
      pr = prFromPayload(ev.pull_request ?? ev)
      if (pr.merged !== true || (pr.defaultBranch && pr.base !== pr.defaultBranch)) {
        // Decide before fetching: an unmerged close, or a merge into a
        // non-default branch, never reads anything.
        process.stdout.write(`${JSON.stringify(decide({ pr, closingIssues: [] }))}\n`)
        process.exit(0)
      }
      const gh = ghRunner()
      ;({ closingIssues } = await fetchCandidates({ gh, repo, prNumber: pr.number }))
      // The channel (~14 calls) is read only when there is something to release.
      const first = decide({ pr, closingIssues })
      channelBodies = first.releases.length ? (await fetchChannel({ gh, repo })).channelBodies : []
      const decision = decide({ pr, closingIssues, channelBodies })
      process.stdout.write(`${JSON.stringify(decision)}\n`)
      if (has('apply')) {
        if (decision.releases.length === 0 && decision.skipped.length === 0) console.log('This merge closed no issue — nothing to release.')
        else await apply(decision, { gh, repo, prNumber: pr.number })
      }
      process.exit(0)
    } catch (e) {
      console.log(`could not read this merge's event, closing references or the channel — nothing released (release by hand if you claimed): ${e?.message ?? e}`)
      process.stdout.write(`${JSON.stringify({ releases: [], channel: null, skipped: [] })}\n`)
      process.exit(0)
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
}
