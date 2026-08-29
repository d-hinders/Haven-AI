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

import { loadQaConfig, QaConfigError } from './config.js'
import type { Scenario, ScenarioContext, ScenarioResult } from './scenarios/types.js'
import { withinBudgetSettle } from './scenarios/within-budget-settle.js'
import { overBudgetRefused } from './scenarios/over-budget-refused.js'
import { x402OverBudgetRejected } from './scenarios/x402-over-budget-rejected.js'
import { x402Erc7710OverBudgetRejected } from './scenarios/x402-erc7710-over-budget-rejected.js'
import { x402Delegation3009 } from './scenarios/x402-delegation-3009.js'
import { x402Delegation3009Sweep } from './scenarios/x402-delegation-3009-sweep.js'
import { x402Delegation3009GraceResume } from './scenarios/x402-delegation-3009-grace-resume.js'
import { x402Erc7710Settle } from './scenarios/x402-erc7710-settle.js'
import { x402Erc7710FreshAgent } from './scenarios/x402-erc7710-fresh-agent.js'
import { x402Erc7710Sdk } from './scenarios/x402-erc7710-sdk.js'
import { x402Erc7710Hosted } from './scenarios/x402-erc7710-hosted.js'
import { x402HostedMcpSigner } from './scenarios/x402-hosted-mcp-signer.js'
import { x402CatalogGuidedPurchase } from './scenarios/x402-catalog-guided-purchase.js'
import { delegationLifecycle } from './scenarios/delegation-lifecycle.js'
import { thrownErrorDetail } from './lib/thrown-error-detail.js'
import { runPreflight, formatPreflight } from './lib/preflight.js'

// Deterministic, no-LLM scenarios run in order.
//
// EVERY leg now runs on the DELEGATION rail (#2016). The first three used to
// drive the seeded LEGACY AllowanceModule identity; since #1986 that account
// answers HTTP 410 from `POST /payments` and the x402 path, so two of them
// were guaranteed red and the third was passing on the retirement's refusal
// rather than on the check it existed to prove. All three were re-based rather
// than retired — the invariants outlived the rail, only the instruments changed:
//
//   within-budget-settle    /payments, eip712_userop typed data instead of the
//                           legacy raw-hash scheme. Also the suite's positive
//                           control: the leg that proves the money path can
//                           still say YES, which is what makes the two
//                           refusals below mean anything.
//   over-budget-refused     renamed from `over-budget-queue`. The approval
//                           QUEUE it asserted does not exist on this rail and
//                           no longer exists anywhere (#1986/#1989); the
//                           circuit breaker is the caveat enforcer reverting
//                           during gas estimation. Same invariant, different
//                           shape — so a different name.
//   x402-over-budget-rejected  driven on the EIP-3009 funding shape, where the
//                           budget really is enforced at authorize.
//
//   x402-erc7710-over-budget-rejected  the same invariant on the PREFERRED
//                           scheme, added by #2082. Until then, erc7710
//                           authorize returned 201 with a signable child for
//                           ANY amount (verified live against dev 2026-08-25,
//                           handed to #1993 rather than asserted around), so
//                           "an over-budget x402 call is never turned into a
//                           signable intent" was FALSE on the path most
//                           payments take. The pre-check made the case exist
//                           to prove; this leg proves it.
//
// STATE WHAT IS STILL UNCOVERED. Neither over-budget x402 leg proves the CHAIN
// refuses an over-budget redemption — that needs a merchant that actually
// attempts one, and no leg does. The caveat stack was always the gate and is
// unchanged by #2082; what the new leg asserts is WHEN Haven says no, not
// whether the chain would have.
//
// x402 coverage is DELEGATION-RAIL ONLY. The legacy `x402-settle` and
// `x402-sweep-recovery` legs were removed by owner decision (#1535): the
// delegation rail is the base for every new account, and the legacy
// AllowanceModule rail is now retired outright (epic #1440). With that
// retirement, `legacy-authorize.ts` and the AllowanceModule rail modules are
// DELETED (#1987), so the execute-branch coverage that removal cost
// (`recordX402Signature` → `executeAllowanceTransfer` → `confirmX402Intent`,
// and the #692/#684 stale-nonce retry class) no longer has a subject. The
// note is kept as history, not as an outstanding debt.
//
// The delegation-rail legs run the standing delegation identity
// (`QA_DELEGATION_*`). They are ordered settle-then-sweep so a settle failure
// is diagnosed against a clean delegate rather than one the sweep case has
// already left money on.
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
  overBudgetRefused,
  x402OverBudgetRejected,
  // #2082: the same refusal on the erc7710 shape, straight after its 3009
  // sibling so a failure is diagnosed against a scheme the leg above has
  // already shown healthy — and so the two read as one invariant, two
  // schemes, rather than as unrelated legs.
  x402Erc7710OverBudgetRejected,
  x402Delegation3009,
  x402Delegation3009GraceResume,
  x402Delegation3009Sweep,
  x402Erc7710Settle,
  // #1674: the COLD START — a fresh agent whose first-ever payment is
  // erc7710, so the delegate account is counterfactual and authorize must
  // deploy it (#1667). After the long-lived leg so a failure here is
  // diagnosable against a steady state the sibling has already shown healthy.
  x402Erc7710FreshAgent,
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

  // #2011 removes the retired legacy identity from the harness: every
  // leg now builds its own `HavenApi` on the delegation identity, and no
  // scenario reads the legacy fields. One consumer survives outside the
  // scenarios — the only legacy preflight residual check is removed with the
  // dead config fields. Every scenario builds its own delegation identity.
  const ctx: ScenarioContext = { cfg }

  console.log(`Haven money-flow QA → ${cfg.apiUrl}`)

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
