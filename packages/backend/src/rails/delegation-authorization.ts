/**
 * Delegation-rail authorization (#829, epic #821 Phase 3).
 *
 * Picks the delegation that authorizes a payment and prepares its sponsored
 * redemption. The ENFORCERS are the authority: budget, recipient and expiry
 * are checked on-chain during gas estimation, so an out-of-policy payment
 * fails HERE — before any state is written, before any signature is asked
 * for. This module therefore does no policy arithmetic of its own: it selects
 * a candidate and lets the chain rule.
 *
 * Selection: the ACTIVE delegation for (agent, token) whose recipient matches
 * the payment, else the agent's ACTIVE open-budget delegation for that token.
 * A pinned delegation always wins over the open one — the tighter grant is
 * the one the owner meant for that recipient.
 *
 * No refill machinery exists here, and that is the point: the period budget
 * resets on the clock inside ERC20PeriodTransferEnforcer. Compare
 * session-schedule-wiring.ts (the rail this replaces), which recomputed a
 * session matrix on every payment.
 */

import {
  selectDelegationForPayment,
  type DelegationForPaymentRow,
} from '../infra/repositories/delegation-budgets.js'
import type { Address, Hex } from 'viem'
import { getChain } from '../domain/chains.js'
import { computeHybridAccountAddress } from './hybrid-provisioning.js'
import {
  createDelegationRail,
  delegationRailBundlerUrl,
  type PreparedRedemption,
} from './delegation-rail.js'

export interface DelegationAuthorization {
  delegationHash: string
  prepared: PreparedRedemption
}

/**
 * The delegation that authorizes this payment, or null when the agent has no
 * applicable active grant (caller fails closed with a clean 403). The SQL
 * lives in `infra/repositories/delegation-budgets.ts`
 * (`SELECT_DELEGATION_FOR_PAYMENT_SQL`, #999).
 */
export async function selectDelegation(
  agentId: string,
  tokenAddress: string,
  toAddress: string,
): Promise<DelegationForPaymentRow | null> {
  return selectDelegationForPayment(agentId, tokenAddress, toAddress)
}

/**
 * Prepare the sponsored redemption for the selected delegation. Throws when
 * the caveats reject the payment (budget exceeded, wrong recipient, expired)
 * — the caller maps that to a clean 402/502 without writing state.
 */
export async function prepareDelegationPayment(
  agent: { id: string; chain_id: number; delegate_address: string },
  tokenAddress: string,
  toAddress: string,
  amountRaw: bigint,
): Promise<DelegationAuthorization | null> {
  const delegation = await selectDelegation(agent.id, tokenAddress, toAddress)
  if (!delegation) return null

  const delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
    ownerAddress: agent.delegate_address as Address,
  })
  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.delegate_address as Address,
    chainId: agent.chain_id,
    bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
    rpcUrl: getChain(agent.chain_id).rpcUrl,
    sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
  })
  if (rail.delegateAccountAddress.toLowerCase() !== delegateAccountAddress.toLowerCase()) {
    // Defensive: the grant was built against a different delegate account.
    throw new Error('delegate account mismatch between grant and rail — refusing to prepare')
  }

  const prepared = await rail.prepareRedemption(
    JSON.parse(delegation.delegation_json),
    tokenAddress as Address,
    toAddress as Address,
    amountRaw,
  )
  return { delegationHash: delegation.delegation_hash, prepared }
}

/** Submit a signed redemption. The agent's signature was produced client-side. */
export async function submitDelegationPayment(
  agent: { chain_id: number; delegate_address: string },
  preparedUserOp: unknown,
  signature: Hex,
): Promise<{ txHash: string }> {
  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.delegate_address as Address,
    chainId: agent.chain_id,
    bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
    rpcUrl: getChain(agent.chain_id).rpcUrl,
    sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
  })
  const result = await rail.submitRedemption(
    {
      userOperation: preparedUserOp,
      userOpHash: '0x' as Hex,
      signingTypedData: null,
      delegateAccountAddress: rail.delegateAccountAddress,
    },
    signature,
  )
  return { txHash: result.txHash }
}
