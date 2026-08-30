import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  ROOT,
  PROOF_ENV_FLAG,
  PROOF_TEST_FILE,
  REQUIRED_PROOF_CASES,
  collectCases,
  evaluate,
  render,
} from './db-concurrency-proof.mjs'

// The fixtures below are the REAL vitest 3.2.4 JSON reports measured on `dev`
// at 2026-08-30 against the docker-compose Postgres 16.15, running
// `packages/backend/src/infra/__tests__/db-harness-lock-concurrency.test.ts`
// with and without HAVEN_DB_CONCURRENCY_PROOF=1. They are kept here because the
// difference between them is the entire subject of #2208.

const CASE = (title, status) => ({ title, status })

const ALWAYS_ON = [
  CASE('a BLOCKING waiter pins a live snapshot; a POLLED waiter pins none', 'passed'),
  CASE('initDbHarness() waits without pinning a snapshot, and still serialises', 'passed'),
  CASE('a waiter that cannot acquire THROWS rather than proceeding without the lock', 'passed'),
  CASE('releaseAdvisoryLock actually releases', 'passed'),
]

const reportOf = (cases) => ({ testResults: [{ name: PROOF_TEST_FILE, assertionResults: cases }] })

/** Flag SET: both proof cases execute and pass. `Tests 6 passed (6)`. */
const REPORT_WITH_FLAG = reportOf([
  ...ALWAYS_ON,
  ...REQUIRED_PROOF_CASES.map((t) => CASE(t, 'passed')),
])

/** Flag UNSET: vitest still prints `Tests 6 passed (6)` and exits 0. */
const REPORT_WITHOUT_FLAG = reportOf([
  ...ALWAYS_ON,
  ...REQUIRED_PROOF_CASES.map((t) => CASE(t, 'skipped')),
])

test('the flag-set report is the only one that counts as proof', () => {
  const result = evaluate({ report: REPORT_WITH_FLAG })
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
})

test('#2208: a SKIPPED proof case is red, even though vitest exited 0', () => {
  // This is the whole defect in one assertion. Both reports come from a vitest
  // run that succeeded; only one of them proved anything.
  assert.equal(evaluate({ report: REPORT_WITH_FLAG }).ok, true)
  assert.equal(evaluate({ report: REPORT_WITHOUT_FLAG }).ok, false)

  const problems = evaluate({ report: REPORT_WITHOUT_FLAG }).problems.join('\n')
  // The message has to name the gate, or a 3am reader re-debugs it from scratch.
  assert.match(problems, new RegExp(PROOF_ENV_FLAG))
  for (const title of REQUIRED_PROOF_CASES) assert.ok(problems.includes(title))
})

test('every not-executed status vitest can emit is treated as not executed', () => {
  for (const status of ['skipped', 'pending', 'todo', 'disabled']) {
    const report = reportOf([...ALWAYS_ON, ...REQUIRED_PROOF_CASES.map((t) => CASE(t, status))])
    assert.equal(evaluate({ report }).ok, false, `status "${status}" must not read as proof`)
  }
})

test('a RENAMED proof case is red rather than silently unverified', () => {
  const report = reportOf([
    ...ALWAYS_ON,
    CASE('PROOF: renamed at some point and nobody noticed', 'passed'),
    CASE(REQUIRED_PROOF_CASES[1], 'passed'),
  ])
  const result = evaluate({ report })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /MISSING from the report/)
})

test('the BLOCKING control failing is red — the proof is not just about the green half', () => {
  // If a Postgres change ever stops the pre-fix shape producing 40P01, the
  // polled case still passes. A job that only watched the polled case would go
  // on reporting a guarantee it had stopped being able to falsify.
  const report = reportOf([
    ...ALWAYS_ON,
    CASE(REQUIRED_PROOF_CASES[0], 'failed'),
    CASE(REQUIRED_PROOF_CASES[1], 'passed'),
  ])
  const result = evaluate({ report })
  assert.equal(result.ok, false)
  assert.match(result.problems.join('\n'), /FAILED/)
})

