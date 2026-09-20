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
// Two sources, because GitHub's `closingIssuesReferences` (GraphQL) carries
// only the references it linked from the PR BODY — measured on PR #2314, where
// `Closes #2268` sat in a commit message, closed #2268 on merge, and is absent
// from that list. So: GitHub's list, plus the closing keywords in the title and
// every commit message, read with the grammar `operator-verify-close-guard.mjs`
// already maintains for the same reason (`parseClosingRefs`). The commit/title
// scan runs only when the PR merges into the DEFAULT branch: GitHub closes
// nothing on a merge into any other branch, so a `dev → main` promotion never
// releases (its thirty `Closes #` commit lines would otherwise spam #1289).
// Every issue found by the scan alone is checked against GitHub — it is
// released only if it IS closed now; one GitHub did not close is logged and
// left alone, so the workflow never un-claims an issue that is still open.
// `Refs #N` (operator-verify mode) is neither a keyword nor a linked
// reference, so an issue kept open for a human step keeps its claim.
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
// Posted to #1289 only if a CLAIM for that issue is found in the channel's
// recent comments, read with the SAME parser the projection uses, so a quoted
// or fenced claim does not count and the leading-run rule applies. Without the
// gate every merge would add a line to a 1,400-comment thread for claims that
// were only ever made on the issue. "Recent" is the last two REST pages —
// ≤200 comments, about a week at current volume — so a branch older than that
// gets no channel copy even if its claim was there; the issue release still is.

import { parse } from './claim-assignee.mjs'
import { parseClosingRefs, commitsFromGraphQL } from './operator-verify-close-guard.mjs'

export const CHANNEL_ISSUE = 1289
export const AUTO_RELEASE_MARK = 'posted automatically on merge (#3177)'

/**
 * @param {object} o
 * @param {{number:number, merged:boolean, author:string, authorType?:string, mergeCommit?:string|null, base?:string|null}} o.pr
 * @param {{number:number, assignees?:string[], state?:string}[]} o.closingIssues
 *        GitHub's linked references (no `state`) plus scan-found issues (with
 *        the `state` GitHub reports for them now)
 * @param {string[]} [o.channelBodies]   comment bodies on the channel issue
 * @param {number} [o.channelIssue]
 * @returns {{releases: {issue:number, body:string, unassign:string[]}[], channel: {body:string}|null, skipped: {issue:number, reason:string}[]}}
 */
