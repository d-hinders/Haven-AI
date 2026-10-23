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
// And the half the upsert lacked (#4069): `--green` CLOSES it. The money-flow
// job calls it only on a full-coverage green run, so the issue no longer waits
// for an owner to close it by hand (16 hand closes of #2769 before this). The
// close is a write the upsert never had to guard, so it selects the way
// `qa-balance-issue.mjs` does — bot author + exact title, never a human issue
// that merely carries the label — and fails closed: an unreadable lookup
// throws before any write.
//
// And the half nobody could read off the issue (#4236): each failure's body and
// comment name the last-green → first-red WINDOW and the PRs in it, and the
// opening comment of an episode @-mentions a single PR's author under a gate
// (see § The last-green → first-red window, below).
//
// `gh` is called through an injectable runner so the test can drive this exact
// entry point with a recording stub on PATH and assert which calls were REACHED
// (ship-next § Implement step 5: presence in source is not reachability). The
// default runner is the real `gh`, which the workflow has via GH_TOKEN.
//
// Usage (from the workflow's failure and green steps):
//   node scripts/ci/qa-failure-issue.mjs qa-run.attempt-*.log   # failure: upsert
//   node scripts/ci/qa-failure-issue.mjs --green                 # full-coverage green: close
// TRIGGER and RUN_URL are built from the Actions env (`triggerLine`, `runUrlFromEnv`)
// unless set explicitly, so the two steps share one trigger construction.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { byAttempt, scrubFull } from './qa-retry.mjs'
import { BOT_AUTHOR } from './standing-issue-upsert.mjs'
// `evaluate` is aliased: qa-freshness.mjs exports a different `evaluate` (its
// promotion verdict), and a reader of this file should never have to guess which.
import { evaluate as evaluateJobWindow, prOf } from './dev-push-health.mjs'
import {
  BRANCH_LABELLED_EVENTS,
  EVIDENCE_EVENTS,
  MONEY_FLOW_JOB,
  jobsQueryArgs,
  loadMoneyPathGlobs,
  moneyFlowJobConclusion,
  moneyPathFiles,
  preFilterHarnessCandidates,
  selectGreenRun,
} from './qa-freshness.mjs'

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
//   rate_limit    Haven's OWN per-agent x402 hourly cap (#3541) — the
//                 harness out-ran a limiter working as designed, by its own
//                 volume (back-to-back hand dispatches on one QA identity)
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
export const CLASSES = ['provider', 'preflight', 'harness', 'rate_limit', 'haven', 'unclassified']

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
  // #3391: this signature only survives into real logs because the transport
  // scrub no longer redacts the HOST (`secretSegments`, rpc-transport.ts) —
  // the backend suite's no-network test (rpc-transport-key-scrub.test.ts →
  // `classifies provider after the real scrub`) feeds a REAL scrubbed viem
  // HttpRequestError through classifyLog, so a scrub that redacts the host
  // again or a regex narrowed away from the raw `URL:` shape reddens one of
  // the two suites. Keep the fixture in lockstep with that test.
  /URL: https:\/\/sepolia\.base\.org\b/,
  // dRPC's free-plan limits (code 30 timeouts, code 31 batches): seen in 4 runs
  // of the 2026-09-26 sample and otherwise left unclassified.
  /on the free plan|upgrade to paid plan/,
]
// The harness prints `err.message`, never the error's name (thrown-error-detail.ts,
// run.ts), so match the MESSAGE shapes a JS runtime error has — a quoted
// "TypeError" in a relayed body is someone else's error.
const HARNESS = [/\bis not a function\b|\bis not defined\b|Cannot (read|set) properties of (undefined|null)/]
// #3541: the body of the x402 cap (`agentHourlyX402CapExceeded`,
// modules/x402/delegation-authorize.ts), however the leg relays it — direct,
// SDK or hosted MCP. Only that body: Haven's other limiters are deliberately
// NOT matched. `moneyPathRateLimit`'s 429 (`Rate limit exceeded, retry in 1
// minute`) and a `RelayerBudgetExceededError` land in `haven` when relayed as
// `failed (429)`, and in `unclassified` when the status is lost (SDK, sweep
// scenario) — pinned by test. A loose /Rate limit exceeded/ would pull the
// first one in here.
const RATE_LIMIT = [/Rate limit exceeded: max \d+ x402 payments per hour/]
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
 * pathological input) is scrubbed WHOLE, with a marker at the match, and only
 * then trimmed and cut. Where the window itself cuts the line, the scrubbed
 * text's first and last three whitespace tokens are dropped, one at a time,
 * never past the marker: a label/value pair the window's edge splits lies
 * within those three tokens (`password = <v>`, `Authorization : Bearer <v>`),
 * and an intact pair is already `<redacted>`. One theoretical gap remains
 * (round 4 review): the token holding the match is never dropped, so a label
 * cut at the window edge whose value shares that whitespace-free token stays
 * bare — which needs ~900 characters of URLs with no whitespace between the
 * value and the match. The harness's error details are compact and capped
 * (thrownErrorDetail: 200 per value, 700 total), so it cannot print that.
 */
