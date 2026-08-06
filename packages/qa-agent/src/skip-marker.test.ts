import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #1044 contract: the skip-visibility chain is three parties agreeing on one
 * string. `run.ts` prints `green-with-skips:` when legs were skipped; the
 * qa-dev workflow's "Coverage completeness" step greps for EXACTLY that
 * marker; qa-freshness then reads that step's conclusion. If the marker
 * drifts in either place the whole chain goes silently blind — a green run
 * with skips would read as full coverage again, which is the bug #1044
 * closed. Same three-way-drift discipline as scripts/ci/money-path.test.mjs.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUN_TS = readFileSync(path.join(HERE, 'run.ts'), 'utf8')
const WORKFLOW = readFileSync(path.join(HERE, '../../../.github/workflows/qa-dev.yml'), 'utf8')

describe('skip-visibility contract (#1044)', () => {
  it('run.ts emits the marker the workflow greps for', () => {
    expect(RUN_TS).toContain('green-with-skips:')
    expect(WORKFLOW).toContain('grep -q "green-with-skips:" qa-run.log')
  })

  it('the workflow captures the log the grep reads', () => {
    // The marker is useless if stdout is not tee'd to the file the
    // completeness step inspects.
    expect(WORKFLOW).toContain('tee qa-run.log')
  })

  it('strict mode reads the env var the workflow forwards', () => {
    expect(RUN_TS).toContain("process.env.QA_REQUIRE_ALL_LEGS === '1'")
    expect(WORKFLOW).toContain('QA_REQUIRE_ALL_LEGS')
  })

  it('the completeness step name matches what qa-freshness inspects', () => {
    const gate = readFileSync(path.join(HERE, '../../../scripts/ci/qa-freshness.mjs'), 'utf8')
    expect(WORKFLOW).toContain('- name: Coverage completeness')
    expect(gate).toContain("step.name === 'Coverage completeness'")
  })
})
