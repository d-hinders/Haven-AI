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
 * This produces it. Two signals, both read off the commits of every PR
 * merged into `dev` in the window (#3228 — `dev`'s own history stopped
 * carrying them when the squash-only ruleset landed on 2026-09-07):
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
 * The window selects PRs by the day they MERGED into `dev` (`--since`
 * inclusive, `--until` exclusive), and counts every merge commit inside those
 * PRs whenever it was made. A window with no merged PR refuses (exit 1)
 * rather than print the target state over nothing; a failed GitHub read
 * exits 2. Dates take the `=` form only: `--since 2026-09-08` used to fall
 * back to the 7-day default without a word, and is now refused.
 *
 * Until #3228 this read `dev`'s full history (`git log origin/dev`) by committer date.
 * Over #1500's own window (2026-08-14 → 08-15) that reproduced #1500's table
 * — 50 commits, 6 resyncs, 1 divergence. The PR-commit source answers a
 * different question (every resync inside the PRs that merged that day, not
 * the resync commits dated that day), so its figure for the same window is
 * larger; `docs/contributing/branch-and-release-flow.md` records both.
 *
 * Usage:
 *   node scripts/branch-hygiene.mjs                  # last 7 days
 *   node scripts/branch-hygiene.mjs --since=2026-08-14 --until=2026-08-15
 *   node scripts/branch-hygiene.mjs --json
 *   node scripts/branch-hygiene.mjs --from-json=<file>   # fixture (self-test)
 *
 * Needs an authenticated `gh` and a fetched `origin/dev` (a parent is "on dev"
 * when it is an ancestor of the local `origin/dev`).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Every shape a merge subject takes in this repo's real history, mined rather
 * than imagined — `git log origin/dev --format=%s | rg '^Merge '` — because a
 * regex written from memory is how a report ends up quietly measuring
 * something adjacent to the thing it claims. Since #3228 the subject decides
 * only the same-name (two-writers) case; a resync is decided by its parent,
 * because PR-commit subjects are often hand-written.
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

/**
 * Count resyncs from each merged PR's OWN commits (#3228).
 *
 * Since the squash-only "Dev merge" ruleset (2026-09-07) a PR's commits are
 * squashed into one before they reach `dev`, so `dev`'s history no longer
 * carries the resync merges this report exists to count: over 2026-09-08 →
 * 09-23 it read 0 across 259 commits and printed the target state, while 29
 * resync commits sat inside 23 of the 259 PRs merged in that window. The PR's
 * commit list survives the squash, so that is what this reads.
 *
 * A merge commit is a resync when one of its parents is a commit from
 * outside the PR that is in `origin/dev`'s history — whatever its subject
 * says. Subjects in PR commits
 * are often hand-written ("Merge origin/dev into x", "merge dev (73a7beaa)
 * into x"), and a subject regex missed 14 of them on that window. The subject
 * classifier above still decides the two-writers case, where neither parent
 * is on `dev`. Anything else is reported as an other merge, never dropped.
 *
 * `prs` is `[{ number, headRefName, commits: [{ oid, subject, parents: [oid] }] }]`;
 * `isOnDev(oid)` answers whether a commit is an ancestor of `origin/dev`.
 */