export function excerpt(line, index, { before = 80, after = 160 } = {}) {
  const MARK = '\u0001'
  const a = Math.max(0, index - 1000)
  const b = Math.min(line.length, index + 1000)
  let scrubbed = scrubFull(`${line.slice(a, index)}${MARK}${line.slice(index, b)}`)
  if (a > 0) scrubbed = dropEdgeTokens(scrubbed, 'front', MARK)
  if (b < line.length) scrubbed = dropEdgeTokens(scrubbed, 'back', MARK)
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

/** Drop up to three whitespace tokens from one end of `text`, one at a time, never one holding `stop`. */
export function dropEdgeTokens(text, end, stop = null) {
  let t = text
  for (let n = 0; n < 3; n++) {
    const m = end === 'front' ? /^\S*\s+/.exec(t) : /\s+\S*$/.exec(t)
    if (!m || (stop && m[0].includes(stop))) break
    t = end === 'front' ? t.slice(m[0].length) : t.slice(0, t.length - m[0].length)
  }
  return t
}

/**
 * `scrub` for a whole line: `qa-retry`'s `scrub` slices to 1024 characters
 * BEFORE scrubbing, which can cut a labelled value below the 16 characters
 * that mark it as a key and publish its first part. Here an over-long line is
 * cut, its last three tokens dropped, then scrubbed whole and capped.
 */
export function scrubLine(text, max = 240) {
  let t = String(text ?? '')
  if (t.length > 2000) t = dropEdgeTokens(t.slice(0, 2000), 'back')
  const s = scrubFull(t)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Class and signature for one failing leg: its FAIL line plus continuation lines. */
export function classifyLeg(lines) {
  // rate_limit first: its body is specific, and its `failed (429)` phrasing
  // would otherwise class it `haven` (a product signal it is not).
  for (const [cls, patterns] of [['rate_limit', RATE_LIMIT], ['provider', PROVIDER], ['harness', HARNESS], ['haven', HAVEN]]) {
    const hit = firstMatch(lines, patterns)
    if (!hit) continue
    const found = excerpt(hit.line, hit.index)
    // A hit on a continuation line (`Status: 429`) keeps the step it belongs to.
    const signature = hit.line === lines[0] ? found : `${scrubLine(lines[0] ?? '', 120)} → ${found}`
    return { class: cls, signature: noIssueRefs(signature) }
  }
  return { class: 'unclassified', signature: noIssueRefs(scrubLine(lines[0] ?? '', 240)) }
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
    return { runClass: 'preflight', signature: noIssueRefs(scrubLine(failing[0] ?? lines[preflightAt].trim(), 200)), legs: [] }
  }
  // The harness itself crashed: run-level, no legs.
  const crashed = lines.find((l) => /^\s*✗ harness crashed:/.test(l))
  if (crashed) {
    return { runClass: 'harness', signature: noIssueRefs(scrubLine(crashed.trim(), 240)), legs: [] }
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
    return { runClass: 'unclassified', signature: runLine ? noIssueRefs(scrubLine(runLine.trim(), 200)) : null, legs }
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
export function buildBody({ trigger, runUrl, when, classification = null, window = null, mention = false }) {
  const line = windowLine(window, { mention })
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
    ...(line ? [`- **Window:** ${line.replace(/^window: /, '')}`] : []),
    '',
    ...classificationSection(classification),
    '',
    'This blocks the dev → main freshness gate (#578) until a green run exists.',
    'Triage it by class: `docs/operations/agent-qa.md` → Troubleshooting → *Classify the',
    'failure*. A recurring `provider` class is a finding for the provider; `rate_limit` is the',
    'harness out-running Haven\'s own x402 cap (space out hand dispatches), never a product',
    'defect; an `unclassified` one needs reading, and a real regression gets its own bug report under',
    '`docs/bug-reports/`. This issue closes itself on the next full-coverage green run (#4069);',
    'the next failure reopens it.',
  ].join('\n')
}

export function buildComment({ trigger, runUrl, when, classification = null, window = null, mention = false }) {
  const line = windowLine(window, { mention })
  const cls = classification ? classification.runClass : 'unclassified'
  const legs = classification?.legs?.length ? ` — legs: ${classification.legs.map((l) => `\`${l.leg}\` ${l.class}`).join(', ')}` : ''
  // The body is rewritten per failure; the comment is the thread's history, so
  // earlier attempts' classes are recorded here too.
  const earlier = (classification?.earlier ?? []).map((e) => `attempt ${e.attempt} \`${e.runClass}\``)
  return `\`qa-dev\` failure at ${when} (trigger: \`${trigger}\`), class \`${cls}\`${legs}${earlier.length ? `; earlier: ${earlier.join(', ')}` : ''} — ${runUrl}${line ? `\n\n${line}` : ''}`
}

