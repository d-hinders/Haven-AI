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

// The RAW lines, comments included. A `#` line inside a `run: |` block is a
// bash comment, not a YAML one, and GitHub still pastes `${{ }}` into it — a
// value with a newline ends the comment and the rest runs as shell. So no
// line is dropped before the run: block is cut out (#4740 review, cell R7);
// YAML comments are skipped only where a parser below reads YAML keys.
const lines = workflow.split('\n')
const isYamlComment = (line) => /^\s*#/.test(line)
const indentOf = (line) => line.match(/^\s*/)[0].length

/** Every step of the one job, as its raw lines. */
const steps = (() => {
  const jobSteps = lines.findIndex((line) => /^\s{4}steps:\s*$/.test(line))
  assert.notEqual(jobSteps, -1, 'qa-purge-throwaways.yml has no job steps: — update this guard')
  const out = []
  for (const line of lines.slice(jobSteps + 1)) {
    if (/^\s{6}- /.test(line)) out.push([line])
    else if (out.length) out[out.length - 1].push(line)
  }
  return out
})()

const purgeStep = steps.find((s) => s.some((line) => /^\s{6}- name: Purge throwaway QA identities\s*$/.test(line)))

/**
 * A step's `run:` value as raw lines: the `run:` line itself, then every line
 * indented deeper than the `run` key (blank lines included). Comment lines
 * inside count — they are script. A YAML comment after the block, at the key's
 * indent or less, ends it.
 */
function runLines(step) {
  const runIdx = step.findIndex((line) => /^\s+(- )?run:/.test(line) && !isYamlComment(line))
  if (runIdx === -1) return null
  const keyIndent = step[runIdx].indexOf('run:')
  const out = [step[runIdx]]
  for (const line of step.slice(runIdx + 1)) {
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break
    out.push(line)
  }
  return out
}

/** The body of a step's `run: |` block, de-indented. */
function runBody(step) {
  const block = runLines(step)
  assert.ok(block && /run: \|\s*$/.test(block[0]), 'the purge step has no `run: |` block — update this guard')
  const body = block.slice(1)
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  const indent = Math.min(...body.filter((l) => l.trim()).map(indentOf))
  return body.map((l) => l.slice(indent)).join('\n')
}

/** The step's `env:` mapping, as written (expressions unresolved). */
function envOf(step) {
  const envIdx = step.findIndex((line) => /^\s{8}env:\s*$/.test(line))
  assert.notEqual(envIdx, -1, 'the purge step has no env: block — update this guard')
  const env = {}
  for (const line of step.slice(envIdx + 1)) {
    if (isYamlComment(line) || line.trim() === '') continue
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
    const block = runLines(step)
    if (!block) continue
    runBlocks += 1
    const body = block.join('\n')
    assert.ok(!/\binputs\s*[.[]/i.test(body), `a run: block inlines an input (shell injection beside the credential): ${step[0].trim()}`)
    // Stricter: no expression at all. `${{ env.X }}` or `${{ inputs['x'] }}`
    // is pasted into the script exactly like `${{ inputs.x }}`; a run: block
    // here reads values as shell variables only.
    assert.ok(!body.includes('${{'), `a run: block contains a \${{ }} expression (read it as a shell variable instead): ${step[0].trim()}`)
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
    // Argument injection, no shell command needed: under the inline form this
    // put `--apply` into argv with dry_run=true, and the purge deleted for real.
    '7" --apply "',
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
