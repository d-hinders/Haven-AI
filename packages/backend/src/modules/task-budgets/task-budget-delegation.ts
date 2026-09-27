/**
 * Task budget child delegation (#3329) — the unsigned, self-delegated CHILD
 * of an agent's budget delegation, scoped to one task.
 *
 * Chain: `[task child, budget]` (leaf first) — same shape as the x402
 * erc7710 settlement chain (`modules/x402/x402-delegation.ts`), but the
 * DELEGATE is the agent's OWN delegate account, never `ANY_BENEFICIARY`
 * (owner decision #3329-1: "the child's delegate = the agent's OWN delegate
 * smart account (self-delegation under its budget)"). That is what makes a
 * task child a DIFFERENT typed-data class than a settlement child — the SDK
 * guard (`@haven_ai/sdk` `isTaskChildTypedData`) tells them apart on exactly
 * this field (`message.delegate === message.delegator`).
 *
 * Pure construction — no DB, no network, no signing — mirroring
 * `rails/delegation-policy.ts` and `modules/x402/x402-delegation.ts`.
 */

import { keccak256, pad, stringToBytes, type Address, type Hex } from 'viem'
import { createDelegation, type Delegation } from '@metamask/smart-accounts-kit'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { getDelegationEnvironment, delegationSigningPayload } from '../../rails/delegation-policy.js'

/** Owner decision #3329-4: TTL bounds for a task budget's life. */
export const MAX_TASK_BUDGET_TTL_SECONDS = 86_400
export const MIN_TASK_BUDGET_TTL_SECONDS = 60

/**
 * Domain-separated salt keyed on the task budget's OWN id (owner decision
 * #3329-4: `haven-task-budget:<task_budget_id>`) — distinct from both the
 * budget-delegation salt (`haven-delegation:`) and the settlement-child salt
 * (`haven-x402-settlement:`), so no task child can ever collide with either.
 */
export function taskBudgetSalt(taskBudgetId: string): Hex {
  if (!taskBudgetId) throw new Error('task budget id is required to salt the child delegation')
  return keccak256(stringToBytes(`haven-task-budget:${taskBudgetId}`))
}

export interface TaskBudgetDelegationRequest {
  chainId: number
  taskBudgetId: string
  /** The agent's delegate account — both delegator AND delegate (self). */
  delegateAccountAddress: Address
  /** The SIGNED budget delegation (the parent) this child is carved from. */
  budgetDelegation: Delegation
  token: Address
  maxAtomic: bigint
  /** Pinned recipient; undefined = the task budget carries no recipient pin. */
  recipient?: Address
  ttlSeconds: number
}

export interface BuiltTaskBudgetDelegation {
  child: Omit<Delegation, 'signature'>
  childHash: Hex
  /** EIP-712 payload the AGENT signs client-side — Haven never signs. */
  signingPayload: ReturnType<typeof delegationSigningPayload>
  expiresAt: number
}

/**
 * The narrowed, unsigned task-budget child. `to` is always the agent's own
 * delegate account — no `ANY_BENEFICIARY` on a task child (#3329 invariant,
 * `delegation-policy.ts:26-29`'s reasoning carried over: an open BUDGET is
 * open in its recipient, never in who may redeem).
 */
export function buildTaskBudgetDelegation(
  req: TaskBudgetDelegationRequest,
): BuiltTaskBudgetDelegation {
  if (req.maxAtomic <= 0n) throw new Error('task budget max amount must be positive')
  if (
    !Number.isInteger(req.ttlSeconds) ||
    req.ttlSeconds < MIN_TASK_BUDGET_TTL_SECONDS ||
    req.ttlSeconds > MAX_TASK_BUDGET_TTL_SECONDS
  ) {
    throw new Error(
      `task budget ttl_seconds must be an integer between ${MIN_TASK_BUDGET_TTL_SECONDS} and ${MAX_TASK_BUDGET_TTL_SECONDS}`,
    )
  }
  const env = getDelegationEnvironment(req.chainId)
  const nowSec = Math.floor(Date.now() / 1000)
  const expiresAt = nowSec + req.ttlSeconds

  const caveats: Array<Record<string, unknown>> = []
  if (req.recipient) {
    caveats.push({
      type: 'allowedCalldata',
      startIndex: 4,
      value: pad(req.recipient.toLowerCase() as Hex, { size: 32 }),
    })
  }
  caveats.push({ type: 'timestamp', afterThreshold: 0, beforeThreshold: expiresAt })

  const child = createDelegation({
    environment: env,
    from: req.delegateAccountAddress,
    to: req.delegateAccountAddress, // self — never ANY_BENEFICIARY (see header)
    parentDelegation: req.budgetDelegation,
    scope: {
      type: 'erc20TransferAmount',
      tokenAddress: req.token,
      maxAmount: req.maxAtomic,
    },
    caveats: caveats as never,
    salt: taskBudgetSalt(req.taskBudgetId),
  })
  const childHash = hashDelegation({ ...child, signature: '0x' } as Delegation)
  return {
    child,
    childHash,
    signingPayload: delegationSigningPayload(child, req.chainId),
    expiresAt,
  }
}
