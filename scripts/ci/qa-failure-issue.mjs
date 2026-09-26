#!/usr/bin/env node
// The ONE standing `qa-failure` issue (#2767).
//
// Until #2767, `.github/workflows/qa-dev.yml` opened a new issue titled
// `qa-dev money-flow failed (<date>)` whenever NO `qa-failure` issue was open —
// the date was only in the title — so a failure after the previous issue had
// been closed filed a sibling (several on one day), and a failing day with one
// already open filed nothing. Thirteen such issues between 2026-09-01 and
// 2026-09-08, up to three a day (`gh issue list --label qa-failure --state all
// --search 'created:2026-09-01..2026-09-08'`, read 2026-09-08), each closed by
// hand once green, each a ticket the backlog counted as needed. The reopen path
// below is the half that lookup lacked. `docs-audit.yml` already does the right thing for
// the staleness report — one issue, rewritten in place — and this script gives
// the money-flow harness the same shape:
//
//   - an OPEN `qa-failure` issue exists → rewrite its body with the latest run
//     and leave one comment recording the failure in the thread's history;
//   - none open, but the standing issue exists CLOSED (it was closed on green)
//     → REOPEN it, then the same edit + comment. A second failing day updates
//     the same issue instead of opening `failed (<date+1>)`;
//   - neither → create it, once, under the fixed title.
//
// `gh` is called through an injectable runner so the test can drive this exact
// entry point with a recording stub on PATH and assert which calls were REACHED
// (ship-next § Implement step 5: presence in source is not reachability). The
// default runner is the real `gh`, which the workflow has via GH_TOKEN.
//
// Usage (from the workflow's failure step):
//   TRIGGER='...' RUN_URL='...' node scripts/ci/qa-failure-issue.mjs qa-run.attempt-*.log

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { byAttempt, scrub } from './qa-retry.mjs'

export const LABEL = 'qa-failure'
export const LABEL_COLOR = 'b60205'
export const LABEL_DESCRIPTION =
  'Automated: the scheduled/post-deploy money-flow QA run is failing (one standing issue)'

/** Fixed title — the upsert finds a closed standing issue by it. No date in it, on purpose. */
export const ISSUE_TITLE = 'qa-dev money-flow failing'

// ── Failure classification (#3337, absorbs #3339) ─────────────────────────
//
// Every issue used to carry the same sentence — "A transient testnet/RPC flake
// can be cleared by re-dispatching the workflow" — in 25 of 25 qa-failure
// issues ever filed. It steered triage toward "flake", and it made the bodies
// useless to search. The issue now records a CLASS and the SIGNATURE that
// earned it, per run and per failing leg, read from the attempt logs the
// money-flow step keeps (#3338). A class is only assigned on a signature;
// everything else is `unclassified` — never a guess.
//
//   provider      the RPC/bundler provider refused or failed the request
//   preflight     the harness stopped before any leg ran (a resource floor)
//   harness       the harness itself threw (a JS runtime error)
//   haven         Haven's API answered a 4xx to a request the leg expected to
//                 succeed (`<step> failed (4xx)` on the FAIL line itself)
//   unclassified  no signature — including the backend's masked 502 ("Could
//                 not deploy the account for this budget") and a timeout on a
//                 Haven endpoint, which hide whether a provider or Haven
//                 failed underneath
//
// The RUN takes its legs' class when they agree, `mixed` (with a count per
// class) when they do not, and `preflight` when no leg ran — so one provider
// leg among masked 502s is still visible at run level.
//
// Provider signatures, measured on 2026-09-26 over the money-flow job logs of
// the newest 40 failed qa-dev runs: `Batch of more than N requests`, `no
// available upstreams` and `flashblocks` (in 8 logs each), `Status: 429` (in 2,
// on a continuation line after
// `HTTP request failed.`); `-32016` / `over rate limit` and `RPC Request
// failed` from #2449's triage. A recurring `provider` class is a finding for
// the provider, not something a re-dispatch clears.
export const CLASSES = ['provider', 'preflight', 'harness', 'haven', 'unclassified']

