/**
 * Deterministic money-flow QA harness (#575) — `npm run qa:dev`.
 *
 * Drives the real Haven money-movement path on Base Sepolia against the shared
 * dev backend, using the seeded QA identity (#574), and asserts the #420
 * invariants. No LLM, fixed inputs, asserted outputs; exits non-zero on any
 * failure. Prints a summary suitable for a docs/bug-reports/ run report.
 *
 * Config: the QA_* env (see packages/qa-agent/README.md + docs/operations/agent-qa.md).
 */

import { ethers } from 'ethers'
import { loadQaConfig, QaConfigError } from './config.js'
import { HavenApi } from './lib/haven-api.js'
import type { Scenario, ScenarioContext, ScenarioResult } from './scenarios/types.js'
import { withinBudgetSettle } from './scenarios/within-budget-settle.js'
import { overBudgetQueue } from './scenarios/over-budget-queue.js'
import { x402OverBudgetRejected } from './scenarios/x402-over-budget-rejected.js'
import { x402Settle } from './scenarios/x402-settle.js'
import { x402Sweep } from './scenarios/x402-sweep.js'

// Deterministic, no-LLM scenarios run in order — five money-flow invariants:
// within-budget settle, over-budget queue, x402 over-budget reject, x402 settle,
// and delegate sweep recovery (#603/#684).
const SCENARIOS: Scenario[] = [
  withinBudgetSettle,
  overBudgetQueue,
  x402OverBudgetRejected,
  x402Settle,
  x402Sweep,
]

async function main(): Promise<void> {
  let cfg
  try {
    cfg = loadQaConfig()
  } catch (e) {
    if (e instanceof QaConfigError) {
      console.error(`✗ ${e.message}`)
      process.exit(2)
    }
    throw e
  }

  const ctx: ScenarioContext = {
    cfg,
    api: new HavenApi(cfg),
    delegateKey: cfg.delegateKey,
    delegateAddress: new ethers.Wallet(cfg.delegateKey).address,
  }

  console.log(`Haven money-flow QA → ${cfg.apiUrl}`)
  console.log(`  delegate ${ctx.delegateAddress}\n`)

  const results: { scenario: Scenario; result: ScenarioResult }[] = []
  for (const scenario of SCENARIOS) {
    process.stdout.write(`• ${scenario.name} … `)
    let result: ScenarioResult
    try {
      result = await scenario.run(ctx)
    } catch (e) {
      result = { pass: false, detail: e instanceof Error ? e.message : String(e) }
    }
    const tag = result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL'
    console.log(`${tag} — ${result.detail}`)
    results.push({ scenario, result })
  }

  const failures = results.filter((r) => !r.result.pass && !r.result.skipped)
  printRunReport(cfg.apiUrl, results)

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length}/${results.length} scenario(s) failed`)
    process.exit(1)
  }
  console.log(`\n✓ all ${results.length} scenario(s) passed`)
}

function printRunReport(
  apiUrl: string,
  results: { scenario: Scenario; result: ScenarioResult }[],
): void {
  console.log('\n─── run report (paste into docs/bug-reports/) ───')
  console.log(`# Money-flow QA run — ${new Date().toISOString()}`)
  console.log(`Target: ${apiUrl} (Base Sepolia)\n`)
  console.log('| Scenario | Invariant | Result | Detail |')
  console.log('|---|---|---|---|')
  for (const { scenario, result } of results) {
    const status = result.skipped ? 'skip' : result.pass ? 'pass' : '**FAIL**'
    console.log(`| ${scenario.name} | ${scenario.invariant} | ${status} | ${result.detail} |`)
  }
}

main().catch((e) => {
  console.error('\n✗ harness crashed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
