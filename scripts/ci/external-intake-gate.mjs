// Fails a pull request into `dev` that is external, or that would close an
// external issue, until a maintainer accepts it (#4200 part C). The
// definitions — maintainer, Bot, external, accepted, blocked — live in
// `external-intake.mjs`; this file applies them to one pull request.
//
// ## The rule
//
// A non-draft PR into `dev` FAILS when either
//   1. the PR itself is blocked (external author, not accepted), or
//   2. an issue it CLOSES is open and blocked.
// The closing set is `fetchCandidates` from `release-on-merge.mjs`, used
// unchanged — GitHub's linked references plus the closing keywords in the title
// and commit messages, the PR ownership gate's set (#3179). `Refs #n` and plain
// mentions are NOT gated: they are how an external issue is cited (the revert,
// PR #4195, carries `Refs #4107`). Closed candidates and pull-request numbers
// are skipped. Standing is read live, never from the event payload: a label
// applied with `GITHUB_TOKEN` fires no `labeled` event, and the label is not
// the control anyway.
//
// The #4107 shape this closes: a `NONE`-authored issue, closed by a
// COLLABORATOR's PR (#4148) that merged with no review.
//
// ## What it cannot see (accepted residual, per the issue's threat model)
//
// A PR that only mentions or `Refs` an external issue, and a maintainer
// re-filing external content under their own name. The agent refusal
// (AGENTS.md, part B) covers the agent case. A collaborator whose invite is
// still pending reads `NONE` and is gated until it is accepted.
//
// ## Re-running
//
// Accepting an ISSUE does not re-trigger `pull_request_target` on the PRs that
// close it (the ownership gate's precedent), so the failure text says to re-run
// the check or edit the PR. Accepting the PR itself does: `unlabeled` is one of
// the workflow's trigger types.
//
// ## Fail closed
//
// A read that errors — the PR, a candidate, its events, an actor's permission —
// fails the check with the error in the log. Re-run after a transient error.

import { fetchCandidates } from './release-on-merge.mjs'
import { EXTERNAL_LABEL, maintainerActorResolver, readStanding } from './external-intake.mjs'

export const GATED_BASE = 'dev'

const WAY_OUT = (n) => `a maintainer removes \`${EXTERNAL_LABEL}\` from #${n}, then re-runs this check or edits the PR`

/**
 * Pure verdict.
 *
 * @param {object} o
 * @param {{number:number, draft:boolean, base:string|null}} o.pr
 * @param {{number:number, author:string, association:string, blocked:boolean}|null} o.prStanding
 * @param {{number:number, state?:string, isPullRequest?:boolean, unreadable?:boolean, error?:string, author?:string, association?:string, blocked?:boolean}[]} o.issues
 * @returns {{verdict:'pass'|'fail', reason:string, report:string}}
 */
export function evaluate({ pr, prStanding, issues }) {
  if (pr.draft === true) return { verdict: 'pass', reason: 'draft pull request — not a merge candidate; re-checked on ready_for_review', report: '' }
  if (pr.base !== GATED_BASE) return { verdict: 'pass', reason: `merges into ${pr.base}, not ${GATED_BASE}`, report: '' }

  const lines = []
  if (prStanding?.blocked) {
    lines.push(`- This pull request (#${pr.number}) is by @${prStanding.author} (${prStanding.association}), not a maintainer, and no maintainer has accepted it — ${WAY_OUT(pr.number)}.`)
  }
  const unreadable = []
  for (const i of issues ?? []) {
    if (!Number.isInteger(i?.number)) continue
    if (i.unreadable) {
      unreadable.push(i)
      continue
    }
    if (i.isPullRequest || String(i.state).toLowerCase() !== 'open') continue
    if (i.blocked) lines.push(`- It closes #${i.number}, opened by @${i.author} (${i.association}), not a maintainer, and not accepted — ${WAY_OUT(i.number)}.`)
  }
  for (const u of unreadable) lines.push(`- Could not read #${u.number}${u.error ? ` (${u.error})` : ''} — the gate fails closed; re-run this check.`)

  if (lines.length === 0) return { verdict: 'pass', reason: 'neither this pull request nor any open issue it closes is unaccepted external intake', report: '' }
  return {
    verdict: 'fail',
    reason: `${lines.length} blocking item(s)`,
    report: [
      '❌ External intake gate: Haven does not take outside contributions without a maintainer accepting them.',
      '',
      ...lines,
      '',
      `Citing an external issue is fine: \`Refs #<n>\` and plain mentions are not gated, only closing keywords and linked references. Posted by the External intake gate (#4200).`,
    ].join('\n'),
  }
}

/** Everything `evaluate` needs, read live. Throws when the PR or its closing set cannot be read. */
export async function collect({ gh, repo, prNumber }) {
  const isMaintainerActor = maintainerActorResolver({ gh, repo })
  const prStanding = await readStanding({ gh, repo, number: prNumber, isMaintainerActor })
  const { closingIssues } = await fetchCandidates({ gh, repo, prNumber })
  const issues = []
  for (const c of closingIssues) {
    if (c.unreadable || c.isPullRequest || String(c.state).toLowerCase() !== 'open') {
      issues.push({ number: c.number, state: c.state ?? 'unknown', isPullRequest: c.isPullRequest === true, unreadable: c.unreadable === true })
      continue
    }
    try {
      issues.push(await readStanding({ gh, repo, number: c.number, isMaintainerActor }))
    } catch (e) {
      issues.push({ number: c.number, unreadable: true, error: String(e?.message ?? e) })
    }
  }
  return { prStanding, issues }
}

export function ghRunner() {
  return async (args, { input } = {}) => {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  }
}

/** The PR fields read from the payload: routing only (number, draft, base) — never standing. */
export function prFromPayload(ev) {
  return { number: Number(ev?.number), draft: ev?.draft === true, base: ev?.base?.ref ?? null }
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/ci/external-intake-gate.mjs --event "$GITHUB_EVENT_PATH"`
// Exit 0 = pass, 1 = fail (or could not read: fail closed), 2 = bad arguments.
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
    console.error('usage: external-intake-gate.mjs --event <file>')
    process.exitCode = 2
    return
  }
  const repo = process.env.GITHUB_REPOSITORY ?? 'd-hinders/Haven-AI'
  try {
    const ev = JSON.parse(readFileSync(eventPath, 'utf8'))
    const pr = prFromPayload(ev.pull_request ?? ev)
    let prStanding = null
    let issues = []
    if (!pr.draft && pr.base === GATED_BASE) ({ prStanding, issues } = await collect({ gh: ghRunner(), repo, prNumber: pr.number }))
    const result = evaluate({ pr, prStanding, issues })
    if (result.verdict === 'pass') {
      console.log(`✅ External intake gate: ${result.reason}.`)
      process.exitCode = 0
    } else {
      console.log(result.report)
      process.exitCode = 1
    }
  } catch (e) {
    console.log(`❌ External intake gate: could not read this pull request or its closing references — the gate fails closed. Re-run this job. (${e?.message ?? e})`)
    process.exitCode = 1
  }
})()
