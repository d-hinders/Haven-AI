#!/usr/bin/env node
// Verdict for the nightly advisory-lock deadlock proof (#2208) — the
// `Verify the proof cases actually ran` step in
// `.github/workflows/db-concurrency-proof.yml`.
//
// ## What is being proven, and why a green vitest exit is not it
//
// #2198 fixed a real deadlock: a blocking `pg_advisory_lock()` pins a live
// snapshot for the whole wait, and `CREATE INDEX CONCURRENTLY` cannot mark an
// index valid until every older snapshot in the DATABASE has drained — so each
// waits for the other and Postgres kills one with SQLSTATE `40P01`. The fix is
// `pg_try_advisory_lock` polling (`packages/backend/src/db/advisory-lock.ts`).
//
// The two end-to-end cases that reproduce that — one asserting the deadlock
// still happens on the BLOCKING form, one asserting it does not on the polled
// form — are gated behind `HAVEN_DB_CONCURRENCY_PROOF=1`, deliberately, and
// #2208 explains at length why un-gating them is the wrong fix (a
// `CONCURRENTLY` build's duration is unbounded inside a 2 700-test parallel
// suite; as always-on tests they hung past 120 s, reproducibly).
//
// ## The failure mode this file exists for
//
// `it.runIf(false)` does not fail. Measured on `dev` at 2026-08-30, running the
// proof file with the flag UNSET:
//
//     Tests  6 passed (6)          # ...and the JSON report says:
//     "PROOF: a BLOCKING waiter deadlocks ..."  -> "skipped"
//     "PROOF: the POLLED waiter does not ..."   -> "skipped"
//
// Exit code 0. A nightly job that ran the file and checked `$?` would be green
// forever while proving nothing — the same shape as every instrument this repo
// has caught reporting after it stopped measuring (a CI health check reading a
// stale SHA, a capture harness returning short pages, a baselines workflow
// re-blessing files it never compared). So the job does not ask "did vitest
// exit 0". It asks, of the JSON report, whether these two named cases were
// EXECUTED and PASSED.
//
// The titles below are therefore load-bearing, and a rename would make this
// guard vacuous in the one direction it cannot detect at runtime. That is why
// `db-concurrency-proof.test.mjs` reads the actual test file and asserts each
// title still appears in it — the rename fails on EVERY pull request, in
// `ci.yml`'s dependency-free `Repo CI config checks` job, rather than at 3am in
// a job nobody is watching.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The environment gate. Named once, referenced by the workflow and the docs. */
export const PROOF_ENV_FLAG = 'HAVEN_DB_CONCURRENCY_PROOF'

/** Repo-relative path of the file carrying the proof cases. */
export const PROOF_TEST_FILE =
  'packages/backend/src/infra/__tests__/db-harness-lock-concurrency.test.ts'

/**
 * The two cases whose EXECUTION is the whole point of the nightly.
 *
 * Both, not one. A job that only showed the current (polled) code passing would
 * prove the test ran, not that it can fail — the blocking case is the built-in
 * control, and it is the half that goes red if a Postgres upgrade, a planner
 * change or a tuning default ever stops producing `40P01` from the pre-fix
 * shape. Losing it silently would leave the green case unfalsifiable.
 */
export const REQUIRED_PROOF_CASES = [
  'PROOF: a BLOCKING waiter deadlocks a concurrent CREATE INDEX CONCURRENTLY (40P01)',
  'PROOF: the POLLED waiter does not — the same build completes VALID',
]

/**
 * Statuses vitest's JSON reporter emits for a case that did NOT execute.
 * `pending` is what `it.runIf(false)` produces in vitest 3; `skipped` and
 * `todo` are the neighbouring shapes. All three mean the same thing here.
 */
const NOT_EXECUTED = new Set(['skipped', 'pending', 'todo', 'disabled'])

/**
 * Flatten a vitest JSON report to `{ title, status }`.
 *
 * Tolerant of the report shape rather than assuming it: a malformed or
 * truncated report must land in `problems`, never default to green.
 */
