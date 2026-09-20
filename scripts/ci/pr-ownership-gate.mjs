// Fails a pull request that would close an issue somebody else holds (#3179).
//
// ## The incident this closes
//
// #3015, 2026-09-15 (every time read from the issue's timeline, #1289 and PR
// #3022): Daniel claimed the issue on its own thread at 12:50:01Z (the
// projection assigned him); Antonio's checker missed that claim and posted a
// second one on #1289 at 13:03:08Z (the projection added him too); Daniel
// opened PR #3022 — `Closes #3015` — at 13:28:09Z, released the issue fifty
// seconds later (RELEASE 13:28:59Z, unassigned 13:29:13Z) and merged at
// 13:41:14Z while Antonio was still the assignee and his claim stood. Nobody
// talked. The claim protocol had no gate on the builder side: nothing between a
// pushed branch and a merged PR asked "does the issue this PR closes belong to
// you?" This check asks — at `opened`, when the first claimant had not yet
// released — and while the answer is "no" the PR cannot merge: 38 minutes from
// Antonio's claim to that merge, the conversation that never happened.
//
// ## The rule
//
// For every issue the PR would close (the same candidate set the merge-time
// release uses — GitHub's linked references plus the closing keywords in the
// title and commit messages, read back from GitHub): if the issue is open and
// somebody OTHER than the PR author is its assignee, or holds a LIVE claim on
// it under the #3178 holder rule (a collaborator's claim comment, last activity
// < 24 h, no RELEASE since), the check fails and names them, with a link to
// the claim. No assignee and no live claim, or assignee == author, passes. A
// DRAFT PR passes (a draft is not a merge candidate — the check re-runs on
// `ready_for_review`). A PR into a non-default branch passes (GitHub closes
// nothing there). A closed candidate is skipped.
//
// The failure text gives the two ways out: coordinate in #1289 for a handover
// (the holder posts `🔓 RELEASE`), or drop the closing keyword and use `Refs`.
//
// The author's OWN hold start is passed to the shared holder rule, so a claim
// posted later than the author's — the one #3178 refuses — does not block the
// author's PR: a refused claim is not a claim here either. Bot assignees do not
// count (a GitHub App's login ends in `[bot]`; the Copilot coding agent, login
// `Copilot`, type Bot, is not distinguishable from a login alone — none of this
// repo's assignable users is a bot today). A STALE foreign holder who is still
// assigned blocks through the assignee field; the report names the third way
// out for that case: post your own claim, and #3178 takes the stale hold over.
//
// Time of check vs time of use: the check re-runs on open, edit, push, reopen
// and ready-for-review. An issue claimed by somebody else AFTER the last run can
// merge on a stale green tick — the PR author was there first, which is the
// protocol's own answer; stated so nobody reads the tick as a live lock.
//
// ## Fail closed
//
// A required check that cannot read the issues it must judge FAILS, with the
// read error in the log, rather than passing — the operator-verify close guard
// sets that precedent, and a green check that judged nothing is the worse
// outcome. Re-run the job after a transient error.
//
// ## Interaction with the merge-time release (#3177)
//
// The release runs after the merge, and a merge cannot happen while this check
// is red, so by construction an issue is released only when it belonged to the
// PR that closed it — or its holder released it first.

import { fetchCandidates } from './release-on-merge.mjs'
import { fetchClaimState, liveHolders, holderClaim, ageText, branchOf, sameLogin, CHANNEL_ISSUE } from './claim-collision.mjs'

/**
 * Pure verdict.
 *
 * @param {object} o
 * @param {{number:number, author:string, draft:boolean, base?:string|null, defaultBranch?:string|null}} o.pr
 * @param {{number:number, state:string, isPullRequest?:boolean, unreadable?:boolean, assignees:string[], live:{holder:string, claim:{createdAt:string, body?:string, onIssue?:number, htmlUrl?:string|null}, lastActivityAt?:string|null}[]}[]} o.issues
 *        every candidate, read back: assignees, and the live holders OTHER
 *        than the author (from `liveHolders`)
 * @param {number} [o.nowMs]
 * @returns {{verdict:'pass'|'fail', reason:string, findings:{issue:number, assignees:string[], holders:{login:string, claimedAt:string, url:string|null, branch:string|null, where:string}[]}[], report:string}}
 */