const PROVIDER = [
  /-32016|over rate limit/i,
  /RPC Request failed/,
  /\bStatus: 429\b|Too Many Requests/,
  /Batch of more than \d+ requests/,
  /no available upstreams/,
  /flashblocks/,
  // #2511: a 502 whose body quotes the public endpoint is an RPC outage. Matched
  // on the RAW line; the signature is scrubbed afterwards like every other.
  /\bURL: https:\/\/sepolia\.base\.org\b/,
]
const HARNESS = [/\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/, /Cannot read properties of/]
// The harness's own Haven API client reports `<step> failed (<status>)`. A 4xx
// relayed from a MERCHANT (`(HTTP 402)` inside a hosted-tool refusal) is not Haven's.
const HAVEN = [/^• \S+ … FAIL — [^(]*\bfailed \(4\d\d\)/]

/** The first line matching one of `patterns`, with the match's index, or null. */
function firstMatch(lines, patterns) {
  for (const line of lines) {
    for (const re of patterns) {
      const m = re.exec(line)
      if (m) return { line, index: m.index }
    }
  }
  return null
}

/**
 * The evidence, not the first 200 characters: a real provider FAIL line
 * carries its signature well past character 200 ("…Sweep relay failed: could
 * not coalesce error (error={ … "no available upstreams" …"), so the excerpt
 * is taken AROUND the match and prefixed with the leg. Its edges are widened
 * to whitespace, so a URL is never cut in half before scrubbing.
 */
export function excerpt(line, index, { before = 80, after = 160 } = {}) {
  let start = Math.max(0, index - before)
  let end = Math.min(line.length, index + after)
  while (start > 0 && !/\s/.test(line[start - 1])) start--
  while (end < line.length && !/\s/.test(line[end])) end++
  const leg = /^• \S+ … FAIL — /.exec(line)?.[0] ?? ''
  const cutFront = start > leg.length // the leg prefix itself is always kept
  const head = cutFront ? `${leg || ''}… ` : ''
  const text = cutFront ? line.slice(start, end) : line.slice(0, end)
  return scrub(`${head}${text}${end < line.length ? ' …' : ''}`, 320)
}

/** Class and signature for one failing leg: its FAIL line plus continuation lines. */
export function classifyLeg(lines) {
  for (const [cls, patterns] of [['provider', PROVIDER], ['harness', HARNESS], ['haven', HAVEN]]) {
    const hit = firstMatch(lines, patterns)
    if (hit) return { class: cls, signature: excerpt(hit.line, hit.index) }
  }
  return { class: 'unclassified', signature: scrub(lines[0] ?? '', 240) }
}

/**
 * Classify one attempt's harness log. A leg's text is its `• <name> … FAIL — …`
 * line and every line after it up to the next leg or summary line, because a
 * provider signature often lands on a later line (`Status: 429`). A preflight
 * refusal is run-level: no leg ran.
 *
 * @returns {{ runClass: string, signature: string|null, legs: Array<{leg: string, class: string, signature: string}> }}
 */
export function classifyLog(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''))
  const preflightAt = lines.findIndex((l) => /^\s*✗ preflight:/.test(l))
  if (preflightAt !== -1) {
    // The resource lines that failed their floor say which one.
    const failing = lines.slice(0, preflightAt).filter((l) => /^\s+✗ /.test(l)).map((l) => l.trim())
    return { runClass: 'preflight', signature: scrub(failing[0] ?? lines[preflightAt].trim(), 200), legs: [] }
  }
  const legs = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^• (\S+) … FAIL — /.exec(lines[i])
    if (!m) continue
    const block = [lines[i]]
    for (let j = i + 1; j < lines.length && !/^(• |✓ |✗ |\| )/.test(lines[j]); j++) block.push(lines[j])
    legs.push({ leg: m[1], ...classifyLeg(block) })
  }
  const counts = new Map()
  for (const l of legs) counts.set(l.class, (counts.get(l.class) ?? 0) + 1)
  if (counts.size === 0) {
    // No failing leg (e.g. strict mode refusing skipped legs): the run-level ✗ line says why.
    const runLine = lines.find((l) => /^\s*✗ /.test(l))
    return { runClass: 'unclassified', signature: runLine ? scrub(runLine.trim(), 200) : null, legs }
  }
  if (counts.size === 1) return { runClass: legs[0].class, signature: legs[0].signature, legs }
  const summary = CLASSES.filter((c) => counts.has(c)).map((c) => `${c} ×${counts.get(c)}`).join(', ')
  return { runClass: 'mixed', signature: summary, legs }
}

/** The classification section of the body, for the final (failing) attempt. */
export function classificationSection(result) {
  if (!result) {
    return ['## Classification', '', '**Run:** `unclassified` — no harness log (the run failed before the harness ran).']
  }
  const out = ['## Classification', '', `**Run:** \`${result.runClass}\`${result.signature ? ` — ${result.signature}` : ''}`]
  if (result.legs.length > 0) {
    out.push('', '| Leg | Class | Signature |', '|---|---|---|')
    for (const l of result.legs) out.push(`| \`${l.leg}\` | \`${l.class}\` | ${l.signature.replace(/\|/g, '\\|')} |`)
  }
  return out
}

