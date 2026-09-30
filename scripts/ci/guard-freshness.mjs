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
import {
  MIN_HARNESS_RUN_SECONDS,
  MONEY_FLOW_JOB,
  RAILWAY_DEV_ENVIRONMENT,
  moneyFlowJobConclusion,
  parseDeployRunName,
  tooShortForHarness,
} from './qa-freshness.mjs'

// Moved to qa-freshness.mjs by #3361, which filters its green-run query with
// them; re-exported so this module's API is unchanged.
export { MIN_HARNESS_RUN_SECONDS, MONEY_FLOW_JOB, RAILWAY_DEV_ENVIRONMENT, parseDeployRunName, tooShortForHarness }

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
 * doing its job, not a false positive to silence. `RAILWAY_DEV_ENVIRONMENT`
 * lives in qa-freshness.mjs since #3361 (imported above).
 */
export const RAILWAY_DEPLOY_CREATOR = 'railway-app[bot]'

/**
 * The one issue this reporter owns. Upserted, and CLOSED when everything is healthy.
 *
 * The word "scheduled" was dropped in #2268: the registry now also covers a
 * trigger fired from outside the repository, and a title that describes only
 * half of what the body can report is the same kind of quietly-wrong
 * documentation this reporter exists to catch. Safe to retitle then because the
 * upsert only looked at OPEN issues and none was open; #2226 (the previous
 * title) had already been closed healthy. Since #3340 an alarm with no open
 * issue REOPENS the newest closed one with this exact title, so a retitle now
 * also starts a fresh thread — which is the point of retitling.
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
    // Judge the run by the money-flow JOB. The gate job skips several runs per
    // deploy (in_progress statuses, the re-stated `success`; 3–11 rows per dev
    // SHA measured in #3340), and each of
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
      'job) — a rename on the Railway side makes the gate job skip the harness on every run. ' +
      '(3) `gh run list --workflow qa-dev.yml --event deployment_status --limit 10` shows runs ' +
      'arriving: none at all means the trigger is not firing (default-branch workflow file, ' +
      'event disabled). A run the gate refused still concludes `success` at run level (#3368); ' +
      'read its `money-flow` job instead — `gh run view <id> --json jobs --jq ' +
      '\'.jobs[] | select(.name=="money-flow") | .conclusion\'` prints `skipped` when the gate ' +
      'job refused it, and the gate job\'s log line says why. See ' +
      'docs/operations/agent-qa.md → "Post-deploy trigger (deployment_status)".',
  },
]

/**
 * Could this run have run the harness at all? (#3340) qa-dev.yml's gate skips
 * the money-flow job unconditionally unless the deployment status is `success`
 * AND the environment is the dev backend, and its run name says both. So a
 * title naming another environment (Vercel's `Preview`) or another state
 * (`in_progress`) is a run that certainly did nothing — dropping it BEFORE the
 * job lookup keeps the bounded lookup budget for runs that can change the
 * answer. It only ever removes runs that could not have counted, so it can make
 * the guard stricter, never greener. An unparseable title is kept: the job list
 * decides, as before.
 */
export function mayHaveRunHarness(run, guard) {
  if (!guard?.provenance) return true
  const t = parseDeployRunName(run?.displayTitle)
  if (!t) return true
  return t.environment === guard.provenance.environment && t.state === 'success'
}

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
    if (!mayHaveRunHarness(r, guard)) continue
    if (requiredJob && r?.conclusion === 'failure') {
      // A run-level `failure` is never a harness success, whichever job failed
      // (#3340): count it as a run without spending a job lookup on it, so a
      // stretch of red runs cannot exhaust the budget before an older green.
      out.push({ ...r })
      continue
    }
    if (requiredJob && tooShortForHarness(r)) continue
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

// #3409: reason codes `observe()` can attach to `incompleteReasons`, and the
// prose each renders as. Split in two: BOUNDEDNESS causes stopped a search
// that otherwise trusted what it read (a success may genuinely sit further
// back); DISTRUST causes mean what was read could not be trusted at all, so
// "may exist further back" would overstate what is known — dropped for those.
const BOUNDEDNESS_REASONS = {
  'page-cap': 'the page cap',
  'lookup-budget': 'the job-lookup budget',
  'index-reach': 'a Deployments index that does not reach that far',
}
const DISTRUST_REASONS = {
  'listing-not-near-now': 'page 1 of the run listing did not open near "now"',
  'listing-not-contiguous': 'the run listing was not contiguous and newest-first across pages',
  'listing-missing-run': 'an in-window Railway deployment has no matching run in the listing',
  'lookup-failure': 'a check-runs lookup threw or could not be read',
  'malformed-index': 'the Deployments index response body was not a list',
}

