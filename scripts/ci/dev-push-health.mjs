#!/usr/bin/env node
// Push-to-dev CI health watcher (#3890) — `.github/workflows/dev-push-health.yml`.
//
// ## The problem this exists for
//
// `dev` merges do not require an up-to-date branch (#2632 O1), so two
// individually green PRs can conflict semantically once both land. The cost was
// accepted on the understanding that it "reddens the push-to-`dev` CI run … to
// be fixed forward" (autonomous-pr-loop.md). Nothing watched that run. #3886:
// #3855's merge broke `MCP server checks` on its own `dev` push, #3875's push
// inherited it, and nobody noticed for about five hours (job failed 09:47Z;
// #3886 filed 14:46Z). It surfaced only when an unrelated PR (#3885) inherited
// the failure.
//
// ## Three traps, each one measured
//
// 1. A cancelled run hides a failure. `ci.yml` runs `cancel-in-progress` with
//    ONE group for every `dev` push, so a superseded run concludes `cancelled`
//    even when a job in it already FAILED (#3855's run 38042422892). So this
//    reads jobs, never the run conclusion.
// 2. The aggregator fails on every superseded run. `Lint, Type-check & Build`
//    is `if: always()` and needs every check job, so a run whose check jobs
//    were cancelled reports it as `failure` (run 38025222136: 16 cancelled,
//    only `Repo CI config checks` and `Detect changed surfaces` finished). It is
//    derived from the leaves, so it is excluded by name: counting it would open
//    an issue several times a day.
// 3. A skipped job looks green. A later push that routes nothing to the broken
//    job leaves it `skipped` and the run `success` while the break stands. Only
//    a DECISIVE conclusion — `success` or `failure` — moves a job's state.
//
// ## Stateless
//
// The triggering `workflow_run` is only a wake-up. Every evaluation re-reads a
// window of recent completed push/`dev` CI runs and derives each job's state
// from scratch, so a dropped event (GitHub keeps one pending run per
// concurrency group) or out-of-order completion cannot make the issue drift
// from the truth.
//
// Report-only: it never fails the build. The signal is one upserted issue
// labelled `ci-health` + `code-quality` (the second label queues it for
// ship-next), the same contract as `guard-freshness.mjs`.
//
// `evaluate()`, `failureAnnotations()`, `prOf()` and the renderers are pure;
// every `gh` call lives in the CLI wrapper at the bottom.

import { execFileSync } from 'node:child_process'

/** The upserted issue's title. guard-freshness matches on ITS exact title, so the two never collide. */
export const ISSUE_TITLE = '🩺 dev is red: a push-to-dev CI job is failing'

/** The watched workflow's `name:` — asserted against ci.yml by the test, because `workflow_run` matches by name. */
export const WATCHED_WORKFLOW = 'CI'

/**
 * Jobs derived from other jobs' results. `Lint, Type-check & Build` is
 * `if: always()` over every check job and reads `failure` whenever a superseded
 * run cancelled them (trap 2). A real leaf failure is reported on the leaf.
 */
export const DERIVED_JOBS = new Set(['Lint, Type-check & Build'])

/** How many completed push/`dev` CI runs one evaluation reads. */
export const LOOKBACK_RUNS = 30

const DECISIVE = new Set(['success', 'failure'])

/** Shared verbatim with guard-freshness.mjs: `--force` with a different string would make the two scripts overwrite each other. */
export const CI_HEALTH_LABEL_DESCRIPTION = 'Automated: a scheduled CI guard is failing or has stopped running'

/**
 * A run's place in `dev`'s history: when its commit was pushed. A re-run
 * attempt keeps its run's `created_at` and the list endpoint already returns
 * the latest attempt's conclusions, so a re-run updates its own run in place.
 * Ordering by the attempt's start instead would let a re-run of an OLD commit
 * leapfrog newer ones: a flaky pass would close the issue while HEAD is red
 * (#3890 code review S1).
 */
export function runTime(run) {
  return Date.parse(run.created_at)
}

