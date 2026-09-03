// Tests for the `ci` aggregator job's gate on `ci_config_checks` (#2321).
//
// The `Repo CI config checks` job (`ci_config_checks` in
// `.github/workflows/ci.yml`) is NOT a required status check in either active
// ruleset — it gates only TRANSITIVELY, through one shell block inside the
// `ci` aggregator job (`Lint, Type-check & Build`, which IS required). Nothing
// in GitHub's own configuration records the coupling; it is one `needs:`
// entry and one `if … exit 1` block, both inside the aggregator.
//
// Remove the `if` block, or drop `ci_config_checks` from `needs:`, and the
// whole `scripts/ci/*.test.mjs` glob becomes advisory SILENTLY — CI stays
// green either way. The protection is exactly as loud as this suite is.
//
// This file pins the two halves of that coupling:
//
//   1. the aggregator's `needs:` list still includes `ci_config_checks`, and
//   2. the aggregator still `exit 1`s when `needs.ci_config_checks.result`
//      is not `success`.
//
// Dependency-free by design (no js-yaml): the `ci` job is parsed with
// targeted readers over `readFileSync`, mirroring the sibling suite
// `change-classifier.test.mjs` — a fixed-shape block is read by hand, and a
// missing shape fails loudly (`assert.notEqual(…, -1, …)`) rather than
// passing vacuously. The file to read honors `process.env.CI_YML_PATH` (an
// env var, not argv — `node --test` owns argv), so the mutation proof can
// run this suite against a fixture copy of ci.yml without touching the real
// file.
//
// Run with: node --test scripts/ci/ci-config-gate.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
// CI_YML_PATH is how the mutation proof substitutes a fixture. `node --test`
// owns argv, so the override must ride the environment, not argv.
const CI_YML = process.env.CI_YML_PATH
  ? path.resolve(process.env.CI_YML_PATH)
  : path.join(ROOT, '.github/workflows/ci.yml')
const workflow = readFileSync(CI_YML, 'utf8')

/** Leading-whitespace width of a line. */
const indentOf = (line) => (line.match(/^ */) || [''])[0].length

/**
 * The `ci` job's block as lines: from the line whose key is exactly `ci`
 * (`^  ci:$`, NOT `ci_config_checks`) through the line before the next
 * 2-space-indented job key, or to EOF when the job is last in the file.
 * Returns null (so a caller can assert loudly) instead of silently reading
 * nothing.
 */
function ciJobBlock(workflowText) {
  const lines = workflowText.split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (/^  ci:\s*$/.test(lines[i])) starts.push(i)
  }
  if (starts.length === 0) return null
  if (starts.length > 1) {
    // A second exact `ci:` key is either a duplicate job — which would make
    // "the ci job" ambiguous — or a reshape this reader cannot reason about.
    throw new Error(
      `ci.yml has ${starts.length} lines matching \`^  ci:$\`; expected exactly one \`ci\` job`,
    )
  }
  const start = starts[0]
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-zA-Z_][a-zA-Z0-9_-]*:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return { lines: lines.slice(start, end), start }
}

/**
 * The job's `needs:` as an array of job names.
 *
 * Handles BOTH shapes GitHub Actions accepts, so a reformat between them
 * does not silently break this test:
 *   - flow form:  `needs: [a, b, c]`
 *   - block form:
 *         needs:
 *           - a
 *           - b
 * Returns null when neither shape is found (called within an assertion).
 */
