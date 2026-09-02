#!/usr/bin/env node
// CI guard freshness reporter (#2208, widened by #2268) —
// `.github/workflows/guard-freshness.yml`.
//
// ## The problem this exists for
//
// A job that silently stops running looks exactly like a passing one.
// There is no red X for "did not happen". The ways it stops are all mundane:
// the workflow file is renamed or moved, its cron is edited, GitHub disables
// schedules on a repo with 60 days of no activity, a token expires, the default
// branch changes out from under `on: schedule` (which only ever runs from the
// default branch). In every one of those, the last thing anybody saw was green.
//
// #2208 asked for a nightly re-proof of the advisory-lock deadlock. A nightly
// nobody would notice the absence of is a guarantee that decays quietly, so the
// nightly ships with this: a reporter that asks the Actions API when each
// registered guard last SUCCEEDED, and escalates staleness into an issue.
//
// ## Why it is not itself a nightly
//
// The obvious shape — a second cron — has the identical failure mode, and two
// crons dying together is not a hypothetical (they die from repo-level causes:
// schedule disablement, a default-branch change). So this runs on `push` to
// `dev` and `main`. It fires on every merge, dozens of times a week, driven by
// the one event this repository cannot stop producing while it is being worked
// on. A weekly cron is kept as a floor for quiet periods, not as the mechanism.
//
// The remaining layer is in `db-concurrency-proof.test.mjs`, which runs in
// `ci.yml`'s dependency-free per-PR job and asserts the guard's file, its test
// case titles and its env gate are all still where the workflow points. Rename
// something and a pull request goes red immediately — the fast path — while
// this reporter covers the slow one (it ran, then it stopped).
//
// ## What #2268 widened, and why it belongs in the SAME registry
//
// The original registry watched scheduled guards. #2268 was the same defect with
// the sender moved off the premises: `qa-dev.yml`'s `repository_dispatch`
// (`dev-deployed`) trigger — the one that runs the money-flow harness against
// what the dev deploy just shipped — had fired **zero** times in the
// repository's history, while the workflow's other two triggers fired normally
// and the operations doc described all three as live. Nobody noticed, because
// the failure has no red X: a trigger that never fires and a trigger that fires
// and finds nothing are the same picture.
//
// Two arms make that case detectable and they are both in the registry entry
// rather than in this prose: `countedEvents`, so a healthy sibling trigger on
// the same workflow file cannot vouch for the dead one, and `requiredTrigger`,
// so deleting the `on:` block goes red at pull-request time instead of leaving
// a permanently-fresh run history behind it.
//
// ## What #2273 repointed, and the third arm it added
//
// The sender never existed and could not be built where the docs said (#2268:
// Railway's webhooks cannot carry an Authorization header and its only service
// hook is PRE-deploy). #2273 replaced the trigger with GitHub's own
// `deployment_status` event — Railway creates real Deployments — and this
// entry now watches THAT. Repointed, never deleted: a registry entry naming a
// trigger that no longer exists guards nothing, and the whole file exists
// because "guards nothing" looks like "green".
//
// The third arm is `provenance` (#2271). The old entry counted
// `repository_dispatch` runs on `dev`, and a manual
// `gh api .../dispatches` produced one structurally identical to a real
// post-deploy run — the diagnostic dispatch sent while investigating #2268 read
// as "✓ last success 0.0d ago" for four days with no hook configured. A
// `deployment_status` run has something a curl cannot fake: the Deployments API
// records WHO created the deployment of that SHA, and only Railway's GitHub App
// installation can write `railway-app[bot]`. So a run counts only when a
// Railway-created deployment of the run's exact `headSha` exists for the dev
// environment. A `workflow_dispatch`, a `schedule`, or a Deployment a human
// creates through the API with their own token all fail that lookup.
//
// `evaluate()` and `selectQualifyingRuns()` are pure; every `gh` call lives in
// the CLI wrapper at the bottom.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Shared with the dev → main promotion gate (#2404): ONE definition of which
// qa-dev.yml job moves money and how its conclusion is read off a run's job
// list, so the two gates cannot disagree. qa-freshness.mjs guards its CLI
// behind an argv check, so importing it runs nothing.
import { MONEY_FLOW_JOB, moneyFlowJobConclusion } from './qa-freshness.mjs'

