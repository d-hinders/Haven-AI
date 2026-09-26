/**
 * Task budget orchestration (#3329): the remainder pre-check, child build,
 * payment-time resolution and close preparation. The ENFORCERS remain the
 * authority — every check here is a pre-sign REFUSAL convenience (owner
 * decision #3329-3), never a second source of truth: an over-budget or
 * mismatched task-budget redemption still reverts on-chain regardless of
 * what this module decides.
 */

import type { Address, Hex } from 'viem'
import type { Delegation } from '@metamask/smart-accounts-kit'
import { getUserOperationHash, entryPoint07Address } from 'viem/account-abstraction'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import { sumOpenReservedAtomic, type TaskBudgetRow } from '../../infra/repositories/task-budgets.js'
import type { DelegationForPaymentRow } from '../../infra/repositories/delegation-budgets.js'
import { computeHybridAccountAddress } from '../../rails/hybrid-provisioning.js'
import { buildRevocation, delegationSigningPayload, recoverDelegationSigner } from '../../rails/delegation-policy.js'
import {
  createDelegationRail,
  delegationRailBundlerUrl,
  readDisabledDelegationHashes,
  userOpTypedData,
  type PreparedRedemption,
  type RedemptionSubmitResult,
} from '../../rails/delegation-rail.js'
import { deserializeUserOp, serializeUserOp } from '../../rails/execution-rail.js'
import { buildTaskBudgetDelegation, type BuiltTaskBudgetDelegation } from './task-budget-delegation.js'

export interface RemainderCheck {
  ok: boolean
  remainingAtomic: string
  reservedAtomic: string
  /** Remaining minus already-reserved — what a NEW task budget may still claim. */
  availableAtomic: string
}

/**
 * Owner decision #3329-3: "pre-sign refusal when open children + request >
 * on-chain remainder". Reads the parent's on-chain remaining budget (the
 * same enforcer read `GET /machine-payments/allowances` uses) and subtracts
 * the sum of this agent's other OPEN, unexpired task budgets under the same
 * parent — so two task budgets cannot both claim the same slice of a budget
 * that has not yet been spent.
 */
export async function checkRemainderForNewTaskBudget(
  agentId: string,
  chainId: number,
  parentDelegation: DelegationForPaymentRow,
  requestedAtomic: bigint,
  budgetAtomicFallback: string,
  nowSec: number,
): Promise<RemainderCheck> {
  const [{ remainingAtomic }, reserved] = await Promise.all([
    readRemainingBudget(chainId, parentDelegation.delegation_json, budgetAtomicFallback),
    sumOpenReservedAtomic(agentId, parentDelegation.delegation_hash, nowSec),
  ])
  const remaining = BigInt(remainingAtomic)
  const available = remaining > reserved ? remaining - reserved : 0n
  return {
    ok: requestedAtomic <= available,
    remainingAtomic,
    reservedAtomic: reserved.toString(),
    availableAtomic: available.toString(),
  }
}

export interface BuildChildInput {
  chainId: number
  taskBudgetId: string
  delegateOwnerAddress: Address
  budgetDelegation: Delegation
  token: Address
  maxAtomic: bigint
  recipient?: Address
  ttlSeconds: number
}

/** Derives the delegate account address and builds the unsigned child. */
export async function buildTaskBudgetChild(
  input: BuildChildInput,
): Promise<BuiltTaskBudgetDelegation & { delegateAccountAddress: Address }> {
  const delegateAccountAddress = await computeHybridAccountAddress(input.chainId, {
    ownerAddress: input.delegateOwnerAddress,
  })
  const built = buildTaskBudgetDelegation({
    chainId: input.chainId,
    taskBudgetId: input.taskBudgetId,
    delegateAccountAddress,
    budgetDelegation: input.budgetDelegation,
    token: input.token,
    maxAtomic: input.maxAtomic,
    recipient: input.recipient,
    ttlSeconds: input.ttlSeconds,
  })
  return { ...built, delegateAccountAddress }
}

/** Reasons a task budget cannot authorize a payment (#3329 §3 refusal table). */
export type TaskBudgetPaymentRefusal =
  | 'task_budget_not_found'
  | 'task_budget_not_open'
  | 'task_budget_token_mismatch'
  | 'task_budget_recipient_mismatch'
  | 'task_budget_parent_mismatch'

export interface TaskBudgetPaymentResolution {
  ok: boolean
  refusal?: TaskBudgetPaymentRefusal
  row?: TaskBudgetRow
}

