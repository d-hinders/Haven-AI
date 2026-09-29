/**
 * The run report `qa:dev` prints (paste into docs/bug-reports/) — extracted
 * from run.ts so it can be tested without booting the harness (#3459).
 */

import type { Scenario, ScenarioResult } from '../scenarios/types.js'

export type ScenarioOutcome = { scenario: Scenario; result: ScenarioResult }

export function formatRunReport(apiUrl: string, results: ScenarioOutcome[], now = new Date()): string[] {
  const lines = [
    '\n─── run report (paste into docs/bug-reports/) ───',
    `# Money-flow QA run — ${now.toISOString()}`,
    `Target: ${apiUrl} (Base Sepolia)\n`,
    '| Scenario | Invariant | Result | Detail |',
    '|---|---|---|---|',
  ]
  for (const { scenario, result } of results) {
    const status = result.skipped ? 'skip' : result.pass ? 'pass' : '**FAIL**'
    lines.push(`| ${scenario.name} | ${scenario.invariant} | ${status} | ${result.detail} |`)
  }
  // #3459: a throwaway agent the harness could not revoke is a leak, reported
  // beside the table so it never edits a verdict or a Detail cell.
  const warned = results.filter((r) => r.result.cleanupWarning)
  if (warned.length > 0) {
    lines.push('\nCleanup warnings (verdicts above are unaffected):')
    for (const { scenario, result } of warned) lines.push(`- ${scenario.name}: ${result.cleanupWarning}`)
  }
  return lines
}
