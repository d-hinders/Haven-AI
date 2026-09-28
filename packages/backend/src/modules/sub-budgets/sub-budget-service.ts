/**
 * Sub-budget orchestration (#3330): narrowing validation, the two-child
 * build, payment-time resolution and close preparation. The ENFORCERS
 * remain the authority — every check here is a pre-sign REFUSAL convenience
 * (the same posture `modules/task-budgets/task-budget-service.ts` states for
 * #3329), never a second source of truth: an over-budget or mismatched
 * sub-budget redemption still reverts on-chain regardless of what this
 * module decides, because the DelegationManager enforces all three hops of
 * the `[B child, A child, A budget]` chain in one redemption.
 */

import type { Address, Hex } from 'viem'
import type { Delegation } from '@metamask/smart-accounts-kit'
import { getUserOperationHash, entryPoint07Address } from 'viem/account-abstraction'
import { sumOpenReservedForParent, type SubBudgetRow } from '../../infra/repositories/sub-budgets.js'
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
import {
  buildSubBudgetGrant,
  buildSubBudgetParentChild,
  readParentExpiry,
  readParentPeriodScope,
  type BuiltSubBudgetDelegation,
  type SubBudgetNarrowing,
} from './sub-budget-delegation.js'

export { subBudgetSalt } from './sub-budget-delegation.js'

/**
 * #3330 gate: "the API refuses a child wider than the parent in any of
 * amount, expiry or recipient BEFORE signing" — and it decodes the parent
 * budget delegation ITSELF to do it, so the check is against the instrument
 * that will actually enforce, never a request field. Runs before either
 * child is built, so a wider request never reaches a signing payload.
 *
 * - amount: the requested period amount must be ≤ the parent budget's own
 *   `periodAmount` (decoded from the parent's
 *   `ERC20PeriodTransferEnforcer` caveat).
 * - expiry: the child must not outlive the parent delegation's own
 *   `TimestampEnforcer` upper bound.
 * - recipient: a pinned child may only be pinned to the SAME recipient the
 *   parent delegation pins (a parent delegation with no pin may carry one —
 *   the pin narrows); a child can never WIDEN a pin away.
 *
 * `parentBudgetToken` and `parentRecipient` arrive from the caller's
 * delegation ROW (the authoritative, owner-granted record).
 */
export function checkNarrowingRefusal(input: {
  budgetDelegation: Delegation
  parentBudgetToken: string
  parentRecipientAddress: string | null
  requested: { periodAmountAtomic: bigint; recipient?: Address; expiresAt: number }
}):
  | { ok: true; parentScope: { token: Address; periodAmount: bigint; periodDuration: number; startDate: number } }
  | { ok: false; reason: 'amount' | 'expiry' | 'recipient' | 'parent_not_period_scoped' } {
  const parentScope = readParentPeriodScope(input.budgetDelegation)
  if (!parentScope) return { ok: false, reason: 'parent_not_period_scoped' }
  if (parentScope.token.toLowerCase() !== input.parentBudgetToken.toLowerCase()) {
    return { ok: false, reason: 'parent_not_period_scoped' }
  }
  if (BigInt(input.requested.periodAmountAtomic) > BigInt(parentScope.periodAmount)) {
    return { ok: false, reason: 'amount' }
  }
  // The parent delegation's OWN timestamp caveat is its expiry — the row's
  // clock and the caveat are one thing (the builder always writes both).
  const parentExpiry = readParentExpiry(input.budgetDelegation)
  if (parentExpiry !== null && input.requested.expiresAt > parentExpiry) {
    return { ok: false, reason: 'expiry' }
  }
  if (
    input.parentRecipientAddress &&
    (!input.requested.recipient ||
      input.requested.recipient.toLowerCase() !== input.parentRecipientAddress.toLowerCase())
  ) {
    return { ok: false, reason: 'recipient' }
  }
  return { ok: true, parentScope }
}

