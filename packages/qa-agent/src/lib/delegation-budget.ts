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
 *
 * **Two callers, two reasons, and they are not interchangeable (#2594).** The
 * over-budget legs use the number as a CEILING to exceed; `within-budget-settle`
 * uses it as a FLOOR to clear. Both must refuse a fallback, but not for the same
 * reason, and the run report is where that matters: on 2026-09-06 four scenarios
 * failed together and `within-budget-settle`'s line read "refusing to build an
 * over-budget amount from a number the chain did not supply" — a use it never
 * makes. A reader of that report learns something false about the leg. `use`
 * is what keeps each refusal about its own caller.
 */

import type { HavenApi } from './haven-api.js'
import {
  createCaveatEnforcerClient,
  getSmartAccountsEnvironment,
  type Delegation,
} from '@metamask/smart-accounts-kit'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC } from './chain.js'

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
/**
 * What the caller does with the number, which decides why a fallback is unusable.
 *
 * `ceiling` — the leg derives an amount ABOVE the budget and expects a refusal.
 * `floor` — the leg needs the budget to be at least its fixed amount.
 */
export type BudgetUse = 'ceiling' | 'floor'

const FALLBACK_REASON: Record<BudgetUse, string> = {
  ceiling:
    'refusing to build an over-budget amount from a number the chain did not supply',
  // The fallback IS the full configured budget (#1145), so it is OPTIMISTIC:
  // it can clear a floor the real remaining would not, which turns budget
  // exhaustion into what reads as a settlement defect — the exact
  // misattribution this leg's own precondition exists to prevent.
  floor:
    'the fallback reports the FULL configured budget, so it can clear a floor the real ' +
    'remaining would not — and this leg would then report a settlement failure for a ' +
    'budget that was simply spent',
}

export async function readOnchainBudget(
  api: HavenApi,
  symbol = 'USDC',
  use: BudgetUse = 'ceiling',
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
        FALLBACK_REASON[use],
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

/**
 * Read one exact period delegation by its hash (#3505).
 *
 * Symbol lookup is ambiguous when an agent owns both an open and a
 * merchant-pinned USDC grant. The caller therefore supplies the delegation
 * bytes it signed and the hash the backend recorded; this helper verifies the
 * binding before asking the enforcer for that delegation's live remainder.
 * A failed read is an error, never a fallback — QA evidence must come from the
 * authority the chain applies.
 */
export async function readOnchainDelegationBudget(
  chainId: number,
  delegationHash: string,
  delegation: Record<string, unknown>,
  configuredAtomic: string,
): Promise<OnchainBudget | { error: string }> {
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return { error: `per-delegation QA reads support Base Sepolia only, got chain ${chainId}` }
  }
  let actualHash: string
  try {
    actualHash = hashDelegation(delegation as unknown as Delegation)
  } catch (error) {
    return { error: `could not hash delegation ${delegationHash}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (actualHash.toLowerCase() !== delegationHash.toLowerCase()) {
    return {
      error: `delegation bytes hash to ${actualHash}, not the requested ${delegationHash}`,
    }
  }
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) })
    const enforcer = createCaveatEnforcerClient({
      client,
      environment: getSmartAccountsEnvironment(chainId),
    })
    const { availableAmount } = await enforcer.getErc20PeriodTransferEnforcerAvailableAmount({
      delegation: delegation as unknown as Delegation,
    })
    return { remaining: availableAmount, configured: configuredAtomic }
  } catch (error) {
    return {
      error:
        `could not read live remaining for delegation ${delegationHash}: ` +
        (error instanceof Error ? error.message : String(error)),
    }
  }
}

/** An amount comfortably above `remaining`, atomic units. */
export function overBudgetAmount(remaining: bigint): bigint {
  return remaining + 1_000_000n // + 1 USDC
}
