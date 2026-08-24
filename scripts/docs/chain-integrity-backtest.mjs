#!/usr/bin/env node
// Replay the #1843 chain-integrity check over merged history.
//
// NOT a gate — nothing runs this in CI. It exists so the numbers that chose
// this check's shape stay falsifiable: the decision to use CONTAINMENT rather
// than #1843's proposed order-preserving subsequence rests on a measured false
// positive rate, and a measurement nobody can re-run is an assertion.
//
//   node scripts/docs/chain-integrity-backtest.mjs [--merges=250] [--since=YYYY-MM-DD]
//
// For each `Merge pull request #N from <feature branch>` on the current branch's
// history it computes exactly what CI would have computed for that pull request
// — base = merge-base(first parent, second parent), head = the branch tip — and
// reports every doc the check would have failed.
//
// Two merge shapes are EXCLUDED, and the exclusion is the point rather than
// tidiness: `Merge branch 'dev' into <x>` sync merges and
// `Merge pull request #N from d-hinders/dev` promotions both have `dev` as the
// second parent, so including them measures dev's own advance instead of any
// pull request's change. Counting them was the first draft of this script and
// it reported a 41% failure rate that was almost entirely that artefact.
//
// Numbers measured on 2026-08-22, for the record (they move as `dev` moves —
// re-derive rather than cite):
//   * since 2026-08-15: 24 PRs, 17 changed `last-verified` lines, 0 failures.
//   * full history, 128 PRs: 40 would have failed — ALL of them before #1496,
//     when the convention was to REPLACE the note rather than chain it. The
//     check asserts the current convention and is not retroactive: it only ever
//     compares a pull request's own edit against its own merge base.

import { execFileSync } from 'node:child_process'
import { REPO_ROOT, ROOT_DOCS } from './validate-frontmatter.mjs'
import { lastVerifiedLine, checkChain } from './chain-integrity.mjs'

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function git(args, quiet = false) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

const limit = arg('merges', '250')
const since = arg('since', null)
const ref = arg('ref', 'origin/dev')

const merges = (git(['log', '--merges', '--format=%H %P', `-n${limit}`, ref]) || '').trim()
let prs = 0
let lines = 0
let broken = 0
let resets = 0

for (const entry of merges.split('\n').filter(Boolean)) {
  const [merge, p1, p2] = entry.split(' ')
  if (!p2) continue
  const subject = (git(['log', '-1', '--format=%s', merge]) || '').trim()
  if (!/^Merge pull request #\d+ from /.test(subject)) continue
  if (/from d-hinders\/dev$/.test(subject)) continue
  const date = (git(['log', '-1', '--format=%ad', '--date=short', merge]) || '').trim()
  if (since && date < since) continue
  prs++

  const base = (git(['merge-base', p1, p2]) || '').trim()
  if (!base) continue

  const changed = (git(['diff', '--name-only', `${base}...${p2}`]) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.md') && (f.startsWith('docs/') || ROOT_DOCS.includes(f)))

  for (const rel of changed) {
    const prevRaw = git(['show', `${base}:${rel}`], true)
    const nextRaw = git(['show', `${p2}:${rel}`], true)
    if (prevRaw === null || nextRaw === null) continue
    const prev = lastVerifiedLine(prevRaw)
    const next = lastVerifiedLine(nextRaw)
    if (!prev || !next || prev === next) continue
    lines++
    const result = checkChain(prev, next)
    if (result.status === 'broken') {
      broken++
      console.log(`BROKEN  ${date}  ${merge.slice(0, 8)}  ${rel}  dropped ${result.dropped.join(', ')}`)
    }
    if (result.status === 'reset') resets++
  }
}

console.log(
  `\n${prs} pull request(s), ${lines} changed \`last-verified\` line(s), ` +
  `${broken} would have failed, ${resets} declared chain-reset.`,
)