/** The PR number a squash merge names last in its subject — `… (#3855)`. */
export function prOf(run) {
  const subject = String(run.head_commit?.message ?? run.display_title ?? '').split('\n')[0]
  const all = [...subject.matchAll(/\(#(\d+)\)/g)]
  return all.length ? Number(all[all.length - 1][1]) : null
}

/**
 * Derive every leaf job's state from a window of runs.
 *
 * @param {Array<{id:number, head_sha:string, conclusion:string, created_at:string,
 *   run_started_at?:string, run_attempt?:number, html_url?:string,
 *   head_commit?:{message:string}, jobs:Array<{id:number, name:string, conclusion:string|null, html_url?:string}>}>} runs
 * @returns {{ healthy: boolean, red: object[], dropped: object[] }}
 */
export function evaluate(runs) {
  const ordered = [...runs].sort((a, b) => runTime(a) - runTime(b) || a.id - b.id)
  /** name → { lastSuccess, firstFailure, latestFailure, latestFailureJob } */
  const state = new Map()
  const dropped = []

  for (const run of ordered) {
    const names = new Set(run.jobs.map((j) => j.name))
    for (const job of run.jobs) {
      if (DERIVED_JOBS.has(job.name) || !DECISIVE.has(job.conclusion)) continue
      const s = state.get(job.name) ?? { lastSuccess: null, firstFailure: null, latestFailure: null, latestFailureJob: null }
      if (job.conclusion === 'success') {
        s.lastSuccess = run
        s.firstFailure = null
        s.latestFailure = null
        s.latestFailureJob = null
      } else {
        if (!s.firstFailure) s.firstFailure = run
        s.latestFailure = run
        s.latestFailureJob = job
      }
      state.set(job.name, s)
    }
    // A failing job that no longer EXISTS in a later run that ran to
    // completion was renamed or removed: it can never pass again, so it is
    // dropped rather than holding the issue open forever. Absent is not
    // skipped — a skipped job is still listed. A cancelled run, or one with no
    // jobs at all (a workflow that failed to start), proves nothing.
    if (run.conclusion === 'cancelled' || run.jobs.length === 0) continue
    for (const [name, s] of state) {
      if (s.firstFailure && runTime(s.latestFailure) < runTime(run) && !names.has(name)) {
        dropped.push({ job: name, latestFailure: s.latestFailure, goneIn: run })
        state.delete(name)
      }
    }
  }

  const red = []
  for (const [name, s] of state) {
    if (!s.firstFailure) continue
    // Suspects: every run after the job's last success, up to and including
    // its first failure. The job was skipped or cancelled in all but the last,
    // so any of their commits may have broken it. Blaming the triggering run
    // would have named #3875 for #3855's break.
    const after = s.lastSuccess ? runTime(s.lastSuccess) : -Infinity
    const suspects = ordered.filter(
      (r) => runTime(r) > after && runTime(r) <= runTime(s.firstFailure),
    )
    red.push({
      job: name,
      lastSuccess: s.lastSuccess,
      firstFailure: s.firstFailure,
      latestFailure: s.latestFailure,
      latestFailureJob: s.latestFailureJob,
      suspects,
      // No success inside the window: the break may predate it.
      openEnded: !s.lastSuccess,
    })
  }
  red.sort((a, b) => a.job.localeCompare(b.job))
  return { healthy: red.length === 0, red, dropped }
}

/** Keep only failure-level annotations, minus the generic exit-code line every failed job carries. */
export function failureAnnotations(annotations) {
  return (annotations ?? []).filter(
    (a) => a.annotation_level === 'failure' && !/^Process completed with exit code \d+\.?$/.test(String(a.message).trim()),
  )
}

const short = (sha) => String(sha ?? '').slice(0, 8)
const link = (run) => (run?.html_url ? `[${run.id}](${run.html_url})` : String(run?.id ?? '?'))
const prLabel = (run) => {
  const pr = prOf(run)
  return pr ? `#${pr}` : 'no PR in subject'
}

/** The issue body. Says which job is red, which commits may have broken it, and what failed. */
export function renderIssueBody({ red, dropped }, { annotations = {}, runUrl } = {}) {
  const lines = [
    'A CI job is failing on `dev` itself, on a push run rather than a pull request.',
    '',
    '`dev` merges do not require an up-to-date branch, so two individually green PRs can',
    'break `dev` together. That is accepted on the condition that the break is fixed',
    'forward (`docs/contributing/autonomous-pr-loop.md`). Every PR that runs these jobs',
    'inherits the failure until then.',
    '',
  ]
  for (const r of red) {
    lines.push(`### \`${r.job}\``)
    lines.push('')
    lines.push(`- **Failing since:** \`${short(r.firstFailure.head_sha)}\` (${prLabel(r.firstFailure)}), run ${link(r.firstFailure)}`)
    lines.push(`- **Latest failure:** \`${short(r.latestFailure.head_sha)}\`, run ${link(r.latestFailure)}`)
    if (r.openEnded) {
      lines.push(`- **Last passed:** not within the last ${LOOKBACK_RUNS} push runs, so the break may be older`)
    } else {
      lines.push(`- **Last passed:** \`${short(r.lastSuccess.head_sha)}\`, run ${link(r.lastSuccess)}`)
    }
    if (r.suspects.length === 1 && !r.openEnded) {
      lines.push(`- **Introduced by:** \`${short(r.suspects[0].head_sha)}\` (${prLabel(r.suspects[0])})`)
    } else {
      lines.push('- **Introduced by one of:** (the job was skipped or cancelled in between, so any of these may be the cause)')
      for (const s of r.suspects) {
        const job = s.jobs.find((j) => j.name === r.job)
        lines.push(`  - \`${short(s.head_sha)}\` (${prLabel(s)}): job ${job?.conclusion ?? 'absent'}, run ${link(s)}`)
      }
    }
    const notes = annotations[r.job] ?? []
    if (notes.length) {
      lines.push('- **What failed:**')
      for (const a of notes.slice(0, 5)) {
        const where = a.path && a.path !== '.github' ? `\`${a.path}:${a.start_line}\` ` : ''
        const msg = String(a.title || a.message).split('\n')[0].slice(0, 200)
        lines.push(`  - ${where}${msg}`)
      }
    }
    lines.push('')
  }
  if (dropped.length) {
    lines.push('### No longer tracked')
    lines.push('')
    for (const d of dropped) {
      lines.push(`- \`${d.job}\`: absent from run ${link(d.goneIn)}, so the job was renamed or removed. Its last failure was run ${link(d.latestFailure)}.`)
    }
    lines.push('')
  }
  lines.push('**Fix it forward:** reproduce on `origin/dev`, fix in a PR into `dev`. A job that later reads `skipped` has NOT recovered; this issue closes only when each job above runs and passes.')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(
    `_Upserted by \`dev-push-health.yml\` (#3890)${runUrl ? ` — [run](${runUrl})` : ''}. ` +
      'It closes this issue automatically once every job above has passed again; do not edit by hand._',
  )
  return lines.join('\n')
}

/** One line per red or dropped job, printed on healthy runs too. */
export function renderSummary({ healthy, red, dropped }, examined) {
  const lines = [
    healthy ? `✅ No push-to-dev CI job is red (${examined} runs examined).` : `❌ ${red.length} push-to-dev CI job(s) red (${examined} runs examined).`,
  ]
  for (const r of red) {
    lines.push(`  ✗ ${r.job}: failing since ${short(r.firstFailure.head_sha)} (${prLabel(r.firstFailure)}), ${r.suspects.length} suspect run(s)`)
  }
  for (const d of dropped) lines.push(`  – ${d.job}: no longer exists (last failed in run ${d.latestFailure.id})`)
  return lines.join('\n')
}

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

/**
 * The window: the newest LOOKBACK_RUNS completed push runs of ci.yml on `dev`,
 * each with its latest attempt's jobs. `until` (an ISO time) replays the window
 * as it stood when a past run completed.
 */
export function readWindow({ until } = {}, gh = defaultGh) {
  const repo = process.env.GITHUB_REPOSITORY || 'd-hinders/Haven-AI'
  const args = [
    'api', '-X', 'GET', `repos/${repo}/actions/workflows/ci.yml/runs`,
    '-f', 'branch=dev', '-f', 'event=push', '-f', 'status=completed',
    '-F', `per_page=${LOOKBACK_RUNS}`,
  ]
  if (until) args.push('-f', `created=<=${until}`)
  const { workflow_runs: runs } = JSON.parse(gh(args))
  if (!Array.isArray(runs)) throw new Error('workflow runs response is not a list')
  return runs.map((run) => {
    const { jobs } = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]))
    return { ...run, jobs: Array.isArray(jobs) ? jobs : [] }
  })
}