/**
 * The trigger line (#2271): a deployment_status run names the Railway
 * deployment (id, creator, deployed SHA) — GitHub-authored provenance a curl
 * cannot produce; a workflow_dispatch names the actor who started it. Built
 * here, from the job's env, so the failure and green steps share it.
 */
export function triggerLine(env = process.env) {
  switch (env.GITHUB_EVENT_NAME) {
    case 'deployment_status':
      return `deployment_status — Railway deployment ${env.DEPLOYMENT_ID ?? ''} of ${env.DEPLOYMENT_SHA ?? ''} to '${env.DEPLOYMENT_ENV ?? ''}', created by ${env.DEPLOYMENT_CREATOR ?? ''}`
    case 'workflow_dispatch':
      return `workflow_dispatch — started by ${env.GITHUB_ACTOR ?? ''}`
    default:
      return env.GITHUB_EVENT_NAME || ''
  }
}

/** This run's URL, from the Actions env; '' outside Actions. */
export function runUrlFromEnv(env = process.env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : ''
}

// ── The last-green → first-red window (#4236) ─────────────────────────────
//
// The comment that lands on every failure used to name the trigger and the
// class, and no suspect: on 2026-10-20 the money-flow job went red at
// `aa818795d` (#4144, one PR after the green at `84f347f0a`) and the first
// issue attributing it was filed 23.7 h after #2769 reopened. The bot now
// names the window itself:
//
//   - LAST GREEN is the newest qa-dev run, created before this one, that
//     `selectGreenRun` admits: an evidence event, a branch-labelled event on
//     `dev`, a commit in this run's history, and a `money-flow` JOB success —
//     never a run-level `success`, which a gate-skipped run also has. Rows
//     `preFilterHarnessCandidates` drops are never read. Ancestry comes from
//     the compare API: the job's checkout is depth 1, so `findGreenRun`'s
//     `git merge-base` would refuse every row.
//   - FIRST RED is the oldest run after it whose `money-flow` job failed (rules
//     1-3 passed too), or this run. `dev-push-health.mjs`'s `evaluate` derives
//     both: only a DECISIVE conclusion moves the state, so `skipped` and
//     `cancelled` never count. This run is red by construction: the step runs
//     inside the failing `money-flow` job, whose conclusion is not final yet.
//   - The PRs are the FIRST-PARENT chain from first red back to last green.
//     The compare API lists every commit in the range, a merged branch's
//     own commits included, so the chain is walked through `parents[0]`; a
//     status other than `ahead`, or a chain that leaves the compare page, is
//     "unavailable". One `commits/{sha}` read per PR says whether it touches a
//     money-path file (`moneyPathFiles`) or the harness (`packages/qa-agent/`).
//
// Recomputed on every failure, never read back from the issue body. Every
// `gh` call carries a time bound and the lookup has a total budget (calls and
// time): the money-flow job has no `timeout-minutes` and holds the
// `qa-dev-money-flow` concurrency group. Any failed or timed-out read makes
// the window "unavailable"; nothing here can stop the upsert below.

