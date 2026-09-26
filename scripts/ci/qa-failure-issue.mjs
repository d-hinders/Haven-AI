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
import { byAttempt, scrub, scrubFull } from './qa-retry.mjs'

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
//   harness       the harness itself threw (a JS runtime error's message, or
//                 the run-level `✗ harness crashed:` line)
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
// available upstreams` and `flashblocks` (in 8 logs each), `Status: 429` (in 2:
// on a continuation line after `HTTP request failed.`, or JSON-escaped as
// `…failed.\\n\\nStatus: 429` inside a relayed 502 body); `-32016` / `over rate limit` and `RPC Request
// failed` from #2449's triage. A recurring `provider` class is a finding for
// the provider, not something a re-dispatch clears.
export const CLASSES = ['provider', 'preflight', 'harness', 'haven', 'unclassified']

const PROVIDER = [
  /-32016|over rate limit/i,
  /RPC Request failed/,
  // No leading \b: a relayed body carries these JSON-escaped (`…failed.\\n\\nStatus: 429`).
  /Status: 429\b|Too Many Requests/,
  /Batch of more than \d+ requests/,
  /no available upstreams/,
  /flashblocks/,
  // #2511: a 502 whose body quotes the public endpoint is an RPC outage. Matched
  // on the RAW line; the signature is scrubbed afterwards like every other.
  /URL: https:\/\/sepolia\.base\.org\b/,
  // dRPC's free-plan limits (code 30 timeouts, code 31 batches): seen in 4 runs
  // of the 2026-09-26 sample and otherwise left unclassified.
  /on the free plan|upgrade to paid plan/,
]
// The harness prints `err.message`, never the error's name (thrown-error-detail.ts,
// run.ts), so match the MESSAGE shapes a JS runtime error has — a quoted
// "TypeError" in a relayed body is someone else's error.
const HARNESS = [/\bis not a function\b|\bis not defined\b|Cannot (read|set) properties of (undefined|null)/]
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
 * is taken AROUND the match and prefixed with the leg.
 *
 * Scrub BEFORE cutting: a cut can fall between a label and its value
 * (`Bearer <v>`, `"apiKey": "<v>"`), and a bare value is not recognisable as a
 * key. So a bounded window (±1000 characters; the scrub regexes backtrack on
 * pathological input) is scrubbed whole with a marker at the match, and the
 * excerpt is cut from the scrubbed text. Where the window itself cuts the
 * line, its first and last three whitespace tokens are dropped first: a label
 * and its value span at most three (`password = <v>`, `"apiKey": "<v>"`,
 * `Bearer <v>`), and scrubbing can shrink the text enough (URLs → `<url>`)
 * for the excerpt to reach the window's edge.
 */
export function excerpt(line, index, { before = 80, after = 160 } = {}) {
  const MARK = '\u0001'
  const a = Math.max(0, index - 1000)
  const b = Math.min(line.length, index + 1000)
  let raw = `${line.slice(a, index)}${MARK}${line.slice(index, b)}`
  const trim = (re) => {
    const m = re.exec(raw)
    if (m && !m[0].includes(MARK)) raw = raw.slice(0, m.index) + raw.slice(m.index + m[0].length)
  }
  if (a > 0) trim(/^\S*(\s+\S+){0,2}\s+/)
  if (b < line.length) trim(/\s+(\S+\s+){0,2}\S*$/)
  const scrubbed = scrubFull(raw)
  const at = Math.max(0, scrubbed.indexOf(MARK)) // a marker swallowed into a <url> falls back to the start
  const text = scrubbed.replace(MARK, '')
  // Already scrubbed, so the cut needs no widening: it can no longer split a secret.
  const start = Math.max(0, at - before)
  const end = Math.min(text.length, at + after)
  const leg = /^• \S+ … FAIL — /.exec(line)?.[0] ?? ''
  const cutFront = a > 0 || start > leg.length // the leg prefix itself is always kept
  const out = `${cutFront ? `${leg}… ` : ''}${text.slice(cutFront ? start : 0, end)}${end < text.length || b < line.length ? ' …' : ''}`
  return out.length > 320 ? `${out.slice(0, 319)}…` : out
}

/**
 * Neutralise `#123` so a signature quoting an issue does not create a
 * cross-reference event from the public qa-failure issue.
 */