export function evaluate({ pr, issues, nowMs = Date.now(), channelIssue = CHANNEL_ISSUE }) {
  if (pr.draft === true) return { verdict: 'pass', reason: 'draft pull request — not a merge candidate; re-checked on ready_for_review', findings: [], report: '' }
  if (pr.defaultBranch && pr.base !== pr.defaultBranch) return { verdict: 'pass', reason: `merges into ${pr.base}, not the default branch — GitHub closes nothing there`, findings: [], report: '' }

  const findings = []
  const unreadable = []
  for (const issue of issues ?? []) {
    if (!Number.isInteger(issue?.number)) continue
    if (issue.unreadable) {
      unreadable.push(issue.number)
      continue
    }
    if (issue.isPullRequest || String(issue.state).toLowerCase() !== 'open') continue
    // A bot assignee (a coding agent GitHub lets you assign) is nobody's claim.
    const foreignAssignees = (issue.assignees ?? []).filter((a) => a && !sameLogin(a, pr.author) && !/\[bot\]$/i.test(a))
    const holders = (issue.live ?? [])
      .filter((h) => !sameLogin(h.holder, pr.author))
      .map((h) => {
        const since = h.firstClaim ?? h.claim // the hold's start, not the newest re-claim
        return {
          login: h.holder,
          claimedAt: since?.createdAt ?? null,
          lastActivityAt: h.lastActivityAt ?? null,
          url: since?.htmlUrl ?? null,
          branch: branchOf(h.claim?.body),
          where: since?.onIssue === channelIssue ? `#${channelIssue}` : `#${issue.number}`,
        }
      })
    if (foreignAssignees.length === 0 && holders.length === 0) continue
    findings.push({ issue: issue.number, assignees: foreignAssignees, holders })
  }

  if (unreadable.length > 0 && findings.length === 0) {
    // Fail closed: a candidate that could not be read cannot be judged.
    return {
      verdict: 'fail',
      reason: `could not read issue(s) ${unreadable.map((n) => `#${n}`).join(', ')} — the gate fails closed; re-run after a transient error`,
      findings: [],
      report: `❌ PR ownership gate: could not read ${unreadable.map((n) => `#${n}`).join(', ')}. A required check that judged nothing must not pass. Re-run this job.`,
    }
  }
  if (findings.length === 0) return { verdict: 'pass', reason: 'every issue this PR closes is unheld or held by its author', findings: [], report: '' }

  const lines = [`❌ PR ownership gate: this pull request would close ${findings.length === 1 ? 'an issue' : `${findings.length} issues`} held by someone else.`, '']
  for (const f of findings) {
    const parts = []
    for (const h of f.holders) {
      const age = h.claimedAt ? ageText(h.claimedAt, nowMs) : 'at an unknown time'
      const active = h.lastActivityAt && h.lastActivityAt !== h.claimedAt ? `, last active on it ${ageText(h.lastActivityAt, nowMs)}` : ''
      parts.push(`@${h.login} claimed it ${age} on ${h.where}${h.branch ? ` (branch \`${h.branch}\`)` : ''}${active}${h.url ? ` — ${h.url}` : ''}`)
    }
    const onlyAssigned = f.assignees.filter((a) => !f.holders.some((h) => sameLogin(h.login, a)))
    if (onlyAssigned.length) parts.push(`assigned to ${onlyAssigned.map((a) => `@${a}`).join(', ')} (no live claim comment found — a tracking assignment still counts here; if their claim went stale, post your own \`🔒 CLAIM #${f.issue}\` and the projection takes it over)`)
    lines.push(`- #${f.issue}: ${parts.join('; ')}.`)
  }
  lines.push('', 'Two ways out (AGENTS.md § Cross-session agent coordination):', `1. Coordinate in #${channelIssue} for a handover — the holder posts \`🔓 RELEASE #<issue>\` (and unassigns), then re-run this check.`, '2. Keep the PR but stop closing the issue: change `Closes #<issue>` to `Refs #<issue>` in the body, title and commit messages (the check re-runs on edit and on push).', '', `A draft PR is not gated; mark ready when the ownership is settled. Posted by the PR ownership gate (#3179).`)
  return { verdict: 'fail', reason: `held by someone else: ${findings.map((f) => `#${f.issue}`).join(', ')}`, findings, report: lines.join('\n') }
}

/**
 * Read everything `evaluate` needs: the PR's candidate issues (linked refs +
 * title/commit keywords, read back) and, per open candidate, the live holders
 * other than the author. Throws on a failed PR/candidate read (fail closed);
 * a single unreadable candidate is marked, not thrown, by `fetchCandidates`.
 */
export async function collect({ gh, repo, prNumber, author, nowMs = Date.now(), channelIssue = CHANNEL_ISSUE }) {
  const { closingIssues } = await fetchCandidates({ gh, repo, prNumber })
  const issues = []
  for (const c of closingIssues) {
    if (c.unreadable || c.isPullRequest || String(c.state).toLowerCase() !== 'open') {
      issues.push({ number: c.number, state: c.state ?? 'unknown', isPullRequest: c.isPullRequest === true, unreadable: c.unreadable === true, assignees: c.assignees ?? [], live: [] })
      continue
    }
    const { assignees, comments } = await fetchClaimState({ gh, repo, issue: c.number, channelIssue })
    // When the author's own hold BEGAN (their first claim after their last
    // release — a re-claim or channel copy does not move it): a claim posted
    // after it does not block (older wins — the rule #3178's reply applies).
    const own = holderClaim({ holder: author, issue: c.number, comments, channelIssue })
    const claimedAt = own.claim && !own.releasedAfter ? (own.firstClaim ?? own.claim).createdAt : null
    const { live } = liveHolders({ issue: c.number, claimant: author, assignees, comments, claimedAt, nowMs, channelIssue })
    issues.push({ number: c.number, state: 'open', assignees, live })
  }
  return { issues }
}

export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
}

/** The PR fields the gate needs, from the `pull_request` event object. */
export function prFromPayload(ev) {
  return {
    number: Number(ev?.number),
    author: ev?.user?.login ?? '',
    draft: ev?.draft === true,
    base: ev?.base?.ref ?? null,
    defaultBranch: ev?.base?.repo?.default_branch ?? null,
  }
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/ci/pr-ownership-gate.mjs --event "$GITHUB_EVENT_PATH"`
// Exit 0 = pass, 1 = fail (or could not read: fail closed), 2 = bad arguments.
// The report goes to stdout so the job log and the step summary can carry it.
// The process ends by itself (never `process.exit` after a stdout write).
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) await (async () => {
  const { readFileSync } = await import('node:fs')
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const eventPath = arg('event')
  if (!eventPath) {
    console.error('usage: pr-ownership-gate.mjs --event <file>')
    process.exitCode = 2
    return
  }
  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  try {
    const ev = JSON.parse(readFileSync(eventPath, 'utf8'))
    const pr = prFromPayload(ev.pull_request ?? ev)
    let issues = []
    if (!pr.draft && !(pr.defaultBranch && pr.base !== pr.defaultBranch)) {
      ;({ issues } = await collect({ gh: ghRunner(), repo, prNumber: pr.number, author: pr.author }))
    }
    const result = evaluate({ pr, issues })
    if (result.verdict === 'pass') {
      console.log(`✅ PR ownership gate: ${result.reason}.`)
      process.exitCode = 0
    } else {
      console.log(result.report)
      process.exitCode = 1
    }
  } catch (e) {
    console.log(`❌ PR ownership gate: could not read this pull request's closing references or their issues — the gate fails closed. Re-run this job. (${e?.message ?? e})`)
    process.exitCode = 1
  }
})()
