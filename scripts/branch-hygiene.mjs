#!/usr/bin/env node
/**
 * Branch-hygiene report (#1500).
 *
 * `docs/contributing/branch-and-release-flow.md` § *Branch lifetime* says a
 * work branch is cut fresh from `origin/dev`, carries one PR, and dies on
 * merge. #1500 wrote that down; nothing MEASURED it, so the rule's own
 * acceptance criterion — "a week of normal volume shows zero
 * `Merge branch 'dev' into <branch>` commits" — was a number no one could
 * produce without hand-writing a `git log`.
 *
 * This produces it. Two signals, both read off `dev`'s history:
 *
 *   resync     `Merge branch 'dev' into <branch>` — a branch that went stale
 *              under work landing beneath it. The direct cost is a dev-merge,
 *              a conflict resolve and a full CI re-run; the compounding cost
 *              is that a CONFLICTING PR produces no `pull_request` check runs
 *              at all, so an armed auto-merge silently never fires (#1366).
 *
 *   divergence `Merge remote-tracking branch 'origin/<b>' into <b>` — the
 *              same branch name diverging between local and remote, i.e. two
 *              writers on one branch. Strictly worse than staleness, and the
 *              exact hazard AGENTS.md § Cross-session agent coordination
 *              warns about.
 *
 * REPORTING, not gating, and deliberately so. These commits are evidence of a
 * launch configuration, not of a bad PR, and the contributor who would trip
 * the gate is never the one who can fix the cause — that is an environment
 * setting (#1500 options 1 and 2). A gate here would block the wrong person
 * for something they cannot change. Read the number; act on the trend.
 *
 * The window is applied HERE rather than by `git log --since/--until`. A bare
 * date undercounts: over #1500's own window `--since=2026-08-14
 * --until=2026-08-15` reports 30 commits where `--since=2026-08-14T00:00
 * --until=2026-08-15T00:00` reports 49, because those options bound a history
 * TRAVERSAL and over a merge-heavy branch its edges are not where a reader
 * assumes. A hygiene report that answers "clean!" because it asked the
 * question in the wrong shape is worse than no report, so the window is a
 * plain comparison over committer dates the script reads itself.
 *
 * Matching reads the commit SUBJECT rather than using `git log --grep`, which
 * searches the entire message — a squash commit whose BODY quotes
 * "Merge branch 'dev' into ..." (a doc change about this very rule will)
 * would otherwise count as a resync that never happened.
 *
 * Against #1500's own window (2026-08-14 → 08-15) this reproduces its table
 * exactly: 50 commits, 6 resyncs, 1 divergence, four of the six on the one
 * branch that stayed open 7.5 hours.
 *
 * Usage:
 *   node scripts/branch-hygiene.mjs                  # last 7 days
 *   node scripts/branch-hygiene.mjs --since=2026-08-14 --until=2026-08-15
 *   node scripts/branch-hygiene.mjs --json
 */

import { execFileSync } from 'node:child_process'

/**
 * Every shape a merge subject takes in this repo's real history, mined rather
 * than imagined — `git log origin/dev --format=%s | rg '^Merge '` — because a
 * regex written from memory is how a report ends up quietly measuring
 * something adjacent to the thing it claims.
 *
 *   Merge branch 'dev' into <b>                          `git merge dev`
 *   Merge remote-tracking branch 'origin/dev' into <b>   `git pull origin dev`
 *   Merge branch 'dev' of <url> into <b>                 pull, no tracking name
 *   Merge remote-tracking branch 'origin/<b>' into <b>   the two-writers case
 */
const MERGE_SUBJECT =
  /^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'(?: of \S+)? into (.+)$/

/** Branches that are integration targets, never work branches that went stale. */
const INTEGRATION_BRANCHES = new Set(['dev', 'main'])

export function classify(subject) {
  const match = MERGE_SUBJECT.exec(subject)
  if (!match) return null
  const [, source, target] = match

  // Same name on both sides: one branch, two writers. Strictly worse than
  // staleness and counted separately, whatever the source branch is.
  if (source === target) return { kind: 'divergence', branch: target }

  // Only a resync FROM dev counts. `main` into a branch is release
  // reconciliation, a different act with a different cause (see
  // promotion-merge-method), and counting it would put `main`-into-`dev`
  // merges in a table of work branches that outlived their PR — which is
  // nonsense, and was this script's first bug.
  if (source !== 'dev') return null
  if (INTEGRATION_BRANCHES.has(target)) return null

  return { kind: 'resync', branch: target }
}

export function summarize(subjects) {
  const findings = subjects.map(classify).filter(Boolean)
  const byBranch = new Map()
  for (const finding of findings) {
    const entry = byBranch.get(finding.branch) ?? { resync: 0, divergence: 0 }
    entry[finding.kind] += 1
    byBranch.set(finding.branch, entry)
  }
  return {
    total: subjects.length,
    resyncs: findings.filter((f) => f.kind === 'resync').length,
    divergences: findings.filter((f) => f.kind === 'divergence').length,
    branches: [...byBranch.entries()]
      .map(([branch, counts]) => ({ branch, ...counts }))
      .sort((a, b) => b.resync + b.divergence - (a.resync + a.divergence)),
  }
}

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function main() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const since = arg('since', sevenDaysAgo)
  const until = arg('until', '')

  // Whole history, then filtered exactly. See the note above on why the window
  // is not handed to git. The field separator is \x01 rather than NUL because
  // Node refuses to spawn a process with a NUL byte in an argument.
  const lines = execFileSync('git', ['log', 'origin/dev', '--format=%cI\u0001%s'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)

  const subjects = []
  for (const line of lines) {
    const [committedAt, subject] = line.split('\u0001')
    if (!subject) continue
    const day = committedAt.slice(0, 10)
    if (day < since) continue
    if (until && day >= until) continue
    subjects.push(subject)
  }

  const report = summarize(subjects)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ since, until: until || null, ...report }, null, 2))
    return
  }

  const window = until ? `${since} → ${until}` : `since ${since}`
  console.log(`Branch hygiene on origin/dev, ${window} (${report.total} commits)\n`)
  console.log(`  stale-branch resyncs:      ${report.resyncs}`)
  console.log(`  local/remote divergences:  ${report.divergences}`)

  if (report.branches.length === 0) {
    console.log('\n\u2713 One branch per PR, each cut fresh. This is the target state (#1500).')
    return
  }

  console.log('\n  by branch:')
  for (const b of report.branches) {
    const parts = [
      b.resync ? `${b.resync} resync${b.resync > 1 ? 's' : ''}` : '',
      b.divergence ? `${b.divergence} divergence${b.divergence > 1 ? 's' : ''}` : '',
    ].filter(Boolean)
    console.log(`    ${b.branch} \u2014 ${parts.join(', ')}`)
  }
  console.log(
    '\n  Each of these is a branch that outlived one PR. The fix is upstream of\n' +
    '  any single change: see docs/contributing/branch-and-release-flow.md\n' +
    '  \u00a7 Branch lifetime for the reset recipe and its guard (#1500).',
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
