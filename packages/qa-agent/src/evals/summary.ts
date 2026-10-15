/**
 * The GitHub job-summary half of the report (#3959 scope 7): a per-task
 * markdown table — pass rate, pass^k, median wall time per session — plus
 * the run's total cost, the model and the hosted MCP commit, rendered to
 * `$GITHUB_STEP_SUMMARY` by the workflow. The full JSON report stays the
 * artifact; this is the version readable WITHOUT opening it.
 */

import type { EvalReport } from './runner.js'

function usd(n: number): string {
  return `$${n.toFixed(4)}`
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

export function renderMarkdownSummary(report: EvalReport): string {
  const lines: string[] = []
  lines.push(`## Agent evals — ${report.adapter}`)
  lines.push('')
  lines.push(`${report.generatedAt} · ${report.trialsPerTask} trial(s) per task · pass^k on **${report.tasksPassingAll}/${report.tasksRun}** tasks`)
  lines.push('')
  lines.push('| Task | Category | Pass rate | pass^k | Median session | Cost (USD) |')
  lines.push('|---|---|---|---|---|---|')
  for (const t of report.tasks) {
    const rate = `${Math.round(t.passRate * 100)}%`
    const passK = t.passAll ? 'yes' : 'no'
    const costs = t.trials.map((r) => r.costUsd).filter((c): c is number => c !== undefined)
    const cost = costs.length > 0 ? usd(costs.reduce((a, b) => a + b, 0) / costs.length) : '—'
    lines.push(`| ${t.id} | ${t.category} | ${rate} | ${passK} | ${ms(t.medianSessionMs)} | ${cost} |`)
  }
  lines.push('')
  if (report.totalCostUsd !== undefined) {
    lines.push(`**Total cost the run reported:** ${usd(report.totalCostUsd)}`)
  }
  if (report.model) {
    lines.push(`**Model:** ${report.model}`)
  }
  if (report.hostedMcp) {
    const where =
      report.hostedMcp.source === 'pr-checkout'
        ? `built from this checkout${report.hostedMcp.commit ? ` @ \`${report.hostedMcp.commit}\`` : ''} (the PR head, not dev)`
        : 'the deployed dev stack'
    lines.push(`**Hosted MCP:** ${where}${report.hostedMcp.url ? ` — ${report.hostedMcp.url}` : ''}`)
    lines.push('')
    lines.push('> Error bodies produced by `packages/backend` stay dev-deployed whatever this job checked out.')
  }
  return `${lines.join('\n')}\n`
}
