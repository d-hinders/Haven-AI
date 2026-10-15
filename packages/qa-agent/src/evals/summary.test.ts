/**
 * The $GITHUB_STEP_SUMMARY renderer (#3959 scope 7): per-task table with
 * pass rate, pass^k, median wall time, plus total cost, model and the
 * hosted MCP provenance.
 */

import { describe, expect, it } from 'vitest'
import { renderMarkdownSummary } from './summary.js'
import type { EvalReport } from './runner.js'

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    generatedAt: '2026-10-15T08:00:00.000Z',
    adapter: 'claude-code',
    trialsPerTask: 1,
    tasks: [
      {
        id: 'over-budget-direct-refused',
        title: 'Over-budget direct send is refused',
        category: 'over-budget',
        source: { kind: 'scenario', ref: 'over-budget-refused', note: 'test' },
        trials: [{ trial: 1, pass: true, graders: [], wallMs: 41000, costUsd: 0.2137, detail: '' }],
        passRate: 1,
        passAll: true,
        slowestSessionMs: 41000,
        medianSessionMs: 41000,
      },
      {
        id: 'direct-send-partial-budget',
        title: 'Partial-budget send succeeds',
        category: 'direct-payment',
        source: { kind: 'scenario', ref: 'direct-send', note: 'test' },
        trials: [{ trial: 1, pass: false, graders: [], wallMs: 39000, detail: 'no transfer' }],
        passRate: 0,
        passAll: false,
        slowestSessionMs: 39000,
        medianSessionMs: 39000,
      },
    ],
    tasksRun: 2,
    tasksPassingAll: 1,
    totalCostUsd: 0.2137,
    model: 'claude-sonnet-4-5',
    hostedMcp: { source: 'pr-checkout', commit: 'abc1234' },
    ...overrides,
  }
}

describe('renderMarkdownSummary', () => {
  it('renders the per-task table columns #3959 requires', () => {
    const md = renderMarkdownSummary(report())
    expect(md).toContain('| Task | Category | Pass rate | pass^k | Median session | Cost (USD) |')
    expect(md).toContain('| 100% | yes |')
    expect(md).toContain('| 0% | no |')
    expect(md).toContain('41.0s')
  })

  it('reports total cost, model and the hosted MCP commit (PR head, not dev)', () => {
    const md = renderMarkdownSummary(report())
    expect(md).toContain('$0.2137')
    expect(md).toContain('claude-sonnet-4-5')
    expect(md).toContain('abc1234')
    expect(md).toContain('not dev')
    // The standing caveat: backend error bodies stay dev-deployed.
    expect(md).toContain('dev-deployed')
  })

  it('names the dev stack instead of a commit for dev-deployed runs', () => {
    const md = renderMarkdownSummary(report({ hostedMcp: { source: 'dev-deployed', url: 'https://mcp.example/v1' } }))
    expect(md).toContain('deployed dev stack')
    expect(md).toContain('https://mcp.example/v1')
  })

  it('omits cost/model lines for lanes that do not report them (hermes)', () => {
    const md = renderMarkdownSummary(report({ totalCostUsd: undefined, model: undefined, hostedMcp: undefined }))
    expect(md).not.toContain('Total cost')
    expect(md).not.toContain('**Model:**')
    expect(md).toContain('| — |')
  })
})