/**
 * The `unconfirmed` finding's detail text, from `observe()`'s `incompleteReasons`.
 *
 * An empty `incompleteReasons` still renders the bare "search stopped before
 * covering N days" sentence, with no bucket-specific clause, no `::warning::`
 * pointer, and no dead-trigger sentence — `observe()` itself never returns
 * `searchComplete: false` without recording at least one reason, so this
 * shape is reachable only from a hand-built `observations` object (as the
 * `evaluate()` unit tests in guard-freshness.test.mjs do), never from a real
 * `observe()` call.
 */
export function renderUnconfirmedDetail(guard, seen) {
  const reasons = Array.isArray(seen.incompleteReasons) ? seen.incompleteReasons : []
  const bounded = reasons.filter((r) => r in BOUNDEDNESS_REASONS).map((r) => BOUNDEDNESS_REASONS[r])
  const distrust = reasons.filter((r) => r in DISTRUST_REASONS).map((r) => DISTRUST_REASONS[r])
  const clauses = []
  if (bounded.length > 0) {
    clauses.push(`the search stopped before covering ${guard.maxAgeDays} days (${bounded.join('; ')})`)
  }
  if (distrust.length > 0) {
    clauses.push(`the run listing, a job lookup, or the Deployments index could not be trusted (${distrust.join('; ')})`)
  }
  if (clauses.length === 0) {
    clauses.push(`the search stopped before covering ${guard.maxAgeDays} days`)
  }
  let detail = `No successful run was found among the ${seen.examined ?? 'examined'} runs read (${clauses.join('; ')}).`
  if (distrust.length > 0) {
    detail += " See the run's `::warning::` lines for which check tripped."
  }
  if (reasons.includes('listing-missing-run')) {
    detail +=
      ' An in-window deployment with no matching run reads as EITHER an anomalous listing OR the ' +
      "deployment_status trigger itself has stopped firing (#2268) — the listing alone cannot tell them apart."
  }
  // Only true for the causes that stopped an otherwise-trusted search short —
  // a distrusted read is not "the answer is further back", it is "this read
  // cannot say".
  if (bounded.length > 0) {
    detail += ' A success may exist further back; this is not evidence that it never succeeded.'
  }
  return detail
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

    if (!seen.lastSuccessAt && seen.searchComplete === false) {
      // #3340: the observation stopped before it reached the end of the budget
      // window (page cap or job-lookup budget), so "never" would be a claim the
      // evidence does not support. Still a finding — "could not confirm" is not
      // "fine" — but one that says what it actually knows.
      findings.push({
        guard,
        kind: 'unconfirmed',
        detail: renderUnconfirmedDetail(guard, seen),
      })
      continue
    }

    if (!seen.lastSuccessAt) {
      findings.push({
        guard,
        kind: seen.lastRunAt ? 'never-succeeded' : 'never-run',
        detail: seen.lastRunAt
          ? (seen.searchedBackTo
              ? `No successful run among the ${seen.examined ?? 'examined'} runs read back to ${seen.searchedBackTo}, ` +
                `which covers its ${guard.maxAgeDays}-day budget (most recent run ${seen.lastRunAt}).`
              : `It has run (most recently ${seen.lastRunAt}) but has never completed successfully.`)
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
      : finding?.kind === 'unconfirmed'
        ? `not found in the ${seen?.examined ?? ''} runs read`.replace('  ', ' ')
        : seen?.searchedBackTo
          ? `none since ${seen.searchedBackTo}`
          : 'never'
    lines.push(`  ${finding ? '✗' : '✓'} ${guard.workflow} — last success ${age} (budget ${guard.maxAgeDays}d)`)
    if (finding) lines.push(`      ${finding.kind}: ${finding.detail}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI wrapper. All IO here.
// ---------------------------------------------------------------------------

// A 100-run page of the REST API is several MB before projection; the run
// page below projects with --jq, and the buffer is raised as a margin (#3340:
// the first live run of the paged reader died on ENOBUFS at the 1 MB default).
const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

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
function readDeploymentIndex({ environment, creator }, gh = defaultGh) {
  // `GITHUB_REPOSITORY` is set inside Actions; the `{owner}/{repo}` placeholders
  // are gh's own resolution from the git remote when run by hand.
  const repo = process.env.GITHUB_REPOSITORY || '{owner}/{repo}'
  const deployments = JSON.parse(gh([
    'api', '-X', 'GET', `repos/${repo}/deployments`,
    '-f', `environment=${environment}`,
    '-F', 'per_page=100',
  ]))
  const index = {}
  // #3409: a non-array 200 (empty `{}`, or any other unparseable-as-a-list
  // body) used to fall through to an empty `list` in total silence — read as
  // "Railway has deployed nothing", not "this response could not be trusted".
  // Recorded so `observe()` can warn and mark the search incomplete instead.
  const malformed = !Array.isArray(deployments)
  const list = malformed ? [] : deployments
  const created = list.map((d) => d?.created_at).filter(Boolean).sort()
  // Non-enumerable: the oldest deployment a FULL index page reaches (#3340
  // review N2). A short page is the whole history, so it cannot be "too short".
  Object.defineProperty(index, '__oldest', { value: list.length >= 100 ? (created[0] ?? null) : null, enumerable: false })
  // #3409: the diagnostic line needs the ACTUAL oldest entry regardless of
  // page length — `__oldest` stays gated on
  // `length >= 100` because that gate is what `indexShort` (and the M1
  // mutation test) exercises, not what a human reading the log wants to see.
  Object.defineProperty(index, '__oldestActual', { value: created[0] ?? null, enumerable: false })
  Object.defineProperty(index, '__count', { value: list.length, enumerable: false })
  Object.defineProperty(index, '__malformed', { value: malformed, enumerable: false })
  // #3409: `{ sha, created_at }` for every Railway-created deployment, kept
  // alongside the sha→creator map so `observe()` can ask "is there an
  // in-window dev deployment whose sha never showed up in the run listing" —
  // the third listing-coherence check. Non-enumerable for the same reason as
  // `__oldest`: existing callers construct plain `{ [sha]: creator }` fixtures
  // and must keep working unchanged.
  const deploymentsSeen = []
  for (const d of list) {
    if (typeof d?.sha !== 'string' || typeof d?.creator?.login !== 'string') continue
    // "A Railway-created deployment of this SHA exists" — so once the expected
    // creator is recorded for a SHA it sticks, whatever else deployed the same
    // commit before or after it.
    if (index[d.sha] !== creator) index[d.sha] = d.creator.login
    if (d.creator.login === creator && typeof d.created_at === 'string') {
      deploymentsSeen.push({ sha: d.sha, created_at: d.created_at })
    }
  }
  Object.defineProperty(index, '__deployments', { value: deploymentsSeen, enumerable: false })
  return index
}

/**
 * How many SHAs' money-flow check runs one evaluation may fetch (#3340). One
 * `commits/<sha>/check-runs?check_name=<job>` call answers the job's conclusion
 * for EVERY run at that SHA (the run id is in each check run's `details_url`),
 * so the budget counts deploys, not runs. Counting runs failed on 2026-09-25/26:
 * Railway re-states `success` for a superseded deployment, the gate skips those
 * runs, and 24 per-run lookups were spent on them before reaching a green run
 * at 11:31Z (measured with the live dry run). Only runs that passed the event,
 * provenance and run-name filters, and are not a run-level `failure`, reach the
 * reader, newest first, and paging stops at the first success. A run past the
 * budget is refused (null → not counted), and the observation then says the
 * search was cut short: `unconfirmed`, never `fresh`.
 */
export const JOB_LOOKUP_BUDGET = 24

/** At most this many 100-run pages per counted event per evaluation (#3340). */
export const RUN_PAGE_CAP = 8

/**
 * #3321. Re-read of the incident history (2026-09-30, review round 1): 8 of 9
 * guard-freshness reopens were qa-dev.yml reading the IDENTICAL frozen page —
 * 100 `deployment_status` rows, newest `2026-09-19T16:20:14Z`, oldest
 * `2026-09-18T21:18:20Z` — printed verbatim by runs 36542205451, 36548966124,
 * 36565011143 and 36692820874, and matched by the `never-run … since
 * 2026-09-18T21:18:20Z` text of the four 09-28 runs that predate the #3409
 * diagnostics (36393133139, 36426594058, 36440588919, 36449044291). The 9th
 * (36570505601, 09-29 12:47) was a DIFFERENT guard reading a DIFFERENT frozen
 * page: `db-concurrency-proof.yml`'s `schedule` page 1 frozen at
 * `2026-09-18T07:36:48Z` ("11.2d ago"), while that job in fact succeeds
 * nightly (verified success 2026-09-30T09:00:02Z) — so the defect is not
 * specific to `deployment_status`, the Deployments index, or a guard with
 * `provenance`; both counted guards in `SCHEDULED_GUARDS` hit it.
 *
 * The endpoint sets `Cache-Control: private, max-age=60, s-maxage=60`
 * (measured live, 2026-09-30) — proof the response is ALLOWED to be
 * cache-served, but a 60 s directive cannot by itself explain an 11-day-old
 * snapshot, so the deeper cause is GitHub's own read path for this listing
 * (cache or search-index replica) occasionally serving a stale snapshot.
 *
 * What the evidence actually shows, from `guard-freshness.yml`'s own CI run
 * logs (not hand reads): classifying every guard-freshness.yml evaluation
 * from 09-27 to 09-30, roughly 11 of ~55 came back stale over those three
 * days. The three 09-28 timestamps named in earlier drafts of this comment
 * (15:02/15:22/15:39) are ONE cluster, not three separate ones — fresh
 * evaluations bracket it at 14:58 and 15:41, so it lasted AT LEAST 37
 * minutes. "1–2 minutes" is not a cluster length: it is the gap between two
 * consecutive evaluations where a stale read was immediately followed by a
 * fresh one (16:09:59→16:11:04, 15:39:50→15:41:17) — evidence for how fast
 * an ISOLATED stale read can resolve, not for how long a cluster lasts. A
 * hand-run reproduction on 2026-09-30 (2 of 25 identical reads returning a
 * frozen `newest=2026-09-19T05:36:10Z`) and a separate hand-run attempt to
 * see whether varying the request shape (`per_page`, a `created=>` filter)
 * dodges the stale read (inconclusive — a live stale cluster was caught once
 * but had already resolved by the time the varied shapes were tried against
 * it) both happened, but neither is recorded anywhere reproducible; they are
 * not restated here as numbers.
 *
 * A single read of this listing is therefore not ground truth for ANY
 * counted-event guard, which is exactly the shape coherence check 1 already
 * detects for a provenance guard (page 1 does not open near "now"). The fix:
 * page 1 of every counted event is now retried up to `PAGE1_RETRY_ATTEMPTS`
 * times, `PAGE1_RETRY_DELAY_MS` apart, whenever it could change the answer —
 * no qualifying success found yet, AND (for a provenance guard) the
 * Deployments index shows an in-window deploy, or (for a guard with no
 * provenance, e.g. `db-concurrency-proof.yml`) unconditionally, since page 1
 * being stale there is indistinguishable from the guard being about to fail
 * either way and the retry only costs time on that already-losing path. A
 * page with no rows at all (a workflow that has genuinely never run) is
 * "stale" by the same test (no `newest` to compare) and is retried too, up to
 * the same bound — the extra reads are wasted but cost is capped, and a
 * truly-empty history stays empty on every retry, so the verdict is
 * unaffected. The first retry that opens near "now" replaces the stale read;
 * a genuinely dead trigger cannot self-correct on retry — every attempt
 * stays old — so the guard still exhausts every attempt and still escalates
 * that case exactly as before.
 *
 * Staleness is per-request, not per-workflow-run or per-cluster: an isolated
 * stale read recovers within about a minute (see the gaps above), which the
 * retry window below is sized for, but the 09-28 cluster ran at least 37
 * minutes — longer than any in-evaluation retry budget can reasonably cover.
 * For that case the mitigation is NOT the retry: it is the next evaluation.
 * `guard-freshness.yml` runs on every push to `dev`/`main` — 144
 * push-triggered runs in the 7 days to 2026-09-30 (measured) — so a cluster
 * that outlasts one evaluation's retries is very likely covered by the next
 * one, minutes later, without a human noticing the first. `3 ×
 * PAGE1_RETRY_DELAY_MS` is a judgement call sized for the isolated-read case,
 * not a claim that it covers a multi-minute cluster; the `(retried Nx —
 * #3321)` diagnostic line is what will show whether a future occurrence
 * outlasts it.
 */
// Worst case ~60 s per stale page 1, per counted event, per guard (3 attempts
// × 20 s between them). One evaluation can sleep on MULTIPLE page-1 retries —
// qa-dev.yml has one counted event (up to ~60 s) and db-concurrency-proof.yml
// has two, schedule and workflow_dispatch (up to ~60 s each, ~120 s) — so a
// single evaluation's worst case is ~180 s (~3 min), inside
// guard-freshness.yml's own `timeout-minutes: 5`. Sized for an isolated
// stale read (recovers in under a minute, per the measurements above), not
// for the longer clusters the next push-triggered evaluation covers instead
// — see the JSDoc above.
export const PAGE1_RETRY_ATTEMPTS = 3
export const PAGE1_RETRY_DELAY_MS = 20000

/** Synchronous sleep (Node allows `Atomics.wait` on the main thread). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function boundedCheckRunReader(budget, jobName, shaOfRun, gh = defaultGh) {
  const repo = process.env.GITHUB_REPOSITORY || '{owner}/{repo}'
  const bySha = new Map() // sha → Map(runId → [{ name, conclusion }])
  let left = budget
  const read = (databaseId) => {
    const sha = shaOfRun.get(databaseId)
    if (!sha) return null
    if (!bySha.has(sha)) {
      if (left <= 0) {
        read.exhausted = true
        return null
      }
      left -= 1
      read.attempted += 1
      // Decision (#3409): not cached, so a transient blip is retried on the
      // next pass rather than refusing the sha for the rest of the
      // evaluation; the budget cost is the same as before this change. It is
      // caught HERE (rather than left to propagate, as before) so `observe()`
      // can count it, but `bySha` stays unset on failure, so a later run at
      // the same sha re-attempts the call while the lookup budget lasts.
      let checks
      try {
        checks = JSON.parse(gh([
          'api', '-X', 'GET', `repos/${repo}/commits/${sha}/check-runs`,
          '-f', `check_name=${jobName}`, '-F', 'per_page=100',
          '--jq', '[.check_runs[] | {name, conclusion, details_url}]',
        ]))
      } catch (err) {
        read.failed += 1
        read.lastError = err
        return null
      }
      const runs = new Map()
      for (const c of Array.isArray(checks) ? checks : []) {
        const m = /\/actions\/runs\/(\d+)\//.exec(String(c?.details_url ?? ''))
        if (m) runs.set(Number(m[1]), [{ name: c.name, conclusion: c.conclusion }])
      }
      bySha.set(sha, runs)
      read.cached = bySha.size
    }
    return bySha.get(sha).get(Number(databaseId)) ?? null
  }
  read.exhausted = false
  read.attempted = 0
  read.failed = 0
  read.cached = 0
  return read
}

/** One page of a workflow's runs for one event, newest first, in `gh run list`'s field names. */
function readRunPage(guard, event, page, gh) {
  const repo = process.env.GITHUB_REPOSITORY || '{owner}/{repo}'
  const parsed = JSON.parse(gh([
    'api', '-X', 'GET', `repos/${repo}/actions/workflows/${guard.workflow}/runs`,
    '-f', `event=${event}`, '-F', 'per_page=100', '-F', `page=${page}`,
    '--jq', '[.workflow_runs[] | {id, conclusion, status, event, head_branch, head_sha, created_at, updated_at, run_started_at, display_title}]',
  ]))
  const runs = Array.isArray(parsed) ? parsed : []
  return runs.map((r) => ({
    databaseId: r.id,
    conclusion: r.conclusion,
    status: r.status,
    event: r.event,
    headBranch: r.head_branch,
    headSha: r.head_sha,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    runStartedAt: r.run_started_at,
    displayTitle: r.display_title,
  }))
}

/**
 * Everything `evaluate` needs about one guard, read from disk and the API.
 * Exported with an injectable `gh` runner so the IO half is testable (#3340):
 * the pure half already answered correctly while this wrapper looked at the
 * newest 50 runs and spent its 12 job lookups on runs that could never count.
 *
 * Runs are read a page at a time, newest first, per counted event, and paging
 * stops once a qualifying success is found, the page reaches past the guard's
 * `maxAgeDays`, the pages run out, or `RUN_PAGE_CAP` is hit — so the common
 * healthy case costs one page. `searchComplete` is false, and the returned
 * `incompleteReasons` names why, whenever the search did not reach a definite
 * answer: the page cap or the job-lookup budget stopped it short of the
 * window (a success may still exist further back), OR the run listing, a
 * check-runs lookup, or the Deployments index could not be trusted (#3409) —
 * a page not opening near "now" while the deployment index shows an in-window
 * deploy, pages arriving out of order, an in-window Railway deployment with
 * no matching run in the listing (which reads as EITHER an anomalous listing
 * OR the trigger itself has stopped firing, #2268 — the listing alone cannot
 * tell them apart), a thrown/unreadable lookup, or a non-array
 * Deployments response body. A found success yields `fresh` or `stale` by
 * its own age, never `unconfirmed`, whatever else tripped — including a
 * `searchComplete: false` from a coherence check on the SAME page the
 * success came from (e.g. an out-of-order page 2 that also contains a fresh
 * success): the `::warning::` line and the diagnostics still print, but the
 * verdict is `fresh`, not `unconfirmed`.
 */
export function observe(guard, { gh = defaultGh, now = Date.now(), root = ROOT, sleep = sleepSync } = {}) {
  const workflowPath = path.join(root, '.github', 'workflows', guard.workflow)
  const fileExists = existsSync(workflowPath)
  if (!fileExists) return { fileExists: false, triggerPresent: false, lastSuccessAt: null, lastRunAt: null }

  const triggerPresent = guard.requiredTrigger
    ? guard.requiredTrigger.test(readFileSync(workflowPath, 'utf8'))
    : true

  try {
    // One stream PER counted event, rather than one shared window filtered
    // afterwards. `qa-dev.yml` is dispatched manually dozens of times a week, so
    // a single window can contain zero of the event we care about while the
    // trigger is perfectly healthy — the busier the workflow, the blinder the
    // check, which is backwards.
    const nowMs = typeof now === 'number' ? now : new Date(now).getTime()
    const horizon = new Date(nowMs - guard.maxAgeDays * DAY_MS).toISOString()
    const index = guard.provenance ? readDeploymentIndex(guard.provenance, gh) : undefined
    // N2 (#3340 review): a Deployments index that does not reach the horizon
    // silently drops older runs at the provenance check; say so.
    const indexShort = Boolean(index?.__oldest && index.__oldest > horizon)
    // #3321: computed BEFORE paging, from the index alone, so page 1's retry
    // decision (below) does not depend on the very listing read it is
    // deciding whether to trust.
    const earlyHasInWindowDeploy = Boolean(index?.__deployments?.some((d) => d.created_at >= horizon))
    const shaOfRun = new Map()
    const jobsFor = guard.requiredJob
      ? boundedCheckRunReader(JOB_LOOKUP_BUDGET, guard.requiredJob, shaOfRun, gh)
      : undefined
    const runs = []
    let searchComplete = true
    let qualifying = []
    // #3409: the LEADING HYPOTHESIS for the false `never-run` at 07:42 (spec
    // review on this issue) is an anomalous *listing* — a page of old rows
    // that a correct, event-filtered, newest-first, paged read could not have
    // produced — kept as a hypothesis because nothing logged what that page
    // actually held, so it cannot be proven after the fact. These checks
    // catch that SHAPE directly, on the pages actually read, rather than
    // trusting the API's pagination to be internally consistent, and are
    // worth keeping whether or not that hypothesis is what actually fired.
    // `warnings` collects the `::warning::` lines named by the acceptance
    // criteria; `pageStats` feeds the per-page diagnostics printed below;
    // `reasons` records which check(s) tripped, for `evaluate()`'s detail text.
    const warnings = []
    const pageStats = []
    const reasons = []
    const markIncomplete = (reason) => {
      searchComplete = false
      if (!reasons.includes(reason)) reasons.push(reason)
    }
    let page1Newest = null
    for (const event of guard.countedEvents) {
      let prevPageOldest = null // reset per event: each stream paginates independently
      for (let page = 1; ; page += 1) {
        if (page > RUN_PAGE_CAP) {
          markIncomplete('page-cap')
          break
        }
        let batch = readRunPage(guard, event, page, gh)
        // #3321: page 1 is the one page every evaluation always reads, and
        // measurably the one GitHub hands back stale — both a provenance
        // guard (qa-dev.yml) and a guard with none (db-concurrency-proof.yml)
        // hit it. Retried when it could still change the answer: no
        // qualifying success found yet (a success already in hand needs no
        // rescue — S2), AND either the guard has no provenance (page 1 being
        // stale is itself the only signal available, so any staleness here is
        // worth a retry — B1) or it does and the Deployments index shows an
        // in-window deploy (the narrower, already-proven condition). A
        // genuinely dead trigger cannot self-correct on retry — every attempt
        // stays old — so the guard still exhausts every attempt and still
        // escalates exactly as before; only a transient stale read is
        // cleared.
        const foundSuccessSoFar = qualifying.some((r) => r.conclusion === 'success')
        const page1RetryEligible = page === 1 && !foundSuccessSoFar && (guard.provenance ? earlyHasInWindowDeploy : true)
        let page1RetryCount = 0
        if (page1RetryEligible) {
          while (page1RetryCount < PAGE1_RETRY_ATTEMPTS) {
            const batchDates = batch.map((r) => r.createdAt).filter(Boolean).sort()
            const batchNewest = batchDates.at(-1)
            if (batchNewest && batchNewest >= horizon) break
            sleep(PAGE1_RETRY_DELAY_MS)
            batch = readRunPage(guard, event, page, gh)
            page1RetryCount += 1
          }
        }
        for (const r of batch) shaOfRun.set(r.databaseId, r.headSha)
        runs.push(...batch)
        const dates = batch.map((r) => r.createdAt).filter(Boolean).sort()
        const oldest = dates[0]
        const newest = dates.at(-1)
        pageStats.push({
          event, page, count: batch.length, newest: newest ?? null, oldest: oldest ?? null,
          ...(page1RetryCount > 0 ? { retried: page1RetryCount } : {}),
        })
        if (page === 1 && newest && page1Newest === null) page1Newest = newest

        // Coherence check 2: contiguous and newest-first. Page N's newest row
        // must not be newer than page N-1's oldest — otherwise the pages
        // overlap or arrived out of order, and paging-until-horizon can stop
        // having skipped real rows in between (exactly how the 07:42 page,
        // read alone, was not provably the true head of the list). Reachable
        // only while still searching: pagination stops as soon as a success
        // qualifies, so a page this check inspects is always one read before
        // any success was found.
        if (prevPageOldest && newest && newest > prevPageOldest) {
          markIncomplete('listing-not-contiguous')
          warnings.push(
            `guard-freshness: listing-coherence — ${guard.workflow}'s ${event} page ${page} is not contiguous ` +
              `with page ${page - 1} (newest ${newest} is after the previous page's oldest ${prevPageOldest}).`,
          )
        }
        if (oldest) prevPageOldest = oldest

        // Newest first, so the bounded job-list reader spends its budget on the
        // runs that can actually change the answer.
        qualifying = selectQualifyingRuns(
          runs.slice().sort((x, y) => String(y?.updatedAt || y?.createdAt || '').localeCompare(String(x?.updatedAt || x?.createdAt || ''))),
          guard,
          index,
          jobsFor,
        )
        if (qualifying.some((r) => r.conclusion === 'success')) break
        if (batch.length < 100 || !oldest || oldest < horizon) break
        // Past the lookup budget, more pages can only feed `lastRunAt`.
        if (jobsFor?.exhausted) {
          markIncomplete('lookup-budget')
          break
        }
      }
    }
    const foundSuccess = () => qualifying.some((r) => r.conclusion === 'success')
    if (jobsFor?.exhausted && !foundSuccess()) markIncomplete('lookup-budget')
    if (indexShort && !foundSuccess()) markIncomplete('index-reach')
    // #3409 criterion 3: a non-array Deployments body used to read as "Railway
    // deployed nothing", indistinguishable from a genuinely empty history.
    if (index?.__malformed && !foundSuccess()) {
      markIncomplete('malformed-index')
      warnings.push(
        `guard-freshness: listing-coherence — the deployment index for ${guard.workflow} was not a list ` +
          '(empty or unparseable response body); not trusted.',
      )
    }
    // #3409 criterion 2: a thrown/unreadable check-runs lookup. Not cached
    // (see boundedCheckRunReader) — a later pass over the accumulated run
    // list re-attempts the same sha while the lookup budget lasts — but a
    // failure that occurred while no qualifying success has been found by the
    // end of the search must not read as a confident "never", because the
    // lookup that could have supplied the success is exactly the one that
    // failed.
    if (jobsFor?.failed > 0 && !foundSuccess()) {
      markIncomplete('lookup-failure')
      warnings.push(
        `guard-freshness: lookup-failure — ${jobsFor.failed} check-runs lookup(s) for ${guard.workflow} ` +
          `threw and no qualifying success was found among the ${runs.length} runs read.`,
      )
    }
    // Coherence check 3: a Railway dev deployment inside the window whose sha
    // never showed up anywhere in the listing we read. At 07:42 the index held
    // `679e7971`, deployed inside the 4-day window, with no matching run in
    // the page the guard trusted. Evaluated once, after the full search across
    // every counted event, and only when no success was found by then.
    let hasInWindowDeploy = false
    if (index?.__deployments && !foundSuccess()) {
      const seenShas = new Set(runs.map((r) => r.headSha))
      const inWindow = index.__deployments.filter((d) => d.created_at >= horizon)
      hasInWindowDeploy = inWindow.length > 0
      const missing = inWindow.filter((d) => !seenShas.has(d.sha))
      if (missing.length > 0) {
        markIncomplete('listing-missing-run')
        warnings.push(
          `guard-freshness: listing-coherence — the deployment index has ${missing.length} in-window Railway ` +
            `deployment(s) to ${guard.workflow} with no matching run in the listing (e.g. sha ${missing[0].sha} ` +
            `deployed ${missing[0].created_at}). Either the run listing is anomalous, or the deployment_status ` +
            'trigger has stopped firing (#2268) — the listing alone cannot tell them apart.',
        )
      }
    }
    // Coherence check 1: page 1, newest-first, should open near "now" — a
    // page whose newest row already predates the guard's own maxAgeDays
    // budget cannot be trusted to be the actual head of the listing (the
    // 07:42 page's newest row was, on the leading hypothesis, well past the
    // budget). Evaluated once, after the full search, and gated on TWO
    // things: no success was found, AND the deployment index shows at least
    // one dev deployment actually happened inside the window — deploys
    // happened, so recent runs should exist. Without an in-window deploy, a
    // stale page 1 is exactly what a genuinely quiet week looks like, and is
    // reported as a diagnostic line only (below), never a `::warning::` or an
    // incomplete search: without a real deploy in the window, an old page 1
    // is not evidence the listing lied.
    if (page1Newest && page1Newest < horizon && !foundSuccess() && hasInWindowDeploy) {
      markIncomplete('listing-not-near-now')
      warnings.push(
        `guard-freshness: listing-coherence — page 1 of ${guard.workflow}'s run listing opens at ` +
          `${page1Newest}, already past its ${guard.maxAgeDays}-day budget, while the deployment index shows a ` +
          'dev deployment inside that window; not trusted as "near now".',
      )
    }

    for (const w of warnings) console.error(`::warning::${w}`)

    const readDates = runs.map((r) => r.createdAt).filter(Boolean).sort()
    const success = qualifying.filter((r) => r.conclusion === 'success')
    const lastSuccessAt = newestTimestamp(success)
    // #3409 criterion 4: diagnostics on every observation without an in-budget
    // success (never-run, never-succeeded, unconfirmed, stale) — the two
    // hypotheses at 07:42 (an anomalous page vs. a failed lookup) were
    // indistinguishable after the fact because nothing logged what either page
    // held. Printed only then, so the common healthy push stays quiet (per the
    // module's own "stays green, low-noise" design).
    const ageMs = lastSuccessAt ? nowMs - Date.parse(lastSuccessAt) : null
    const nonFresh = !lastSuccessAt || !searchComplete || (ageMs !== null && ageMs > guard.maxAgeDays * DAY_MS)
    if (nonFresh) {
      console.error(`guard-freshness diagnostics for ${guard.workflow}:`)
      for (const p of pageStats) {
        console.error(
          `  page ${p.page} (${p.event}): ${p.count} rows, newest=${p.newest}, oldest=${p.oldest}` +
            (p.retried ? ` (retried ${p.retried}x — #3321)` : ''),
        )
      }
      // The size counts SHAs from every creator (the index is not filtered to
      // Railway's), so it is comparable across guards; the oldest entry and
      // the short-page note are what say whether it reaches the horizon.
      console.error(
        `  deployment index: ${
          index
            ? `${Object.keys(index).length} shas (all creators), oldest=${index.__oldestActual ?? 'n/a'} ` +
              `(${
                index.__malformed
                  ? 'malformed — response body was not a list'
                  : index.__count < 100
                    ? 'short page — likely the whole history'
                    : 'full page — may not reach further back'
              })`
            : 'n/a (no provenance)'
        }`,
      )
      console.error(
        `  lookups: attempted=${jobsFor?.attempted ?? 0}, failed=${jobsFor?.failed ?? 0}, cached=${jobsFor?.cached ?? 0}`,
      )
    }
    return {
      fileExists: true,
      triggerPresent,
      lastSuccessAt,
      lastRunAt: newestTimestamp(qualifying),
      searchComplete,
      examined: runs.length,
      searchedBackTo: readDates[0] ?? null,
      incompleteReasons: reasons,
    }
  } catch (err) {
    console.error(`run list failed for ${guard.workflow}: ${err.message}`)
    return undefined // -> 'unobserved', which is a finding, not a pass
  }
}


if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const gh = defaultGh
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
    // #3340: a flap closes the issue on recovery and used to file a NEW one on
    // the next alarm (five in 28 hours on 2026-09-24/25). Reopen the most recent
    // closed issue with the same title instead, as qa-failure-issue.mjs does, so
    // one guard's history stays in one thread.
    const closedListed = tryGh(
      ['issue', 'list', '--label', 'ci-health', '--state', 'closed', '--limit', '20',
       '--search', `in:title "${ISSUE_TITLE}"`, '--json', 'number,title'],
      'list closed ci-health issues',
    )
    let closed
    try {
      closed = closedListed ? JSON.parse(closedListed).find((i) => i.title === ISSUE_TITLE) : undefined
    } catch (err) {
      console.error(`::warning::guard-freshness could not parse the closed issue list: ${err.message}`)
    }
    // A failed reopen falls back to filing, so the alarm is never a silent
    // edit to a closed issue (#3340 review S4).
    const reopened = closed ? tryGh(['issue', 'reopen', String(closed.number)], `reopen #${closed.number}`) : null
    if (closed && reopened !== null) {
      // The labels are re-asserted: `code-quality` is what queues the issue for
      // ship-next, and a human may have stripped it when closing (#3340 S6).
      tryGh(['issue', 'edit', String(closed.number), '--body', body,
             '--add-label', 'ci-health', '--add-label', 'code-quality'], `update #${closed.number}`)
      tryGh(['issue', 'comment', String(closed.number), '--body',
             `Reopened: a guard stopped proving its guarantee again.${runUrl ? ` Run: ${runUrl}` : ''}`],
            `comment on #${closed.number}`)
      console.log(`Reopened #${closed.number}.`)
    } else {
      tryGh(['issue', 'create', '--title', ISSUE_TITLE, '--label', 'ci-health',
             '--label', 'code-quality', '--body', body], 'file the staleness issue')
    }
  }
  // The reporter itself stays GREEN: the issue is the signal, and a permanently
  // red push-triggered check on `dev` would be noise on work that did not cause
  // it. Staleness is a queued work item, not a broken build.
  process.exit(0)
}
