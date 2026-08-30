#!/usr/bin/env node
// Scheduled-guard freshness reporter (#2208) — `.github/workflows/guard-freshness.yml`.
//
// ## The problem this exists for
//
// A scheduled job that silently stops running looks exactly like a passing one.
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
// `evaluate()` is pure; every `gh` call lives in the CLI wrapper at the bottom.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const DAY_MS = 24 * 60 * 60 * 1000

/** The one issue this reporter owns. Upserted, and CLOSED when everything is healthy. */
export const ISSUE_TITLE = '🩺 A scheduled CI guard has stopped proving its guarantee'

/**
 * The registry. Adding a scheduled guard here is what makes its absence
 * detectable; the self-test asserts every `workflow` below exists on disk, so a
 * rename cannot quietly de-register one.
 *
 * `maxAgeDays` is a budget, not the cadence: 3 days on a nightly tolerates two
 * consecutive misses (an Actions incident, a queue backlog) before it speaks. A
 * reporter that cries on the first blip gets muted, and a muted reporter is
 * worse than none — which is the same reasoning that keeps the proof job itself
 * non-gating.
 */
export const SCHEDULED_GUARDS = [
  {
    workflow: 'db-concurrency-proof.yml',
    label: 'Advisory-lock deadlock proof (#2208)',
    maxAgeDays: 3,
    cadence: 'nightly',
    why:
      'It is the only thing that re-proves end to end that a blocking advisory-lock waiter ' +
      'still deadlocks a concurrent CREATE INDEX CONCURRENTLY (40P01) and that the polled ' +
      'waiter in packages/backend/src/db/advisory-lock.ts still does not. While it is not ' +
      'running, that guarantee rests on assertions about the cause only.',
  },
]

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
    lines.push(
      `- **Restart it:** \`gh workflow run ${f.guard.workflow}\`, then check why it stopped — ` +
        'a renamed file, an edited cron, an expired token, a changed default branch, or ' +
        "GitHub's 60-day inactivity disablement of scheduled workflows.",
    )
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

function observe(guard) {
  const fileExists = existsSync(path.join(ROOT, '.github', 'workflows', guard.workflow))
  if (!fileExists) return { fileExists: false, lastSuccessAt: null, lastRunAt: null }
  try {
    const raw = gh([
      'run', 'list',
      '--workflow', guard.workflow,
      '--limit', '50',
      '--json', 'conclusion,status,createdAt,updatedAt',
    ])
    const runs = JSON.parse(raw)
    const completed = runs.filter((r) => r.status === 'completed')
    const success = completed.filter((r) => r.conclusion === 'success')
    const newest = (list) =>
      list.map((r) => r.updatedAt || r.createdAt).sort().at(-1) ?? null
    return { fileExists: true, lastSuccessAt: newest(success), lastRunAt: newest(runs) }
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

  // Self-heal the labels: `ci-health` names the subject, `code-quality` is what
  // puts it in the ship-next queue. That second label is the notification
  // decision — a nightly failure that only lands in a mailbox at 3am gets
  // muted; one that becomes a queued work item gets picked up by whoever ships
  // next, which is the behaviour actually wanted.
  gh(['label', 'create', 'ci-health', '--color', 'b60205',
      '--description', 'Automated: a scheduled CI guard is failing or has stopped running', '--force'])

  const existing = JSON.parse(
    gh(['issue', 'list', '--label', 'ci-health', '--state', 'open', '--limit', '10',
        '--json', 'number,title']),
  ).find((i) => i.title === ISSUE_TITLE)

  if (result.healthy) {
    if (existing) {
      gh(['issue', 'comment', String(existing.number), '--body',
          `Every registered guard is fresh again.\n\n\`\`\`\n${summary}\n\`\`\``])
      gh(['issue', 'close', String(existing.number), '--reason', 'completed'])
      console.log(`Closed #${existing.number} — guards recovered.`)
    }
    process.exit(0)
  }

  const body = renderIssueBody(result.findings, { runUrl })
  if (existing) {
    gh(['issue', 'edit', String(existing.number), '--body', body])
    console.log(`Updated #${existing.number}.`)
  } else {
    gh(['issue', 'create', '--title', ISSUE_TITLE,
        '--label', 'ci-health', '--label', 'code-quality', '--body', body])
  }
  // The reporter itself stays GREEN: the issue is the signal, and a permanently
  // red push-triggered check on `dev` would be noise on work that did not cause
  // it. Staleness is a queued work item, not a broken build.
  process.exit(0)
}