/** The harness package: a PR touching it can redden the run without touching Haven. */
export const HARNESS_PREFIX = 'packages/qa-agent/'

/**
 * Run classes whose failure may be a code change (captain decision on #4236,
 * 2026-10-21). `provider` and `rate_limit` are outages or the harness's own
 * volume and `preflight` is a resource floor: none is the PR author's to fix,
 * so they never @-mention. `mixed` is not here either.
 */
export const MENTION_CLASSES = new Set(['haven', 'harness', 'unclassified'])

/** qa-dev runs one lookup lists. 150 were created in the first 28 h of the 2026-10-20 episode. */
export const WINDOW_RUN_LIMIT = 300

/** Time bound on each `gh` call of the window lookup. */
export const WINDOW_CALL_TIMEOUT_MS = 30_000

/** Total budget of one window lookup, in calls and in time. Past it the window is "open-ended". */
export const WINDOW_CALL_BUDGET = 80
export const WINDOW_BUDGET_MS = 120_000

class LookupBudgetSpent extends Error {
  constructor(kind, used, ms) {
    super(kind === 'calls' ? `lookup budget spent (${used} calls)` : `lookup time budget spent (${Math.round(ms / 1000)} s, ${used} calls made)`)
    this.kind = kind
    this.used = used
    this.ms = ms
  }
}

const sha9 = (sha) => String(sha ?? '').slice(0, 9)

/**
 * Whether THIS run tested dev: `selectGreenRun`'s event and branch rules,
 * applied to the red side, plus the green step's own rule (a dispatch with a
 * `haven_api_url` override tested another backend). From the env alone, so a
 * run that is not dev's spends no `gh` call. Returns the reason it is not, or null.
 */
export function notDevReason(env = process.env) {
  const event = env.GITHUB_EVENT_NAME ?? ''
  if (!EVIDENCE_EVENTS.includes(event)) return `event '${event || 'missing'}'`
  if (env.QA_HAVEN_API_URL_OVERRIDE) return 'dispatch with a haven_api_url override'
  if (BRANCH_LABELLED_EVENTS.includes(event) && env.GITHUB_REF !== 'refs/heads/dev') {
    return `${event} from '${env.GITHUB_REF ?? ''}'`
  }
  return null
}

/** `gh` with a per-call time bound, for the window lookup only. */
const windowGh = (args, timeout) =>
  execFileSync('gh', args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

/** A `gh` runner that spends from one budget; every call gets min(per-call bound, time left). */
function budgeted(gh, { calls, ms, callMs, now }) {
  const deadline = now() + ms
  let used = 0
  const call = (args) => {
    const left = deadline - now()
    if (used >= calls) throw new LookupBudgetSpent('calls', used, ms)
    if (left <= 0) throw new LookupBudgetSpent('time', used, ms)
    used += 1
    try {
      return gh(args, Math.min(callMs, left))
    } catch (err) {
      const what = `\`gh ${args.slice(0, 2).join(' ')}\``
      if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGKILL') throw new Error(`${what} timed out after ${Math.round(Math.min(callMs, left) / 1000)} s`)
      const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0]
      throw new Error(`${what} failed: ${scrubLine(detail, 120)}`)
    }
  }
  call.used = () => used
  return call
}

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`unparseable ${what}`)
  }
}

/** A `gh run list` row in the REST run shape `evaluate` reads, with only the money-flow job. */
function asEvaluatedRun(row, conclusion) {
  return {
    id: Number(row.databaseId),
    head_sha: row.headSha,
    created_at: row.createdAt,
    conclusion: row.conclusion,
    event: row.event,
    jobs: conclusion === null || conclusion === undefined ? [] : [{ name: MONEY_FLOW_JOB, conclusion }],
  }
}

const endpoint = (run) => ({ id: run.id, sha: run.head_sha, event: run.event })

/**
 * Compute the window for the current (failing) run. Never throws for a read:
 * the caller turns a throw into "unavailable", and so does `readQaWindow`.
 *
 * @param {object} o
 * @param {(args: string[], timeoutMs: number) => string} o.gh
 * @param {string} o.repo
 * @param {{id: string|number, sha: string, event: string}} o.current
 */
