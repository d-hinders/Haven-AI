/**
 * #420 invariant: an over-budget payment is **queued for approval, not executed**.
 *
 * Requests an amount far above the agent's on-chain allowance and asserts the
 * backend returns `pending_approval` (HTTP 202) with no signable intent — the
 * non-custodial circuit breaker. Nothing is signed or moved.
 */

import { type Scenario, type ScenarioContext, pass, fail } from './types.js'

const AMOUNT = '1000000' // USDC — far above any QA allowance

export const overBudgetQueue: Scenario = {
  name: 'over-budget-queue',
  invariant: 'A payment exceeding the allowance is queued for owner approval, never auto-executed.',
  async run(ctx: ScenarioContext) {
    const res = await ctx.api.createPayment('USDC', AMOUNT, ctx.cfg.paymentTo)

    if (res.data.status !== 'pending_approval') {
      return fail(
        `expected status 'pending_approval', got '${res.data.status ?? '?'}' (HTTP ${res.status})`,
      )
    }
    if (res.data.sign_data) {
      return fail('over-budget payment returned a signable intent — it should be queued, not executable')
    }
    return pass(`queued for approval, not executed (payment ${res.data.payment_id})`)
  },
}
