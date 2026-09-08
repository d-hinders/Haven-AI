/**
 * #420 invariant (PRICE_EXCEEDS_MAX): an x402 priced call above the agent's
 * budget is **rejected, never turned into a signable intent**.
 *
 * ⚠️ RE-BASED (#2016) BECAUSE IT WAS PASSING FOR THE WRONG REASON.
 *
 * The previous version drove the seeded LEGACY identity and asserted only
 * `error_code || error` — "some refusal happened". After #1986 the refusal it
 * was reading was the RAIL RETIREMENT ("The Safe rail is retired"), not the
 * budget check. It reported PASS in the 2026-08-25 `qa-dev` run, and it would
 * have reported PASS with over-budget enforcement deleted outright. A red leg
 * announces itself; that one did not.
 *
 * ── What the delegation rail actually does, per scheme ─────────────────
 *
 * **EIP-3009 bridge shape** (`payTo` = the agent's delegate EOA,
 * `merchantPayTo` = the merchant): authorize used to prepare the funding
 * redemption, so the budget caveat was enforced during gas estimation and an
 * over-budget call came back HTTP 502 carrying the enforcer's revert reason.
 * Since #2706 (landed as PR #2719) a typed 403 pre-check refuses BEFORE any
 * prepare, field-for-field the erc7710 body, so the enforcer never speaks on
 * this path. That is deliberate and this leg now asserts the new shape.
 *
 * ── Where the enforcer proof went, stated rather than dropped ──────────
 *
 * The naive edit here — swap 502 for 403 — would have destroyed what this
 * leg exists for: with the pre-check alone satisfying it, DELETING the
 * on-chain enforcer would leave it green, which is the 2026-08-25 defect
 * recorded above, one rail across. The guarantee is now split across a PAIR,
 * and each half is falsified by a different deletion:
 *
 *   * delete the pre-check → this leg's 403 becomes the enforcer's 502 and
 *     THIS scenario fails;
 *   * delete the enforcer → `over-budget-refused` (POST /payments, which
 *     still reaches the chain and still asserts
 *     `ERC20PeriodTransferEnforcer:transfer-amount-exceeded`) fails.
 *
 * Neither half alone proves the invariant. Read them together, and do not
 * retire `over-budget-refused` without moving its enforcer assertion first.
 *
 * What the pair does NOT restore, said plainly rather than left to be
 * discovered: the on-chain refusal of an x402 3009 FUNDING redemption is now
 * observed by nothing, and cannot be — after #2706 no client-side call reaches
 * the enforcer on that path. `over-budget-refused` covers a different
 * entrypoint on the same delegation. The coverage is gone, not relocated.
 *
 * **erc7710 direct settlement** (`payTo` = the merchant): authorize builds a
 * settlement CHILD delegation and returns 201 `pending_signature` WITH
 * `sign_data`, for any amount. The budget is enforced when the merchant
 * redeems the [child, budget] chain on-chain — funds are safe, but the
 * invariant's words ("never turned into a signable intent") are FALSE on the
 * preferred scheme. Verified live against dev on 2026-08-25. That is a real
 * coverage gap and it is recorded on #1993 rather than papered over here:
 * proving it would need a merchant redemption attempt, which no leg does.
 *
 * The assertions below are built so a bare status code cannot satisfy them —
 * see `over-budget-refused`, whose comment block carries the full reasoning.
 */

import { HavenApi } from '../lib/haven-api.js'
import { overBudgetAmount, readOnchainBudget } from '../lib/delegation-budget.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

// Base Sepolia (84532) — mirrors backend chains.ts; USDC is Circle's testnet token.
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const NETWORK = 'eip155:84532'