export interface BuildChildrenInput {
  chainId: number
  subBudgetId: string
  /** A's delegate-owner address (drives both account derivations). */
  delegatingOwnerAddress: Address
  /** B's delegate-owner address (drives the grant's `to` derivation). */
  subAgentOwnerAddress: Address
  /** A's SIGNED budget delegation — the root parent. */
  budgetDelegation: Delegation
  narrowing: SubBudgetNarrowing
}

export interface BuiltSubBudgetChildren {
  parentChild: BuiltSubBudgetDelegation & { delegateAccountAddress: Address }
  grant: BuiltSubBudgetDelegation & { subAgentAccountAddress: Address }
}

/**
 * Build BOTH children of one sub-budget: A's self-delegated parent-child
 * and B's grant chained under it. A's delegate key will sign the
 * parent-child, and A signs the grant too (the grant's delegator is A's own
 * account — the owner-approved envelope, decision log 2026-09-27). The
 * grant's salt uses the SAME sub-budget id, so the two rows of one tree
 * share one identity root (`haven-sub-budget:<id>`), each with its own
 * delegator/delegate/scope bytes.
 */
export async function buildSubBudgetChildren(input: BuildChildrenInput): Promise<BuiltSubBudgetChildren> {
  const [delegatingAccountAddress, subAgentAccountAddress] = await Promise.all([
    computeHybridAccountAddress(input.chainId, { ownerAddress: input.delegatingOwnerAddress }),
    computeHybridAccountAddress(input.chainId, { ownerAddress: input.subAgentOwnerAddress }),
  ])
  if (subAgentAccountAddress.toLowerCase() === delegatingAccountAddress.toLowerCase()) {
    throw new Error('the sub-agent resolves to the delegating agent itself — use a task budget (#3329)')
  }
  const parentChild = buildSubBudgetParentChild({
    chainId: input.chainId,
    subBudgetId: input.subBudgetId,
    delegateAccountAddress: delegatingAccountAddress,
    budgetDelegation: input.budgetDelegation,
    narrowing: input.narrowing,
  })
  const grant = buildSubBudgetGrant({
    chainId: input.chainId,
    subBudgetId: input.subBudgetId,
    delegatingAccountAddress,
    subAgentAccountAddress,
    parentChildDelegation: { ...parentChild.child, signature: '0x' } as Delegation,
    narrowing: input.narrowing,
  })
  return {
    parentChild: { ...parentChild, delegateAccountAddress: delegatingAccountAddress },
    grant: { ...grant, subAgentAccountAddress },
  }
}

/** Reasons a sub-budget cannot authorize a payment (#3330 refusal table). */
export type SubBudgetPaymentRefusal =
  | 'sub_budget_not_found'
  | 'sub_budget_not_open'
  | 'sub_budget_token_mismatch'
  | 'sub_budget_recipient_mismatch'
  | 'sub_budget_parent_mismatch'

export interface SubBudgetPaymentResolution {
  ok: boolean
  refusal?: SubBudgetPaymentRefusal
  row?: SubBudgetRow
}

/**
 * The checks a payment surface runs before it will use a sub-budget to
 * authorize a payment: the grant row must be OPEN and unexpired, the token
 * must match, the pinned recipient (if any) must match `to`, the row's
 * `parent_delegation_hash` must equal the SELECTED budget delegation's hash
 * (the same #3329 review finding E rule: a sub-budget can only ever spend
 * through the exact parent it was carved from), AND the parent-child row
 * that hash names must itself still be OPEN and unexpired — revoking A's
 * budget delegation makes A's parent-child unresolvable at payment time
 * (the active-by-hash lookup in `routes/payments.ts` answers null) and
 * strands B's child on-chain once the owner's disable lands, even while
 * B's own row still says `open`.
 */
