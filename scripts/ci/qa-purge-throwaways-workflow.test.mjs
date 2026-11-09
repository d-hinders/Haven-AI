// #4740 (epic #4674): the QA purge workflow must never paste a workflow input
// into a `run:` block.
//
// GitHub substitutes `${{ inputs.* }}` into the script text BEFORE bash parses
// it. `retention_days` is a free-text string, so an inlined value runs as
// shell — in the step whose env holds QA_PURGE_DATABASE_URL, and before the
// purge script's own `parseRetentionDays` can refuse it. The inputs travel as
// `env:` values instead and are read as quoted shell variables.
//
// The guard is two-sided: a static check that no run: block names `inputs`,
// and a cell that runs the purge step's real `run:` body under bash — with
// GitHub's substitution simulated, so restoring the inline form turns it red —
// against a stub `npm` that records its argv. That proves a crafted value
// reaches the script as one argument and that only the exact string `false`
// adds `--apply`. The script's refusal of that argument is pinned in
// packages/backend/src/infra/__tests__/qa-throwaway-purge.test.ts.
//
// Run with: node --test scripts/ci/qa-purge-throwaways-workflow.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/qa-purge-throwaways.yml'), 'utf8')

/** The live (non-comment) lines of the workflow, in order. */
const live = workflow.split('\n').filter((line) => !/^\s*#/.test(line))

/** Every step of the one job, as its live lines. */
const steps = (() => {
  const jobSteps = live.findIndex((line) => /^\s{4}steps:\s*$/.test(line))
  assert.notEqual(jobSteps, -1, 'qa-purge-throwaways.yml has no job steps: — update this guard')
  const out = []
  for (const line of live.slice(jobSteps + 1)) {
    if (/^\s{6}- /.test(line)) out.push([line])
    else if (out.length) out[out.length - 1].push(line)
  }
  return out
})()

const purgeStep = steps.find((s) => s.some((line) => /^\s{6}- name: Purge throwaway QA identities\s*$/.test(line)))

/** The body of a step's `run: |` block, de-indented. */
function runBody(step) {
  const runIdx = step.findIndex((line) => /^\s+run: \|\s*$/.test(line))
  assert.notEqual(runIdx, -1, 'the purge step has no `run: |` block — update this guard')
  const body = step.slice(runIdx + 1)
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length))
  return body.map((l) => l.slice(indent)).join('\n')
}

/** The step's `env:` mapping, as written (expressions unresolved). */
function envOf(step) {
  const envIdx = step.findIndex((line) => /^\s{8}env:\s*$/.test(line))
  assert.notEqual(envIdx, -1, 'the purge step has no env: block — update this guard')
  const env = {}
  for (const line of step.slice(envIdx + 1)) {
    const m = line.match(/^\s{10}([A-Z0-9_]+):\s*(.*)$/)
    if (!m) break
    env[m[1]] = m[2].trim()
  }
  return env
}

/**
 * GitHub's expression substitution, for the one context these tests feed:
 * `${{ inputs.<name> }}` becomes the raw input value. Anything else becomes ''.
 */
const substitute = (text, inputs) =>
  text.replace(/\$\{\{\s*(?:github\.event\.)?inputs\.([a-z_]+)\s*\}\}|\$\{\{[^}]*\}\}/g, (_, name) =>
    name === undefined ? '' : String(inputs[name] ?? ''),
  )

/**
 * Run the purge step's real `run:` body under GitHub's default bash, with the
 * given inputs substituted the way GitHub would, and a stub `npm` on PATH that
 * writes its argv (NUL-separated) to a file. Returns the argv npm received.
 */
function runPurgeStep(inputs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-purge-step-'))
  try {
    const argvFile = path.join(dir, 'npm-argv')
    const marker = path.join(dir, 'pwned')
    const npm = path.join(dir, 'npm')
    writeFileSync(npm, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\n`)
    chmodSync(npm, 0o755)
    const script = path.join(dir, 'step.sh')
    writeFileSync(script, substitute(runBody(purgeStep), inputs))

    const env = { PATH: `${dir}:${process.env.PATH}`, PWNED_MARKER: marker }
    for (const [name, value] of Object.entries(envOf(purgeStep))) env[name] = substitute(value, inputs)

    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { env, encoding: 'utf8' })
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      pwned: existsSync(marker),
      argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split('\0').slice(0, -1) : null,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const NPM_PREFIX = ['run', '-s', 'qa:purge-throwaways', '-w', 'packages/backend', '--']

test('the purge step exists and is the one that holds the database credential', () => {
  assert.ok(purgeStep, 'qa-purge-throwaways.yml has no "Purge throwaway QA identities" step — update this guard')
  assert.match(envOf(purgeStep).QA_PURGE_DATABASE_URL ?? '', /secrets\.QA_PURGE_DATABASE_URL/)
})

test('no run: block inlines an input — each travels through an env var', () => {
  let runBlocks = 0
  for (const step of steps) {
    const runIdx = step.findIndex((line) => /^\s+(- )?run:/.test(line))
    if (runIdx === -1) continue
    runBlocks += 1
    const body = step.slice(runIdx).join('\n')
    assert.ok(!/\binputs\s*[.[]/i.test(body), `a run: block inlines an input (shell injection beside the credential): ${step[0].trim()}`)
  }
  assert.ok(runBlocks >= 3, `found ${runBlocks} run: blocks — the step parser no longer sees this workflow; update this guard`)
})

test('both inputs reach the purge step as env values', () => {
  const env = envOf(purgeStep)
  assert.equal(env.PURGE_RETENTION_DAYS, '${{ inputs.retention_days }}')
  assert.equal(env.PURGE_DRY_RUN, '${{ inputs.dry_run }}')
})

test('a crafted retention_days reaches npm as ONE argument and runs nothing', () => {
  for (const crafted of [
    '7"; echo pwned; "',
    // Closes the array, runs a command, reopens it: executes under the inline form.
    '7"); touch "$PWNED_MARKER"; echo pwned; args=(--retention-days "7',
    '$(touch "$PWNED_MARKER")',
    '`touch "$PWNED_MARKER"`',
    '7\n--apply',
  ]) {
    const r = runPurgeStep({ retention_days: crafted, dry_run: 'true' })
    assert.equal(r.status, 0, `step failed for ${JSON.stringify(crafted)}: ${r.stderr}`)
    assert.equal(r.pwned, false, `a command in retention_days ran: ${JSON.stringify(crafted)}`)
    assert.ok(!/^pwned$/m.test(r.stdout), `"echo pwned" ran for ${JSON.stringify(crafted)}`)
    assert.deepEqual(r.argv, [...NPM_PREFIX, '--retention-days', crafted], `argv for ${JSON.stringify(crafted)}`)
  }
})

test('only the exact string "false" turns on --apply; every other dry_run value is a dry run', () => {
  const ok = runPurgeStep({ retention_days: '7', dry_run: 'false' })
  assert.deepEqual(ok.argv, [...NPM_PREFIX, '--retention-days', '7', '--apply'])

  for (const dryRun of ['true', '', 'False', 'FALSE', 'false ', ' false', '0', 'no', 'false; true', '"false"']) {
    const r = runPurgeStep({ retention_days: '7', dry_run: dryRun })
    assert.equal(r.status, 0, `step failed for dry_run=${JSON.stringify(dryRun)}: ${r.stderr}`)
    assert.deepEqual(r.argv, [...NPM_PREFIX, '--retention-days', '7'], `dry_run=${JSON.stringify(dryRun)} turned on --apply`)
  }
})