function readAnnotations(red, gh = defaultGh) {
  const repo = process.env.GITHUB_REPOSITORY || 'd-hinders/Haven-AI'
  const out = {}
  for (const r of red) {
    if (!r.latestFailureJob) continue
    try {
      out[r.job] = failureAnnotations(JSON.parse(gh(['api', `repos/${repo}/check-runs/${r.latestFailureJob.id}/annotations`])))
    } catch (err) {
      console.error(`::warning::dev-push-health could not read annotations for ${r.job}: ${err.message}`)
    }
  }
  return out
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const gh = defaultGh
  // `--until <run-id>` replays the window as it stood when that run was
  // created: the pre-merge proof, since `workflow_run` only fires from the
  // default branch. Implies a dry run.
  const untilIdx = process.argv.indexOf('--until')
  const untilRun = untilIdx > -1 ? process.argv[untilIdx + 1] : null
  const dryRun = Boolean(untilRun) || process.env.DEV_PUSH_HEALTH_DRY_RUN === '1'

  let window
  try {
    let until
    if (untilRun) {
      const repo = process.env.GITHUB_REPOSITORY || 'd-hinders/Haven-AI'
      until = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${untilRun}`])).created_at
    }
    window = readWindow({ until }, gh)
  } catch (err) {
    // Never fail the build: an unreadable window is a warning, and the next
    // push re-evaluates from scratch.
    console.error(`::warning::dev-push-health could not read the run window: ${err.message}`)
    process.exit(0)
  }

  const result = evaluate(window)
  const summary = renderSummary(result, window.length)
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Push-to-dev CI health (#3890)\n\n\`\`\`\n${summary}\n\`\`\`\n`)
  }
  const annotations = result.healthy ? {} : readAnnotations(result.red, gh)
  if (dryRun) {
    if (!result.healthy) console.log(`\n${renderIssueBody(result, { annotations })}`)
    process.exit(0)
  }

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined

  // Every `gh` write is wrapped: this runs after every `dev` push and must never
  // red the build (the guard-freshness contract).
  const tryGh = (args, what) => {
    try {
      return gh(args)
    } catch (err) {
      console.error(`::warning::dev-push-health could not ${what}: ${err.message}`)
      return null
    }
  }
  // `null` = the lookup itself failed, `undefined` = no such issue. Open issues
  // come from the plain label list, never search: search lags behind a
  // just-created issue, and evaluations run back to back (one per completed
  // run), so a lagging search would file a duplicate (#3890 code review S2).
  // Closed issues use search, as guard-freshness does; the closed set is old.
  const findByTitle = (state) => {
    const args = ['issue', 'list', '--label', 'ci-health', '--state', state, '--limit', state === 'open' ? '100' : '20',
                  '--json', 'number,title']
    if (state === 'closed') args.push('--search', `in:title "${ISSUE_TITLE}"`)
    const listed = tryGh(args, `list ${state} ci-health issues`)
    if (listed === null) return null
    try {
      return JSON.parse(listed).find((i) => i.title === ISSUE_TITLE)
    } catch (err) {
      console.error(`::warning::dev-push-health could not parse the ${state} issue list: ${err.message}`)
      return null
    }
  }

  const existing = findByTitle('open')
  // Not knowing whether the issue exists is not the same as it not existing:
  // stop rather than risk a duplicate. The next completed run re-evaluates.
  if (existing === null) process.exit(0)
  if (result.healthy) {
    if (existing) {
      tryGh(['issue', 'comment', String(existing.number), '--body',
             `Every push-to-dev CI job that was red has run and passed again.\n\n\`\`\`\n${summary}\n\`\`\``],
            `comment on #${existing.number}`)
      tryGh(['issue', 'close', String(existing.number), '--reason', 'completed'], `close #${existing.number}`)
      console.log(`Closed #${existing.number}: dev recovered.`)
    }
    process.exit(0)
  }

  tryGh(['label', 'create', 'ci-health', '--color', 'b60205', '--description', CI_HEALTH_LABEL_DESCRIPTION, '--force'],
        'ensure the ci-health label exists')
  const body = renderIssueBody(result, { annotations, runUrl })
  if (existing) {
    tryGh(['issue', 'edit', String(existing.number), '--body', body], `update #${existing.number}`)
    console.log(`Updated #${existing.number}.`)
    process.exit(0)
  }
  // Reopen rather than refile (guard-freshness's #3340 fix): a flap, or a human
  // closing the issue while a job is still red, keeps one thread. Labels are
  // re-asserted because `code-quality` is what queues it.
  const closed = findByTitle('closed')
  const reopened = closed ? tryGh(['issue', 'reopen', String(closed.number)], `reopen #${closed.number}`) : null
  if (closed && reopened !== null) {
    tryGh(['issue', 'edit', String(closed.number), '--body', body, '--add-label', 'ci-health', '--add-label', 'code-quality'],
          `update #${closed.number}`)
    tryGh(['issue', 'comment', String(closed.number), '--body',
           `Reopened: a push-to-dev CI job is red.${runUrl ? ` Run: ${runUrl}` : ''}`], `comment on #${closed.number}`)
    console.log(`Reopened #${closed.number}.`)
  } else {
    tryGh(['issue', 'create', '--title', ISSUE_TITLE, '--label', 'ci-health', '--label', 'code-quality', '--body', body],
          'file the dev-health issue')
  }
  process.exit(0)
}
