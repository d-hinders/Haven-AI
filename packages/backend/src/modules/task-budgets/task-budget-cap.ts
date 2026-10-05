/**
 * #3500: an open task budget's cap, checked BEFORE a payment is built.
 *
 * A task budget is a child delegation whose cap is an `ERC20TransferAmountEnforcer`
 * caveat: a cumulative ceiling on what may ever be transferred through that
 * child, tracked by the enforcer in `spentMap(delegationManager, delegationHash)`.
 * The chain enforces it: a payment past the cap reverts during the UserOp's
 * simulation (`ERC20TransferAmountEnforcer:allowance-exceeded`). Before this,
 * that revert reached the agent as an untyped 502 whose hosted next step said
 * "transient, retry once", and on the erc7710 leg (where Haven builds no
 * UserOp) it would only surface when the merchant tried to redeem.
 *
 * This reads the enforcer's own storage, the same authority the chain applies,
 * so the refusal is decided on the figure that would have reverted. It is a
 * guide, never the gate: an unreadable chain degrades to "not checked" and the
 * enforcer still refuses on-chain. Where Haven builds a UserOp (`POST
 * /payments`, the x402 funding leg) a transfer-cap revert re-reads this figure
 * and answers the same typed refusal only if the read confirms it; otherwise
 * the old 502 stands. The erc7710 leg builds nothing, so it has no fallback.
 *
 * `spentMap` counts only REDEEMED spend: authorizations issued but not yet
 * redeemed (erc7710 settlement children in flight) are invisible here, so two
 * concurrent payments can each pass and the second still fail on-chain.
 */
import type { Hex } from 'viem'
import {
  readTaskBudgetSpent,
  readTaskBudgetSpentBounded,
  type TaskBudgetSpentReader,
} from '../../infra/chain/task-budget-spent-reader.js'

export { readTaskBudgetSpent, readTaskBudgetSpentBounded, type TaskBudgetSpentReader }

export type TaskBudgetCapCheck =
  | { outcome: 'fits' }
  | { outcome: 'exceeded'; spentAtomic: bigint; remainingAtomic: bigint; maxAtomic: bigint }
  /** The read failed: not checked. The enforcer remains the gate. */
  | { outcome: 'unreadable' }

export async function checkTaskBudgetCap(
  input: { chainId: number; delegationHash: string; maxAtomic: string; amountAtomic: bigint },
  readSpent: TaskBudgetSpentReader = readTaskBudgetSpent,
): Promise<TaskBudgetCapCheck> {
  let maxAtomic: bigint
  let spentAtomic: bigint
  try {
    maxAtomic = BigInt(input.maxAtomic)
    spentAtomic = await readSpent(input.chainId, input.delegationHash as Hex)
  } catch {
    return { outcome: 'unreadable' }
  }
  const remainingAtomic = spentAtomic >= maxAtomic ? 0n : maxAtomic - spentAtomic
  // `<`, never `<=`: spending the exact remainder is what the enforcer allows.
  if (remainingAtomic < input.amountAtomic) {
    return { outcome: 'exceeded', spentAtomic, remainingAtomic, maxAtomic }
  }
  return { outcome: 'fits' }
}

/** The typed refusal body, shared by every path that takes a task budget. */
export function taskBudgetExceededBody(input: {
  taskBudgetId: string
  tokenSymbol: string
  amountHuman: string
  amountAtomic: string
  remainingAtomic: string
  remainingHuman: string
  maxAtomic: string
}): Record<string, unknown> {
  const remaining = ` (${input.remainingHuman} ${input.tokenSymbol} left)`
  return {
    error:
      `This payment of ${input.amountHuman} ${input.tokenSymbol} exceeds what is left of task budget ` +
      `${input.taskBudgetId}${remaining}. Its cap is enforced on-chain, so retrying cannot succeed. ` +
      'Close this task budget and open a new one, or pay without it from the agent\'s own budget.',
    error_code: 'task_budget_exceeded',
    task_budget_id: input.taskBudgetId,
    amount_atomic: input.amountAtomic,
    remaining_atomic: input.remainingAtomic,
    max_atomic: input.maxAtomic,
  }
}

/**
 * #3501: the READ-side twin of {@link checkTaskBudgetCap} — spent/remaining
 * for a task-budget REPORT, decided on the same authority (the enforcer's
 * own `spentMap` for the child's delegation hash).
 *
 * A report must never lie by omission: a failed chain read answers
 * `spentAtomic: null, remainingAtomic: null` with a console warning, and the
 * caller labels the figures unavailable. It must NEVER fall back to "remaining
 * = the full cap" the way the parent budget's read does (#1145 kept its
 * fallback because that number had a prior behaviour to preserve): for a task
 * budget the full cap as "remaining" is exactly the wrong answer the issue
 * reports — the agent would read `1500/1500 left`, attempt the payment, and
 * revert on-chain again. Unavailable is honest; optimistic is not.
 */
export async function readTaskBudgetSpentForReport(
  input: { chainId: number; delegationHash: string; maxAtomic: string },
  // The BOUNDED variant: a report is a polled, advisory read and the GET
  // endpoints carrying it must answer promptly even when every RPC endpoint
  // hangs (#1145's lesson). Inject `readTaskBudgetSpent` (unbounded) to
  // reproduce the pre-check's contract in tests.
  readSpent: TaskBudgetSpentReader = readTaskBudgetSpentBounded,
): Promise<{ spentAtomic: string | null; remainingAtomic: string | null }> {
  try {
    const spent = await readSpent(input.chainId, input.delegationHash as Hex)
    const max = BigInt(input.maxAtomic)
    const remaining = spent >= max ? 0n : max - spent
    return { spentAtomic: spent.toString(), remainingAtomic: remaining.toString() }
  } catch (err) {
    console.warn(
      `task-budget: on-chain spent read unavailable for delegation ${input.delegationHash} ` +
        `(chain ${input.chainId}) — reporting spent/remaining as null rather than an optimistic figure: ` +
        (err instanceof Error ? err.message : String(err)),
    )
    return { spentAtomic: null, remainingAtomic: null }
  }
}
