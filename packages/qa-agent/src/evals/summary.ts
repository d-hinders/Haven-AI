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
  if (report.taskFilter !== undefined) {
    lines.push('')
    lines.push(`**Task filter (#4218):** \`${report.taskFilter.join('`, `')}\` — a FILTERED run; the pass^k line above is NOT a whole-suite green.`)
  }
  lines.push('')
  lines.push(`Executed order: ${report.order.join(' → ')}${report.shuffleSeed !== undefined ? ` (shuffle seed ${report.shuffleSeed})` : ''}`)
  lines.push('')
  lines.push('| Task | Category | Pass rate | pass^k | Median session | Cost (USD) |')
  lines.push('|---|---|---|---|---|---|')
  for (const t of report.tasks) {
    const rate = `${Math.round(t.passRate * 100)}%`
    // The drainer runs ONE trial on purpose — its pass^k is not comparable
    // with the k-trial tasks', so the cell says so instead of yes/no.
    const passK = t.drainsBudget ? 'k=1 (drains budget)' : t.passAll ? 'yes' : 'no'
    const costs = t.trials.map((r) => r.costUsd).filter((c): c is number => c !== undefined)
    const cost = costs.length > 0 ? usd(costs.reduce((a, b) => a + b, 0) / costs.length) : '—'
    lines.push(`| ${t.id} | ${t.category} | ${rate} | ${passK} | ${ms(t.medianSessionMs)} | ${cost} |`)
  }
  // Failed trials, with the public-safe tool trace (names + error codes
  // only), so a failure can be diagnosed from the run page itself.
  const failed = report.tasks.flatMap((t) => t.trials.filter((r) => !r.pass).map((r) => ({ t, r })))
  if (failed.length > 0) {
    lines.push('')
    lines.push('**Failed trials**')
    lines.push('')
    for (const { t, r } of failed) {
      lines.push(`- \`${t.id}\` trial ${r.trial}: ${r.detail}`)
      if (r.trace) lines.push(`  - tools: ${r.trace.length ? r.trace.map((s) => `\`${s}\``).join(' → ') : '(no tool calls)'}`)
    }
  }
  lines.push('')
  // Model identity in EVERY report (#3992 C): absent values say so instead
  // of disappearing — an unpinned model change must never read as a
  // regression in the trend lines.
  lines.push(`**Model:** ${report.model ?? 'not reported'}`)
  lines.push(`**Inference server build:** ${report.inferenceServerBuild ?? 'not reported'}`)
  lines.push(`**Harness version:** ${report.harnessVersion ?? 'not reported'}`)
  if (report.budgetEvents && report.budgetEvents.length > 0) {
    lines.push('')
    for (const e of report.budgetEvents) {
      lines.push(
        `> Budget increase detected before ${e.detectedBeforeTask} trial ${e.detectedBeforeTrial}: ${e.previousRemainingAtomic} → ${e.observedRemainingAtomic} (refill boundary crossed mid-run).`,
      )
    }
  }
  if (report.guardEvents && report.guardEvents.length > 0) {
    lines.push('')
    for (const e of report.guardEvents) {
      lines.push(`> Budget wait skipped before ${e.beforeTask} trial ${e.beforeTrial}: ${e.reason}.`)
    }
  }
  if (report.totalCostUsd !== undefined) {
    lines.push('')
    lines.push(`**Total cost the run reported:** ${usd(report.totalCostUsd)}`)
  }
  if (report.hostedMcp) {
    const where =
      report.hostedMcp.source === 'pr-checkout'
        ? `built from this checkout${report.hostedMcp.commit ? ` @ \`${report.hostedMcp.commit}\`` : ''} (the dispatched commit, not the deployed dev stack)`
        : 'the deployed dev stack'
    lines.push(`**Hosted MCP:** ${where}${report.hostedMcp.url ? ` — ${report.hostedMcp.url}` : ''}`)
    lines.push('')
    lines.push('> Error bodies produced by `packages/backend` stay dev-deployed whatever this job checked out.')
  }
  return `${lines.join('\n')}\n`
}
