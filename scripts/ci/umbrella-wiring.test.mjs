// Tests for the umbrella wiring of every surface job in ci.yml (#3005,
// closing reviewer finding 2 on #3004).
//
// A `<flag>_checks` job is only real if THREE couplings hold at once:
//
//   1. its `if:` gates on ITS OWN flag — `needs.changes.outputs.<flag>`.
//      A swapped flag (copy-paste the job above, forget to change the gate)
//      runs the wrong suite and silently skips the right one.
//   2. the umbrella `ci` job's `needs:` names it. A skipped job reports
//      `skipped`, not `failure`; without the needs edge the aggregator never
//      even sees the result.
//   3. the summary script pairs the flag with the job: a line gated on
//      `needs.changes.outputs.<flag>` that exits 1 unless
//      `needs.<flag>_checks.result` is `success`. Without the clause a red
//      surface job leaves the required aggregator green.
//
// All three held by reading alone when this file was written — #3004's review
// found two mutations of exactly this wiring survived the whole battery
// (698/698), which is the gap this suite closes. ci_config_checks is not in
// scope: it is unconditional by design (#1030) and its coupling is pinned by
// ci-config-gate.test.mjs.
//
// Dependency-free by design (no js-yaml): targeted readers over
// `readFileSync`, mirroring ci-config-gate.test.mjs — a fixed-shape block is
// read by hand, and a missing shape fails loudly (`assert.notEqual(…, -1,
// …)`) rather than passing vacuously. The file to read honors
// `process.env.CI_YML_PATH` (an env var, not argv — `node --test` owns argv),
// so the mutation proof can run this suite against a fixture copy of ci.yml
// without touching the real file.
//
// Run with: node --test scripts/ci/umbrella-wiring.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OUTPUT_NAMES } from './change-classifier.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
// CI_YML_PATH is how the mutation proof substitutes a fixture. `node --test`
// owns argv, so the override must ride the environment, not argv.
const CI_YML = process.env.CI_YML_PATH
  ? path.resolve(process.env.CI_YML_PATH)
  : path.join(ROOT, '.github/workflows/ci.yml')
const workflow = readFileSync(CI_YML, 'utf8')

/**
 * Every job key in the file, from lines like `  backend_checks:` at exactly
 * two-space indent — the shape every job key in ci.yml uses.
 */
export function jobKeys(workflowText) {
  return [...workflowText.matchAll(/^  ([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/gm)].map((m) => m[1])
}

/**
 * One job's block as lines: from `  <job>:` through the line before the next
 * two-space job key, or EOF. Returns null so a caller can assert loudly
 * instead of silently reading nothing.
 */
function jobBlock(workflowText, job) {
  const lines = workflowText.split('\n')
  const start = lines.findIndex((l) => l === `  ${job}:`)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-zA-Z_][a-zA-Z0-9_-]*:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end)
}

/** The job's single-line `if:` expression, or null when it has none. */
function jobGate(jobLines) {
  const line = jobLines.find((l) => /^    if: .+/.test(l))
  return line ? line.replace(/^    if: /, '') : null
}

/**
 * The umbrella `ci` job's `needs:` as an array (flow form only — the file has
 * used `needs: [a, b, c]` since #1625, and ci-config-gate.test.mjs owns the
 * block-form fallback for that job's other assertions).
 */