export function checkSubBudgetForPayment(
  row: SubBudgetRow | null,
  parentChildRow: SubBudgetRow | null,
  tokenAddress: string,
  toAddress: string,
  selectedParentDelegationHash: string,
  nowSec: number,
): SubBudgetPaymentResolution {
  if (!row) return { ok: false, refusal: 'sub_budget_not_found' }
  if (row.status !== 'open' || Number(row.expires_at) <= nowSec) {
    return { ok: false, refusal: 'sub_budget_not_open' }
  }
  if (row.token_address.toLowerCase() !== tokenAddress.toLowerCase()) {
    return { ok: false, refusal: 'sub_budget_token_mismatch' }
  }
  if (row.recipient_address && row.recipient_address.toLowerCase() !== toAddress.toLowerCase()) {
    return { ok: false, refusal: 'sub_budget_recipient_mismatch' }
  }
  if (
    !parentChildRow ||
    parentChildRow.status !== 'open' ||
    Number(parentChildRow.expires_at) <= nowSec
  ) {
    // The middle link of the chain is dead on the storage side — the on-chain
    // disable (whenever it lands) only confirms what the row already says.
    return { ok: false, refusal: 'sub_budget_parent_mismatch' }
  }
  // BOTH edges of the two-hop tree must bind, or the chain is broken. Edge 1:
  // the grant hangs from the parent-child row — its parent_delegation_hash
  // names the parent-child's OWN delegation_hash. Edge 2: the parent-child
  // hangs from the budget delegation selected for this payment (its OWN
  // parent_delegation_hash names that budget's hash — the #3329
  // review-finding-E rule twice over: the budget is used VERBATIM by hash,
  // never re-selected). A grant naming a parent-child that is not the row
  // resolved by hash, or a parent-child carved from a different budget than
  // the one selected, is a broken chain refused here.
  if (row.parent_delegation_hash.toLowerCase() !== parentChildRow.delegation_hash.toLowerCase()) {
    return { ok: false, refusal: 'sub_budget_parent_mismatch' }
  }
  if (parentChildRow.parent_delegation_hash.toLowerCase() !== selectedParentDelegationHash.toLowerCase()) {
    return { ok: false, refusal: 'sub_budget_parent_mismatch' }
  }
  return { ok: true, row }
}

/**
 * Combine the check above with the resolved budget delegation to produce the
 * three-link chain input `prepareDelegationPayment` wants — the single call
 * every payment surface (`routes/payments.ts`, `modules/x402/delegation-authorize.ts`)
 * makes once it has the grant row, its live parent-child row, and the SAME
 * budget delegation row the grant was carved from.
 */
export function resolveSubBudgetForPayment(
  row: SubBudgetRow | null,
  parentChildRow: SubBudgetRow | null,
  tokenAddress: string,
  toAddress: string,
  selectedParentDelegation: DelegationForPaymentRow,
  nowSec: number,
): SubBudgetPaymentResolution & { childDelegation?: Delegation } {
  const checked = checkSubBudgetForPayment(
    row,
    parentChildRow,
    tokenAddress,
    toAddress,
    selectedParentDelegation.delegation_hash,
    nowSec,
  )
  if (!checked.ok || !checked.row) return checked
  return { ...checked, childDelegation: JSON.parse(checked.row.delegation_json) as Delegation }
}

export interface CloseOutcome {
  /** True when nothing needs signing — the route marks closed immediately. */
  trivial: boolean
  prepared?: PreparedRedemption
}

/**
 * Prepare the close of a LIVE, open sub-budget child:
 * `disableDelegation(child)` from the closing agent's OWN delegate account
 * (owner decision #3329-2's rule, carried over: close is
 * authority-reducing only, the delegate account's own on-chain call — never
 * a Haven signature). Works for BOTH rows of a tree: A closing its
 * parent-child (which strands B's child — its chain's middle link is
 * disabled on-chain once this lands), and B closing its own grant (which
 * leaves A intact). Trivial when the row is `pending` (never signed,
 * nothing on-chain) or already expired.
 */
