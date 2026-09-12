// Drives `scripts/ci/qa-failure-issue.mjs` through its real CLI entry point with
// a recording `gh` stub on PATH, and asserts which `gh` subcommands were REACHED
// in each of the three states the upsert distinguishes (#2767). A source grep for
// `issue create` would pass with the call inside a dead branch; this does not.
//
// Run with: node --test scripts/ci/qa-failure-issue.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ISSUE_TITLE, LABEL, buildBody, upsertStandingIssue } from './qa-failure-issue.mjs'

const SCRIPT = fileURLToPath(new URL('./qa-failure-issue.mjs', import.meta.url))

/**
 * A `gh` stub. Every invocation appends its argv (one JSON line) to $GH_LOG and
 * answers from the scenario in $GH_SCENARIO:
 *   - `issue list ... --state open`   → [{number: OPEN}]   or []
 *   - `issue list ... --state closed` → [{number: CLOSED}] or []
 *   - everything else                 → a plausible one-line success
 */
function makeStub(dir) {
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n')
const scenario = JSON.parse(process.env.GH_SCENARIO || '{}')
if (args[0] === 'issue' && args[1] === 'list') {
  const state = args[args.indexOf('--state') + 1]
  const n = state === 'open' ? scenario.open : scenario.closed
  process.stdout.write(JSON.stringify(n ? [{ number: n }] : []))
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'create') {
  process.stdout.write('https://github.com/d-hinders/Haven-AI/issues/999\\n')
  process.exit(0)
}
process.exit(0)
`,
  )
  chmodSync(stub, 0o755)
  return stub
}

function run(scenario, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-failure-issue-'))
  makeStub(dir)
  const log = join(dir, 'gh.log')
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: log,
      GH_SCENARIO: JSON.stringify(scenario),
      TRIGGER: 'workflow_dispatch — started by tester',
      RUN_URL: 'https://github.com/d-hinders/Haven-AI/actions/runs/1',
      WHEN: '2026-09-08 12:00 UTC',
      ...env,
    },
  })
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  return { result, calls }
}

const sub = (calls, a, b) => calls.filter((c) => c[0] === a && c[1] === b)

describe('qa-failure-issue: one standing issue', () => {
  test('an open qa-failure issue is UPDATED (edit + comment), never duplicated', () => {
    const { result, calls } = run({ open: 12 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'create').length, 0, 'must not create a second issue')
    assert.equal(sub(calls, 'issue', 'reopen').length, 0)
    const edits = sub(calls, 'issue', 'edit')
    assert.equal(edits.length, 1)
    assert.equal(edits[0][2], '12')
    assert.match(edits[0][edits[0].indexOf('--body') + 1], /## Latest failure/)
    const comments = sub(calls, 'issue', 'comment')
    assert.equal(comments.length, 1)
    assert.equal(comments[0][2], '12')
    assert.match(result.stdout, /"action":"updated","number":12/)
  })

  test('a second failure on a later day updates the SAME issue — still no create', () => {
    // The state after day 1: the standing issue is open. Day 2 fails again.
    const { result, calls } = run({ open: 12 }, { WHEN: '2026-09-09 03:20 UTC' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'create').length, 0)
    assert.equal(sub(calls, 'issue', 'edit')[0][2], '12')
    const comment = sub(calls, 'issue', 'comment')[0]
    assert.match(comment[comment.indexOf('--body') + 1], /2026-09-09 03:20 UTC/)
  })

  test('a standing issue closed on green is REOPENED, not replaced', () => {
    const { result, calls } = run({ open: null, closed: 7 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sub(calls, 'issue', 'create').length, 0, 'must reopen, not create')
    const reopen = sub(calls, 'issue', 'reopen')
    assert.equal(reopen.length, 1)
    assert.equal(reopen[0][2], '7')
    assert.equal(sub(calls, 'issue', 'edit')[0][2], '7')
    assert.equal(sub(calls, 'issue', 'comment')[0][2], '7')
    // The closed lookup is title-bound so an unrelated closed qa-failure from the
    // date-titled era is not what gets reopened.
    const closedList = sub(calls, 'issue', 'list').find((c) => c.includes('closed'))
    assert.ok(closedList.some((a) => a.includes(`in:title "${ISSUE_TITLE}"`)))
    assert.match(result.stdout, /"action":"reopened","number":7/)
  })

  test('no issue at all → created ONCE under the fixed, date-free title', () => {
    const { result, calls } = run({ open: null, closed: null })
    assert.equal(result.status, 0, result.stderr)
    const creates = sub(calls, 'issue', 'create')
    assert.equal(creates.length, 1)
    const title = creates[0][creates[0].indexOf('--title') + 1]
    assert.equal(title, ISSUE_TITLE)
    assert.doesNotMatch(title, /\d{4}-\d{2}-\d{2}/, 'the standing title carries no date')
    assert.ok(creates[0].includes(LABEL))
    assert.equal(sub(calls, 'issue', 'edit').length, 0)
    assert.match(result.stdout, /"action":"created"/)
  })

  test('the label is ensured before any lookup, and its failure is tolerated', () => {
    const { calls } = run({ open: 12 })
    assert.deepEqual(calls[0].slice(0, 3), ['label', 'create', LABEL])
    // In-process: a throwing label step does not stop the upsert.
    const seen = []
    const gh = (args) => {
      seen.push(args)
      if (args[0] === 'label') throw new Error('already exists')
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 3 }])
      return ''
    }
    const out = upsertStandingIssue({ gh, trigger: 't', runUrl: 'u', when: 'w', log: () => {} })
    assert.deepEqual(out, { action: 'updated', number: 3 })
    assert.ok(seen.some((a) => a[0] === 'issue' && a[1] === 'edit'))
  })

  test('missing TRIGGER / RUN_URL refuses with exit 2 and touches gh not at all', () => {
    const { result, calls } = run({ open: 12 }, { TRIGGER: '', RUN_URL: '' })
    assert.equal(result.status, 2)
    assert.equal(calls.length, 0)
  })

  test('body names the run, the trigger and the standing-issue contract', () => {
    const body = buildBody({ trigger: 'T', runUrl: 'U', when: 'W' })
    assert.match(body, /\*\*Trigger:\*\* `T`/)
    assert.match(body, /\*\*Run:\*\* U/)
    assert.match(body, /\*\*When:\*\* W/)
    assert.match(body, /one standing/)
  })
})
