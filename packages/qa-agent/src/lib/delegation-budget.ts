/**
 * Read the delegation-rail agent's LIVE on-chain remaining budget (#2016).
 *
 * The over-budget legs exist to prove that the budget check refuses a payment.
 * They can only prove that if the amount they ask for is genuinely above the
 * budget at the moment they ask — a hardcoded "far above any QA allowance"
 * constant proves nothing once the account, the rail or the seed changes, and
 * a refusal is indistinguishable from a refusal for some other reason.
 *
 * So the amount is DERIVED from the chain, and the read is refused rather than
 * guessed when the backend says the number is a fallback.
 */

import type { HavenApi } from './haven-api.js'

export interface OnchainBudget {
  /** Live remaining period budget, atomic units. */
  remaining: bigint
  /** The configured budget, human units — for the failure message only. */
  configured: string
}

/**
 * The agent's live remaining budget for `symbol`, or a reason string.
 *
 * Refuses (rather than returning a number) when the read is a fallback or the
 * budget is already exhausted: in both cases an "over-budget" request would be
 * refused for a reason the leg did not establish, which is the exact vacuous
 * pass #2016 was filed about.
 */
export async function readOnchainBudget(
  api: HavenApi,
  symbol = 'USDC',
): Promise<OnchainBudget | { error: string }> {
  const res = await api.getAllowances()
  if (!res.ok) {
    return { error: `could not read the agent's budget (HTTP ${res.status}): ${res.data.error ?? ''}` }
  }
  const row = (res.data.allowances ?? []).find((a) => a.token_symbol === symbol)
  if (!row) return { error: `the agent has no ${symbol} budget — nothing to be over` }
  const onchain = row.onchain
  if (!onchain || onchain.remaining === undefined) {
    return { error: `the ${symbol} budget carries no on-chain reading` }
  }
  if (onchain.remaining_is_from_chain === false) {
    return {
      error:
        `the ${symbol} remaining budget is a FALLBACK, not a live enforcer read — ` +
        'refusing to build an over-budget amount from a number the chain did not supply',
    }
  }
  const remaining = BigInt(onchain.remaining)
  if (remaining <= 0n) {
    return {
      error:
        `the ${symbol} budget is already exhausted (remaining 0 of ${row.configured_amount ?? '?'}) — ` +
        'every amount would be refused, so a refusal here would prove nothing',
    }
  }
  return { remaining, configured: row.configured_amount ?? '?' }
}

/** An amount comfortably above `remaining`, atomic units. */
export function overBudgetAmount(remaining: bigint): bigint {
  return remaining + 1_000_000n // + 1 USDC
}
