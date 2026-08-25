/**
 * #420 invariant, re-based (#2016): an over-budget payment is **refused before
 * it becomes signable**, by the on-chain policy — never auto-executed.
 *
 * REPLACES `over-budget-queue`, and the rename is the finding. That leg
 * asserted HTTP 202 `pending_approval`: the legacy AllowanceModule rail queued
 * an over-limit spend for the owner to approve. **That queue does not exist on
 * the delegation rail and no longer exists anywhere** — `POST /approvals/:id/
 * approve` is 410 and #1989 deleted the queue UI. Re-pointing the old
 * assertion would have meant inventing a flow nobody built.
 *
 * The circuit breaker it was protecting is still there; it has a different
 * shape. The budget lives in the delegation's ERC20PeriodTransferEnforcer, so
 * an over-budget redemption REVERTS during the bundler's gas estimation —
 * before any intent row is written and before the agent is offered anything to
 * sign. `POST /payments` turns that into HTTP 502 with the simulation error.
 *
 * ⚠️ The whole difficulty of this leg is that 502 is NOT proof. A bundler
 * outage, an RPC failure and an exhausted paymaster all land on the same
 * status, so asserting the status alone would pass with over-budget
 * enforcement deleted outright — which is precisely the defect #2016 was filed
 * about, in the leg next door. Three things therefore have to hold together:
 *
 *  1. the amount is derived from a LIVE enforcer read, so the leg knows it
 *     asked an over-budget question (`readOnchainBudget` refuses a fallback
 *     number and refuses an already-exhausted budget);
 *  2. a within-budget request against the SAME account in the SAME run is
 *     still offered as a signable intent — the instrument can say yes;
 *  3. the refusal decodes to a CAVEAT ENFORCER rejection, named in the result.
 */

import { HavenApi } from '../lib/haven-api.js'
import { caveatEnforcerRejection } from '../lib/revert-reason.js'
import { overBudgetAmount, readOnchainBudget } from '../lib/delegation-budget.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

/** Small, and left UNSIGNED — the control proves offerability, not settlement. */
const CONTROL_AMOUNT = '0.001'

export const overBudgetRefused: Scenario = {
  name: 'over-budget-refused',
  invariant:
    'A payment exceeding the budget is refused by the on-chain caveat enforcer before it ' +
    'becomes signable, never auto-executed — while a within-budget payment is still offered.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.delegationAgentApiKey) {
      return skip('QA_DELEGATION_AGENT_API_KEY not set — over-budget lives on the delegation rail since #2016')
    }
    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)

    const budget = await readOnchainBudget(api)
    if ('error' in budget) return fail(`precondition: ${budget.error}`)

    // ── positive control: the same account, an amount inside the budget ──
    // Without this, every assertion below is also satisfied by an account
    // that can pay nothing at all.
    const control = await api.createPayment('USDC', CONTROL_AMOUNT, ctx.cfg.paymentTo)
    if (!control.ok || !control.data.payment_id || !control.data.sign_data?.typed_data) {
      return fail(
        `control: a within-budget payment was NOT offered as a signable intent ` +
          `(HTTP ${control.status}: ${control.data.error ?? control.data.status ?? '?'}) — ` +
          'the refusal below would prove nothing',
      )
    }

    // ── the over-budget request ─────────────────────────────────────────
    const over = overBudgetAmount(budget.remaining)
    const overHuman = (Number(over) / 1e6).toString()
    const res = await api.createPayment('USDC', overHuman, ctx.cfg.paymentTo)

    if (res.data.payment_id || res.data.sign_data) {
      return fail(
        `over-budget payment produced a signable intent (${res.data.payment_id ?? 'no id'}, ` +
          `HTTP ${res.status}) — it must be refused before it is offered`,
      )
    }
    if (res.status !== 502) {
      return fail(
        `expected HTTP 502 (chain-side policy refusal), got ${res.status}: ` +
          `${res.data.error ?? JSON.stringify(res.data).slice(0, 160)}`,
      )
    }
    const enforcer = caveatEnforcerRejection(res.data.details)
    if (!enforcer) {
      return fail(
        'the refusal did not come from a caveat enforcer — a 502 alone is also what a bundler ' +
          `or RPC failure looks like, and would prove nothing: ${(res.data.details ?? res.data.error ?? '').slice(0, 200)}`,
      )
    }

    return pass(
      `${overHuman} USDC refused on-chain by ${enforcer} with no signable intent, ` +
        `against a live remaining budget of ${budget.remaining} atomic ` +
        `(control: ${CONTROL_AMOUNT} USDC WAS offered, intent ${control.data.payment_id})`,
    )
  },
}
