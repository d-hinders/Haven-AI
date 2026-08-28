#!/usr/bin/env node
// Post-merge health check for a pull request — the "Merged ≠ all green" step in
// `.agents/skills/ship-next/SKILL.md` § Merge Gate, made executable.
//
// Why this is a program and not a line of prose (#2116). The rule used to say
// "confirm the blocking jobs' conclusions on the head SHA", and every agent
// obeyed it by reusing a `headRefOid` captured earlier — usually when the PR was
// opened. The head SHA is not stable across that window. Anything that rewrites
// the branch between capture and merge (auto-merge's own "update branch",
// `gh pr update-branch` to clear BEHIND, merging `dev` in to clear DIRTY, a
// reviewer's suggestion commit) leaves the captured SHA describing a commit that
// never merged.
//
// Measured on PR #2114 (2026-08-27): captured head `bcc23cb5`, merged head
// `af36577f`. `check-runs` on the captured SHA reported 1 failure + 5 cancelled;
// on the real merged head, 23/23 success. That instance produced a false RED.
// The mirror image — a green superseded run standing in for a red merged one —
// is the same bug pointed at the direction that actually hurts, and it is what
// this rule exists to prevent.
//
// The structural fix is the interface: this tool takes a PR NUMBER, never a SHA.
// There is no argument through which a stale SHA can enter. `--expect <sha>` is
// diagnostic only — it reports drift, it never becomes the thing verified.

import { execFileSync } from 'node:child_process'

// Conclusions that mean the job ran and said no.
const FAILING = new Set(['failure', 'timed_out', 'startup_failure', 'stale'])

/**
 * Reduce a commit's check runs to one verdict.
 *
 * `cancelled` is deliberately NOT folded into "not a failure". A cancelled run
 * is the `concurrency: CI-<pr>, cancel-in-progress: true` guard in
 * `.github/workflows/ci.yml` doing its job: a newer run for the same PR
 * superseded this one. Reading it as green is exactly the false-green #2116 is
 * about — you would be reporting a verdict for a commit that was replaced.
 *
 * Zero check runs is also not green. That is the #1777 parked-runs shape
 * (`total_count: 0` beside runs held at `action_required`), and "nothing said
 * no" has never been the same claim as "the blocking jobs passed".
 */