export function computeWindow({
  gh,
  repo,
  current,
  now = Date.now,
  calls = WINDOW_CALL_BUDGET,
  ms = WINDOW_BUDGET_MS,
  callMs = WINDOW_CALL_TIMEOUT_MS,
  globs = loadMoneyPathGlobs(),
}) {
  const call = budgeted(gh, { calls, ms, callMs, now })
  let rows
  try {
    rows = parseJson(
      call([
        'run', 'list', '--repo', repo, '--workflow', 'qa-dev.yml', '--limit', String(WINDOW_RUN_LIMIT),
        '--json', 'databaseId,displayTitle,createdAt,startedAt,updatedAt,headSha,event,headBranch,status,conclusion',
      ]),
      '`gh run list` output',
    )
  } catch (err) {
    return { status: 'unavailable', reason: err.message }
  }
  if (!Array.isArray(rows)) return { status: 'unavailable', reason: '`gh run list` did not return a list' }

  const self = rows.find((r) => String(r?.databaseId) === String(current.id))
  const createdAt = self?.createdAt ?? new Date(now()).toISOString()
  const at = Date.parse(createdAt)
  // Only runs created before this one, and finished: an in-progress run has
  // no decisive money-flow job. The pre-filter runs BEFORE any jobs read.
  const { kept } = preFilterHarnessCandidates(
    rows.filter((r) => r?.status === 'completed' && String(r?.databaseId) !== String(current.id) && Date.parse(r?.createdAt) <= at),
  )
  const ordered = [...kept].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  const ancestry = new Map()
  const conclusions = new Map()
  let readError = null
  const io = {
    // Is `sha` in the failing commit's history? `compare/{sha}...{current}`:
    // `ahead` or `identical` is yes, `behind` or `diverged` is no. A failed
    // read throws (selectGreenRun does not catch it), so it is "unavailable",
    // not a refusal that would quietly push the window further back.
    isAncestorOfHead: (sha) => {
      if (!ancestry.has(sha)) {
        const status = call(['api', `repos/${repo}/compare/${sha}...${current.sha}?per_page=1`, '--jq', '.status']).trim()
        if (!['ahead', 'identical', 'behind', 'diverged'].includes(status)) throw new Error(`unexpected compare status '${status}'`)
        ancestry.set(sha, status === 'ahead' || status === 'identical')
      }
      return ancestry.get(sha)
    },
    // selectGreenRun swallows a jobsFor throw as "unreadable"; the error is
    // kept and rethrown below, so a failed read is never a silent refusal.
    jobsFor: (id) => {
      if (conclusions.has(id)) return conclusions.get(id).jobs
      try {
        const parsed = parseJson(call(jobsQueryArgs(repo, id)), `jobs of run ${id}`)
        if (!Array.isArray(parsed?.jobs)) throw new Error(`the jobs of run ${id} are not a list`)
        // Every qa-dev run lists its money-flow job, skipped or not: one
        // missing means the read is not what it claims, not a refusal.
        const conclusion = moneyFlowJobConclusion(parsed.jobs)
        if (conclusion === null) throw new Error(`run ${id} lists no '${MONEY_FLOW_JOB}' job`)
        conclusions.set(id, { jobs: parsed.jobs, conclusion })
        return parsed.jobs
      } catch (err) {
        readError = err
        return null
      }
    },
  }
  const admit = (candidates) => {
    readError = null
    const result = selectGreenRun(candidates, io)
    if (readError) throw readError
    return result.run
  }

  // Newest first. A row whose jobs were read passed rules 1-3 (dev evidence);
  // a row refused before that is not dev's and plays no part.
  const evaluated = [asEvaluatedRun({ databaseId: current.id, headSha: current.sha, createdAt, conclusion: 'failure', event: current.event }, 'failure')]
  let green = null
  let spent = null
  try {
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i]
      const admitted = admit([row])
      if (admitted) {
        green = admitted
        // Prefer a deployment_status run at the same commit (its SHA is the
        // deployed one by construction): selectGreenRun's own tie-break.
        if (green.event !== 'deployment_status') {
          const same = ordered.slice(i + 1).filter((r) => r.headSha === green.headSha)
          if (same.length) {
            try {
              green = admit([green, ...same]) ?? green
            } catch (err) {
              if (!(err instanceof LookupBudgetSpent)) throw err
            }
          }
        }
        break
      }
      if (conclusions.has(row.databaseId)) evaluated.push(asEvaluatedRun(row, conclusions.get(row.databaseId).conclusion))
    }
  } catch (err) {
    if (!(err instanceof LookupBudgetSpent)) return { status: 'unavailable', reason: err.message }
    spent = err
  }
  if (green) evaluated.push(asEvaluatedRun(green, 'success'))

  const red = evaluateJobWindow(evaluated).red.find((r) => r.job === MONEY_FLOW_JOB)
  if (!red) return { status: 'unavailable', reason: 'no red money-flow state derived' }
  const firstRed = endpoint(red.firstFailure)
  if (red.openEnded) {
    const reason = !spent
      ? `no admitted money-flow success among the newest ${rows.length} qa-dev runs`
      : spent.kind === 'calls'
        ? `no admitted money-flow success within the lookup budget (${spent.used} calls)`
        : `no admitted money-flow success within the lookup time budget (${Math.round(spent.ms / 1000)} s, ${spent.used} calls made)`
    return { status: 'open-ended', reason, firstRed }
  }
  const lastGreen = endpoint(red.lastSuccess)
  // Green and red at one commit: nothing changed in code between them.
  if (lastGreen.sha === firstRed.sha) return { status: 'ok', lastGreen, firstRed, prs: [] }

  let compare
  try {
    compare = parseJson(
      call([
        'api', `repos/${repo}/compare/${lastGreen.sha}...${firstRed.sha}`, '--jq',
        '{status, total_commits, commits: [.commits[] | {sha, parents: [.parents[].sha], login: .author.login, type: .author.type, name: .commit.author.name, message: .commit.message}]}',
      ]),
      'compare output',
    )
  } catch (err) {
    return { status: 'unavailable', reason: err instanceof LookupBudgetSpent ? `${err.message} before the compare read` : err.message }
  }
  if (compare?.status !== 'ahead') return { status: 'unavailable', reason: `compare ${sha9(lastGreen.sha)}...${sha9(firstRed.sha)} is '${compare?.status}', not 'ahead'` }
  if (!Array.isArray(compare.commits)) return { status: 'unavailable', reason: 'the compare read returned no commit list' }
  const bySha = new Map(compare.commits.map((c) => [c.sha, c]))
  // Every commit of the range is listed unless the range is longer than the page.
  const complete = !(Number(compare.total_commits) > compare.commits.length)
  const chain = []
  for (let sha = firstRed.sha; sha !== lastGreen.sha; ) {
    const c = bySha.get(sha)
    if (!c || chain.length > bySha.size) {
      return {
        status: 'unavailable',
        reason: complete
          ? `the first-parent line from ${sha9(firstRed.sha)} does not reach ${sha9(lastGreen.sha)}`
          : `the first-parent line leaves the compare page (${compare.total_commits} commits; the API lists ${compare.commits.length})`,
      }
    }
    chain.push(c)
    sha = c.parents?.[0]
  }
  chain.reverse()

  const prs = []
  for (const c of chain) {
    const pr = {
      number: prOf({ head_commit: { message: c.message } }),
      sha: c.sha,
      author: { login: c.login ?? null, name: c.name ?? null, bot: c.type === 'Bot' || /\[bot\]$/.test(c.login ?? '') },
      moneyPath: null,
      harness: null,
      note: null,
    }
    try {
      const parsed = parseJson(call(['api', `repos/${repo}/commits/${c.sha}`, '--jq', '{files: [.files[].filename]}']), `files of ${sha9(c.sha)}`)
      const files = Array.isArray(parsed?.files) ? parsed.files : []
      pr.moneyPath = moneyPathFiles(files, globs)
      pr.harness = files.some((f) => f.startsWith(HARNESS_PREFIX))
      // The commit API lists at most 300 files: past that, "no" is not proven.
      if (files.length >= 300) pr.note = 'file list cut at 300'
    } catch (err) {
      if (!(err instanceof LookupBudgetSpent)) return { status: 'unavailable', reason: err.message }
      pr.note = 'files not read: lookup budget spent'
    }
    prs.push(pr)
  }
  return { status: 'ok', lastGreen, firstRed, prs }
}