export async function prepareSubBudgetClose(
  agent: { chain_id: number; delegate_address: string },
  row: SubBudgetRow,
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

/** `agent_sub_budgets.prepared_user_op` storage form — bigints survive as strings. */
export function serializeClosePreparedUserOp(prepared: PreparedRedemption): string {
  return serializeUserOp(prepared.userOperation)
}

export type SubBudgetSignContext =
  | {
      purpose: 'open'
      sub_budget_sign_context_version: 1
      typed_data: ReturnType<typeof delegationSigningPayload>
      expected: {
        delegate_account: string
        chain_id: number
        token_address: string
        period_amount_atomic: string
        /** #3330: the parent window the child reuses verbatim. */
        period_duration_seconds: number
        start_date: number
        /** The row's own delegate account (A's, or B's on a grant row). */
        child_delegate_account: string
        recipient_address: string | null
        expires_at: number
        parent_delegation_hash: string
      }
    }
  | {
      purpose: 'close'
      sub_budget_sign_context_version: 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typed_data: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user_operation: any
      user_op_hash: Hex
      expected: { delegate_account: string; chain_id: number; delegation_hash: string }
    }

/**
 * The re-servable sign context for a pending (open the child) or closing
 * (sign the disableDelegation UserOp) sub-budget —
 * `GET /sub-budgets/:id/sign-context`. `null` for any other status (the
 * route answers 409 `sign_context_unavailable`).
 */
export async function buildSubBudgetSignContext(
  agent: { chain_id: number; delegate_address: string },
  row: SubBudgetRow,
): Promise<SubBudgetSignContext | null> {
  const delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
    ownerAddress: agent.delegate_address as Address,
  })
  if (row.status === 'pending') {
    const child = JSON.parse(row.delegation_json) as Delegation
    // The parent window the child reuses verbatim is IN the child's own
    // period caveat terms (the builder pins periodDuration/startDate from the
    // parent scope), so the expected fields derive from the stored child
    // bytes — no second decode of the budget delegation needed here.
    const childScope = readParentPeriodScope(child)
    if (!childScope) {
      throw new Error('the stored sub-budget child carries no ERC20PeriodTransferEnforcer caveat')
    }
    return {
      purpose: 'open',
      sub_budget_sign_context_version: 1,
      typed_data: delegationSigningPayload(child, agent.chain_id),
      expected: {
        delegate_account: delegateAccountAddress,
        chain_id: agent.chain_id,
        token_address: row.token_address,
        period_amount_atomic: row.period_amount_atomic,
        // #3330: the parent window the child reuses verbatim + the row's own
        // delegate account (A's for a parent-child row, B's for a grant) —
        // everything the signer's `assertOwnSubBudgetChild` checks locally.
        period_duration_seconds: childScope.periodDuration,
        start_date: childScope.startDate,
        child_delegate_account: (child as unknown as { delegate: string }).delegate,
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
      sub_budget_sign_context_version: 1,
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
 * Recover the signer of a just-signed sub-budget child and confirm it is
 * the delegating agent's OWN delegate key (the route's `signature_mismatch`
 * refusal) — the same recovery `agent-delegations.ts`'s activation path
 * uses for a budget delegation and #3329 uses for a task child. Used for
 * BOTH rows: A signs its parent-child, and A signs B's grant (whose
 * delegator is still A's account).
 */
export async function recoverSubBudgetChildSigner(
  row: SubBudgetRow,
  chainId: number,
  signature: Hex,
): Promise<string> {
  const child = JSON.parse(row.delegation_json) as Delegation
  return recoverDelegationSigner(child, chainId, signature)
}

/** Submit the stored close UserOp with the agent's signature. */
export async function submitSubBudgetClose(
  agent: { chain_id: number; delegate_address: string },
  row: SubBudgetRow,
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
 * #3329 review finding N2(b)'s rule: whether this sub-budget's child is
 * ALREADY disabled on-chain — the only trustworthy answer to "did a
 * submitted-but-unconfirmed close UserOp land?". A failed read is "not
 * confirmed disabled", never an error (#3329 review finding N6).
 */
export async function isSubBudgetChildDisabledOnChain(
  chainId: number,
  delegationHash: Hex,
): Promise<boolean> {
  try {
    const disabled = await readDisabledDelegationHashes(chainId, [delegationHash])
    return disabled.has(delegationHash)
  } catch {
    return false
  }
}
