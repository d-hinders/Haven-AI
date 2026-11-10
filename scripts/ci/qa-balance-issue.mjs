#!/usr/bin/env node
// The ONE standing `QA wallet balances low` issue (#3631).
//
// Money-flow QA failed in preflight for ~3.5 days (2026-10-01 → 10-05) because
// the delegation treasury ran dry with no warning. `qa-balances.yml` runs
// `npm run qa:balances -w packages/qa-agent` once a day; this script turns its
// report into one standing issue:
//
//   - any wallet, or the QA budget grant, `warn` or `critical` → rewrite the
//     body, and reopen the issue or create it once;
//   - a comment ONLY when a band changes (ok→warn, warn→critical,
//     critical→warn, …) — two runs with the same bands edit the body silently;
//   - nothing `warn` or `critical` → if the issue is open, write the final
//     state, comment it, and close it;
//   - `unknown` (config missing or a failed read) never opens the issue and
//     never blocks a close; it is shown in the body while the issue is open.
//
// The QA budget grant (#4666) is not a wallet: it has no balance, burn, runway
// or top-up, so it rides as `report.budgetGrant` and renders outside the wallet
// table. It carries `key`, `name`, `band` and `reason` like a row, so the alarm
// and band-memory logic below read both through `bandRows`.
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
import { BOT_AUTHOR } from './standing-issue-upsert.mjs'
import { scrubFull } from './qa-retry.mjs'

export const ISSUE_TITLE = 'QA wallet balances low'
export const LABEL = 'qa-funding'
const LABEL_COLOR = 'd93f0b'
const LABEL_DESCRIPTION = 'A QA wallet is within 7 days of running dry, or the QA budget within 30 of ending'
const MARKER = 'qa-balance-bands'
const WALLETS = ['treasury', 'merchant', 'relayer', 'eval-hermes', 'eval-claude']
/** The grant's key in the band marker; `BUDGET_GRANT_KEY` in qa-agent's balances.ts. */
const GRANT_KEY = 'qa-budget'
const BAND_KEYS = [...WALLETS, GRANT_KEY]
const ALARM = new Set(['warn', 'critical'])

const DOCS = 'docs/operations/agent-qa.md'
/** One top-up heading per wallet in agent-qa.md § QA wallet balances. */
export const TOP_UP_ANCHOR = {
  treasury: 'top-up-the-delegation-treasury',
  merchant: 'top-up-the-demo-merchant-settlement-wallet',
  relayer: 'top-up-the-dev-relayer',
  'eval-hermes': 'top-up-the-eval-agent-hermes-lane',
  'eval-claude': 'top-up-the-eval-agent-claude-code-lane',
}
/** The grant's two headings in agent-qa.md § Troubleshooting. */
export const GRANT_ANCHOR = {
  ended: 'the-qa-budget-ended',
  renew: 'renew-the-qa-budget-before-it-ends',
}