/**
 * The window for this Actions run, or null outside Actions (no GITHUB_RUN_ID):
 * no `gh` call is made then, which keeps the CLI tests hermetic. A run that is
 * not dev's is reported as such with no call either. Never throws.
 */
export function readQaWindow(env = process.env, { gh = windowGh, now = Date.now } = {}) {
  if (!env.GITHUB_RUN_ID || !env.GITHUB_REPOSITORY) return null
  const why = notDevReason(env)
  if (why) return { status: 'not-dev', reason: why }
  if (!env.GITHUB_SHA) return { status: 'unavailable', reason: 'GITHUB_SHA is not set' }
  const callMs = Number(env.QA_FAILURE_WINDOW_CALL_TIMEOUT_MS) > 0 ? Number(env.QA_FAILURE_WINDOW_CALL_TIMEOUT_MS) : WINDOW_CALL_TIMEOUT_MS
  try {
    return computeWindow({
      gh,
      repo: env.GITHUB_REPOSITORY,
      current: { id: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, event: env.GITHUB_EVENT_NAME },
      now,
      callMs,
    })
  } catch (err) {
    return { status: 'unavailable', reason: scrubLine(String(err?.message ?? err), 160) }
  }
}

/** `deployment_status` is the only event whose SHA is the deployed commit by construction. */
function endpointText(e) {
  const base = `\`${sha9(e.sha)}\` (run ${e.id})`
  return e.event === 'deployment_status' ? base : `${base} (${e.event}; dev tip, deploy not verified)`
}

