#!/usr/bin/env node
// Two figures for the promotion digest (#2767), each printed with the command
// that produced it so the next reader can re-derive rather than trust:
//
//   1. issues filed per issue closed in the window   — target < 0.3
//   2. product PRs as a share of merges to `dev`      — target > 60 %
//
// Baselines are NOT restated here: #2767's hand count was ~1.0 and 36 % for the
// week to 2026-09-08, and this classifier's own reading of the same window is in
// that PR's body against a named commit. A figure in this file would be a third
// copy that nothing re-derives.
//
// Why these two. In the week to 2026-09-08 the repository merged 199 PRs and
// filed 195 issues, 141 of them citing another issue filed in the same week; 127
// of the 199 merges changed tooling, docs, CI, guards or the QA harness rather
// than the product. #2767 changed the skill so a finding is fixed in its PR or
// dropped with a reason, and filed only above a bar. Whether that moved anything
// is a number, printed every digest, not an impression. If figure 1 has not
// moved within two weeks, the next step named in #2767 is filing-asks-the-user.
//
// The PR classifier is title-based and deliberately dumb, so it is reproducible
// by hand: a conventional-commit subject `type(scope): …` is PRODUCT when its
// type is one of PRODUCT_TYPES and no scope is in TOOLING_SCOPES; TOOLING when
// its type is in TOOLING_TYPES or any scope is in TOOLING_SCOPES; UNCLASSIFIED
// otherwise (no conventional prefix). A pre-#2632 two-parent landing, `Merge pull
// request #N from owner/<type>/slug`, reads its type off the branch prefix. Unclassified subjects count in the
// denominator and never as product — the share is a floor, and the digest prints
// all three buckets so a reader can see how much the floor is doing.
//
// `gh` and `git` are called through injectable runners so the classifier and the
// rendering are unit-tested without a network.
//
// Usage:
//   node scripts/ci/promotion-digest-metrics.mjs [--days=7] [--until=<iso>] [--ref=origin/dev]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const WINDOW_DAYS_DEFAULT = 7

export const PRODUCT_TYPES = new Set(['feat', 'fix', 'perf', 'refactor', 'security'])
export const TOOLING_TYPES = new Set([
  'docs', 'ci', 'chore', 'test', 'build', 'style', 'docs-quality', 'revert', 'release',
  'ship-next', 'skills', 'agent-first',
])
export const TOOLING_SCOPES = new Set([
  'ci', 'docs', 'skills', 'skill', 'scripts', 'qa', 'qa-agent', 'workflow', 'workflows',
  'release', 'guard', 'guards', 'lint', 'hooks', 'agents', 'templates', 'tooling',
  'docs-quality', 'casp', 'contributing', 'retro', 'quality', 'deps', 'dev',
])

const SUBJECT_RE = /^(?<type>[a-z][a-z0-9-]*)(?:\((?<scope>[^)]*)\))?!?:\s/i

// A two-parent landing from before the `Dev merge` ruleset pinned `dev` to squash
// (#2632, 2026-09-07): `Merge pull request #N from <owner>/<type>/<slug>`. The
// branch prefix is the only type it carries, so it is read as `type:`; a merge
// subject with no such prefix stays unclassified.
const MERGE_RE = /^Merge pull request #\d+ from [^/\s]+\/(?<type>[a-z][a-z0-9-]*)\//i