export function verdictFor(checkRuns) {
  const runs = checkRuns ?? []
  const name = (r) => r.name ?? '(unnamed)'

  const failed = runs.filter((r) => FAILING.has(r.conclusion)).map(name).sort()
  const cancelled = runs.filter((r) => r.conclusion === 'cancelled').map(name).sort()
  const pending = runs.filter((r) => r.status !== 'completed').map(name).sort()
  const succeeded = runs.filter((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped').map(name).sort()

  let verdict
  if (runs.length === 0) verdict = 'no-checks'
  else if (failed.length > 0) verdict = 'red'
  else if (cancelled.length > 0) verdict = 'superseded'
  else if (pending.length > 0) verdict = 'pending'
  else verdict = 'green'

  return { verdict, total: runs.length, failed, cancelled, pending, succeeded }
}

/**
 * Decide which commit to ask about, from a freshly-read PR record.
 *
 * The answer is the head SHA, re-read now — not the merge commit. On a squash
 * merge (this repo's feature → `dev` method) the merge commit has ONE parent, so
 * there is no "second parent" to recover the head from; and the squash commit's
 * own check runs are the push-to-`dev` run, a different and smaller set. On
 * PR #2114 that was 16 checks against the PR head's 23 — every PR-only job
 * (`Doc↔code coupling`, `Contract-doc coupling`, both design-system coupling
 * gates, `Banned product-copy terms`) absent. Verifying the merge commit answers
 * "is `dev` green now", which is worth knowing and is reported alongside, but it
 * is not "did this PR's blocking jobs pass on what landed".
 *
 * The head SHA survives `--delete-branch`: the PR record keeps `headRefOid`
 * after the branch is gone (verified on #2114, branch deleted at merge).
 */
export function resolveVerificationTarget(pr) {
  if (!pr || typeof pr.headRefOid !== 'string' || pr.headRefOid.length === 0) {
    throw new Error('PR record carries no headRefOid — cannot verify anything')
  }
  return {
    sha: pr.headRefOid,
    merged: pr.state === 'MERGED',
    state: pr.state,
    mergeCommit: pr.mergeCommit?.oid ?? null,
  }
}

/**
 * Compare a SHA the caller captured earlier against the one just re-read.
 * Reports drift; never substitutes the captured value for the resolved one.
 */
export function describeDrift(captured, resolved) {
  if (!captured) return { drifted: false, checked: false }
  const short = (s) => s.slice(0, 8)
  // Accept an abbreviated captured SHA — that is how they get pasted around.
  const drifted = !resolved.startsWith(captured) && !captured.startsWith(short(resolved))
  return { drifted, checked: true, captured, resolved, message: drifted
    ? `STALE: the SHA you captured (${captured}) is NOT the merged head (${short(resolved)}). Anything you concluded from it describes a commit that never merged.`
    : `The captured SHA matches the merged head (${short(resolved)}).` }
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
}

function repoSlug() {
  const r = gh(['repo', 'view', '--json', 'nameWithOwner'])
  return r.nameWithOwner
}

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'))
  const expect = (argv.find((a) => a.startsWith('--expect=')) ?? '').split('=')[1]
  const prNumber = args[0]

  if (!prNumber || !/^\d+$/.test(prNumber)) {
    console.error('usage: node scripts/ci/verify-merged-head.mjs <pr-number> [--expect=<sha you captured earlier>]')
    console.error('Takes a PR number, never a SHA — the SHA is re-read here so it cannot be stale.')
    return 2
  }

  const slug = repoSlug()
  const pr = gh(['pr', 'view', prNumber, '--json', 'state,headRefOid,mergeCommit,title'])
  const target = resolveVerificationTarget(pr)

  console.log(`PR #${prNumber} — ${pr.title ?? ''}`)
  console.log(`state: ${target.state}   head SHA (re-read now): ${target.sha}`)
  if (target.mergeCommit) console.log(`merge commit: ${target.mergeCommit}`)

  if (expect) {
    const drift = describeDrift(expect, target.sha)
    console.log(drift.drifted ? `\n⚠️  ${drift.message}` : `\n${drift.message}`)
  }

  const runs = gh(['api', '--paginate', `repos/${slug}/commits/${target.sha}/check-runs`, '-q', '[.check_runs[] | {name, status, conclusion}]'])
  const result = verdictFor(runs)

  console.log(`\ncheck runs on ${target.sha.slice(0, 8)}: ${result.total} total, ${result.succeeded.length} ok`)
  if (result.failed.length) console.log(`  FAILED:    ${result.failed.join(', ')}`)
  if (result.cancelled.length) console.log(`  CANCELLED: ${result.cancelled.join(', ')}`)
  if (result.pending.length) console.log(`  PENDING:   ${result.pending.join(', ')}`)

  switch (result.verdict) {
    case 'green':
      console.log('\n✅ GREEN — every check run on the merged head completed successfully.')
      return 0
    case 'superseded':
      console.log('\n🔁 SUPERSEDED — cancelled runs on the head SHA. A newer run for this PR')
      console.log('   replaced them (concurrency: CI-<pr>, cancel-in-progress). This is NOT a pass')
      console.log(`   and NOT a failure. Cross-check with: gh run list --commit ${target.sha.slice(0, 8)}`)
      return 1
    case 'pending':
      console.log('\n⏳ PENDING — checks still running on the merged head. Not verified yet.')
      return 1
    case 'no-checks':
      console.log('\n❓ NO CHECK RUNS on the merged head. Not a pass. Runs may be parked at')
      console.log('   action_required (#1777) — look for them with: gh api ' + `repos/${slug}/actions/runs?head_sha=${target.sha}`)
      return 1
    default:
      console.log('\n❌ RED — a blocking job failed on the commit that merged. Fix or revert before taking new work.')
      return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