function touchesText(pr) {
  if (pr.moneyPath === null) return pr.note ?? 'files not read'
  const n = pr.moneyPath.length
  const money = n === 0
    ? 'touches no money-path file'
    : `touches ${n} money-path file${n === 1 ? '' : 's'}: ${pr.moneyPath.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${n > 3 ? ', …' : ''}`
  return `${money}; ${pr.harness ? 'touches the harness' : 'does not touch the harness'}${pr.note ? ` (${pr.note})` : ''}`
}

function authorText(a, mention) {
  if (!a.login) return `an author with no GitHub account (${md(a.name ?? 'unknown')})`
  return mention ? `@${a.login}` : a.login
}

/**
 * Whether the window's author is @-mentioned (captain decision on #4236,
 * 2026-10-21): only a single-PR window whose PR touches a money-path file or
 * the harness, for a run class that can be a code change, by a human author.
 * The CALLER also keys it on the episode's first comment (reopen) or the body
 * (create): a later failure in the same episode names the author without `@`.
 */
export function mentionable(window, runClass) {
  if (window?.status !== 'ok' || window.prs.length !== 1) return false
  if (!MENTION_CLASSES.has(runClass)) return false
  const [pr] = window.prs
  if (!pr.author.login || pr.author.bot) return false
  return (pr.moneyPath?.length ?? 0) > 0 || pr.harness === true
}