export { MONEY_FLOW_JOB }

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The Railway-side facts the post-deploy trigger keys on (#2273). Both strings
 * are OUTSIDE this repository's control: the environment name is whatever the
 * Railway project calls it, and the creator is the Railway GitHub App's login.
 * `.github/workflows/qa-dev.yml`'s gate job carries the same two literals, and
 * `guard-freshness.test.mjs` pins that file to these constants — so the
 * workflow's filter and this guard's provenance check cannot drift apart. If
 * Railway renames the environment, the gate skips every run, no run qualifies
 * here, and the `stale` finding fires within `maxAgeDays` — which is the alarm
 * doing its job, not a false positive to silence.
 */
export const RAILWAY_DEV_ENVIRONMENT = 'Haven AI / dev'
export const RAILWAY_DEPLOY_CREATOR = 'railway-app[bot]'

/**
 * The one issue this reporter owns. Upserted, and CLOSED when everything is healthy.
 *
 * The word "scheduled" was dropped in #2268: the registry now also covers a
 * trigger fired from outside the repository, and a title that describes only
 * half of what the body can report is the same kind of quietly-wrong
 * documentation this reporter exists to catch. Safe to retitle here because the
 * upsert only ever looks at OPEN issues and none was open; #2226 (the previous
 * title) had already been closed healthy.
 */
export const ISSUE_TITLE = '🩺 A CI guard has stopped proving its guarantee'

/**
 * The registry. Adding a guard here is what makes its absence detectable; the
 * self-test asserts every `workflow` below exists on disk and still declares the
 * trigger the entry is watching, so neither a rename nor a deleted `on:` block
 * can quietly de-register one.
 *
 * `maxAgeDays` is a budget, not the cadence: 3 days on a nightly tolerates two
 * consecutive misses (an Actions incident, a queue backlog) before it speaks. A
 * reporter that cries on the first blip gets muted, and a muted reporter is
 * worse than none — which is the same reasoning that keeps the proof job itself
 * non-gating.
 *
 * Fields:
 * - `countedEvents` / `countedBranches` — which runs count as this guard having
 *   run. Scoping them is the arm that stops a *different*, healthy trigger on
 *   the same workflow file from masking the dead one (#2268).
 * - `requiredTrigger` — a regex the workflow source must still match. The age
 *   check asks "did it run lately"; this asks "can it still run at all", which
 *   the run history can never answer, because a deleted trigger leaves its old
 *   successes in the API forever.
 * - `provenance` — `{ environment, creator }`: when set, a run counts only if
 *   the Deployments API holds a deployment of the run's exact `headSha` to that
 *   environment created by that login (#2271/#2273). The index is read once per
 *   evaluation and injected into `selectQualifyingRuns`; a missing index fails
 *   CLOSED (nothing qualifies), because "could not check" is not "checked".
 * - `requiredJob` — the job whose conclusion IS the run's verdict. A run whose
 *   `gate` job refused the harness has run-level conclusion `success` (GitHub
 *   reports a run with skipped jobs as success — measured on ci.yml run
 *   33604474457, jobs skipped=12 success=2, run `success`), so on qa-dev.yml
 *   the run-level field cannot tell "the harness passed" from "nothing ran".
 *   The job list can. Read through `moneyFlowJobConclusion`, shared with
 *   qa-freshness.mjs so both gates judge the same job. Unreadable → refused.
 * - `restart` — what a human actually does about it. Not every guard is
 *   restarted with `gh workflow run`.
 */
export const SCHEDULED_GUARDS = [
  {
    workflow: 'db-concurrency-proof.yml',
    label: 'Advisory-lock deadlock proof (#2208)',
    maxAgeDays: 3,
    cadence: 'nightly',
    // Which runs count as "the guard ran" (review finding on PR #2222).
    //
    // NOT any successful run. `db-concurrency-proof.yml` also has a narrow
    // paths-filtered `pull_request` trigger, and those paths are precisely the
    // files someone edits while working ON the guard — so a broken cron could
    // be masked indefinitely by PR runs, and the healthy path would auto-close
    // the staleness issue. Worse, a PR run can be GREEN on a branch that
    // deliberately breaks the code (the proof branch used to red-test this very
    // job), so a `pull_request` success is not even evidence about `dev`.
    //
    // `workflow_dispatch` counts: a deliberate manual run against the default
    // branch does prove the thing. `pull_request` never does.
    countedEvents: ['schedule', 'workflow_dispatch'],
    // ...and only from the branches a dispatch is meaningful on. A dispatch on
    // a feature branch proves something about that branch, not about `dev`.
    countedBranches: ['dev', 'main'],
    why:
      'It is the only thing that re-proves end to end that a blocking advisory-lock waiter ' +
      'still deadlocks a concurrent CREATE INDEX CONCURRENTLY (40P01) and that the polled ' +
      'waiter in packages/backend/src/db/advisory-lock.ts still does not. While it is not ' +
      'running, that guarantee rests on assertions about the cause only.',
    requiredTrigger: /^\s*schedule:/m,
    restart:
      '`gh workflow run db-concurrency-proof.yml`, then check why it stopped — a renamed ' +
      'file, an edited cron, an expired token, a changed default branch, or GitHub’s ' +
      '60-day inactivity disablement of scheduled workflows.',
  },
  {
    // #2268 → #2273. This one is NOT a schedule. It is a trigger whose sender
    // lives outside the repository, which is a strictly worse version of the
    // same defect: `qa-dev.yml` declared three triggers, two of them fired, and
    // the third — `repository_dispatch: [dev-deployed]`, meant to be POSTed by
    // the Railway dev deploy — had fired ZERO times in the repository's entire
    // history (156 qa-dev runs, 2026-06-30 → 2026-08-31; and zero
    // repository_dispatch runs across every workflow). Nothing looked wrong,
    // because a trigger that never fires looks exactly like one that fires and
    // finds nothing.
    //
    // #2268's operator findings closed the old route for good: Railway cannot
    // send an authenticated dispatch from anywhere (URL-only webhooks, a
    // pre-deploy-only service hook). #2273 rebuilt the trigger on GitHub's own
    // `deployment_status` event, which Railway's GitHub integration DOES emit —
    // 28 of the newest 100 Deployments on 2026-09-02 were `railway-app[bot]` →
    // `Haven AI / dev`, each reaching `state: success`. This entry watches that.
    workflow: 'qa-dev.yml',
    label: 'Post-deploy money-flow QA — the `deployment_status` trigger (#2273, was #2268)',
    // Four days, not three. Dev deploys are bursty and stop entirely over a
    // quiet weekend, and a reporter that speaks every Monday morning is one
    // people learn to close unread.
    maxAgeDays: 4,
    cadence: 'every dev deploy',
    // ONLY `deployment_status`. This is the load-bearing line in the whole
    // entry, and it is deliberately narrower than the other guard's: the nightly
    // `schedule` and the manual `workflow_dispatch` on this same workflow are
    // both alive and green, so counting them would report the post-deploy
    // trigger healthy on the strength of the two signals that are not it. That
    // is precisely how this went unnoticed for two months.
    countedEvents: ['deployment_status'],
    // No branch scoping, on purpose. #2273 wrote this predicting that a
    // `deployment_status` run would have no head branch to match (Railway
    // creates its Deployments against a bare commit SHA, `ref` == `sha` on
    // every one observed, and GitHub documents GITHUB_REF as EMPTY for that
    // case). Measured otherwise on 2026-09-02 (#2427): all three runs on
    // deployment 6218620498 report `headBranch: dev`. The scoping stays off
    // for the reason that holds either way: a branch name says nothing about
    // which commit was deployed. The `provenance` check below is the
    // replacement, and a stronger one: it binds the run to a deployment of
    // that exact SHA to the dev environment, which is what "on dev" was
    // trying to say.
    countedBranches: null,
    // #2271. Counting `deployment_status` alone would still let a human create
    // a Deployment by hand (`gh api -X POST .../deployments`) and mute this
    // guard. That deployment's creator would be the human, not the Railway app.
    provenance: { environment: RAILWAY_DEV_ENVIRONMENT, creator: RAILWAY_DEPLOY_CREATOR },
    // Judge the run by the money-flow JOB. The gate job skips two or three runs
    // per deploy (in_progress statuses, the re-stated `success`), and each of
    // those is a run-level `success` at a SHA that IS in the Railway index —
    // a decoy that would read as "fresh post-deploy green" while nothing ran,
    // and could mask a real harness failure at the same SHA behind it
    // (replacement haven-reviewer finding on #2273; #2404 hit the same shape
    // in the promotion gate).
    requiredJob: MONEY_FLOW_JOB,
    requiredTrigger: /^\s*deployment_status:\s*$/m,
    why:
      'It is the only trigger that runs the money-flow harness against what the dev deploy ' +
      'ACTUALLY shipped, at the SHA it shipped. Without it, freshness rests on the nightly ' +
      'cron alone, a busy day on dev outruns it, and qa-freshness then blocks the dev → main ' +
      'promotion — correctly, but at the worst moment, where the pressure is to reach for the ' +
      'qa-override label instead.',
    restart:
      'There is no command that restarts this: a `workflow_dispatch` run, a `repository_dispatch`, ' +
      'and a Deployment created by hand all deliberately do NOT clear this finding (#2271). ' +
      'Check, in order: (1) Railway still creates GitHub Deployments for the dev backend — ' +
      '`gh api -X GET repos/d-hinders/Haven-AI/deployments -f environment=\'Haven AI / dev\' -F per_page=5` ' +
      'must list recent `railway-app[bot]` deployments; if it does not, the Railway GitHub ' +
      'integration for the `Haven AI` project is what broke. (2) The environment is still ' +
      'named exactly `Haven AI / dev` (`RAILWAY_DEV_ENVIRONMENT` here and in qa-dev.yml\'s gate ' +
      'job) — a rename on the Railway side skips every run. (3) `gh run list --workflow qa-dev.yml ' +
      '--event deployment_status --limit 10` shows runs arriving: none at all means the trigger ' +
      'is not firing (default-branch workflow file, event disabled); runs that are all `skipped` ' +
      'mean the gate job is refusing them — read its log line. See ' +
      'docs/operations/agent-qa.md → "Post-deploy trigger (deployment_status)".',
  },
]

/**
 * The runs that count as this guard having run, newest timestamp first.
 *
 * Pure and exported so the event/branch scoping is a test rather than a line
 * buried in an IO helper — it is the difference between a watchdog and a
 * watchdog that a PR run can silence.
 */
export function selectQualifyingRuns(runs, guard, deploymentCreatorsBySha, jobsFor) {
  const events = guard.countedEvents
  const branches = guard.countedBranches
  const provenance = guard.provenance
  const requiredJob = guard.requiredJob
  const out = []
  for (const r of Array.isArray(runs) ? runs : []) {
    if (r?.status !== 'completed') continue
    // Belt: a run-level `skipped` is never the guard having run. The braces
    // are `requiredJob` below — on qa-dev.yml a gate-refused run is NOT
    // reported as skipped but as `success` (see the registry comment).
    if (r?.conclusion === 'skipped') continue
    if (events && !events.includes(r?.event)) continue
    if (branches && !branches.includes(r?.headBranch)) continue
    if (provenance) {
      // Fail closed: no index, or a SHA the index has never seen, is "cannot
      // prove Railway deployed this", which is the same answer as "did not".
      const sha = typeof r?.headSha === 'string' ? r.headSha : ''
      const creator = deploymentCreatorsBySha?.[sha]
      if (!sha || creator !== provenance.creator) continue
    }
    if (requiredJob) {
      // The run's verdict is the job's. Unreadable job list, no thunk, a
      // thrown lookup, or a job list without the job: refused, never assumed.
      let jobs = null
      try {
        jobs = typeof jobsFor === 'function' ? jobsFor(r?.databaseId) : null
      } catch {
        jobs = null
      }
      const conclusion = moneyFlowJobConclusion(jobs)
      if (conclusion === null || conclusion === 'skipped') continue
      out.push({ ...r, conclusion })
      continue
    }
    out.push(r)
  }
  return out
}

/** Newest `updatedAt`/`createdAt` in a run list, or null. */
export function newestTimestamp(runs) {
  const stamps = (Array.isArray(runs) ? runs : [])
    .map((r) => r?.updatedAt || r?.createdAt)
    .filter((t) => typeof t === 'string' && t.length > 0)
  return stamps.length === 0 ? null : stamps.slice().sort().at(-1)
}

/**
 * `{ healthy, findings }` for a set of observations.
 *
 * `observations` maps a workflow filename to
 * `{ fileExists, lastSuccessAt, lastRunAt }` (ISO strings or null).
 *
 * There is no default-healthy path. An unobserved guard is a finding: "we could
 * not tell" and "it is fine" are different answers, and collapsing them is the
 * exact defect this file is about.
 */
export function evaluate({ guards = SCHEDULED_GUARDS, observations = {}, now = Date.now() } = {}) {
  const findings = []
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime()

  for (const guard of guards) {
    const seen = observations[guard.workflow]

    if (!seen) {
      findings.push({
        guard,
        kind: 'unobserved',
        detail: 'No run data could be read for this workflow (API error, or it is unknown to Actions).',
      })
      continue
    }

    if (seen.fileExists === false) {
      findings.push({
        guard,
        kind: 'missing-file',
        detail: `.github/workflows/${guard.workflow} does not exist. The guard was renamed or deleted.`,
      })
      continue
    }

    // "Can it still fire at all", which the run history structurally cannot
    // answer: deleting a trigger leaves every past success in the Actions API,
    // so an age-only check reads green on a guard that can never run again —
    // the same trap `missing-file` closes, one level in. Checked BEFORE the age
    // check, because a workflow whose trigger was removed an hour ago is still
    // perfectly fresh by timestamp.
    if (seen.triggerPresent === false) {
      findings.push({
        guard,
        kind: 'missing-trigger',
        detail:
          `.github/workflows/${guard.workflow} no longer declares the trigger this guard ` +
          `watches (${guard.requiredTrigger}). It cannot fire, however green its history looks.`,
      })
      continue
    }

    if (!seen.lastSuccessAt) {
      findings.push({
        guard,
        kind: seen.lastRunAt ? 'never-succeeded' : 'never-run',
        detail: seen.lastRunAt
          ? `It has run (most recently ${seen.lastRunAt}) but has never completed successfully.`
          : 'Actions has no record of it ever running.',
      })
      continue
    }

    const ageMs = nowMs - new Date(seen.lastSuccessAt).getTime()
    if (Number.isNaN(ageMs)) {
      findings.push({ guard, kind: 'unobserved', detail: `Unparseable timestamp "${seen.lastSuccessAt}".` })
      continue
    }
    const ageDays = ageMs / DAY_MS
    if (ageDays > guard.maxAgeDays) {
      findings.push({
        guard,
        kind: 'stale',
        ageDays,
        detail:
          `Last successful run was ${ageDays.toFixed(1)} days ago (${seen.lastSuccessAt}), ` +
          `past its ${guard.maxAgeDays}-day budget for a ${guard.cadence} job.`,
      })
    }
  }

  return { healthy: findings.length === 0, findings }
}

/** The issue body. Says what stopped, why it matters, and how to restart it. */
export function renderIssueBody(findings, { now = new Date().toISOString(), runUrl } = {}) {
  const lines = [
    'One or more scheduled CI guards are no longer producing the evidence they exist for.',
    '',
    'A scheduled job that stops running looks exactly like a passing one — there is no red X',
    'for "did not happen". This issue is that red X.',
    '',
  ]
  for (const f of findings) {
    lines.push(`### \`${f.guard.workflow}\` — ${f.guard.label}`)
    lines.push('')
    lines.push(`- **Problem:** ${f.kind} — ${f.detail}`)
    lines.push(`- **Cadence:** ${f.guard.cadence} (budget: ${f.guard.maxAgeDays} days)`)
    lines.push(`- **Why it matters:** ${f.guard.why}`)
    // Per-guard, because "restart it" is not one instruction. #2208's guard is a
    // cron you re-run with `gh workflow run`; #2268's sender lives in a
    // third-party deploy dashboard and no command in this repository can fix it.
    // A generic restart hint on the second one would send the reader to do the
    // one thing that provably does NOT clear the finding.
    lines.push(`- **Restart it:** ${f.guard.restart}`)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push(
    `_Upserted by \`guard-freshness.yml\` (#2208)${runUrl ? ` — [run](${runUrl})` : ''}. ` +
      'It closes this issue automatically once every guard is fresh again; do not edit by hand._',
  )
  return lines.join('\n')
}

/** One-line-per-guard log/summary line, printed on healthy runs too. */
export function renderSummary({ healthy, findings }, observations = {}, guards = SCHEDULED_GUARDS, now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime()
  const lines = [healthy ? '✅ Every scheduled guard is fresh.' : '❌ A scheduled guard has gone stale.', '']
  for (const guard of guards) {
    const seen = observations[guard.workflow]
    const finding = findings.find((f) => f.guard.workflow === guard.workflow)
    const age = seen?.lastSuccessAt
      ? `${((nowMs - new Date(seen.lastSuccessAt).getTime()) / DAY_MS).toFixed(1)}d ago`
      : 'never'
    lines.push(`  ${finding ? '✗' : '✓'} ${guard.workflow} — last success ${age} (budget ${guard.maxAgeDays}d)`)
    if (finding) lines.push(`      ${finding.kind}: ${finding.detail}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI wrapper. All IO here.
// ---------------------------------------------------------------------------

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' })

/**
 * `{ [fullSha]: creatorLogin }` for the newest 100 Deployments to one
 * environment (#2273). One API call per evaluation. 100 is deep enough: a
 * qualifying run has to be inside `maxAgeDays` anyway, and the dev environment
 * saw 28 deployments in the 100 newest across ALL environments on 2026-09-02.
 * The Deployments API filters on the FULL sha only — a short sha returns
 * nothing (measured) — so the index is keyed on what `gh run list` reports as
 * `headSha`, which is full. Throws on API failure so the caller's catch turns it
 * into `unobserved`, a finding, rather than an empty index that reads as
 * "nothing Railway deployed".
 */
function readDeploymentIndex({ environment, creator }) {
  // `GITHUB_REPOSITORY` is set inside Actions; the `{owner}/{repo}` placeholders
  // are gh's own resolution from the git remote when run by hand.
  const repo = process.env.GITHUB_REPOSITORY || '{owner}/{repo}'
  const deployments = JSON.parse(gh([
    'api', '-X', 'GET', `repos/${repo}/deployments`,
    '-f', `environment=${environment}`,
    '-F', 'per_page=100',
  ]))
  const index = {}
  for (const d of Array.isArray(deployments) ? deployments : []) {
    if (typeof d?.sha !== 'string' || typeof d?.creator?.login !== 'string') continue
    // "A Railway-created deployment of this SHA exists" — so once the expected
    // creator is recorded for a SHA it sticks, whatever else deployed the same
    // commit before or after it.
    if (index[d.sha] !== creator) index[d.sha] = d.creator.login
  }
  return index
}

/**
 * How many runs' job lists one evaluation may fetch (one `gh run view` each).
 * Only runs that already passed the event and provenance filters reach the
 * reader, i.e. the two-to-four `deployment_status` rows a real deploy leaves
 * behind; 12 spans several deploys, and a run past the budget is refused
 * (null → not counted), which errs toward `stale`, never toward `fresh`.
 */
const JOB_LOOKUP_BUDGET = 12

function boundedJobsReader(budget) {
  let left = budget
  return (databaseId) => {
    if (left <= 0 || databaseId === undefined || databaseId === null) return null
    left -= 1
    const parsed = JSON.parse(gh(['run', 'view', String(databaseId), '--json', 'jobs']))
    return Array.isArray(parsed?.jobs) ? parsed.jobs : null
  }
}

function observe(guard) {
  const workflowPath = path.join(ROOT, '.github', 'workflows', guard.workflow)
  const fileExists = existsSync(workflowPath)
  if (!fileExists) return { fileExists: false, triggerPresent: false, lastSuccessAt: null, lastRunAt: null }

  const triggerPresent = guard.requiredTrigger
    ? guard.requiredTrigger.test(readFileSync(workflowPath, 'utf8'))
    : true

  try {
    // One query PER counted event, rather than one shared window filtered
    // afterwards. `qa-dev.yml` is dispatched manually dozens of times a week, so
    // a single `--limit 100` window can contain zero of the event we care about
    // while the trigger is perfectly healthy — the busier the workflow, the
    // blinder the check, which is backwards.
    const runs = []
    for (const event of guard.countedEvents) {
      runs.push(...JSON.parse(gh([
        'run', 'list',
        '--workflow', guard.workflow,
        '--event', event,
        '--limit', '50',
        '--json', 'databaseId,conclusion,status,event,headBranch,headSha,createdAt,updatedAt',
      ])))
    }
    const index = guard.provenance ? readDeploymentIndex(guard.provenance) : undefined
    const qualifying = selectQualifyingRuns(
      // Newest first, so the bounded job-list reader below spends its budget
      // on the runs that can actually change the answer.
      runs.slice().sort((a, b) => String(b?.updatedAt || b?.createdAt || '').localeCompare(String(a?.updatedAt || a?.createdAt || ''))),
      guard,
      index,
      guard.requiredJob ? boundedJobsReader(JOB_LOOKUP_BUDGET) : undefined,
    )
    const success = qualifying.filter((r) => r.conclusion === 'success')
    return {
      fileExists: true,
      triggerPresent,
      lastSuccessAt: newestTimestamp(success),
      lastRunAt: newestTimestamp(qualifying),
    }
  } catch (err) {
    console.error(`gh run list failed for ${guard.workflow}: ${err.message}`)
    return undefined // -> 'unobserved', which is a finding, not a pass
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const observations = {}
  for (const guard of SCHEDULED_GUARDS) {
    const seen = observe(guard)
    if (seen) observations[guard.workflow] = seen
  }

  const result = evaluate({ observations })
  const summary = renderSummary(result, observations)
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### Scheduled guard freshness (#2208)\n\n\`\`\`\n${summary}\n\`\`\`\n`,
    )
  }

  if (process.env.GUARD_FRESHNESS_DRY_RUN === '1') process.exit(0)

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined

  // Every `gh` call below is wrapped, because this script runs on EVERY push to
  // main/dev and its own file says it never fails the build. An unwrapped
  // execFileSync throw on a rate limit or a transient network blip would make
  // that false, and a watchdog that reds unrelated work is a watchdog somebody
  // turns off (review finding on PR #2222).
  const tryGh = (args, what) => {
    try {
      return gh(args)
    } catch (err) {
      console.error(`::warning::guard-freshness could not ${what}: ${err.message}`)
      return null
    }
  }

  // `ci-health` names the subject; `code-quality` is what puts the issue in the
  // ship-next queue. That second label is the notification decision — a nightly
  // failure that only lands in a mailbox at 3am gets muted; one that becomes a
  // queued work item gets picked up by whoever ships next.
  //
  // Only self-healed on the path that is about to need it: on the common
  // healthy push this is one fewer API call for nothing.
  if (!result.healthy) {
    tryGh(['label', 'create', 'ci-health', '--color', 'b60205', '--description',
           'Automated: a scheduled CI guard is failing or has stopped running', '--force'],
          'ensure the ci-health label exists')
  }

  const listed = tryGh(
    ['issue', 'list', '--label', 'ci-health', '--state', 'open', '--limit', '20',
     '--json', 'number,title'],
    'list open ci-health issues',
  )
  let existing
  try {
    existing = listed ? JSON.parse(listed).find((i) => i.title === ISSUE_TITLE) : undefined
  } catch (err) {
    console.error(`::warning::guard-freshness could not parse the issue list: ${err.message}`)
  }

  if (result.healthy) {
    if (existing) {
      tryGh(['issue', 'comment', String(existing.number), '--body',
             `Every registered guard is fresh again.\n\n\`\`\`\n${summary}\n\`\`\``],
            `comment on #${existing.number}`)
      tryGh(['issue', 'close', String(existing.number), '--reason', 'completed'],
            `close #${existing.number}`)
      console.log(`Closed #${existing.number} — guards recovered.`)
    }
    process.exit(0)
  }

  const body = renderIssueBody(result.findings, { runUrl })
  if (existing) {
    tryGh(['issue', 'edit', String(existing.number), '--body', body], `update #${existing.number}`)
    console.log(`Updated #${existing.number}.`)
  } else {
    tryGh(['issue', 'create', '--title', ISSUE_TITLE, '--label', 'ci-health',
           '--label', 'code-quality', '--body', body], 'file the staleness issue')
  }
  // The reporter itself stays GREEN: the issue is the signal, and a permanently
  // red push-triggered check on `dev` would be noise on work that did not cause
  // it. Staleness is a queued work item, not a broken build.
  process.exit(0)
}
