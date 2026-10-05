#!/usr/bin/env node
// The ONE standing `QA wallet balances low` issue (#3631).
//
// Money-flow QA failed in preflight for ~3.5 days (2026-10-01 → 10-05) because
// the delegation treasury ran dry with no warning. `qa-balances.yml` runs
// `npm run qa:balances -w packages/qa-agent` once a day; this script turns its
// report into one standing issue:
//
//   - any wallet `warn` or `critical` → rewrite the body, and reopen the issue
//     or create it once;
//   - a comment ONLY when a wallet's band changes (ok→warn, warn→critical,
//     critical→warn, …) — two runs with the same bands edit the body silently;
//   - no wallet `warn` or `critical` → if the issue is open, write the final
//     balances, comment them, and close it;
//   - `unknown` (config missing or a failed read) never opens the issue and
//     never blocks a close; it is shown in the body while the issue is open.
//
// ## Selection: bot author + exact title, over open AND closed issues
//
// Built on `standing-issue-upsert.mjs`'s rule (#3341), not on
// `qa-failure-issue.mjs`'s label/`in:title` lookup: this script also CLOSES
// issues, so adopting a human issue that carries the label or whose title
// contains the words would let it close someone else's issue. The upsert
// module only looks at OPEN issues; this one must find the closed standing
// issue to reopen it, so it lists `--state all` and applies the same exact
// author + title filter itself. Every lookup failure exits non-zero BEFORE
// any write (fail closed).
//
// The previous run's bands ride in the body as a hidden marker, so the
// band-change rule needs no other state.
//
// Usage:
//   RUN_URL=... node scripts/ci/qa-balance-issue.mjs --report qa-balances.json
//
// `gh` is on PATH; the test drives this entry point with a recording stub.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BOT_AUTHOR } from './standing-issue-upsert.mjs'

export const ISSUE_TITLE = 'QA wallet balances low'
export const LABEL = 'qa-funding'
const LABEL_COLOR = 'd93f0b'
const LABEL_DESCRIPTION = 'A QA wallet is within 7 days of running dry (#3631)'
const MARKER = 'qa-balance-bands'
const WALLETS = ['treasury', 'merchant', 'relayer']
const ALARM = new Set(['warn', 'critical'])

const DOCS = 'docs/operations/agent-qa.md'
/** One top-up heading per wallet in agent-qa.md § QA wallet balances. */
export const TOP_UP_ANCHOR = {
  treasury: 'top-up-the-delegation-treasury',
  merchant: 'top-up-the-demo-merchant-settlement-wallet',
  relayer: 'top-up-the-dev-relayer',
}

const defaultGh = (args, { input } = {}) =>
  execFileSync('gh', args, { encoding: 'utf8', ...(input !== undefined ? { input } : {}) })