/** Everything that carries a band: the wallet rows, plus the grant when the report has one. */
export function bandRows(report) {
  return [...report.rows, ...(report.budgetGrant ? [report.budgetGrant] : [])]
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
 * The bands to remember: today's, except that an `unknown` reading keeps its
 * last KNOWN band — a failed read carries no information about the wallet or
 * the grant. A marker written before the grant existed reads as `ok`.
 */
export function nextBands(previous, rows) {
  const out = {}
  for (const key of BAND_KEYS) {
    const row = rows.find((r) => r.key === key)
    out[key] = row && row.band !== 'unknown' ? row.band : (previous[key] ?? 'ok')
  }
  return out
}

/** Whatever carries a band (wallets, the grant) whose known band changed since the last run. */
export function bandChanges(previous, rows) {
  const changes = []
  for (const row of rows) {
    if (row.band === 'unknown') continue
    const before = previous[row.key] ?? 'ok'
    if (before !== row.band) changes.push({ key: row.key, name: row.name, from: before, to: row.band })
  }
  return changes
}

/**
 * A row's reason, safe for a PUBLIC issue: scrubbed again here although the
 * harness already writes a safe one (balances.ts `safeReason`) — a provider
 * URL carries its API key, and this repo is public (#3631 review H1).
 */
export function publicReason(reason) {
  const s = scrubFull(String(reason ?? ''))
  return s.length > 160 ? `${s.slice(0, 159)}…` : s
}

function fmtRunway(row) {
  if (row.basis === 'fallback') return 'fallback floor'
  if (row.runwayDays !== undefined) return `${row.runwayDays} days`
  return row.basis === 'observed' ? 'no observed burn' : '—'
}

/** Format an atomic amount by unit: the report's rows and top-ups carry theirs. */
const UNIT_DECIMALS = { USDC: 6, ETH: 18 }
function fmtAmount(atomic, unit) {
  const decimals = UNIT_DECIMALS[unit] ?? 18
  try {
    const s = BigInt(atomic ?? '0').toString().padStart(decimals + 1, '0')
    const whole = s.slice(0, -decimals)
    const fraction = s.slice(-decimals).replace(/0+$/, '')
    return fraction ? `${whole}.${fraction}` : whole
  } catch {
    return '0'
  }
}

/** The wallets the harness may top up from the faucet, in the order it does (#3836, #3997). */
const TOP_UP_WALLETS = ['merchant', 'eval-hermes', 'eval-claude', 'relayer']
const TOP_UP_NAMES = {
  merchant: 'Demo-merchant settlement wallet',
  relayer: 'Dev backend relayer',
  'eval-hermes': 'Eval agent (Hermes lane)',
  'eval-claude': 'Eval agent (Claude Code lane)',
}

/**
 * Why a top-up was skipped, when the harness gave no reason. Every skip has
 * its own wording: rendering a skip with the attempted-claims line would show
 * it as a failed attempt.
 */
const SKIP_TEXT = {
  'not-needed': 'not needed',
  unreadable: 'the wallet balance could not be read',
  'wrong-chain': 'the wallet is not on Base Sepolia',
  'invalid-address': 'the wallet address is not an address',
}

/** One line for one wallet's faucet outcome, naming the wallet. */
export function topUpSummary(wallet, topUp) {
  if (!topUp) return null
  const head = `${TOP_UP_NAMES[wallet] ?? wallet} testnet faucet top-up`
  if (topUp.stopReason === 'missing-credentials') return `${head}: skipped: no CDP credentials.`
  if (topUp.status === 'skipped') {
    const why = topUp.reason ? publicReason(topUp.reason) : (SKIP_TEXT[topUp.stopReason] ?? `\`${topUp.stopReason}\``)
    return `${head}: not requested — ${why}.`
  }
  const reason = topUp.reason ? ` — ${publicReason(topUp.reason)}` : ''
  const unit = topUp.unit ?? 'ETH'
  return `${head}: ${Number(topUp.claimsMade) || 0} accepted claim(s), ${fmtAmount(topUp.amountReceivedAtomic, unit)} ${unit} received; stop: \`${topUp.stopReason}\`${reason}.`
}

/** `YYYY-MM-DD` (UTC) from an ISO timestamp; the wording the refusals use for an ended budget. */
const utcDate = (iso) => String(iso ?? '').slice(0, 10)

/** One line for the grant's state, in the body and the close comment. No links. */
export function grantSummary(grant) {
  const name = grant?.name ?? 'QA budget grant (USDC)'
  if (!grant) return `${name}: no reading — this run's report carries no grant.`
  if (grant.band === 'unknown') return `${name}: unknown — ${grant.reason ? publicReason(grant.reason) : 'no reading'}.`
  if (grant.noLiveBudget) {
    const ended = grant.endsAt ? `; the latest ended budget, of any token or pin, ended on ${utcDate(grant.endsAt)} (UTC)` : ''
    return `${name}: **${grant.band}** — no live open USDC budget${ended}.`
  }
  return `${name}: **${grant.band}** — ends on ${utcDate(grant.endsAt)} (UTC), in ${grant.daysLeft} days.`
}

/** The lead paragraph when the grant is what raised the issue. */
function grantLead(grant, docBase) {
  const ended = `[The QA budget ended](${docBase}#${GRANT_ANCHOR.ended})`
  if (grant.noLiveBudget) {
    return (
      `**The QA identity has no live open USDC budget.** Money-flow QA's spending legs that need it fail until a person ` +
      `with the QA owner key sets a new one: ${ended}.`
    )
  }
  return (
    `**The QA budget grant ends on ${utcDate(grant.endsAt)} (UTC), in ${grant.daysLeft} days.** When it ends, every ` +
    `spending leg of money-flow QA goes red at once, and only a person with the QA owner key can renew it: ` +
    `[renew it before it ends](${docBase}#${GRANT_ANCHOR.renew}), or see ${ended}.`
  )
}

/** The issue body: the wallet table, the grant, the top-up links, the time and the run. */
export function buildBody(report, { runUrl, repo, bands }) {
  const docBase = `https://github.com/${repo}/blob/dev/${DOCS}`
  const walletAlarm = report.rows.some((r) => ALARM.has(r.band))
  const grantAlarm = ALARM.has(report.budgetGrant?.band)
  const lines = [
    ...(grantAlarm ? [grantLead(report.budgetGrant, docBase), ''] : []),
    ...(walletAlarm
      ? [
          `One or more wallets the QA flows depend on has **less than 7 days of runway** (or cannot cover one run). ` +
            `Money-flow QA fails in preflight once a core wallet (treasury, merchant, relayer) runs dry — top it up before then. ` +
            `The eval-agent rows are reported here so a low eval balance is found before a failed night, ` +
            `not by one: an eval run fails long before preflight does.`,
          '',
        ]
      : []),
    // The body is rewritten once more on a close, and neither lead is true then.
    ...(walletAlarm || grantAlarm ? [] : ['Nothing is known to be `warn` or `critical` as of the last check.', '']),
    '| Wallet | Band | Address | Balance | Burn / day | Runway | Asset | Top up |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const row of report.rows) {
    const asset = row.token ? `${row.unit} \`${row.token}\`` : 'native ETH'
    const balance = row.balance !== undefined ? `${row.balance} ${row.unit}` : '—'
    const burn = row.burnPerDay !== undefined ? `${row.burnPerDay} ${row.unit}` : '—'
    const band = row.band === 'unknown' ? `unknown — ${row.reason ? publicReason(row.reason) : 'no reading'}` : `**${row.band}**`
    lines.push(
      `| ${row.name} | ${band} | ${row.address ? `\`${row.address}\`` : '—'} | ${balance} | ${burn} | ${fmtRunway(row)} | ${asset} | [how](${docBase}#${TOP_UP_ANCHOR[row.key]}) |`,
    )
  }
  lines.push('', grantSummary(report.budgetGrant))
  const topUps = TOP_UP_WALLETS.map((wallet) => topUpSummary(wallet, report.topUps?.[wallet])).filter(Boolean)
  if (topUps.length > 0) lines.push('', ...topUps)
  lines.push(
    '',
    `Runway is the balance divided by the median observed daily drop over the last 14 daily readings; until 7 ` +
      `readings exist, a fixed fallback floor decides. \`warn\` is under 7 days, \`critical\` under 1 day or below ` +
      `one run's cost. The QA budget grant is \`warn\` at 30 days or fewer before it ends, and \`critical\` at 7 days ` +
      `or fewer or with no live budget. This issue closes itself when nothing is \`warn\` or \`critical\`. What it ` +
      `means and how to clear it: [${DOCS} § QA wallet balances](${docBase}#qa-wallet-balances-standing-issue).`,
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
    (r) => `- ${r.name}: ${r.balance !== undefined ? `${r.balance} ${r.unit}` : '—'} (${r.band}${r.band === 'unknown' && r.reason ? ` — ${publicReason(r.reason)}` : ''})`,
  )
  const unknown = bandRows(report).some((r) => r.band === 'unknown') || !report.budgetGrant
  const head = unknown
    ? `Nothing is known to be \`warn\` or \`critical\` ([run](${runUrl})); anything that could not be read is listed as unknown. Closing.`
    : `Nothing is \`warn\` or \`critical\` any more ([run](${runUrl})). Closing.`
  return [head, '', ...items, `- ${grantSummary(report.budgetGrant)}`].join('\n')
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
  const rows = bandRows(report)
  const bands = nextBands(previous, rows)
  const alarm = rows.some((r) => ALARM.has(r.band))
  const body = buildBody(report, { runUrl, repo, bands })

  if (alarm) {
    const changes = bandChanges(previous, rows)
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
  log('Nothing is warn or critical; no open standing issue — nothing to do')
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

// True only when this file is the process's entry point, so importing it (a
// self-test, a build config) never runs the CLI. Both paths are resolved
// first: Node resolves symlinks for a module's own URL and leaves
// `process.argv[1]` as typed, so an unresolved comparison answered "not the
// entry point" through any symlink, and the script exited 0 without running
// (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main()
}