/**
 * The checks `prepareDelegationPayment` runs before it will use a task
 * budget to authorize a payment (#3329 §2): row must already be OPEN and
 * unexpired, the token must match, the pinned recipient (if any) must match
 * `to`, and the row's `parent_delegation_hash` must equal the SELECTED
 * budget delegation's hash — a task budget can only ever spend through the
 * exact parent it was carved from, never a different active grant that
 * happens to cover the same token. An EXPIRED open row answers
 * `task_budget_not_open` (not `not_found` — the row exists, it is simply no
 * longer usable), same as `selectOpenForPayment`'s storage-scoped filter.
 */
export function checkTaskBudgetForPayment(
  row: TaskBudgetRow | null,
  tokenAddress: string,
  toAddress: string,
  selectedParentDelegationHash: string,
  nowSec: number,
): TaskBudgetPaymentResolution {
  if (!row) return { ok: false, refusal: 'task_budget_not_found' }
  if (row.status !== 'open' || Number(row.expires_at) <= nowSec) {
    return { ok: false, refusal: 'task_budget_not_open' }
  }
  if (row.token_address.toLowerCase() !== tokenAddress.toLowerCase()) {
    return { ok: false, refusal: 'task_budget_token_mismatch' }
  }
  if (row.recipient_address && row.recipient_address.toLowerCase() !== toAddress.toLowerCase()) {
    return { ok: false, refusal: 'task_budget_recipient_mismatch' }
  }
  if (row.parent_delegation_hash.toLowerCase() !== selectedParentDelegationHash.toLowerCase()) {
    return { ok: false, refusal: 'task_budget_parent_mismatch' }
  }
  return { ok: true, row }
}

/**
 * Combine the check above with the resolved budget delegation to produce the
 * `[taskChild, budget]` chain input `prepareDelegationPayment` wants — the
 * single call every payment surface (`routes/payments.ts`,
 * `modules/x402/delegation-authorize.ts`) makes once it has the task budget
 * row and the SAME budget delegation row it is about to authorize against.
 */
export function resolveTaskBudgetChildForPayment(
  row: TaskBudgetRow | null,
  tokenAddress: string,
  toAddress: string,
  selectedParentDelegation: DelegationForPaymentRow,
  nowSec: number,
): TaskBudgetPaymentResolution & { childDelegation?: Delegation } {
  const checked = checkTaskBudgetForPayment(
    row,
    tokenAddress,
    toAddress,
    selectedParentDelegation.delegation_hash,
    nowSec,
  )
  if (!checked.ok || !checked.row) return checked
  return { ...checked, childDelegation: JSON.parse(checked.row.delegation_json) as Delegation }
}

export interface CloseOutcome {
  /** True when nothing needs signing — the route markCloses immediately. */
  trivial: boolean
  prepared?: PreparedRedemption
}

/**
 * Prepare the close of a LIVE, open task budget: `disableDelegation(child)`
 * from the agent's own delegate account (owner decision #3329-2: close is
 * authority-reducing only, the delegate account's own on-chain call — never
 * a Haven signature). Trivial when the row is `pending` (never signed,
 * nothing on-chain), or `open`/`closing` but already expired — #3329 review
 * finding N2(c): a `closing` row's expiry is the CHILD's own spend caveat,
 * unaffected by which status the close ended up in; once past it the child
 * cannot be redeemed for spending either way, so a revoke call is equally
 * pure overhead in both statuses.
 */
export async function prepareTaskBudgetClose(
  agent: { chain_id: number; delegate_address: string },
  row: TaskBudgetRow,
  nowSec: number,
): Promise<CloseOutcome> {
  if (row.status === 'pending') return { trivial: true }
  if ((row.status === 'open' || row.status === 'closing') && Number(row.expires_at) <= nowSec) {
    return { trivial: true }
  }
  const child = JSON.parse(row.delegation_json) as Delegation
  const revocation = buildRevocation(child, agent.chain_id)
  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.delegate_address as Address,
    chainId: agent.chain_id,
    bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
    sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
  })
  const prepared = await rail.prepareAccountCall(revocation.to, revocation.data as Hex)
  return { trivial: false, prepared }
}

/** `agent_task_budgets.prepared_user_op` storage form — bigints survive as strings. */
export function serializeClosePreparedUserOp(prepared: PreparedRedemption): string {
  return serializeUserOp(prepared.userOperation)
}

