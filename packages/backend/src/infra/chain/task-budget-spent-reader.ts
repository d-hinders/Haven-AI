/**
 * #3500: what has been transferred through one delegation so far, read from
 * its `ERC20TransferAmountEnforcer` (`spentMap(delegationManager, hash)`).
 * That storage IS the cap's authority: the enforcer compares against it when
 * a redemption runs. A module of its own so route tests mock the chain here,
 * not inside the cap arithmetic (`modules/task-budgets/task-budget-cap.ts`).
 *
 * #3501 reuses this read for the agent-facing task-budget REPORTS (GET
 * /task-budgets, the SDK summary). A report is a polled, advisory read: the
 * same #1145/#718 lesson applies, so #3501's callers pass the SAME bounds the
 * parent-budget reader (`delegation-budget-reader.ts`) pins —
 * `TASK_BUDGET_SPENT_READ_TIMEOUT_MS` split per failover leg, `retryCount: 0`
 * (`timeout` alone does not bound the call; viem defaults to 3 retries and a
 * TimeoutError is retryable). A caller that needs the ENFORCING read — the
 * payment pre-check — keeps the unbounded default: there the enforcer's
 * verdict is the gate, and a slow-but-correct answer beats a skipped check.
 */
import { createPublicClient, parseAbi, type Hex } from 'viem'
import { chainForId, getDelegationContracts } from '../../rails/delegation-contracts.js'
import { rpcEndpoints, rpcTransport } from './rpc-transport.js'

const ERC20_TRANSFER_AMOUNT_SPENT_ABI = parseAbi([
  'function spentMap(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

/**
 * The TOTAL time budget for one REPORT read, across every failover leg —
 * the same bound the parent-budget reader carries. Advisory only: the
 * enforcer still rules at redemption, so a prompt, possibly-fallback answer
 * beats a correct one that arrives late.
 */
export const TASK_BUDGET_SPENT_READ_TIMEOUT_MS = 2_000

/** Zero, deliberately — see `delegation-budget-reader.ts` (#1145's lesson). */
export const TASK_BUDGET_SPENT_READ_RETRY_COUNT = 0

/** Each failover leg's equal share of `TASK_BUDGET_SPENT_READ_TIMEOUT_MS` (#3255). */
export function taskBudgetSpentReadLegTimeoutMs(chainId: number): number {
  return Math.floor(TASK_BUDGET_SPENT_READ_TIMEOUT_MS / Math.max(1, rpcEndpoints(chainId).length))
}

/** The bounded transport options a REPORT read passes to `rpcTransport`. */
export function taskBudgetSpentReadTransportOptions(chainId: number): { timeout: number; retryCount: number } {
  return {
    timeout: taskBudgetSpentReadLegTimeoutMs(chainId),
    retryCount: TASK_BUDGET_SPENT_READ_RETRY_COUNT,
  }
}

/** Shared body of both reads — they differ only in the transport options. */
async function readSpentFromChain(
  chainId: number,
  delegationHash: Hex,
  transportOptions?: { timeout: number; retryCount: number },
): Promise<bigint> {
  const pins = getDelegationContracts(chainId)
  const client = createPublicClient({ chain: chainForId(chainId), transport: rpcTransport(chainId, transportOptions) })
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

export type TaskBudgetSpentReader = (chainId: number, delegationHash: Hex) => Promise<bigint>

/**
 * The UNBOUNDED read — the payment pre-check's default (#3500). The enforcer's
 * verdict is the gate there, so a slow-but-correct answer beats skipping the
 * check; failure degrades to 'unreadable' in the caller.
 */
export const readTaskBudgetSpent: TaskBudgetSpentReader = (chainId, delegationHash) =>
  readSpentFromChain(chainId, delegationHash)

/**
 * #3501: the REPORT variant of the read — identical contract, but behind the
 * bounded transport (per-leg timeout split, retryCount 0, the #1145
 * discipline): a report is a polled, advisory read, and the endpoint that
 * carries it must answer promptly even when every RPC endpoint hangs. The
 * enforcer still rules at redemption, so a prompt "unknown" beats a correct
 * number that arrives late.
 */
export const readTaskBudgetSpentBounded: TaskBudgetSpentReader = (chainId, delegationHash) =>
  readSpentFromChain(chainId, delegationHash, taskBudgetSpentReadTransportOptions(chainId))
