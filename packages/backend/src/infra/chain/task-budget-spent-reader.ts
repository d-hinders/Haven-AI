/**
 * #3500: what has been transferred through one delegation so far, read from
 * its `ERC20TransferAmountEnforcer` (`spentMap(delegationManager, hash)`).
 * That storage IS the cap's authority: the enforcer compares against it when
 * a redemption runs. A module of its own so route tests mock the chain here,
 * not inside the cap arithmetic (`modules/task-budgets/task-budget-cap.ts`).
 */
import { createPublicClient, parseAbi, type Hex } from 'viem'
import { chainForId, getDelegationContracts } from '../../rails/delegation-contracts.js'
import { rpcTransport } from './rpc-transport.js'

const ERC20_TRANSFER_AMOUNT_SPENT_ABI = parseAbi([
  'function spentMap(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

export type TaskBudgetSpentReader = (chainId: number, delegationHash: Hex) => Promise<bigint>

export const readTaskBudgetSpent: TaskBudgetSpentReader = async (chainId, delegationHash) => {
  const pins = getDelegationContracts(chainId)
  const client = createPublicClient({ chain: chainForId(chainId), transport: rpcTransport(chainId) })
  // `latest`, not `finalized`: a lagging read can only UNDER-state what was
  // spent, which lets a payment through to the on-chain gate; it can never
  // refuse one the chain would have allowed.
  return client.readContract({
    address: pins.enforcers.erc20TransferAmount,
    abi: ERC20_TRANSFER_AMOUNT_SPENT_ABI,
    functionName: 'spentMap',
    args: [pins.delegationManager, delegationHash],
  })
}