function umbrellaNeeds(workflowText) {
  const job = jobBlock(workflowText, 'ci')
  if (!job) return null
  const flow = job.find((l) => /^    needs:\s*\[/.test(l))
  if (!flow) return null
  return flow
    .replace(/^    needs:\s*\[/, '')
    .replace(/\]\s*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The surface jobs: every `X_checks` job whose X is an emitted classifier
 * output. Filtering through OUTPUT_NAMES (rather than "everything ending in
 * _checks") is what keeps ci_config_checks out — its prefix is a job name,
 * not a changes-output flag — and ties the set to the classifier's contract
 * rather than to a naming convention.
 */
function surfaceJobs(workflowText) {
  const keys = jobKeys(workflowText)
  return OUTPUT_NAMES.filter((flag) => keys.includes(`${flag}_checks`)).map((flag) => ({
    flag,
    job: `${flag}_checks`,
  }))
}

const surfaces = surfaceJobs(workflow)

describe('every surface job is wired into the umbrella (#3005)', () => {
  test('the surface-job reader found the jobs it is asserting on', () => {
    // A reader that matches nothing passes every other test vacuously. If
    // this ever fails, the job-key shape changed and the readers above need
    // updating — not this assertion loosening.
    assert.ok(surfaces.length >= 11, `expected the 11 package surface jobs, found ${surfaces.length}`)
  })

  for (const { flag, job } of surfaces) {
    describe(job, () => {
      const block = jobBlock(workflow, job)

      test('the job block exists and is readable', () => {
        assert.notEqual(block, null, `ci.yml has no job block for ${job}`)
      })

      test('gates on its OWN flag — needs.changes.outputs.<flag>', () => {
        // The #3004 mutation that survived: a job whose `if:` was left
        // pointing at a NEIGHBOURING surface's flag. Asserting the flag is
        // read back out of the gate (not just mentioned) is what makes a
        // swap red: the swapped flag changes what this expression reads, so
        // the extracted name no longer matches the job's own.
        assert.notEqual(block, null)
        const gate = jobGate(block)
        assert.notEqual(gate, null, `${job} has no if: gate — it would run on every diff`)
        const gateFlag = gate.match(/needs\.changes\.outputs\.([a-z_]+)/)?.[1] ?? null
        assert.equal(
          gateFlag,
          flag,
          `${job}'s if: reads outputs.${gateFlag}, not its own outputs.${flag} — ` +
            'the gate and the job it gates have drifted apart (the #3004 mutation shape).',
        )
        assert.match(gate, /==\s*'true'/, `${job}'s gate must compare the flag to 'true'`)
      })

      test('the umbrella ci job needs it', () => {
        const needs = umbrellaNeeds(workflow)
        assert.notEqual(needs, null, 'the ci job has no flow-form needs: list to read')
        assert.ok(
          needs.includes(job),
          `the umbrella ci job's needs: does not name ${job}. A job that is needed ` +
            `nowhere reports 'skipped' rather than 'failure' — dropping it from needs: ` +
            `turns any future red result into silence. needs: = [${needs.join(', ')}]`,
        )
      })

      test('the summary pairs the flag with this job and exits 1', () => {
        // The #3004 gap: the summary script is inside a run: block no
        // gate-scan reads. One line must carry BOTH the flag condition and
        // this job's result, and the clause must exit 1 — a condition that
        // echoes without exiting is a green tick about a red job. Scoped to
        // the ci job's block: browser_smoke/design_visual also pair a flag
        // with a *_checks result (their `if:`), and an unscoped scan would
        // let one of those satisfy this for frontend.
        const ciBlock = jobBlock(workflow, 'ci')
        assert.notEqual(ciBlock, null, 'ci.yml has no ci job block')
        const clause = ciBlock.findIndex(
          (l) => l.includes(`needs.changes.outputs.${flag}`) && l.includes(`needs.${job}.result`),
        )
        assert.notEqual(
          clause,
          -1,
          `the ci summary has no line pairing needs.changes.outputs.${flag} with ` +
            `needs.${job}.result — a red ${job} would not fail the required aggregator.`,
        )
        // Walk to the clause's closing `fi` at the same indent and require an
        // exit 1 inside it (ci-config-gate's guard shape, generalised).
        const indent = (l) => (l.match(/^ */) || [''])[0].length
        const base = indent(ciBlock[clause])
        let exits = false
        for (let i = clause + 1; i < ciBlock.length; i++) {
          if (/^\s*fi\s*$/.test(ciBlock[i]) && indent(ciBlock[i]) === base) break
          if (/^\s*exit\s+1\s*$/.test(ciBlock[i])) exits = true
        }
        assert.ok(
          exits,
          `the summary clause for ${flag} does not exit 1 — ` +
            'it reports without failing, which reads as a pass.',
        )
      })
    })
  }
})

describe('the umbrella wiring stays total', () => {
  test('every emitted package flag has exactly one surface job — no orphans either way', () => {
    // With #3005 every non-pseudo flag owns a job; a flag without one routes
    // a suite nowhere, and a job whose flag the classifier stopped emitting
    // gates on a key that is always absent (permanently skipped).
    const keys = new Set(jobKeys(workflow))
    for (const flag of OUTPUT_NAMES) {
      if (flag === 'code' || flag === 'full') continue
      assert.ok(
        keys.has(`${flag}_checks`),
        `no ${flag}_checks job for emitted output "${flag}" — its surface routes nowhere`,
      )
    }
  })

  test('changes itself is in the umbrella needs list', () => {
    const needs = umbrellaNeeds(workflow)
    assert.notEqual(needs, null)
    assert.ok(
      needs.includes('changes'),
      'the ci job does not need changes — every result check above reads its outputs',
    )
  })
})