export function decide({ pr, closingIssues, channelBodies = [], channelIssue = CHANNEL_ISSUE }) {
  const none = { releases: [], channel: null, skipped: [] }
  if (!pr || pr.merged !== true) return none
  if (!Number.isInteger(pr.number) || pr.number <= 0) return none

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
    if (issue.state !== undefined && String(issue.state).toLowerCase() !== 'closed') {
      // Named by a commit keyword but GitHub did not close it (the keyword sat
      // in a code span, or the merge did not reach the default branch). Its
      // claim is live; say so and leave it.
      skipped.push({ issue: n, reason: `still ${issue.state} — GitHub did not close it on this merge; release by hand if you claimed it` })
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

const CLOSING_QUERY = 'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ title closingIssuesReferences(first:50){ nodes{ number assignees(first:20){ nodes{ login } } } } } } }'
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
 * The reads the decision needs. Throws on a failed read — the CLI turns that
 * into a logged, exit-0 "nothing released", never a red run.
 *
 * @param {object} o
 * @param {(args:string[], opts?:object)=>Promise<string>} o.gh
 * @param {string} o.repo             owner/name
 * @param {number} o.prNumber
 * @param {boolean} o.scanCommits     true when the PR merged into the default branch
 * @param {number} [o.channelIssue]
 */
export async function fetchInputs({ gh, repo, prNumber, scanCommits, channelIssue = CHANNEL_ISSUE }) {
  const [owner, name] = repo.split('/')
  const vars = ['-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prNumber}`]

  const linked = parseJsonStrict(await gh(['api', 'graphql', ...vars, '-f', `query=${CLOSING_QUERY}`, '--jq', '.data.repository.pullRequest']), 'closing references')
  const closingIssues = (linked?.closingIssuesReferences?.nodes ?? []).map((node) => ({
    number: Number(node.number),
    assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
  }))

  if (scanCommits) {
    // Title + every commit message, the grammar the close guard maintains.
    const texts = [linked?.title ?? '']
    let cursor = null
    for (let page = 0; page < 5; page += 1) {
      const args = ['api', 'graphql', ...vars, '-f', `query=${COMMITS_QUERY}`, '--jq', '.data.repository.pullRequest.commits']
      if (cursor) args.push('-F', `cursor=${cursor}`)
      const connection = parseJsonStrict(await gh(args), 'commit messages')
      for (const c of commitsFromGraphQL(connection)) texts.push(c.message)
      if (!connection?.pageInfo?.hasNextPage) break
      cursor = connection.pageInfo.endCursor
    }
    for (const text of texts) {
      for (const n of parseClosingRefs(text)) {
        if (closingIssues.some((i) => i.number === n)) continue
        // Found by the scan alone: ask GitHub whether it actually closed it.
        const issue = parseJsonStrict(await gh(['api', `repos/${repo}/issues/${n}`]), `issue #${n}`)
        closingIssues.push({
          number: n,
          assignees: (issue?.assignees ?? []).map((a) => a.login),
          state: issue?.state ?? 'unknown',
        })
      }
    }
  }

  // The whole channel, not a window: a claim posted weeks ago for a branch
  // that merges today still gets its channel copy. ~14 calls at today's size.
  const pages = parseJsonStrict(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${channelIssue}/comments?per_page=100`]), 'channel comments') ?? []
  const channelBodies = []
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const c of Array.isArray(page) ? page : []) channelBodies.push(String(c.body ?? ''))
  }
  return { closingIssues, channelBodies }
}

/**
 * Apply a decision. Every write is attempted independently and a refusal is
 * logged, never thrown — the workflow must not fail the build over a comment.
 * Bodies go through stdin (`-F -`), never argv.
 */
export async function apply(decision, { gh, repo, channelIssue = CHANNEL_ISSUE, log = console.log }) {
  const done = []
  for (const s of decision.skipped ?? []) log(`  left #${s.issue} alone: ${s.reason}`)
  for (const rel of decision.releases) {
    try {
      await gh(['issue', 'comment', String(rel.issue), '--repo', repo, '-F', '-'], { input: rel.body })
      log(`  released #${rel.issue}`)
      done.push({ kind: 'comment', issue: rel.issue })
    } catch (e) {
      log(`  could not comment on #${rel.issue} (skipped): ${e?.message ?? e}`)
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
// closing.json : GraphQL `closingIssuesReferences.nodes`
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
    const ev = readJson(eventPath)
    pr = prFromPayload(ev.pull_request ?? ev)
    if (pr.merged !== true) {
      // Decide before fetching: an unmerged close never reads anything.
      process.stdout.write(`${JSON.stringify(decide({ pr, closingIssues: [] }))}\n`)
      process.exit(0)
    }
    try {
      ;({ closingIssues, channelBodies } = await fetchInputs({
        gh: ghRunner(), repo, prNumber: pr.number,
        scanCommits: pr.defaultBranch !== null && pr.base === pr.defaultBranch,
      }))
    } catch (e) {
      console.log(`could not read this merge's closing references or the channel — nothing released (release by hand if you claimed): ${e?.message ?? e}`)
      process.stdout.write(`${JSON.stringify({ releases: [], channel: null, skipped: [] })}\n`)
      process.exit(0)
    }
  } else {
    pr = prFromPayload(readJson(prPath))
    closingIssues = (readJson(closingPath) ?? []).map((node) => ({
      number: Number(node.number),
      assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
      ...(node.state !== undefined ? { state: node.state } : {}),
    }))
    const channelPath = arg('channel')
    channelBodies = channelPath ? (readJson(channelPath) ?? []).map((c) => String(c.body ?? '')) : []
  }

  const decision = decide({ pr, closingIssues, channelBodies })
  process.stdout.write(`${JSON.stringify(decision)}\n`)
  if (has('apply')) {
    if (decision.releases.length === 0 && decision.skipped.length === 0) console.log('This merge closed no issue — nothing to release.')
    else await apply(decision, { gh: ghRunner(), repo })
  }
}
