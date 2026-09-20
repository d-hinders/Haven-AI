// Decides what `.github/workflows/claim-release-on-merge.yml` posts when a
// pull request merges: a `🔓 RELEASE` on every issue the PR closes, an
// unassign of everyone still assigned there, and — only when the claim was
// also posted on the coordination channel — the same line on #1289.
//
// ## Why a machine posts the release (#3177)
//
// The claim protocol in AGENTS.md § Cross-session agent coordination asks the
// author to release "every place you claimed" once the PR is up — the moment
// attention has already moved on. Measured on 2026-09-19: 613 CLAIM lines on
// #1289 and 60 issue numbers claimed with no matching RELEASE in the channel,
// 58 of them on issues that had closed via a PR. A missed release is the
// projection's documented failure mode (a stale assignee reads as live work),
// and the one moment the repository KNOWS the work landed is the merge event.
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
// GitHub's own `closingIssuesReferences` (GraphQL) — the same grammar GitHub
// honours for `Closes #N` in the title, body and commits — never a regex of
// our own. `Refs #N` (operator-verify mode) is deliberately absent from that
// list, so an issue kept open for a human step keeps its claim.
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
// were only ever made on the issue.

import { parse } from './claim-assignee.mjs'

export const CHANNEL_ISSUE = 1289
export const AUTO_RELEASE_MARK = 'posted automatically on merge (#3177)'

/**
 * @param {object} o
 * @param {{number:number, merged:boolean, author:string, mergeCommit?:string|null, base?:string|null}} o.pr
 * @param {{number:number, assignees?:string[]}[]} o.closingIssues  GitHub's closingIssuesReferences
 * @param {string[]} [o.channelBodies]   recent comment bodies on the channel issue
 * @param {number} [o.channelIssue]
 * @returns {{releases: {issue:number, body:string, unassign:string[]}[], channel: {body:string}|null}}
 */
export function decide({ pr, closingIssues, channelBodies = [], channelIssue = CHANNEL_ISSUE }) {
  const none = { releases: [], channel: null }
  if (!pr || pr.merged !== true) return none
  if (!Number.isInteger(pr.number) || pr.number <= 0) return none

  const sha = typeof pr.mergeCommit === 'string' && /^[0-9a-f]{7,40}$/i.test(pr.mergeCommit)
    ? pr.mergeCommit.slice(0, 8)
    : null
  const where = [sha ? `squash \`${sha}\`` : null, pr.base ? `into \`${pr.base}\`` : null]
    .filter(Boolean)
    .join(', ')

  const releases = []
  for (const issue of closingIssues ?? []) {
    const n = Number(issue?.number)
    if (!Number.isInteger(n) || n <= 0 || n === channelIssue) continue
    if (releases.some((r) => r.issue === n)) continue
    const unassign = [...new Set([...(issue.assignees ?? []), pr.author].filter((s) => typeof s === 'string' && s.length > 0))]
    releases.push({
      issue: n,
      body: `🔓 RELEASE #${n} — landed as PR #${pr.number}${where ? ` (${where})` : ''} — ${AUTO_RELEASE_MARK}; nothing to release by hand.`,
      unassign,
    })
  }
  if (releases.length === 0) return none

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

  return { releases, channel }
}

// ---------------------------------------------------------------------------
// Fetch and apply — `gh` is injected so the tests drive these with a recorder.
// ---------------------------------------------------------------------------

/** Default runner: `gh` on PATH, GH_TOKEN from the environment. */
export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
  }
}

/**
 * The two reads the decision needs, using GitHub's own grammar for "which
 * issues does this PR close" and the channel's most recent ≤200 comments
 * (two REST pages — GraphQL caps `last:` at 100).
 */
export async function fetchInputs({ gh, repo, prNumber, channelIssue = CHANNEL_ISSUE }) {
  const [owner, name] = repo.split('/')
  const query = 'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ closingIssuesReferences(first:50){ nodes{ number assignees(first:20){ nodes{ login } } } } } } }'
  const closingRaw = JSON.parse(await gh([
    'api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prNumber}`, '-f', `query=${query}`,
    '--jq', '.data.repository.pullRequest.closingIssuesReferences.nodes',
  ]))
  const closingIssues = (closingRaw ?? []).map((node) => ({
    number: Number(node.number),
    assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
  }))

  const total = Number(await gh(['api', `repos/${repo}/issues/${channelIssue}`, '--jq', '.comments'])) || 0
  const last = Math.max(1, Math.ceil(total / 100))
  const pages = last > 1 ? [last - 1, last] : [last]
  const channelBodies = []
  for (const page of pages) {
    const raw = JSON.parse(await gh(['api', `repos/${repo}/issues/${channelIssue}/comments?per_page=100&page=${page}`]))
    for (const c of raw ?? []) channelBodies.push(String(c.body ?? ''))
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
    mergeCommit: ev?.merge_commit_sha ?? null,
    base: ev?.base?.ref ?? null,
  }
}

// ---------------------------------------------------------------------------
// CLI — inputs are FILES (never argv), because two of them carry public
// comment text and one carries a PR body. Prints one JSON document; with
// `--apply` it also posts.
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
    ;({ closingIssues, channelBodies } = await fetchInputs({ gh: ghRunner(), repo, prNumber: pr.number }))
  } else {
    pr = prFromPayload(readJson(prPath))
    closingIssues = (readJson(closingPath) ?? []).map((node) => ({
      number: Number(node.number),
      assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
    }))
    const channelPath = arg('channel')
    channelBodies = channelPath ? (readJson(channelPath) ?? []).map((c) => String(c.body ?? '')) : []
  }

  const decision = decide({ pr, closingIssues, channelBodies })
  process.stdout.write(`${JSON.stringify(decision)}\n`)
  if (has('apply')) {
    if (decision.releases.length === 0) console.log('This merge closed no issue — nothing to release.')
    else await apply(decision, { gh: ghRunner(), repo })
  }
}