export function collectCases(report) {
  const files = Array.isArray(report?.testResults) ? report.testResults : []
  const cases = []
  for (const file of files) {
    const results = Array.isArray(file?.assertionResults) ? file.assertionResults : []
    for (const r of results) {
      cases.push({ title: String(r?.title ?? ''), status: String(r?.status ?? 'unknown') })
    }
  }
  return cases
}

/**
 * Decide whether the nightly actually proved anything.
 *
 * Returns `{ ok, problems }`. There is no default-green path: an empty or
 * unrecognised report yields a problem, because "nothing said no" has never
 * been the same claim as "the proof ran".
 */
export function evaluate({ report, required = REQUIRED_PROOF_CASES } = {}) {
  const problems = []

  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    problems.push(
      'No usable vitest JSON report. The proof run produced nothing to verify, ' +
        'which is a red run, not an absent one.',
    )
    return { ok: false, problems, cases: [] }
  }

  const cases = collectCases(report)
  if (cases.length === 0) {
    problems.push(
      `The vitest report contains no test cases at all — ${PROOF_TEST_FILE} did not run ` +
        '(renamed? deleted? collection error?).',
    )
  }

  for (const title of required) {
    const matches = cases.filter((c) => c.title === title)
    if (matches.length === 0) {
      problems.push(
        `Required proof case is MISSING from the report: "${title}". ` +
          `Either it was renamed (update REQUIRED_PROOF_CASES in the same commit) or ` +
          `${PROOF_TEST_FILE} no longer carries it.`,
      )
      continue
    }
    if (matches.length > 1) {
      problems.push(
        `Required proof case appears ${matches.length} times: "${title}". ` +
          'An ambiguous title makes this verdict unreliable — keep the titles unique.',
      )
    }
    for (const m of matches) {
      if (NOT_EXECUTED.has(m.status)) {
        problems.push(
          `Required proof case did NOT EXECUTE (status "${m.status}"): "${title}". ` +
            `This is what a broken gate looks like: set ${PROOF_ENV_FLAG}=1 for this run. ` +
            'A skipped proof case is a green run that proves nothing.',
        )
      } else if (m.status !== 'passed') {
        problems.push(
          `Required proof case FAILED (status "${m.status}"): "${title}". ` +
            'This is the signal the nightly exists to produce — read the vitest output above.',
        )
      }
    }
  }

  // Anything else red in the same file is still a red run; report it by name so
  // the issue body is actionable without opening the log.
  for (const c of cases) {
    if (c.status !== 'passed' && !NOT_EXECUTED.has(c.status) && !required.includes(c.title)) {
      problems.push(`Non-proof case in the same file failed (status "${c.status}"): "${c.title}".`)
    }
  }

  return { ok: problems.length === 0, problems, cases }
}

/** Human-readable summary for the job log and the GitHub step summary. */
export function render({ ok, problems, cases }, required = REQUIRED_PROOF_CASES) {
  const lines = []
  lines.push(ok ? '✅ The end-to-end deadlock proof ran and passed.' : '❌ The end-to-end deadlock proof did NOT prove anything.')
  lines.push('')
  for (const title of required) {
    const status = cases.find((c) => c.title === title)?.status ?? 'ABSENT'
    lines.push(`  ${status === 'passed' ? '✓' : '✗'} [${status}] ${title}`)
  }
  if (problems.length > 0) {
    lines.push('')
    for (const p of problems) lines.push(`  • ${p}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI wrapper. All IO here; `evaluate` above stays pure and unit-testable.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const reportPath = process.argv[2]
  if (!reportPath) {
    console.error('usage: db-concurrency-proof.mjs <vitest-json-report>')
    process.exit(2)
  }
  let report = null
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (err) {
    // Deliberately NOT a hard exit here: a missing/corrupt report is one of the
    // outcomes `evaluate` is supposed to call red, with the same message shape
    // as every other failure.
    console.error(`Could not read ${reportPath}: ${err.message}`)
  }
  const result = evaluate({ report })
  const text = render(result)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Advisory-lock deadlock proof (#2208)\n\n\`\`\`\n${text}\n\`\`\`\n`)
  }
  process.exit(result.ok ? 0 : 1)
}