/** Read the attempt logs in attempt order; the last one is the failing attempt. */
export function readFinalAttempt(files, read = (f) => readFileSync(f, 'utf8')) {
  const ordered = byAttempt(files)
  for (let i = ordered.length - 1; i >= 0; i--) {
    try {
      return classifyLog(read(ordered[i]))
    } catch {
      // unreadable or missing (an unmatched glob): try the previous attempt
    }
  }
  return null
}

/** The body: latest failure only. History lives in the comments. */
export function buildBody({ trigger, runUrl, when, classification = null }) {
  return [
    'The deterministic money-flow QA run (`qa-dev.yml`) is failing. This is the **one standing**',
    '`qa-failure` issue (#2767): each new failure rewrites this body and adds a comment, and the',
    'issue is reopened rather than replaced when it was closed on green.',
    '',
    '## Latest failure',
    '',
    `- **Trigger:** \`${trigger}\``,
    `- **Run:** ${runUrl}`,
    `- **When:** ${when}`,
    '',
    ...classificationSection(classification),
    '',
    'This blocks the dev → main freshness gate (#578) until a green run exists.',
    'Triage it by class: `docs/operations/agent-qa.md` → Troubleshooting → *Classify the',
    'failure*. A recurring `provider` class is a finding for the provider; an `unclassified`',
    'one needs reading, and a real regression gets its own bug report under',
    '`docs/bug-reports/`. Close this issue once a run is green; the next failure reopens it.',
  ].join('\n')
}

export function buildComment({ trigger, runUrl, when, classification = null }) {
  const cls = classification ? classification.runClass : 'unclassified'
  const legs = classification?.legs?.length ? ` — legs: ${classification.legs.map((l) => `\`${l.leg}\` ${l.class}`).join(', ')}` : ''
  return `\`qa-dev\` failure at ${when} (trigger: \`${trigger}\`), class \`${cls}\`${legs} — ${runUrl}`
}

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' })

function firstNumber(json) {
  try {
    const parsed = JSON.parse(json || '[]')
    const n = Array.isArray(parsed) ? parsed[0]?.number : undefined
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Upsert the standing issue. Returns { action, number } where action is one of
 * 'updated' | 'reopened' | 'created', so the workflow log states what happened.
 */
export function upsertStandingIssue({ gh = defaultGh, trigger, runUrl, when, classification = null, log = console.log }) {
  const body = buildBody({ trigger, runUrl, when, classification })
  const comment = buildComment({ trigger, runUrl, when, classification })

  // Ensure the label exists (labels.yml owns only the surface taxonomy). A
  // failure here (already exists, transient API error) must not stop the upsert.
  try {
    gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION, '--force'])
  } catch {
    // tolerated
  }

  const open = firstNumber(
    gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '1', '--json', 'number']),
  )
  if (open !== null) {
    gh(['issue', 'edit', String(open), '--body', body])
    gh(['issue', 'comment', String(open), '--body', comment])
    log(`Updated the standing qa-failure issue #${open}`)
    return { action: 'updated', number: open }
  }

  // Closed on green? Reopen the SAME issue rather than filing a sibling.
  const closed = firstNumber(
    gh([
      'issue', 'list', '--label', LABEL, '--state', 'closed', '--limit', '1',
      '--search', `in:title "${ISSUE_TITLE}"`, '--json', 'number',
    ]),
  )
  if (closed !== null) {
    gh(['issue', 'reopen', String(closed)])
    gh(['issue', 'edit', String(closed), '--body', body])
    gh(['issue', 'comment', String(closed), '--body', comment])
    log(`Reopened the standing qa-failure issue #${closed}`)
    return { action: 'reopened', number: closed }
  }

  const created = gh(['issue', 'create', '--label', LABEL, '--title', ISSUE_TITLE, '--body', body])
  log(`Created the standing qa-failure issue: ${String(created).trim()}`)
  return { action: 'created', number: null }
}

function main() {
  const trigger = process.env.TRIGGER
  const runUrl = process.env.RUN_URL
  if (!trigger || !runUrl) {
    console.error('qa-failure-issue: TRIGGER and RUN_URL must be set')
    process.exit(2)
  }
  const when = process.env.WHEN || new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  // Attempt logs as arguments (the workflow passes qa-run.attempt-*.log).
  const classification = readFinalAttempt(process.argv.slice(2))
  const result = upsertStandingIssue({ trigger, runUrl, when, classification })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
