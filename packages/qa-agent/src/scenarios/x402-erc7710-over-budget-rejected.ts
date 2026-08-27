/**
 * #420 invariant (PRICE_EXCEEDS_MAX) on the **preferred** scheme (#2082).
 *
 * Its sibling `x402-over-budget-rejected` drives the EIP-3009 funding shape,
 * where authorize prepares a redemption and the caveat enforcer refuses during
 * gas estimation. That leg was deliberately pinned to 3009 by #2016 because on
 * **erc7710** — the scheme #1450 made preferred — an over-budget authorize
 * returned 201 `pending_signature` WITH `sign_data` for any amount. The
 * invariant's own words were false on the path most payments take, and #2016
 * recorded that rather than asserting around it.
 *
 * #2082 closed it with a fail-fast pre-check, so the case now exists to prove.
 * This leg is the live proof against the shared dev backend.
 *
 * ── What this leg does NOT claim ───────────────────────────────────────────
 *
 * It does not prove the chain refuses an over-budget redemption — that needs a
 * merchant that actually attempts one, which no leg does. The on-chain caveat
 * stack was always the gate and is unchanged. What is asserted here is WHEN
 * the refusal arrives: before a signable child exists, rather than four round
 * trips and a signature later.
 *
 * The assertions are built so that a refusal for some OTHER reason cannot
 * satisfy them — the exact vacuous-pass failure #2016 was filed about. A rail
 * retirement (410), a missing delegation (403 with no `error_code`) and a
 * bundler 502 all get rejected explicitly.
 */

import { HavenApi } from '../lib/haven-api.js'
import { overBudgetAmount, readOnchainBudget } from '../lib/delegation-budget.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

// Base Sepolia (84532) — mirrors backend chains.ts; USDC is Circle's testnet token.
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const NETWORK = 'eip155:84532'

export const x402Erc7710OverBudgetRejected: Scenario = {
  name: 'x402-erc7710-over-budget-rejected',
  invariant:
    'An x402 priced call above the agent budget is refused BEFORE it becomes signable on the ' +
    'erc7710 direct-settlement scheme too, not only on the EIP-3009 funding leg.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.delegationAgentApiKey) {
      return skip('QA_DELEGATION_AGENT_API_KEY not set — erc7710 settlement is delegation-rail only')
    }
    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)

    const budget = await readOnchainBudget(api)
    if ('error' in budget) return fail(`precondition: ${budget.error}`)

    // CONTROL FIRST. A within-budget authorize must be OFFERED, otherwise the
    // refusal below is consistent with an account that can pay nothing at all
    // — and this leg would be green for a reason it never established.
    const control = await api.authorizeX402({
      url: ctx.cfg.demoMerchantUrl ?? 'https://example.test/resource',
      // The erc7710 shape IS payTo = the merchant. No merchantPayTo, no
      // settlementScheme: the shape is what selects the scheme, and stating it
      // explicitly here would hide a dispatch regression rather than catch it.
      payTo: ctx.cfg.paymentTo,
      amount: '1',
      asset: USDC,
      network: NETWORK,
    })
    if (!control.data.sign_data) {
      return fail(
        'control: a within-budget erc7710 authorize was NOT offered as signable ' +
          `(HTTP ${control.status}: ${control.data.error ?? ''}) — a refusal below would prove nothing`,
      )
    }
    if (control.data.sign_data.signature_scheme !== 'eip712_delegation') {
      return fail(
        `control: authorize did not select erc7710 — signature_scheme was ` +
          `${control.data.sign_data.signature_scheme}, so this leg would be asserting the 3009 path`,
      )
    }

    const over = overBudgetAmount(budget.remaining)
    const res = await api.authorizeX402({
      url: ctx.cfg.demoMerchantUrl ?? 'https://example.test/resource',
      payTo: ctx.cfg.paymentTo,
      amount: over.toString(),
      asset: USDC,
      network: NETWORK,
    })

    if (res.data.payment_id || res.data.status === 'pending_signature' || res.data.sign_data) {
      return fail(
        'over-budget erc7710 authorize produced a signable intent — the pre-#2082 behaviour, ' +
          'and the whole reason this leg exists',
      )
    }
    if (res.status !== 403) {
      return fail(
        `expected HTTP 403 (spend authority refused pre-funding), got ${res.status}: ` +
          `${res.data.error ?? JSON.stringify(res.data).slice(0, 160)}`,
      )
    }
    // A bare 403 is also what a MISSING delegation produces, and a retired
    // rail produces its own refusal — neither proves the budget check ran.
    if (res.data.error_code !== 'delegation_budget_exceeded') {
      return fail(
        'the 403 did not come from the budget pre-check — a missing delegation and a retired rail ' +
          `also refuse here, and neither proves the budget was consulted: error_code=${res.data.error_code ?? 'none'}`,
      )
    }
    // The number must be the one the leg derived the request from, otherwise
    // the refusal is about some other budget than the one under test.
    if (res.data.remaining_atomic !== budget.remaining.toString()) {
      return fail(
        `the refusal reported remaining=${res.data.remaining_atomic} atomic, but the live budget ` +
          `read said ${budget.remaining} — the pre-check consulted a different delegation`,
      )
    }

    return pass(
      `erc7710 ${over} atomic refused 403 delegation_budget_exceeded before a signable child existed ` +
        `(remaining ${res.data.remaining_atomic}, shortfall ${res.data.shortfall_atomic}), ` +
        'against a control that WAS offered',
    )
  },
}
