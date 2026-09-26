#!/usr/bin/env node
// qa-dev's in-step retry, made visible (#3338, epic #3335).
//
// `qa-dev.yml` retries the money-flow harness inside one step (QA_MAX_ATTEMPTS,
// default 2), so a pass on attempt 2 is a plain green run: `run_attempt` never
// moves, the promotion and freshness gates see `success`, and the only traces
// were a `::warning::` annotation and a job-log line nobody read. Measured
// before this change: 19 of 90 successful harness runs passed only on attempt
// 2, in runs created 2026-09-18T19:27Z → 2026-09-25T19:25Z (#3338; re-taken in
// review with this file's passedOnAttempt/tally).
// A retry that hides a real provider failure is exactly how the RPC waves of
// epic #3335 went unnoticed, so the retry now reports itself:
//
//   summary <final-attempt> <log…>  the job-summary block for a run that passed
//                                   after failed attempts (empty on attempt 1)
//   count [--since YYYY-MM-DD]      how many successful money-flow runs needed
//                                   the retry, read back from the job logs
//
// Failure text is printed into a public job summary, so URLs and key-labelled
// values in it are replaced — a provider URL carries its API key.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * The harness's failed legs and run-level `✗` lines. A leg is read from its
 * live line (`• <name> … FAIL — <detail>`) or, because stderr merged in by
 * `2>&1` can split that line, from its run-report row
 * (`| <name> | <invariant> | **FAIL** | <detail> |`, one console.log each);
 * a leg found both ways is listed once.
 */