/** The previous run's bands from a body's hidden marker; {} when absent. */
export function readBands(body) {
  const m = String(body ?? '').match(new RegExp(`<!-- ${MARKER}: (\\{[^}]*\\}) -->`))
  if (!m) return {}
  try {
    const parsed = JSON.parse(m[1])
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The bands to remember: today's, except that an `unknown` wallet keeps its
 * last KNOWN band — a failed read carries no information about the wallet.
 */
export function nextBands(previous, rows) {
  const out = {}
  for (const key of WALLETS) {
    const row = rows.find((r) => r.key === key)
    out[key] = row && row.band !== 'unknown' ? row.band : (previous[key] ?? 'ok')
  }
  return out
}

/** The wallets whose known band changed since the last run. */
export function bandChanges(previous, rows) {
  const changes = []
  for (const row of rows) {
    if (row.band === 'unknown') continue
    const before = previous[row.key] ?? 'ok'
    if (before !== row.band) changes.push({ key: row.key, name: row.name, from: before, to: row.band })
  }
  return changes
}

function fmtRunway(row) {
  if (row.basis === 'fallback') return 'fallback floor'
  if (row.runwayDays !== undefined) return `${row.runwayDays} days`
  return row.basis === 'observed' ? 'no observed burn' : '—'
}

/** The issue body: one row per wallet, the top-up links, the time and the run. */
export function buildBody(report, { runUrl, repo, bands }) {
  const docBase = `https://github.com/${repo}/blob/dev/${DOCS}`
  const lines = [
    `One or more wallets the QA flows depend on has **less than 7 days of runway** (or cannot cover one run). ` +
      `Money-flow QA fails in preflight once a wallet runs dry — top it up before then.`,
    '',
    '| Wallet | Band | Address | Balance | Burn / day | Runway | Asset | Top up |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const row of report.rows) {
    const asset = row.token ? `${row.unit} \`${row.token}\`` : 'native ETH'
    const balance = row.balance !== undefined ? `${row.balance} ${row.unit}` : '—'
    const burn = row.burnPerDay !== undefined ? `${row.burnPerDay} ${row.unit}` : '—'
    const band = row.band === 'unknown' ? `unknown — ${row.reason ?? 'no reading'}` : `**${row.band}**`
    lines.push(
      `| ${row.name} | ${band} | ${row.address ? `\`${row.address}\`` : '—'} | ${balance} | ${burn} | ${fmtRunway(row)} | ${asset} | [how](${docBase}#${TOP_UP_ANCHOR[row.key]}) |`,
    )
  }
  lines.push(
    '',
    `Runway is the balance divided by the median observed daily drop over the last 14 daily readings; until 7 ` +
      `readings exist, a fixed fallback floor decides. \`warn\` is under 7 days, \`critical\` under 1 day or below ` +
      `one run's cost. This issue closes itself when no wallet is \`warn\` or \`critical\`. What it means and how to ` +
      `clear it: [${DOCS} § QA wallet balances](${docBase}#qa-wallet-balances-standing-issue).`,
    '',
    `Last checked: ${report.checkedAt} · [run](${runUrl})`,
    '',
    `<!-- ${MARKER}: ${JSON.stringify(bands)} -->`,
  )
  return lines.join('\n') + '\n'
}

function buildChangeComment(changes, runUrl) {
  const items = changes.map((c) => `- ${c.name}: ${c.from} → **${c.to}**`)
  return [`Band change ([run](${runUrl})):`, ...items].join('\n')
}

function buildCloseComment(report, runUrl) {
  const items = report.rows.map(
    (r) => `- ${r.name}: ${r.balance !== undefined ? `${r.balance} ${r.unit}` : '—'} (${r.band}${r.band === 'unknown' && r.reason ? ` — ${r.reason}` : ''})`,
  )
  return [`No wallet is \`warn\` or \`critical\` any more ([run](${runUrl})). Closing.`, '', ...items].join('\n')
}

function parseList(json) {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`unparseable \`gh issue list\` output: ${String(json).slice(0, 200)}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`\`gh issue list\` returned ${typeof parsed}, expected a JSON array`)
  return parsed
}

/**
 * The bot-owned standing issue, open or closed: exact author and exact title.
 * An open one wins (lowest number); else the lowest closed one is reopened.
 */
export function selectStandingIssue(candidates, { author = BOT_AUTHOR, title = ISSUE_TITLE } = {}) {
  const mine = candidates.filter(
    (i) => i?.author?.login === author && i?.title === title && Number.isInteger(i?.number),
  )
  const byNumber = (a, b) => a.number - b.number
  const open = mine.filter((i) => String(i.state).toUpperCase() === 'OPEN').sort(byNumber)
  if (open.length) return open[0]
  const closed = mine.filter((i) => String(i.state).toUpperCase() === 'CLOSED').sort(byNumber)
  return closed[0] ?? null
}

/** Returns { action } — 'created' | 'reopened' | 'updated' | 'closed' | 'none'. */
export function syncIssue({ gh = defaultGh, report, runUrl, repo, log = console.log }) {
  try {
    gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION, '--force'])
  } catch {
    // tolerated: the label usually exists, and a transient failure must not stop the sync
  }

  // Fail closed: a failed or unreadable lookup throws before any write.
  const list = parseList(
    gh([
      'issue', 'list', '--label', LABEL, '--state', 'all', '--author', BOT_AUTHOR, '--limit', '50',
      '--json', 'number,title,author,state,body',
    ]),
  )
  const issue = selectStandingIssue(list)
  const previous = readBands(issue?.body)
  const bands = nextBands(previous, report.rows)
  const alarm = report.rows.some((r) => ALARM.has(r.band))
  const body = buildBody(report, { runUrl, repo, bands })

  if (alarm) {
    const changes = bandChanges(previous, report.rows)
    if (!issue) {
      const created = gh(['issue', 'create', '--title', ISSUE_TITLE, '--label', LABEL, '--body-file', '-'], { input: body })
      log(`Created the standing balances issue: ${String(created).trim()}`)
      return { action: 'created' }
    }
    const n = String(issue.number)
    const wasClosed = String(issue.state).toUpperCase() === 'CLOSED'
    if (wasClosed) gh(['issue', 'reopen', n])
    gh(['issue', 'edit', n, '--body-file', '-'], { input: body })
    if (changes.length) gh(['issue', 'comment', n, '--body', buildChangeComment(changes, runUrl)])
    log(`${wasClosed ? 'Reopened' : 'Updated'} the standing balances issue #${n}${changes.length ? ' (band change)' : ''}`)
    return { action: wasClosed ? 'reopened' : 'updated', number: issue.number }
  }

  if (issue && String(issue.state).toUpperCase() === 'OPEN') {
    const n = String(issue.number)
    gh(['issue', 'edit', n, '--body-file', '-'], { input: body })
    gh(['issue', 'comment', n, '--body', buildCloseComment(report, runUrl)])
    gh(['issue', 'close', n])
    log(`Closed the standing balances issue #${n}`)
    return { action: 'closed', number: issue.number }
  }
  log('No wallet is warn or critical; no open standing issue — nothing to do')
  return { action: 'none' }
}

function main() {
  const i = process.argv.indexOf('--report')
  const path = i === -1 ? null : process.argv[i + 1]
  const runUrl = process.env.RUN_URL
  if (!path || !runUrl) {
    console.error('qa-balance-issue: --report <file> and RUN_URL are required')
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`qa-balance-issue: cannot read the report ${path}: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
  if (!Array.isArray(report?.rows)) {
    console.error('qa-balance-issue: the report carries no rows')
    process.exit(2)
  }
  try {
    const result = syncIssue({ report, runUrl, repo: process.env.GITHUB_REPOSITORY || 'd-hinders/Haven-AI' })
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`qa-balance-issue: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
