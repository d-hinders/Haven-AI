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
 * `merchantPayTo` = the merchant): authorize prepares the funding redemption,
 * so the budget caveat is enforced during gas estimation and an over-budget
 * call is refused with HTTP 502 and NO intent row. The invariant holds here,
 * and this is the shape this leg drives.
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
 * The assertions below are built so a 502 alone cannot satisfy them — see
 * `over-budget-refused`, whose comment block carries the full reasoning.
 */

import { HavenApi } from '../lib/haven-api.js'
import { caveatEnforcerRejection } from '../lib/revert-reason.js'
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

    const over = overBudgetAmount(budget.remaining)
    const res = await api.authorizeX402({
      url: ctx.cfg.demoMerchantUrl ?? 'https://example.test/resource',
      // The 3009 funding shape: fund the delegate EOA, settle to the merchant.
      payTo: delegate,
      merchantPayTo: ctx.cfg.paymentTo,
      settlementScheme: 'eip3009',
      amount: over.toString(),
      asset: USDC,
      network: NETWORK,
    })

    if (res.data.payment_id || res.data.status === 'pending_signature' || res.data.sign_data) {
      return fail('over-budget x402 produced a signable intent — it must be refused before it is offered')
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
        'the x402 refusal did not come from a caveat enforcer — a bare 502 is also what a bundler ' +
          'failure, an RPC outage or a retired rail produces, and none of those prove the budget ' +
          `check ran: ${(res.data.details ?? res.data.error ?? '').slice(0, 200)}`,
      )
    }

    return pass(
      `x402 ${over} atomic refused on-chain by ${enforcer} with no signable intent, ` +
        `against a live remaining budget of ${budget.remaining} atomic`,
    )
  },
}