/** The one window line, for the body and the comment alike. Null when there is no window (outside Actions). */
export function windowLine(window, { mention = false } = {}) {
  if (!window) return null
  switch (window.status) {
    case 'not-dev':
      return `window: not a dev run (${md(window.reason)}) — nothing computed, nobody mentioned`
    case 'unavailable':
      return `window: unavailable (${md(window.reason)})`
    case 'open-ended':
      return `window: open-ended — ${md(window.reason)}; first red so far ${endpointText(window.firstRed)}, so the break may be older`
    case 'ok': {
      const n = window.prs.length
      if (n === 0) return "window: 0 PRs — first red is at the last green's commit (no code change; flake, provider or environment)"
      const prs = window.prs
        .map((p) => `${p.number ? `#${p.number}` : `\`${sha9(p.sha)}\` (no PR in subject)`} by ${authorText(p.author, mention && n === 1)} (${touchesText(p)})`)
        .join('; ')
      return `window: last green ${endpointText(window.lastGreen)} → first red ${endpointText(window.firstRed)}: ${n} PR${n === 1 ? '' : 's'} — ${prs}`
    }
    default:
      return `window: unavailable (unknown state)`
  }
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
export function upsertStandingIssue({ gh = defaultGh, trigger, runUrl, when, classification = null, readWindow = () => null, log = console.log }) {
  // Ensure the label exists (labels.yml owns only the surface taxonomy). A
  // failure here (already exists, transient API error) must not stop the upsert.
  try {
    gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION, '--force'])
  } catch {
    // tolerated
  }

  // The window (#4236) is read after the label and before the issue lookups,
  // and a throw is a window line, never a lost comment or reopen.
  // The mention is keyed on the episode's opening event: the reopen comment,
  // or the body when the issue is created. A failure while the issue is
  // already open recomputes the window and names the author without `@`.
  // Reading AND rendering are guarded: a malformed window is one
  // "unavailable" line, never a lost body, comment or reopen.
  const render = (window, mention) => {
    const parts = { trigger, runUrl, when, classification, window }
    return {
      body: buildBody(parts),
      comment: buildComment(parts),
      openingBody: buildBody({ ...parts, mention }),
      openingComment: buildComment({ ...parts, mention }),
      line: windowLine(window),
    }
  }
  let r
  try {
    const window = readWindow()
    r = render(window, mentionable(window, classification?.runClass ?? 'unclassified'))
  } catch (err) {
    r = render({ status: 'unavailable', reason: scrubLine(String(err?.message ?? err), 160) }, false)
  }
  if (r.line) log(r.line)
  const { body, comment } = r

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
    gh(['issue', 'comment', String(closed), '--body', r.openingComment])
    log(`Reopened the standing qa-failure issue #${closed}`)
    return { action: 'reopened', number: closed }
  }

  const created = gh(['issue', 'create', '--label', LABEL, '--title', ISSUE_TITLE, '--body', r.openingBody])
  log(`Created the standing qa-failure issue: ${String(created).trim()}`)
  return { action: 'created', number: null }
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

export function buildCloseComment({ trigger, runUrl, when }) {
  return `\`qa-dev\` full-coverage green at ${when} (trigger: \`${trigger}\`) — ${runUrl}\n\nClosed on green; the next failure reopens it.`
}

/**
 * Close the standing issue on a full-coverage green run (#4069). Only an OPEN
 * issue by the bot with the exact title is closed — a human issue carrying the
 * label is left alone, and a closed one is not touched. A failed or unreadable
 * lookup throws before any write (fail closed).
 *
 * @returns {{ action: 'closed', numbers: number[] } | { action: 'none' }}
 */
export function closeStandingIssue({ gh = defaultGh, trigger, runUrl, when, log = console.log }) {
  const list = parseList(
    gh([
      'issue', 'list', '--label', LABEL, '--state', 'open', '--author', BOT_AUTHOR, '--limit', '50',
      '--json', 'number,title,author,state',
    ]),
  )
  const numbers = list
    .filter(
      (i) =>
        i?.author?.login === BOT_AUTHOR &&
        i?.title === ISSUE_TITLE &&
        String(i?.state).toUpperCase() === 'OPEN' &&
        Number.isInteger(i?.number),
    )
    .map((i) => i.number)
    .sort((a, b) => a - b)
  if (numbers.length === 0) {
    log('Green run; no open standing qa-failure issue — nothing to do')
    return { action: 'none' }
  }
  const comment = buildCloseComment({ trigger, runUrl, when })
  for (const n of numbers) {
    gh(['issue', 'close', String(n), '--reason', 'completed', '--comment', comment])
    log(`Closed the standing qa-failure issue #${n} on green`)
  }
  return { action: 'closed', numbers }
}

function main() {
  const trigger = process.env.TRIGGER || triggerLine()
  const url = process.env.RUN_URL || runUrlFromEnv()
  if (!trigger || !url) {
    console.error('qa-failure-issue: TRIGGER and RUN_URL must be set (or derivable from the Actions env)')
    process.exit(2)
  }
  const when = process.env.WHEN || new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  const args = process.argv.slice(2)
  if (args.includes('--green')) {
    console.log(JSON.stringify(closeStandingIssue({ trigger, runUrl: url, when })))
    return
  }
  // Attempt logs as arguments (the workflow passes qa-run.attempt-*.log).
  const classification = readFinalAttempt(args)
  const result = upsertStandingIssue({ trigger, runUrl: url, when, classification, readWindow: () => readQaWindow(process.env) })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
