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
 * shape. The budget lives in the delegation's ERC20PeriodTransferEnforcer.
 * Until #3503 an over-budget redemption REVERTED during the bundler's gas
 * estimation and `POST /payments` turned that into an untyped HTTP 502. Since
 * #3503 the route pre-checks the live remaining period budget — the same
 * fail-fast check the x402 legs gained in #2082/#2706 — and refuses with a
 * typed 403 `delegation_budget_exceeded` before any UserOp is built.
 *
 * ⚠️ A bare 403 is NOT proof: a missing or revoked delegation refuses with 403
 * too, and a retired rail's 410 is the false green #2016 was filed about.
 * Three things therefore have to hold together:
 *
 *  1. the amount is derived from a LIVE enforcer read, so the leg knows it
 *     asked an over-budget question (`readOnchainBudget` refuses a fallback
 *     number and refuses an already-exhausted budget);
 *  2. a within-budget request against the SAME account in the SAME run is
 *     still offered as a signable intent — the instrument can say yes;
 *  3. the refusal carries `error_code: delegation_budget_exceeded` AND a
 *     `remaining_atomic` equal to the live read — a pre-check answering from a
 *     different delegation refuses correctly by accident.
 *
 * ── What #3503 moved, stated rather than dropped ──────────────────────
 *
 * On a healthy budget read this leg no longer watches the enforcer revert: no
 * live leg does any more. Each deletion is still red somewhere:
 *
 *   * delete the pre-check → the enforcer's 502 returns and THIS leg fails on
 *     the status;
 *   * compile a budget without its period caveat → the pre-check has nothing
 *     to read, fails open, and the over-budget request comes back signable —
 *     THIS leg fails (and `readOnchainBudget` already refuses a budget whose
 *     remaining is not from the chain);
 *   * a deployed enforcer that stops refusing → the CI contract suite
 *     `packages/backend/src/routes/__tests__/non-custody-onchain-enforcer.contract.test.ts`,
 *     which `eth_call`s each deployed enforcer's `beforeHook` over budget.
 *
 * The pre-check FAILS OPEN by design, so a degraded budget read still reaches
 * the enforcer and this leg then goes red on the 502 — a flapping RPC before it
 * is a regression; the failure text names both causes.
 */

import { HavenApi } from '../lib/haven-api.js'
import { overBudgetAmount, readOnchainBudget } from '../lib/delegation-budget.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

/** Small, and left UNSIGNED — the control proves offerability, not settlement. */
const CONTROL_AMOUNT = '0.001'

export const overBudgetRefused: Scenario = {
  name: 'over-budget-refused',
  invariant:
    'A payment exceeding the live on-chain budget is refused before it becomes signable ' +
    '(403 delegation_budget_exceeded, #3503), never auto-executed — while a within-budget ' +
    'payment is still offered.',
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
    if (res.status !== 403) {
      return fail(
        `expected HTTP 403 (period budget pre-check, #3503), got ${res.status}: ` +
          `${res.data.error ?? JSON.stringify(res.data).slice(0, 160)}` +
          (res.status === 502
            ? ' — a 502 means the pre-check did not answer: either it was removed, or its ' +
              'on-chain budget read degraded and it failed OPEN to prepare (by design)'
            : ''),
      )
    }
    if (res.data.error_code !== 'delegation_budget_exceeded') {
      return fail(
        'the 403 did not come from the budget pre-check — a missing delegation also refuses ' +
          `with 403, and does not prove the budget was consulted: ` +
          `error_code=${res.data.error_code ?? '(absent)'} ${(res.data.error ?? '').slice(0, 160)}`,
      )
    }
    if (res.data.remaining_atomic !== budget.remaining.toString()) {
      return fail(
        `the refusal reported remaining=${res.data.remaining_atomic} atomic, but the live budget ` +
          `read said ${budget.remaining} — the pre-check consulted a different delegation`,
      )
    }

    return pass(
      `${overHuman} USDC refused 403 delegation_budget_exceeded with no signable intent ` +
        `(remaining ${res.data.remaining_atomic}, shortfall ${res.data.shortfall_atomic}) ` +
        `against a control that WAS offered (${CONTROL_AMOUNT} USDC, intent ${control.data.payment_id})`,
    )
  },
}
