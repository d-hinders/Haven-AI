/**
 * On-chain remaining-budget reads for the delegation rail (#1145).
 *
 * `GET /machine-payments/allowances` used to report `spent: '0', remaining:
 * <full budget>` for every delegation-rail agent, unconditionally. An agent
 * that had already spent its period read as fully funded, derived
 * `readiness: 'ready'`, and could loop payment attempts that revert on-chain.
 * No funds were ever at risk — the caveat enforcer gates every redemption —
 * but the guidance was wrong, which is the same failure #1135 fixed one level
 * narrower.
 *
 * ## Why the enforcer, and not our own ledger
 *
 * The ERC20PeriodTransferEnforcer's storage IS the authority: it is the thing
 * that reverts an over-budget redemption, and it re-arms itself at the period
 * boundary with no help from us. Reading it means `remaining` is exactly what
 * the chain will allow. An off-chain tally of redemptions would be a second
 * source that can only drift from the first — and it would have to model the
 * period refill correctly, which is precisely the arithmetic the delegation
 * rail exists to stop doing (#821).
 *
 * ## Failure is a fall-BACK, never a fall-to-zero
 *
 * A failed read must not report `remaining: 0`: that would tell a
 * perfectly-funded agent it cannot pay, turning a transient RPC problem into a
 * stopped agent. It falls back to the full budget — today's behaviour — so
 * this change can only make the number more accurate, never less. The caller
 * learns which it got, so it can log the provenance.
 *
 * And the read is BOUNDED, not merely caught (#718's lesson, paid for once
 * already): a `catch` sees a rejection, but an RPC that is slow and never
 * answers would hang the endpoint — and nothing else would stop it, since the
 * process sets no global HTTP deadline. This path is a read an agent polls;
 * a stale-but-prompt number beats a correct one that never arrives.
 */

/**
 * Deliberately short. The fallback is the pre-#1145 answer, so waiting longer
 * buys accuracy that the caller can get on its next poll anyway.
 */
export const REMAINING_READ_TIMEOUT_MS = 2_000

import { createPublicClient, http } from 'viem'
import { createCaveatEnforcerClient, type Delegation } from '@metamask/smart-accounts-kit'
import { getChain } from '../../domain/chains.js'
import { chainForId } from '../../rails/delegation-contracts.js'
import { getDelegationEnvironment } from '../../rails/delegation-policy.js'

export interface RemainingBudget {
  /** Atomic units the chain will still allow this period. */
  remainingAtomic: string
  /** False when the on-chain read failed and `remainingAtomic` is the budget. */
  fromChain: boolean
}

/**
 * Read one delegation's remaining period budget.
 *
 * `budgetAtomic` is the fallback, so a caller always gets a usable number.
 */
export async function readRemainingBudget(
  chainId: number,
  delegationJson: string,
  budgetAtomic: string,
): Promise<RemainingBudget> {
  try {
    const client = createPublicClient({
      chain: chainForId(chainId),
      transport: http(getChain(chainId).rpcUrl, { timeout: REMAINING_READ_TIMEOUT_MS }),
    })
    const enforcerClient = createCaveatEnforcerClient({
      client,
      environment: getDelegationEnvironment(chainId),
    })
    const { availableAmount } = await enforcerClient.getErc20PeriodTransferEnforcerAvailableAmount({
      delegation: JSON.parse(delegationJson) as Delegation,
    })
    return { remainingAtomic: availableAmount.toString(), fromChain: true }
  } catch {
    // Includes the delegation not carrying a period-transfer caveat at all —
    // a shape this reader cannot speak for, and one where the budget is still
    // the best answer available.
    return { remainingAtomic: budgetAtomic, fromChain: false }
  }
}
