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
 * and an over-budget call is refused with NO intent row. This is the shape
 * this leg drives.
 *
 * ── #2706 CHANGED WHICH REFUSAL ARRIVES, AND BOTH ARE CORRECT ─────────────
 *
 * Until #2706 (merged as c3a81644) this leg asserted HTTP 502 with a caveat
 * enforcer named in the revert data: authorize went straight to gas estimation
 * and the enforcer refused there. #2706 extended #2082's fail-fast pre-check to
 * this branch, so the ordinary answer is now the same typed
 * `403 delegation_budget_exceeded` the erc7710 sibling already asserts — the
 * whole point being that a policy refusal and a bundler outage stop looking
 * alike.
 *
 * This leg went red on the deploy of that commit and stayed red for four
 * deploys (#2738). The product was right and the scenario was stale.
 *
 * **Both outcomes are legitimate, and asserting only the 403 would be a new
 * defect.** #2706 requires the pre-check to FAIL OPEN when `readRemainingBudget`
 * reports `fromChain: false`, so a degraded RPC read cannot turn a transient
 * outage into a stopped agent. When it fails open the request reaches the
 * enforcer and the old 502 is exactly what comes back. So this leg accepts
 * either and says which happened, rather than trading one brittle expectation
 * for another.
 *
 * In the harness the 403 is what will essentially always fire: this leg refuses
 * to start unless its OWN budget read was `fromChain: true`, and the backend's
 * pre-check hits the same reader against the same RPC seconds later. The 502
 * branch needs a transient degradation inside that window. It is defensive, not
 * expected — and it is not dead code to be deleted as untaken, because the
 * product may legitimately answer that way.
 *
 * What does NOT vary, and is asserted on both branches: no signable intent is
 * ever produced. That is the #420 invariant; the status code is the mechanism.
 *
 * ── Why the 403 branch still satisfies #2016, which is the real question ──
 *
 * #2016 exists because this leg once reported PASS on a rail-retirement refusal
 * instead of the budget check — a green that would have survived deleting
 * over-budget enforcement outright. Accepting a second outcome has to not
 * reopen that. It does not, and the reason is a coupling worth stating because
 * it is not obvious:
 *
 * the pre-check's number is not a backend-side opinion. `readRemainingBudget`
 * reads the ENFORCER'S OWN STORAGE
 * (`infra/chain/delegation-budget-reader.ts`), and reports `fromChain: false`
 * when the delegation carries no period caveat it can speak for. So run the
 * #2016 mutation — delete over-budget enforcement from the caveat stack — and
 * the read degrades, the pre-check fails open, nothing reverts, and authorize
 * answers 201 with `sign_data`: the signability guard below fails the leg.
 * Upstream of that, this leg's own precondition refuses to run at all against a
 * fallback read. The green cannot survive that mutation on either branch.
 *
 * **What the 403 branch does NOT witness, stated because it is a real trade.**
 * The old 502 assertion witnessed an actual revert. The 403 witnesses the
 * enforcer's STORAGE. Against #2016's mutation — delete the caveat — those are
 * equivalent, per the paragraph above. Against a narrower one — caveat present
 * and readable, but the redemption no longer actually reverts, because the
 * enforcer was upgraded or the DelegationManager stopped invoking it — they are
 * not: this leg would go green on the pre-check while the chain-side gate was
 * gone. It has to make that trade, because on this path the product no longer
 * ordinarily produces a revert to witness. The erc7710 sibling's doc row states
 * the same limit in the same words.
 *
 * A future reader trimming the `fromChain` guard in that reader would break
 * this coupling silently, which is why it is written down here.
 *
 * ── Why there is no control here, unlike the erc7710 sibling ──────────────
 *
 * Not because a control would move funds — it would not. `prepareDelegationPayment`
 * prepares the redemption and returns; submission is a separate call reached
 * only through `POST /payments/:id/sign`. A control here would cost a sponsored
 * gas estimation and leave an unsigned `pending_signature` row per run.
 *
 * The real reason is that the ordered run already contains one, though LATER in
 * the run rather than inline: `run.ts` puts `within-budget-settle` first, and
 * `x402-delegation-3009` — a full within-budget authorize → sign → settle on
 * THIS EXACT shape — runs at index 5 to this leg's index 3. So the suite proves
 * the shape can pay, but not before this leg reports, which is the one thing an
 * inline control would add. The sibling
 * embeds its own control because its scheme has no such leg. Duplicating it
 * here would buy nothing the suite does not already prove.
 *
 * What the control would have discriminated is bought below instead, by
 * asserting the refusal's `error_code` and that its `remaining_atomic` matches
 * the live read this leg derived its amount from — a revoked or missing
 * delegation refuses with a different code, and a different budget.
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
 * The assertions below are built so no bare status code can satisfy them — see
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
    'An x402 priced call above the agent budget is refused on the EIP-3009 funding leg before it ' +
    'becomes signable — by the typed budget pre-check, or by the on-chain caveat enforcer when ' +
    'that pre-check fails open.',
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
    // BRANCH 1 — the ordinary path since #2706: the typed pre-check refused.
    if (res.status === 403) {
      // A bare 403 is also what a MISSING delegation produces, and a retired
      // rail refuses here too; neither proves the budget was consulted.
      if (res.data.error_code !== 'delegation_budget_exceeded') {
        return fail(
          'the 403 did not come from the budget pre-check — a missing delegation and a retired rail ' +
            `also refuse here, and neither proves the budget was consulted: error_code=${res.data.error_code ?? 'none'}`,
        )
      }
      // The number must be the one this leg derived its request from, or the
      // refusal is about some other budget than the one under test.
      if (res.data.remaining_atomic !== budget.remaining.toString()) {
        return fail(
          `the refusal reported remaining=${res.data.remaining_atomic} atomic, but the live budget ` +
            `read said ${budget.remaining} — the two reads disagree: a different delegation, or the ` +
            `budget moved between them`,
        )
      }
      return pass(
        `3009 funding leg: ${over} atomic refused 403 delegation_budget_exceeded before a signable ` +
          `intent existed (remaining ${res.data.remaining_atomic}, shortfall ${res.data.shortfall_atomic})`,
      )
    }

    // BRANCH 2 — #2706's fail-open path: the budget read was not from chain, so
    // the pre-check stood aside and the enforcer refused during gas estimation.
    // Still a correct refusal, and the only one available when the read is
    // degraded — but it must be PROVEN to come from an enforcer, because a
    // bundler failure and an RPC outage produce the same 502.
    if (res.status === 502) {
      const enforcer = caveatEnforcerRejection(res.data.details)
      if (!enforcer) {
        return fail(
          'the x402 refusal did not come from a caveat enforcer — a bare 502 is also what a bundler ' +
            'failure, an RPC outage or a retired rail produces, and none of those prove the budget ' +
            `check ran: ${(res.data.details ?? res.data.error ?? '').slice(0, 200)}`,
        )
      }
      return pass(
        `3009 funding leg: ${over} atomic refused on-chain by ${enforcer} with no signable intent ` +
          `(the #2706 pre-check failed open, as it must on a non-chain budget read), against a live ` +
          `remaining budget of ${budget.remaining} atomic`,
      )
    }

    return fail(
      `expected either 403 delegation_budget_exceeded (the #2706 pre-check) or 502 with a caveat ` +
        `enforcer named in the revert data (its fail-open path), got ${res.status}: ` +
        `${res.data.error ?? JSON.stringify(res.data).slice(0, 160)}`,
    )
  },
}