test('an empty, missing or malformed report is RED, never green by default', () => {
  assert.equal(evaluate({ report: null }).ok, false)
  assert.equal(evaluate({ report: undefined }).ok, false)
  assert.equal(evaluate({ report: {} }).ok, false)
  assert.equal(evaluate({ report: { testResults: [] } }).ok, false)
  assert.equal(evaluate({ report: { testResults: [{ assertionResults: [] }] } }).ok, false)
})

test('a duplicated proof title is red — an ambiguous title makes the verdict unreliable', () => {
  const report = reportOf([
    ...ALWAYS_ON,
    CASE(REQUIRED_PROOF_CASES[0], 'passed'),
    CASE(REQUIRED_PROOF_CASES[0], 'skipped'),
    CASE(REQUIRED_PROOF_CASES[1], 'passed'),
  ])
  assert.equal(evaluate({ report }).ok, false)
})

test('a non-proof case failing in the same file is still red', () => {
  const report = reportOf([
    CASE('a BLOCKING waiter pins a live snapshot; a POLLED waiter pins none', 'failed'),
    ...REQUIRED_PROOF_CASES.map((t) => CASE(t, 'passed')),
  ])
  assert.equal(evaluate({ report }).ok, false)
})

test('collectCases tolerates a truncated report without throwing', () => {
  assert.deepEqual(collectCases({}), [])
  assert.deepEqual(collectCases({ testResults: [{}] }), [])
  assert.deepEqual(collectCases({ testResults: [{ assertionResults: [{}] }] }), [
    { title: '', status: 'unknown' },
  ])
})

test('render names every required case and its status', () => {
  const text = render(evaluate({ report: REPORT_WITHOUT_FLAG }))
  for (const title of REQUIRED_PROOF_CASES) assert.ok(text.includes(title))
  assert.match(text, /\[skipped\]/)
})

// ---------------------------------------------------------------------------
// The couplings that make the runtime guard non-vacuous. These run on EVERY
// pull request (ci.yml → "Repo CI config suites (scripts/ci/*.test.mjs)"), so a
// rename is caught at PR time rather than by a red nightly nobody is watching.
// ---------------------------------------------------------------------------

test('the proof test file still exists where the workflow points', () => {
  assert.ok(
    existsSync(path.join(ROOT, PROOF_TEST_FILE)),
    `${PROOF_TEST_FILE} is gone — the nightly (.github/workflows/db-concurrency-proof.yml) ` +
      'runs a path that no longer exists.',
  )
})

test('every REQUIRED_PROOF_CASE title still appears verbatim in the test file', () => {
  const source = readFileSync(path.join(ROOT, PROOF_TEST_FILE), 'utf8')
  for (const title of REQUIRED_PROOF_CASES) {
    assert.ok(
      source.includes(title),
      `The nightly requires a case titled "${title}" but ${PROOF_TEST_FILE} no longer contains ` +
        'it. Rename it here in the same commit, or the nightly proves nothing.',
    )
  }
})

test('the proof test file still gates on the flag the workflow sets', () => {
  const source = readFileSync(path.join(ROOT, PROOF_TEST_FILE), 'utf8')
  assert.ok(
    source.includes(PROOF_ENV_FLAG),
    `${PROOF_TEST_FILE} no longer mentions ${PROOF_ENV_FLAG}; the workflow would be setting a ` +
      'variable nothing reads.',
  )
})

test('the workflow actually sets the flag and runs this verdict script', () => {
  const wf = path.join(ROOT, '.github/workflows/db-concurrency-proof.yml')
  assert.ok(existsSync(wf), 'the nightly workflow file is missing')
  const source = readFileSync(wf, 'utf8')
  assert.match(source, new RegExp(`${PROOF_ENV_FLAG}:\\s*'?1'?`))
  assert.ok(source.includes('scripts/ci/db-concurrency-proof.mjs'))
  assert.ok(source.includes(PROOF_TEST_FILE.replace('packages/backend/', '')))
})