/** 'product' | 'tooling' | 'unclassified' — see the header for the rule. */
export function classifySubject(subject) {
  const text = String(subject ?? '').trim()
  const m = SUBJECT_RE.exec(text) ?? MERGE_RE.exec(text)
  if (!m) return 'unclassified'
  const type = m.groups.type.toLowerCase()
  const scopes = (m.groups.scope ?? '')
    .split(/[,/\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (scopes.some((s) => TOOLING_SCOPES.has(s))) return 'tooling'
  if (TOOLING_TYPES.has(type)) return 'tooling'
  if (PRODUCT_TYPES.has(type)) return 'product'
  return 'unclassified'
}

export function productShare(subjects) {
  const buckets = { product: 0, tooling: 0, unclassified: 0 }
  for (const s of subjects) buckets[classifySubject(s)] += 1
  const total = subjects.length
  const pct = total === 0 ? null : Math.round((buckets.product / total) * 1000) / 10
  return { ...buckets, total, pct }
}

/** created / closed, or null when nothing closed (printed as `n/a`, never as ∞ or 0). */
export function filedPerClosed(created, closed) {
  if (!Number.isInteger(created) || !Number.isInteger(closed) || closed <= 0) return null
  return Math.round((created / closed) * 100) / 100
}

export function fmtDate(d) {
  return new Date(d).toISOString().slice(0, 10)
}

/**
 * The digest lines. `ref` is the branch the merges are read from; `since`/`until`
 * are ISO dates. Every figure is followed by the command that reproduces it.
 */
export function renderDigestLines({ since, until, created, closed, subjects, ref = 'origin/dev' }) {
  const ratio = filedPerClosed(created, closed)
  const share = productShare(subjects)
  const sinceDay = fmtDate(since)
  const untilDay = fmtDate(until)
  const issueCmd = `gh issue list --state all --limit 1000 --json number --search 'created:${sinceDay}..${untilDay}' | jq length; gh issue list --state closed --limit 1000 --json number --search 'closed:${sinceDay}..${untilDay}' | jq length`
  const prCmd = `git log --first-parent --format=%s --since=${since} --until=${until} ${ref} | node scripts/ci/promotion-digest-metrics.mjs --classify`
  return [
    `**Filing ratio (${sinceDay} → ${untilDay}):** ${ratio === null ? 'n/a' : ratio} issues filed per issue closed` +
      ` (${created} filed / ${closed} closed; target < 0.3 — baseline and rationale in #2767).`,
    `  \`${issueCmd}\``,
    `**Product share of \`${ref}\` merges (${sinceDay} → ${untilDay}):** ${share.pct === null ? 'n/a' : `${share.pct} %`}` +
      ` (${share.product} product / ${share.tooling} tooling / ${share.unclassified} unclassified of ${share.total}; target > 60 % — baseline and rationale in #2767).`,
    `  \`${prCmd}\``,
  ].join('\n')
}

// ---------------------------------------------------------------------------

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' })
const defaultGit = (args) => execFileSync('git', args, { encoding: 'utf8' })

function countIssues(gh, search) {
  const out = gh(['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number', '--search', search])
  const parsed = JSON.parse(out || '[]')
  return Array.isArray(parsed) ? parsed.length : 0
}

export function collect({ gh = defaultGh, git = defaultGit, days = WINDOW_DAYS_DEFAULT, until = new Date(), ref = 'origin/dev' } = {}) {
  const untilDate = new Date(until)
  const sinceDate = new Date(untilDate.getTime() - days * 86_400_000)
  const since = sinceDate.toISOString()
  const untilIso = untilDate.toISOString()
  const created = countIssues(gh, `created:${fmtDate(since)}..${fmtDate(untilIso)}`)
  const closed = countIssues(gh, `is:closed closed:${fmtDate(since)}..${fmtDate(untilIso)}`)
  const subjects = git(['log', '--first-parent', '--format=%s', `--since=${since}`, `--until=${untilIso}`, ref])
    .split('\n')
    .filter(Boolean)
  return { since, until: untilIso, created, closed, subjects, ref }
}

function parseArgs(argv) {
  const opts = { days: WINDOW_DAYS_DEFAULT, until: new Date(), ref: 'origin/dev', classify: false }
  for (const a of argv) {
    if (a === '--classify') opts.classify = true
    else if (a.startsWith('--days=')) opts.days = Number(a.slice(7))
    else if (a.startsWith('--until=')) opts.until = new Date(a.slice(8))
    else if (a.startsWith('--ref=')) opts.ref = a.slice(6)
  }
  return opts
}

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.classify) {
    // Read subjects from stdin, print the bucket per line and the share — the
    // re-derivation command the digest prints.
    const subjects = readFileSync(0, 'utf8').split('\n').filter(Boolean)
    for (const s of subjects) console.log(`${classifySubject(s).padEnd(12)} ${s}`)
    const share = productShare(subjects)
    console.log(`product ${share.product} / tooling ${share.tooling} / unclassified ${share.unclassified} of ${share.total} = ${share.pct === null ? 'n/a' : `${share.pct} %`}`)
    return 0
  }
  if (!Number.isInteger(opts.days) || opts.days <= 0) {
    console.error('promotion-digest-metrics: --days must be a positive integer')
    return 2
  }
  console.log(renderDigestLines(collect(opts)))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