function parseNeeds(jobLines) {
  for (let i = 0; i < jobLines.length; i++) {
    const flow = jobLines[i].match(/^\s{4}needs:\s*\[(.*)\]\s*$/)
    if (flow) {
      return flow[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    if (/^\s{4}needs:\s*$/.test(jobLines[i])) {
      const names = []
      for (let j = i + 1; j < jobLines.length; j++) {
        const item = jobLines[j].match(/^\s{5,}-\s*(.+?)\s*$/)
        if (item) {
          names.push(item[1].trim())
          continue
        }
        // Blank lines and comments between items are fine; anything else at
        // or shallower than the `needs:` key's indent ends the list.
        if (jobLines[j].trim() === '' || /^\s*#/.test(jobLines[j])) continue
        if (indentOf(jobLines[j]) <= 4) break
        return null
      }
      return names.length ? names : null
    }
  }
  return null
}

/** Every `run: |` / `run: >` script block in the job, as arrays of lines. */
function scriptBlocks(jobLines) {
  const blocks = []
  for (let i = 0; i < jobLines.length; i++) {
    if (!/^\s+run:\s*(\||>)\s*$/.test(jobLines[i])) continue
    const base = indentOf(jobLines[i])
    const script = []
    for (let j = i + 1; j < jobLines.length; j++) {
      // Blank lines are content inside a `run: |` block — they carry no
      // indentation, so they must not be read as the block's terminator.
      if (jobLines[j].trim() === '') continue
      if (indentOf(jobLines[j]) > base) script.push(jobLines[j])
      else break
    }
    if (script.length) blocks.push(script)
  }
  return blocks
}

// The guard line we pin, whitespace-tolerant between tokens:
//     if [ "${{ needs.ci_config_checks.result }}" != "success" ]; then
// The `!= "success"` is the load-bearing half: flipping it to `==` turns the
// guard into a no-op that passes the aggregator on every outcome, so the
// test must key on the comparison, not merely on the name being mentioned.
const GUARD_IF_RE =
  /^\s*if\s*\[\s*"\$\{\{\s*needs\.ci_config_checks\.result\s*\}\}"\s*!=\s*"success"\s*\]\s*;\s*then\s*$/
const EXIT_1_RE = /^\s*exit\s+1\s*$/

/**
 * True when a script block contains the guard: an `if` line whose condition
 * fails on a non-success `ci_config_checks` result, closed by its `fi` at
 * the same indentation, with `exit 1` somewhere in between. Matching `fi`
 * by indentation is what keeps a nested `if` from satisfying (or
 * short-circuiting) the scan.
 */
function hasFailingGuard(script) {
  for (let i = 0; i < script.length; i++) {
    if (!GUARD_IF_RE.test(script[i])) continue
    const ifIndent = indentOf(script[i])
    for (let j = i + 1; j < script.length; j++) {
      if (/^\s*fi\s*$/.test(script[j]) && indentOf(script[j]) === ifIndent) {
        if (script.slice(i + 1, j).some((l) => EXIT_1_RE.test(l))) return true
        break
      }
    }
  }
  return false
}

describe('the ci aggregator job gates ci_config_checks (#2321)', () => {
  test('ci_config_checks is still in the aggregator\'s `needs:` list', () => {
    const job = ciJobBlock(workflow)
    assert.notEqual(
      job,
      null,
      'ci.yml has no job whose key is exactly `ci` (a line matching `^  ci:$`)',
    )
    const needs = parseNeeds(job.lines)
    assert.notEqual(
      needs,
      null,
      'the `ci` job has no `needs:` list in flow (`needs: […]`) or block form',
    )
    assert.ok(
      needs.includes('ci_config_checks'),
      `the \`ci\` job's \`needs:\` no longer lists ci_config_checks — ` +
        `without it the whole scripts/ci/*.test.mjs glob is advisory silently. ` +
        `needs: = [${needs.join(', ')}]`,
    )
  })

  test('the aggregator fails on a non-success ci_config_checks result', () => {
    const job = ciJobBlock(workflow)
    assert.notEqual(
      job,
      null,
      'ci.yml has no job whose key is exactly `ci` (a line matching `^  ci:$`)',
    )
    const blocks = scriptBlocks(job.lines)
    assert.ok(
      blocks.length > 0,
      'the `ci` job has no `run: |`/`run: >` script blocks to guard with',
    )
    assert.equal(
      blocks.some(hasFailingGuard),
      true,
      'no `run:` block in the `ci` job has an `if` that exits 1 when ' +
        '`needs.ci_config_checks.result` is not "success" — the transitive ' +
        'gate on ci_config_checks is gone, so scripts/ci/*.test.mjs is ' +
        'advisory while CI stays green.',
    )
  })
})
