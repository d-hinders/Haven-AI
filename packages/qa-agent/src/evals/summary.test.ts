/**
 * The $GITHUB_STEP_SUMMARY renderer (#3959 scope 7): per-task table with
 * pass rate, pass^k, median wall time, plus total cost, the model identity
 * triple (#3992 C), the executed order (#3992 B) and the hosted MCP
 * provenance.
 */

import { describe, expect, it } from 'vitest'
import { renderMarkdownSummary } from './summary.js'
import type { EvalReport } from './runner.js'

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    generatedAt: '2026-10-15T08:00:00.000Z',
    adapter: 'claude-code',
    trialsPerTask: 1,
    order: ['over-budget-direct-refused', 'direct-send-partial-budget'],
    tasks: [
      {
        id: 'over-budget-direct-refused',
        title: 'Over-budget direct send is refused',
        category: 'over-budget',
        source: { kind: 'scenario', ref: 'over-budget-refused', note: 'test' },
        drainsBudget: false,
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
        drainsBudget: false,
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
    inferenceServerBuild: 'anthropic first-party',
    harnessVersion: 'qa-agent 0.0.0',
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

  it('carries the model identity triple in every report, or "not reported" (#3992 C)', () => {
    const md = renderMarkdownSummary(report())
    expect(md).toContain('**Model:** claude-sonnet-4-5')
    expect(md).toContain('**Inference server build:** anthropic first-party')
    expect(md).toContain('**Harness version:** qa-agent 0.0.0')
    const bare = renderMarkdownSummary(report({ model: undefined, inferenceServerBuild: undefined, harnessVersion: undefined }))
    expect(bare).toContain('**Model:** not reported')
    expect(bare).toContain('**Inference server build:** not reported')
    expect(bare).toContain('**Harness version:** not reported')
  })

  it('records the executed order and the shuffle seed (#3992 B)', () => {
    const md = renderMarkdownSummary(report({ order: ['b', 'a'], shuffleSeed: 7 }))
    expect(md).toContain('Executed order: b → a (shuffle seed 7)')
  })

  it('marks the drainer k=1 (drains budget) instead of a comparable pass^k (#3992 A3)', () => {
    const withDrainer = report({
      order: ['direct-send-full-remaining'],
      tasks: [
        {
          id: 'direct-send-full-remaining',
          title: 'Drainer',
          category: 'direct-payment',
          source: { kind: 'scenario', ref: 'x', note: 'n' },
          drainsBudget: true,
          trials: [{ trial: 1, pass: true, graders: [], wallMs: 1000, detail: '' }],
          passRate: 1,
          passAll: true,
          slowestSessionMs: 1000,
          medianSessionMs: 1000,
        },
      ],
      tasksRun: 1,
      tasksPassingAll: 1,
    })
    const md = renderMarkdownSummary(withDrainer)
    expect(md).toContain('k=1 (drains budget)')
  })

  it('names the dev stack instead of a commit for dev-deployed runs', () => {
    const md = renderMarkdownSummary(report({ hostedMcp: { source: 'dev-deployed', url: 'https://mcp.example/v1' } }))
    expect(md).toContain('deployed dev stack')
    expect(md).toContain('https://mcp.example/v1')
  })

  it('omits the cost line for lanes that do not report one, but keeps "not reported" identity (#3992 C)', () => {
    const md = renderMarkdownSummary(report({ totalCostUsd: undefined, hostedMcp: undefined }))
    expect(md).not.toContain('Total cost')
    expect(md).toContain('| — |')
    expect(md).toContain('**Model:**')
  })
})