export function summarizePullRequests(prs, isOnDev) {
  const byBranch = new Map()
  let resyncs = 0
  let divergences = 0
  let otherMerges = 0
  let commits = 0
  let considered = 0
  for (const pr of prs) {
    // A sync-back from `main` is MERGE-merged onto `dev` on purpose
    // (branch-and-release-flow § After every promotion); its merges are
    // release reconciliation, not a work branch going stale.
    if (pr.headRefName === 'main' || /^sync\//.test(pr.headRefName) || /(^|\/)sync-\d+-main$/.test(pr.headRefName)) continue
    considered += 1
    // A parent that is one of the PR's OWN commits is the branch side of the
    // merge, even when it is on `dev` today: before the squash-only ruleset a
    // PR was merge-merged, so its branch commits became `dev` history, and a
    // same-name merge (`origin/<b>` into `<b>`) would otherwise read as a
    // resync. Only a parent from outside the PR that `dev` already had is `dev`.
    const own = new Set(pr.commits.map((c) => c.oid))
    for (const commit of pr.commits) {
      commits += 1
      if (commit.parents.length < 2) continue
      const branch = pr.headRefName
      let kind
      // The same-name subject wins over the parent test: a branch reused
      // across PRs (#1500's own case, #1417) merges `origin/<b>` whose tip is
      // an EARLIER PR's commit, already on `dev` and outside this PR.
      if (classify(commit.subject)?.kind === 'divergence') kind = 'divergence'
      else if (commit.parents.some((oid) => !own.has(oid) && isOnDev(oid))) kind = 'resync'
      else kind = 'other'
      if (kind === 'resync') resyncs += 1
      else if (kind === 'divergence') divergences += 1
      else {
        otherMerges += 1
        continue
      }
      const entry = byBranch.get(branch) ?? { resync: 0, divergence: 0, prs: new Set() }
      entry[kind] += 1
      entry.prs.add(pr.number)
      byBranch.set(branch, entry)
    }
  }
  return {
    prs: considered,
    commits,
    resyncs,
    divergences,
    otherMerges,
    branches: [...byBranch.entries()]
      .map(([branch, { resync, divergence, prs: numbers }]) => ({ branch, resync, divergence, prs: [...numbers].sort((a, b) => a - b) }))
      .sort((a, b) => b.resync + b.divergence - (a.resync + a.divergence)),
  }
}

/** Reads `--name=value`; a bare `--name value` is refused rather than ignored. */
export function parseArgs(argv, now = Date.now()) {
  for (const flag of ['since', 'until', 'repo', 'from-json']) {
    if (argv.includes(`--${flag}`)) {
      throw new Error(`--${flag} takes its value as --${flag}=<value>; "--${flag} <value>" would silently fall back to the default`)
    }
  }
  const arg = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }
  const since = arg('since', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  const until = arg('until', '')
  for (const [name, value] of [['since', since], ['until', until]]) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--${name} must be a YYYY-MM-DD date, got "${value}"`)
  }
  return { since, until, repo: arg('repo', 'd-hinders/Haven-AI'), fromJson: arg('from-json', ''), json: argv.includes('--json') }
}

const PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number headRefName mergedAt
      commits(first: 100) { totalCount nodes { commit { oid message parents(first: 2) { nodes { oid } } } } }
    } }
  }
}`

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Every PR merged into `dev` in the window, with its own commits. */
export function fetchMergedPullRequests({ repo, since, until }) {
  const q = `repo:${repo} is:pr is:merged base:dev merged:>=${since}`
  const prs = []
  let after = null
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `q=${q}`]
    if (after) args.push('-f', `after=${after}`)
    const { data, errors } = JSON.parse(gh(args))
    if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '))
    if (data.search.issueCount > 1000) {
      throw new Error(`${data.search.issueCount} PRs match; GitHub search returns at most 1000 — narrow the window`)
    }
    for (const node of data.search.nodes) {
      if (!node.number) continue
      if (until && node.mergedAt.slice(0, 10) >= until) continue
      let commits = node.commits.nodes.map(({ commit }) => ({
        oid: commit.oid,
        // `message`, not `messageHeadline`: GitHub truncates the headline at
        // about 70 characters with an ellipsis, so a long branch name never
        // matched the same-name subject (found on #1417).
        subject: commit.message.split('\n')[0],
        parents: commit.parents.nodes.map((p) => p.oid),
      }))
      if (node.commits.totalCount > commits.length) {
        // Over 100 commits: the REST list pages further (to 250, GitHub's cap).
        commits = JSON.parse(gh(['api', `repos/${repo}/pulls/${node.number}/commits`, '--paginate', '--slurp']))
          .flat()
          .map((c) => ({ oid: c.sha, subject: c.commit.message.split('\n')[0], parents: c.parents.map((p) => p.sha) }))
      }
      prs.push({ number: node.number, headRefName: node.headRefName, commits })
    }
    if (!data.search.pageInfo.hasNextPage) break
    after = data.search.pageInfo.endCursor
  }
  return prs
}

function isAncestorOfDev(oid) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', oid, 'origin/dev'], { stdio: 'ignore' })
    return true
  } catch {
    // Not an ancestor, or not a commit this clone has: a branch-side parent is
    // never on dev, so both answers are "no".
    return false
  }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`branch-hygiene: ${err.message}`)
    process.exit(2)
  }
  const { since, until, repo, fromJson, json } = opts

  let prs
  let isOnDev = isAncestorOfDev
  if (fromJson) {
    // Fixture mode for the self-test: `{ prs: [...], onDev: [oid, ...] }`.
    const fixture = JSON.parse(readFileSync(fromJson, 'utf8'))
    prs = fixture.prs
    const onDev = new Set(fixture.onDev ?? [])
    isOnDev = (oid) => onDev.has(oid)
  } else {
    try {
      prs = fetchMergedPullRequests({ repo, since, until })
    } catch (err) {
      // A failed read is not a clean window: say so and exit non-zero.
      const detail = String(err.stderr || err.message).trim().split('\n').pop()
      console.error(`branch-hygiene: could not read merged PRs from GitHub (${detail}) — no verdict.`)
      process.exit(2)
    }
  }

  const report = summarizePullRequests(prs, isOnDev)
  const window = until ? `${since} → ${until}` : `since ${since}`

  if (report.prs === 0) {
    // Refuse rather than print the target state over nothing (#3228): a
    // window with no merged PR measured nothing.
    console.error(`branch-hygiene: no PR merged into dev ${window} — nothing was measured, so no verdict.`)
    process.exit(1)
  }

  if (json) {
    console.log(JSON.stringify({ since, until: until || null, ...report }, null, 2))
    return
  }

  console.log(`Branch hygiene: PRs merged into dev ${window} (${report.prs} PRs, ${report.commits} commits)\n`)
  console.log(`  stale-branch resyncs:      ${report.resyncs}`)
  console.log(`  local/remote divergences:  ${report.divergences}`)
  if (report.otherMerges) console.log(`  other merge commits:       ${report.otherMerges} (neither parent on dev, not a same-name merge)`)

  if (report.branches.length === 0) {
    console.log(`\n✓ One branch per PR, each cut fresh, across ${report.prs} PRs. This is the target state (#1500).`)
    return
  }

  console.log('\n  by branch:')
  for (const b of report.branches) {
    const parts = [
      b.resync ? `${b.resync} resync${b.resync > 1 ? 's' : ''}` : '',
      b.divergence ? `${b.divergence} divergence${b.divergence > 1 ? 's' : ''}` : '',
    ].filter(Boolean)
    console.log(`    ${b.branch} (${b.prs.map((n) => `#${n}`).join(', ')}) — ${parts.join(', ')}`)
  }
  console.log(
    '\n  Each of these is a branch that outlived one PR. The fix is upstream of\n' +
    '  any single change: see docs/contributing/branch-and-release-flow.md\n' +
    '  § Branch lifetime for the reset recipe and its guard (#1500).',
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
