/**
 * #420 invariant (PRICE_EXCEEDS_MAX): an x402 priced call that exceeds the
 * agent's budget is **rejected with no signable intent** — the x402 authorize
 * path enforces the same on-chain allowance ceiling as the direct path.
 *
 * Asks Haven to authorize a far-over-allowance x402 payment and asserts it comes
 * back as a rejection (`insufficient_funds`, with the shortfall) rather than a
 * `pending_signature` intent that could be signed and executed.
 */

import { type Scenario, type ScenarioContext, pass, fail } from './types.js'

// Base Sepolia (84532) — mirrors backend chains.ts; USDC is Circle's testnet token.
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const NETWORK = 'eip155:84532'
const AMOUNT = '1000000000' // 1000 USDC atomic — far above any QA allowance

export const x402OverBudgetRejected: Scenario = {
  name: 'x402-over-budget-rejected',
  invariant: 'An x402 priced call above the agent budget is rejected, never turned into a signable intent.',
  async run(ctx: ScenarioContext) {
    const res = await ctx.api.authorizeX402({
      url: ctx.cfg.demoMerchantUrl ?? 'https://example.test/resource',
      payTo: ctx.cfg.paymentTo,
      amount: AMOUNT,
      asset: USDC,
      network: NETWORK,
    })

    if (res.data.payment_id || res.data.status === 'pending_signature') {
      return fail('over-budget x402 produced a signable intent — it should be rejected')
    }
    if (!res.data.error_code && !res.data.error) {
      return fail(`expected a rejection, got HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`)
    }
    const code = res.data.error_code ?? res.data.error
    const shortfall = res.data.shortfall !== undefined ? ` (shortfall ${res.data.shortfall})` : ''
    return pass(`x402 rejected: ${code}${shortfall}`)
  },
}