export type TaskBudgetSignContext =
  | {
      purpose: 'open'
      task_sign_context_version: 1
      typed_data: ReturnType<typeof delegationSigningPayload>
      expected: {
        delegate_account: string
        chain_id: number
        token_address: string
        max_amount_atomic: string
        recipient_address: string | null
        expires_at: number
        parent_delegation_hash: string
      }
    }
  | {
      purpose: 'close'
      task_sign_context_version: 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typed_data: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user_operation: any
      user_op_hash: Hex
      expected: { delegate_account: string; chain_id: number; delegation_hash: string }
    }

/**
 * The re-servable sign context for a pending (open the child) or closing
 * (sign the disableDelegation UserOp) task budget — `GET
 * /task-budgets/:id/sign-context` (#3329 §3). `null` for any other status
 * (the route answers 409 `sign_context_unavailable`).
 */
export async function buildTaskBudgetSignContext(
  agent: { chain_id: number; delegate_address: string },
  row: TaskBudgetRow,
): Promise<TaskBudgetSignContext | null> {
  const delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
    ownerAddress: agent.delegate_address as Address,
  })
  if (row.status === 'pending') {
    const child = JSON.parse(row.delegation_json) as Delegation
    return {
      purpose: 'open',
      task_sign_context_version: 1,
      typed_data: delegationSigningPayload(child, agent.chain_id),
      expected: {
        delegate_account: delegateAccountAddress,
        chain_id: agent.chain_id,
        token_address: row.token_address,
        max_amount_atomic: row.max_atomic,
        recipient_address: row.recipient_address,
        expires_at: Number(row.expires_at),
        parent_delegation_hash: row.parent_delegation_hash,
      },
    }
  }
  if (row.status === 'closing' && row.prepared_user_op) {
    const userOperation = deserializeUserOp(row.prepared_user_op)
    const typedData = userOpTypedData(userOperation, delegateAccountAddress, agent.chain_id)
    const userOpHash = getUserOperationHash({
      chainId: agent.chain_id,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: { ...(userOperation as object), sender: delegateAccountAddress } as never,
    })
    return {
      purpose: 'close',
      task_sign_context_version: 1,
      typed_data: typedData,
      user_operation: userOperation,
      user_op_hash: userOpHash,
      expected: {
        delegate_account: delegateAccountAddress,
        chain_id: agent.chain_id,
        delegation_hash: row.delegation_hash,
      },
    }
  }
  return null
}

/**
 * Recover the signer of the agent's just-signed task-budget child and
 * confirm it is the agent's OWN delegate key (#3329 §3's `signature_mismatch`
 * refusal) — the same recovery `agent-delegations.ts`'s activation path uses
 * for a budget delegation.
 */
export async function recoverTaskBudgetChildSigner(
  row: TaskBudgetRow,
  chainId: number,
  signature: Hex,
): Promise<string> {
  const child = JSON.parse(row.delegation_json) as Delegation
  return recoverDelegationSigner(child, chainId, signature)
}

/** Submit the stored close UserOp with the agent's signature. */
export async function submitTaskBudgetClose(
  agent: { chain_id: number; delegate_address: string },
  row: TaskBudgetRow,
  signature: Hex,
): Promise<RedemptionSubmitResult> {
  const rail = await createDelegationRail({
    delegateOwnerAddress: agent.delegate_address as Address,
    chainId: agent.chain_id,
    bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
    sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
  })
  const userOperation = deserializeUserOp(row.prepared_user_op)
  return rail.submitRedemption(
    {
      userOperation,
      userOpHash: '0x' as Hex,
      signingTypedData: null,
      delegateAccountAddress: rail.delegateAccountAddress,
    },
    signature,
  )
}

/**
 * #3329 review finding N2(b): whether this task budget's child is ALREADY
 * disabled on-chain — the only trustworthy answer to "did a submitted-but-
 * unconfirmed close UserOp land?" `readDisabledDelegationHashes` already
 * requires two consecutive agreeing reads pinned to `finalized` before it
 * will report true, so a false positive here (which would close the row
 * without ever having disabled the child) is the same bar the delegation
 * revoke-all healer holds itself to.
 */
export async function isTaskBudgetChildDisabledOnChain(
  chainId: number,
  delegationHash: Hex,
): Promise<boolean> {
  const disabled = await readDisabledDelegationHashes(chainId, [delegationHash])
  return disabled.has(delegationHash)
}
