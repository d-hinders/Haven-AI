import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #1044 contract: the skip-visibility chain is three parties agreeing on one
 * string. `run.ts` prints `green-with-skips:` when legs were skipped; the
 * qa-dev workflow's "Coverage completeness" step greps for EXACTLY that
 * marker and exits 1, which fails the money-flow job; qa-freshness admits a
 * run only on that job's conclusion. If the marker drifts in either place, or
 * the step stops failing the job, the whole chain goes silently blind — a
 * green run with skips would read as full coverage again, which is the bug
 * #1044 closed. Same three-way-drift discipline as scripts/ci/money-path.test.mjs.
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
    // completeness step inspects. Since #3338 each attempt tees its own log
    // and qa-run.log is a copy of the final attempt's, on both paths.
    expect(WORKFLOW).toContain('tee "qa-run.attempt-$i.log"')
    expect(WORKFLOW.split('cp "qa-run.attempt-$i.log" qa-run.log').length - 1).toBe(2)
  })

  it('strict mode reads the env var the workflow forwards', () => {
    expect(RUN_TS).toContain("process.env.QA_REQUIRE_ALL_LEGS === '1'")
    expect(WORKFLOW).toContain('QA_REQUIRE_ALL_LEGS')
  })

  it('a skip fails the money-flow job itself: the step exits 1 and nothing in the job continues on error', () => {
    // #3368 removed qa-freshness's step-level completeness warning: it could
    // never fire, because a failing step fails the job and the gate only admits
    // a job that succeeded. That removal is safe exactly as long as this holds.
    const job = /^ {2}money-flow:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/m.exec(WORKFLOW)
    expect(job).not.toBeNull()
    // The YAML key, not the word: the workflow's own comment names it.
    expect(job![1]).not.toMatch(/^\s*continue-on-error\s*:/m)
    const step = /- name: Coverage completeness\n([\s\S]*?)(?=\n {6}- name:|(?![\s\S]))/.exec(job![1])
    expect(step).not.toBeNull()
    expect(step![1]).toMatch(/grep -q "green-with-skips:" qa-run\.log[\s\S]*?exit 1/)
  })
})
