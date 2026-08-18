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
import { x402Delegation3009 } from './scenarios/x402-delegation-3009.js'
import { x402Delegation3009Sweep } from './scenarios/x402-delegation-3009-sweep.js'
import { x402Erc7710Settle } from './scenarios/x402-erc7710-settle.js'
import { x402Erc7710Sdk } from './scenarios/x402-erc7710-sdk.js'
import { x402Erc7710Hosted } from './scenarios/x402-erc7710-hosted.js'
import { x402HostedMcpSigner } from './scenarios/x402-hosted-mcp-signer.js'
import { x402CatalogGuidedPurchase } from './scenarios/x402-catalog-guided-purchase.js'
import { delegationLifecycle } from './scenarios/delegation-lifecycle.js'
import { thrownErrorDetail } from './lib/thrown-error-detail.js'
import { runPreflight, formatPreflight } from './lib/preflight.js'

// Deterministic, no-LLM scenarios run in order — seven money-flow invariants:
// within-budget settle, over-budget queue, x402 over-budget reject, x402 settle,
// delegate sweep recovery (#603/#684), and the delegation-rail EIP-3009 bridge
// in both halves (#946) — settle, and verify-without-settle → sweep.
//
// The last two run a SECOND, delegation-rail identity: the rail is a property
// of the account, so the seeded legacy-rail agent cannot exercise it. They are
// ordered settle-then-sweep so a settle failure is diagnosed against a clean
// delegate rather than one the sweep case has already left money on.
//
// `x402-hosted-mcp-signer` (#1154) is the DEFAULT user topology — hosted MCP
// plus a local edge signer — and shares that delegation-rail identity. It runs
// after the 3009 legs so that a hosted-topology failure is diagnosed against a
// rail the two legs above have already shown to be healthy; its residual
// assertion is a DELTA, so sub-floor dust an earlier leg left behind cannot
// make it red for someone else's reason.
//
// `x402-catalog-guided-purchase` (#1312) reuses that same hosted-topology
// identity and residual discipline, retargeted at the epic #1305 guided entry
// point (`haven_prepare_catalog_purchase` → payment_id-only sign/settle).
// Runs immediately after `x402-hosted-mcp-signer` for the same reason: a
// guided-path failure is diagnosed against a topology the sibling leg has
// already shown to be healthy.
const SCENARIOS: Scenario[] = [
  withinBudgetSettle,
  overBudgetQueue,
  x402OverBudgetRejected,
  x402Settle,
  x402Sweep,
  x402Delegation3009,
  x402Delegation3009Sweep,
  x402Erc7710Settle,
  // #1457: the SDK topology, after the raw-API leg so a failure here is
  // diagnosable against a surface the sibling leg has already shown healthy.
  x402Erc7710Sdk,
  x402HostedMcpSigner,
  // #1457: the DEFAULT topology (hosted MCP + local signer), placed straight
  // after the hosted leg so a failure here is diagnosable against a topology
  // the sibling has already shown healthy.
  x402Erc7710Hosted,
  x402CatalogGuidedPurchase,
  delegationLifecycle,
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

  // #1530: state the preconditions BEFORE the first leg. The harness used to
  // assert only what happened during a run, so an exhausted merchant
  // settlement wallet presented as an unexplained payment failure and cost a
  // day of diagnosis. Printed unconditionally — a slow drain is only visible
  // as a trend, and the number is most useful in the log of the run that was
  // chasing something else.
  const preflight = await runPreflight(cfg)
  console.log(formatPreflight(preflight))
  if (preflight.blocked) {
    // Refuse rather than run: every leg downstream would fail for this reason
    // and report it as its own, which is exactly the masking #1530 describes.
    console.error(
      '\n✗ preflight: a resource this run consumes is below its floor. ' +
        'Fix it before reading anything below — the legs cannot pass without it.',
    )
    process.exit(1)
  }
  console.log('')

  const results: { scenario: Scenario; result: ScenarioResult }[] = []
  for (const scenario of SCENARIOS) {
    process.stdout.write(`• ${scenario.name} … `)
    let result: ScenarioResult
    try {
      result = await scenario.run(ctx)
    } catch (e) {
      // Not just e.message: the SDK's errors carry structured context (#1518)
      // and the message alone is generic by construction.
      result = { pass: false, detail: thrownErrorDetail(e) }
    }
    const tag = result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL'
    console.log(`${tag} — ${result.detail}`)
    results.push({ scenario, result })
  }

  const failures = results.filter((r) => !r.result.pass && !r.result.skipped)
  const skipped = results.filter((r) => r.result.skipped)
  printRunReport(cfg.apiUrl, results)

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length}/${results.length} scenario(s) failed`)
    process.exit(1)
  }

  // #1044: a skipped leg is UNEXERCISED coverage, and the promotion gate keys
  // on this run's green. Say it loudly, in a machine-findable shape, instead of
  // folding skips into "all passed" — that fold is how a permanently-skipping
  // leg read as coverage for weeks.
  if (skipped.length > 0) {
    console.log(`\n⚠ green-with-skips: ${skipped.length} scenario(s) NEVER RAN:`)
    for (const { scenario, result } of skipped) {
      console.log(`  - ${scenario.name}: ${result.detail}`)
    }
    if (process.env.QA_REQUIRE_ALL_LEGS === '1') {
      // Strict mode — flipped on once the operator has provisioned every
      // leg's identity. From then on a skip is a failure, not a footnote.
      console.error(`\n✗ QA_REQUIRE_ALL_LEGS=1: refusing to report green with unexercised legs`)
      process.exit(1)
    }
    console.log(
      `\n✓ all ${results.length - skipped.length} EXECUTED scenario(s) passed ` +
        `(${skipped.length} skipped — coverage is partial, see #1044)`,
    )
    return
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