function noIssueRefs(text) {
  return text.replace(/#(\d)/g, '#\u2060$1')
}

/** Class and signature for one failing leg: its FAIL line plus continuation lines. */
export function classifyLeg(lines) {
  for (const [cls, patterns] of [['provider', PROVIDER], ['harness', HARNESS], ['haven', HAVEN]]) {
    const hit = firstMatch(lines, patterns)
    if (!hit) continue
    const found = excerpt(hit.line, hit.index)
    // A hit on a continuation line (`Status: 429`) keeps the step it belongs to.
    const signature = hit.line === lines[0] ? found : `${scrub(lines[0] ?? '', 120)} → ${found}`
    return { class: cls, signature: noIssueRefs(signature) }
  }
  return { class: 'unclassified', signature: noIssueRefs(scrub(lines[0] ?? '', 240)) }
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
    return { runClass: 'preflight', signature: noIssueRefs(scrub(failing[0] ?? lines[preflightAt].trim(), 200)), legs: [] }
  }
  // The harness itself crashed: run-level, no legs.
  const crashed = lines.find((l) => /^\s*✗ harness crashed:/.test(l))
  if (crashed) {
    return { runClass: 'harness', signature: noIssueRefs(scrub(crashed.trim(), 240)), legs: [] }
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
    // No failing leg: strict mode refusing skipped legs, or Coverage completeness
    // finding the green-with-skips marker. The run-level line says why.
    const runLine = lines.find((l) => /^\s*✗ /.test(l)) ?? lines.find((l) => /green-with-skips:/.test(l))
    return { runClass: 'unclassified', signature: runLine ? noIssueRefs(scrub(runLine.trim(), 200)) : null, legs }
  }
  if (counts.size === 1) return { runClass: legs[0].class, signature: legs[0].signature, legs }
  const summary = CLASSES.filter((c) => counts.has(c)).map((c) => `${c} ×${counts.get(c)}`).join(', ')
  return { runClass: 'mixed', signature: summary, legs }
}

/** Signatures are plain text: escape what GitHub would render as HTML (`<url>` would vanish). */
export function md(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One earlier attempt, with the legs of any class that is not `unclassified` named. */
function earlierLine(e) {
  const named = (e.legs ?? []).filter((l) => l.class !== 'unclassified').map((l) => `\`${l.leg}\` ${l.class}`)
  return `Earlier attempt ${e.attempt}: \`${e.runClass}\`${e.signature ? ` — ${md(e.signature)}` : ''}${named.length ? ` (${named.join(', ')})` : ''}`
}

/** The classification section of the body, for the final (failing) attempt. */
export function classificationSection(result) {
  if (!result) {
    return ['## Classification', '', '**Run:** `unclassified` — no harness log (the run failed before the harness ran).']
  }
  const out = ['## Classification', '', `**Run:** \`${result.runClass}\`${result.signature ? ` — ${md(result.signature)}` : ''}`]
  if (result.legs.length > 0) {
    out.push('', '| Leg | Class | Signature |', '|---|---|---|')
    for (const l of result.legs) out.push(`| \`${l.leg}\` | \`${l.class}\` | ${md(l.signature).replace(/\|/g, '\\|')} |`)
  }
  for (const e of result.earlier ?? []) out.push('', earlierLine(e))
  return out
}

/**
 * Read the attempt logs in attempt order; the last readable one is the failing
 * attempt. The earlier attempts' run classes ride along as `earlier`, because
 * on a red run nothing else reports them (#3338's summary only runs on a pass)
 * and an earlier attempt's provider leg is exactly the evidence this exists for.
 */
export function readFinalAttempt(files, read = (f) => readFileSync(f, 'utf8')) {
  const results = []
  for (const f of byAttempt(files)) {
    try {
      const n = Number(/attempt-(\d+)\.log$/.exec(f)?.[1] ?? results.length + 1)
      results.push({ attempt: n, ...classifyLog(read(f)) })
    } catch {
      // unreadable or missing (an unmatched glob)
    }
  }
  if (results.length === 0) return null
  const final = results.at(-1)
  return { ...final, earlier: results.slice(0, -1).map(({ attempt, runClass, signature, legs }) => ({ attempt, runClass, signature, legs })) }
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
  // The body is rewritten per failure; the comment is the thread's history, so
  // earlier attempts' classes are recorded here too.
  const earlier = (classification?.earlier ?? []).map((e) => `attempt ${e.attempt} \`${e.runClass}\``)
  return `\`qa-dev\` failure at ${when} (trigger: \`${trigger}\`), class \`${cls}\`${legs}${earlier.length ? `; earlier: ${earlier.join(', ')}` : ''} — ${runUrl}`
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