export function failingLines(log) {
  const legs = new Map()
  const runLevel = []
  for (const raw of String(log ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const live = /^• (\S+) … FAIL — (.*)$/.exec(line)
    const row = /^\| (\S+) \| .* \| \*\*FAIL\*\* \| (.*) \|$/.exec(line)
    const leg = live ?? row
    if (leg) {
      if (!legs.has(leg[1])) legs.set(leg[1], leg[2])
      continue
    }
    const run = /^✗ (.*)$/.exec(line.trim())
    if (run) runLevel.push({ leg: null, detail: run[1] })
  }
  return [...[...legs].map(([leg, detail]) => ({ leg, detail })), ...runLevel]
}

/**
 * Replace every URL-shaped token (a provider URL embeds its key) and every
 * key-labelled value of 16+ characters (`apiKey: …`, `DRPC_API_KEY=…`,
 * `private_key=…`, `Bearer …`), then cap the length. The length floor keeps
 * short labelled words readable (`Unsupported token: USDT`). Covered:
 * any scheme (`https`, `wss`, …), JSON-escaped (`https:\/\/`) and
 * percent-encoded (`https%3A%2F%2F`) URLs, and unescaped scheme-less
 * `host.tld/path`. Not covered: an escaped scheme-less URL or a bare key
 * with neither URL nor label — the harness prints neither today (ethers'
 * `requestUrl` and viem's `URL:` carry a scheme).
 * Identifiers stay readable — revert reasons, env-var names, leg names, UUIDs,
 * tx hashes — because they are the diagnosis this summary exists to show.
 * Only the first 1024 characters are scanned (the output keeps 240), which
 * bounds the regexes' backtracking on a pathological line.
 */
export function scrub(text, max = 240) {
  const s = scrubFull(String(text ?? '').slice(0, 1024))
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * The same replacements as `scrub`, over the whole text and uncapped. For a
 * caller that must scrub BEFORE it cuts an excerpt (qa-failure-issue.mjs,
 * #3337): cutting first can separate a label from its value, and a bare value
 * is not recognisable as a key. The caller bounds the input's length.
 */
export function scrubFull(text) {
  return String(text ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*(?::\/\/|:\\\/\\\/|%3A%2F%2F)[^\s"'`)\]}]+/gi, '<url>')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s"'`)\]}]*/gi, '<url>')
    .replace(/(?<![a-z0-9])((?:api[_-]?key|private[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|key)["']?\s*[:=]\s*["']?|bearer\s+)[^\s"',;)\]}]{16,}/gi, '$1<redacted>')
}

/**
 * The job-summary markdown for a pass on `finalAttempt` after earlier failed
 * attempts; '' when the run passed on its first attempt. `logs[i]` is attempt
 * i+1's log text.
 */
export function retrySummary(finalAttempt, logs) {
  const n = Number(finalAttempt)
  if (!Number.isInteger(n) || n <= 1) return ''
  const lines = [
    `### money-flow passed on attempt ${n} — the in-step retry absorbed a failure (#3338)`,
    '',
    'A pass that needed the retry is a signal, not noise: a recurring provider',
    'failure hides here (epic #3335). Earlier attempts failed on:',
    '',
  ]
  for (let i = 0; i < n - 1; i++) {
    const found = failingLines(logs[i])
    lines.push(`- **Attempt ${i + 1}:** ${found.length === 0 ? 'no failure line found in its log' : ''}`)
    for (const f of found) lines.push(`  - ${f.leg ? `\`${f.leg}\`: ` : ''}${scrub(f.detail)}`)
  }
  return lines.join('\n') + '\n'
}

/** The CLI's `summary`: logs read in attempt order (`read` is injectable for tests). */
export function summaryFromFiles(finalAttempt, files, read) {
  return retrySummary(finalAttempt, byAttempt(files).map((f) => {
    try {
      return read(f)
    } catch {
      return ''
    }
  }))
}

/** A shell glob sorts `attempt-10` before `attempt-2`: order the log paths by attempt number. */
export function byAttempt(files) {
  const n = (f) => Number(/attempt-(\d+)\.log$/.exec(f)?.[1] ?? Infinity)
  return [...files].sort((a, b) => n(a) - n(b))
}

/** Which attempt a money-flow job log passed on (`money-flow QA passed on attempt N/M`), or null. */
export function passedOnAttempt(jobLog) {
  const m = /money-flow QA passed on attempt (\d+)\/(\d+)/.exec(String(jobLog ?? ''))
  return m ? Number(m[1]) : null
}

/** Pure tally over `[{ runId, attempt }]`: how many passed on attempt 1 vs later. */
export function tally(rows) {
  const t = { passes: 0, firstAttempt: 0, retried: 0, unknown: 0, retriedRuns: [] }
  for (const r of rows) {
    t.passes += 1
    if (r.attempt === 1) t.firstAttempt += 1
    else if (Number.isInteger(r.attempt) && r.attempt > 1) {
      t.retried += 1
      t.retriedRuns.push(r.runId)
    } else t.unknown += 1
  }
  return t
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** The UTC days from `since` to `until`, inclusive, as YYYY-MM-DD. */
export function daysFrom(since, until) {
  const out = []
  for (let d = new Date(`${since}T00:00:00Z`); d.toISOString().slice(0, 10) <= until; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/**
 * The runs API returns at most 1000 results for a filtered query, and qa-dev
 * records 131–215 run-level successes a day (2026-09-24/25, most
 * gate-skipped), so a multi-day query truncates silently. Query one day at a time and refuse if even a day
 * comes back short of its `total_count`.
 */
export function countRuns(since, { gh: run = gh, repo, until = new Date().toISOString().slice(0, 10) } = {}) {
  const rows = []
  for (const day of daysFrom(since, until)) {
    const ids = []
    let total = 0
    for (let page = 1; page <= 10; page++) {
      const res = JSON.parse(run([
        'api', '-X', 'GET', `repos/${repo}/actions/workflows/qa-dev.yml/runs`,
        '-f', 'status=success', '-f', `created=${day}`, '-F', 'per_page=100', '-F', `page=${page}`,
        '--jq', '{total: .total_count, ids: [.workflow_runs[].id]}',
      ]))
      total = res.total
      ids.push(...res.ids)
      if (res.ids.length < 100) break
    }
    if (ids.length < total) throw new Error(`${day}: fetched ${ids.length} of ${total} successful runs — the API cap truncated the day`)
    for (const id of ids) {
      const jobs = JSON.parse(run(['api', `repos/${repo}/actions/runs/${id}/jobs`, '--jq', '[.jobs[] | {id, name, conclusion}]']))
      const mf = jobs.find((j) => j.name === 'money-flow' && j.conclusion === 'success')
      if (!mf) continue // the gate skipped the harness: not a harness pass
      rows.push({ runId: id, attempt: passedOnAttempt(run(['api', `repos/${repo}/actions/jobs/${mf.id}/logs`])) })
    }
  }
  return tally(rows)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'summary') {
    const [finalAttempt, ...files] = rest
    process.stdout.write(summaryFromFiles(finalAttempt, files, (f) => readFileSync(f, 'utf8')))
  } else if (cmd === 'count') {
    const i = rest.indexOf('--since')
    const since = i >= 0 ? rest[i + 1] : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
    const t = countRuns(since, { repo: process.env.GITHUB_REPOSITORY || '{owner}/{repo}' })
    console.log(`qa-dev money-flow passes since ${since}: ${t.passes} — first attempt ${t.firstAttempt}, needed the retry ${t.retried}, unknown ${t.unknown}`)
    if (t.retriedRuns.length) console.log(`retried runs: ${t.retriedRuns.join(' ')}`)
  } else {
    console.error('usage: qa-retry.mjs summary <final-attempt> <attempt logs…> | count [--since YYYY-MM-DD]')
    process.exit(2)
  }
}