export const x402OverBudgetRejected: Scenario = {
  name: 'x402-over-budget-rejected',
  invariant:
    'An x402 priced call above the agent budget is refused by the on-chain caveat enforcer ' +
    'on the EIP-3009 funding leg, never turned into a signable intent.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.delegationAgentApiKey) {
      return skip('QA_DELEGATION_AGENT_API_KEY not set — the x402 budget check lives on the delegation rail since #2016')
    }
    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)

    const agent = await api.getAgent()
    const delegate = agent.data.delegate_address
    if (!delegate) return fail(`could not resolve the agent's delegate EOA (HTTP ${agent.status})`)

    const budget = await readOnchainBudget(api)
    if ('error' in budget) return fail(`precondition: ${budget.error}`)

    // The 3009 funding shape: fund the delegate EOA, settle to the merchant.
    const shape = {
      url: ctx.cfg.demoMerchantUrl ?? 'https://example.test/resource',
      payTo: delegate,
      merchantPayTo: ctx.cfg.paymentTo,
      settlementScheme: 'eip3009' as const,
      asset: USDC,
      network: NETWORK,
    }

    // The control, which this leg did not have before #2738. A refusal proves
    // the budget check only if the SAME shape is offered when it is within
    // budget: without this, a backend refusing every x402 authorize — a
    // misconfigured merchant URL, a retired rail, a dead delegation — reads
    // exactly like a working enforcement.
    const control = await api.authorizeX402({ ...shape, amount: '1' })
    if (!control.data.sign_data) {
      return fail(
        'control: a within-budget 3009 authorize was NOT offered as signable ' +
          `(HTTP ${control.status}: ${control.data.error ?? ''}) — a refusal below would prove nothing`,
      )
    }
    // And it must have been dispatched to the FUNDING leg. The 3009 shape
    // returns `eip712_userop`; erc7710 returns `eip712_delegation`. Without
    // this, a dispatch regression routing this request onto the erc7710 branch
    // passes twice over: the control gets a signable child, and the over-budget
    // call hits the erc7710 pre-check on the SAME delegation, so the
    // `error_code` and `remaining_atomic` both match and the leg reports green
    // having never touched the funding path. The sibling has always carried
    // the mirror of this guard; this leg did not (review finding, #2738).
    if (control.data.sign_data.signature_scheme !== 'eip712_userop') {
      return fail(
        'control: authorize did not select the 3009 funding leg — signature_scheme was ' +
          `${control.data.sign_data.signature_scheme}, so this leg would be asserting the erc7710 path`,
      )
    }

    const over = overBudgetAmount(budget.remaining)
    const res = await api.authorizeX402({ ...shape, amount: over.toString() })

    if (res.data.payment_id || res.data.status === 'pending_signature' || res.data.sign_data) {
      return fail('over-budget x402 produced a signable intent — it must be refused before it is offered')
    }
    if (res.status !== 403) {
      return fail(
        `expected HTTP 403 (budget pre-check, #2706) got ${res.status}: ` +
          `${res.data.error ?? JSON.stringify(res.data).slice(0, 160)}`,
      )
    }
    // A bare 403 is also what a MISSING delegation produces, and a retired rail
    // produced the 410 that caused the 2026-08-25 false green. The typed code
    // is what separates "the budget check ran and said no" from "something
    // else said no".
    if (res.data.error_code !== 'delegation_budget_exceeded') {
      return fail(
        'the 403 did not come from the budget pre-check — a missing delegation and a retired rail ' +
          `also refuse with 403, and neither proves the budget was consulted: ` +
          `error_code=${res.data.error_code ?? '(absent)'} ${(res.data.error ?? '').slice(0, 160)}`,
      )
    }
    // And it must have consulted THIS delegation: a pre-check reading a stale
    // or different budget refuses correctly by accident.
    if (res.data.remaining_atomic !== budget.remaining.toString()) {
      return fail(
        `the refusal reported remaining=${res.data.remaining_atomic} atomic, but the live budget ` +
          `read said ${budget.remaining} — the pre-check consulted a different delegation`,
      )
    }

    return pass(
      `3009 funding leg: ${over} atomic refused 403 delegation_budget_exceeded before any prepare ` +
        `(remaining ${res.data.remaining_atomic}, shortfall ${res.data.shortfall_atomic}), ` +
        'against a control that WAS offered. The on-chain enforcer proof for this rail lives in ' +
        '`over-budget-refused`',
    )
  },
}
