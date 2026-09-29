/**
 * Sub-budget child delegations (#3330) — the unsigned CHILDREN an agent (A)
 * issues when re-delegating a narrower budget to another agent (B) in the
 * same account, as an ERC-7710 child of A's OWN budget delegation.
 *
 * Two rows per tree (table `agent_sub_budgets`, migration 100):
 *
 *   A's row   the PARENT-CHILD: a SELF-delegated narrowing of A's budget
 *             delegation (`from === to === A's delegate account`) — the same
 *             shape class as #3329's task-budget child, so it can never name
 *             a different delegator.
 *   B's row   the GRANT: `from` A's delegate account, `to` B's delegate
 *             account, `parentDelegation` = A's SIGNED parent-child. A real
 *             grant between two accounts — never self.
 *
 * BOTH children are PERIOD-scoped (`erc20PeriodTransfer`): a sub-budget is a
 * slice of the parent's own period meter — periodAmount ≤ the parent's,
 * the SAME periodDuration and startDate (a slice of the same window, not a
 * different clock), expiry ≤ the parent's, optional recipient pin inherited
 * from the parent's (a child can pin; never unpin). The redemption chain B
 * walks is `[B child, A child, A budget]` — three links, leaf first — and
 * the DelegationManager enforces every caveat of all three hops in one
 * redemption, so the PARENT's period enforcer binds any spend B makes even
 * within B's own allowance (the chain is the enforcement; nothing here is).
 *
 * Owner decision (decision log 2026-09-27): sub-budget issuance is
 * owner-governed; A's delegate key only SIGNS these children within the
 * owner-approved envelope. Haven never signs (#824 invariant 12).
 *
 * Pure construction — no DB, no network, no signing — mirroring
 * `modules/task-budgets/task-budget-delegation.ts` and
 * `rails/delegation-policy.ts`.
 */

import { decodeAbiParameters, keccak256, pad, stringToBytes, type Address, type Hex } from 'viem'
import { createDelegation, type Delegation } from '@metamask/smart-accounts-kit'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { getDelegationEnvironment, delegationSigningPayload } from '../../rails/delegation-policy.js'

/**
 * Domain-separated salt keyed on the sub-budget's OWN id — `haven-sub-budget:`
 * is distinct from the budget-delegation salt (`haven-delegation:`), the
 * settlement-child salt (`haven-x402-settlement:`) and the task-budget salt
 * (`haven-task-budget:`), so no sub-budget child can ever collide with
 * either.
 */
export function subBudgetSalt(subBudgetId: string): Hex {
  if (!subBudgetId) throw new Error('sub-budget id is required to salt the child delegation')
  return keccak256(stringToBytes(`haven-sub-budget:${subBudgetId}`))
}

/** The narrowed period budget a sub-budget carries (#3330: never wider). */
export interface SubBudgetNarrowing {
  token: Address
  /** Per-period amount in atomic units — ≤ the parent's own periodAmount. */
  periodAmountAtomic: bigint
  /** The PARENT's period duration and anchor, reused verbatim. */
  periodDurationSeconds: number
  startDate: number
  recipient?: Address
  /** Unix seconds — the child's `TimestampEnforcer` upper bound. */
  expiresAt: number
}

export interface BuiltSubBudgetDelegation {
  child: Omit<Delegation, 'signature'>
  childHash: Hex
  /** EIP-712 payload the DELEGATING agent signs client-side. */
  signingPayload: ReturnType<typeof delegationSigningPayload>
  expiresAt: number
}

/**
 * The parent budget delegation's own period scope, decoded from its caveat
 * stack — `createDelegation` compiles a `erc20PeriodTransfer` scope into an
 * `ERC20PeriodTransferEnforcer` caveat whose terms are the kit's
 * TIGHT-PACKED `abi.encodePacked(address token, uint256 periodAmount,
 * uint256 periodDuration, uint256 startDate)` — 116 bytes (20 + 32×3), NOT
 * the head/tail `abi.encode` layout `decodeAbiParameters` expects (the
 * address is not padded to a word). Decoded by explicit slicing for that
 * reason (verified against the kit's own output, 2026-09-28). A sub-budget
 * can only be carved from a SINGLE-token PERIOD delegation; multi-token
 * parents (`buildMultiTokenBudgetDelegation`'s functionCall scope) are out
 * of scope for v1 (#3330 open question, answered in the slice).
 */
export function readParentPeriodScope(
  budgetDelegation: Delegation,
): { token: Address; periodAmount: bigint; periodDuration: number; startDate: number } | null {
  const periodCaveat = (budgetDelegation.caveats as Array<{ enforcer: string; terms: string }>).find(
    (c) => c.enforcer.toLowerCase() === getPeriodEnforcerAddress().toLowerCase(),
  )
  if (!periodCaveat) return null
  try {
    const body = (periodCaveat.terms as string).slice(2)
    // TIGHT packing: 20-byte address, then three 32-byte uint256s.
    if (body.length !== (20 + 32 * 3) * 2) return null
    const token = `0x${body.slice(0, 40)}` as Address
    const periodAmount = BigInt(`0x${body.slice(40, 104)}`)
    const periodDuration = Number(BigInt(`0x${body.slice(104, 168)}`))
    const startDate = Number(BigInt(`0x${body.slice(168, 232)}`))
    if (!Number.isFinite(periodDuration) || !Number.isFinite(startDate)) return null
    return { token, periodAmount, periodDuration, startDate }
  } catch {
    return null
  }
}

/** The parent's `TimestampEnforcer` upper bound (its expiry), or null. */
export function readParentExpiry(budgetDelegation: Delegation): number | null {
  const PINS = getDelegationContractsPins()
  const ts = (budgetDelegation.caveats as Array<{ enforcer: string; terms: string }>).find(
    (c) => c.enforcer.toLowerCase() === PINS.timestamp.toLowerCase(),
  )
  if (!ts) return null
  // The kit's terms are TIGHT-PACKED `abi.encodePacked(uint128 after,
  // uint128 before)` — 32 bytes, no head/tail padding (verified against the
  // kit, 2026-09-28) — so they are decoded by explicit slicing, not
  // `decodeAbiParameters` (whose head/tail layout expects 64 bytes).
  const body = (ts.terms as string).slice(2)
  if (body.length !== 64) return null
  const before = BigInt(`0x${body.slice(32, 64)}`)
  if (before === 0n) return null
  return Number(before)
}

// Local, lazy: keeps this file's imports to the kit + policy helpers without
// dragging the full contract-pins module into every test that imports the
// builder (the pins are cross-checked by delegation-policy's own drift guard).
let cachedPeriodEnforcer: string | null = null
let cachedTimestampEnforcer: string | null = null
function getPeriodEnforcerAddress(): string {
  if (!cachedPeriodEnforcer) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedPeriodEnforcer = (getDelegationEnvironment(8453).caveatEnforcers as Record<string, string>)
      .ERC20PeriodTransferEnforcer
  }
  return cachedPeriodEnforcer!
}
function getDelegationContractsPins(): { timestamp: string } {
  if (!cachedTimestampEnforcer) {
    cachedTimestampEnforcer = (getDelegationEnvironment(8453).caveatEnforcers as Record<string, string>)
      .TimestampEnforcer
  }
  return { timestamp: cachedTimestampEnforcer! }
}

function childCaveats(narrowing: SubBudgetNarrowing): Array<Record<string, unknown>> {
  const caveats: Array<Record<string, unknown>> = []
  if (narrowing.recipient) {
    caveats.push({
      type: 'allowedCalldata',
      startIndex: 4,
      value: pad(narrowing.recipient.toLowerCase() as Hex, { size: 32 }),
    })
  }
  caveats.push({ type: 'timestamp', afterThreshold: 0, beforeThreshold: narrowing.expiresAt })
  return caveats
}

function finish(
  child: Omit<Delegation, 'signature'>,
  chainId: number,
  expiresAt: number,
): BuiltSubBudgetDelegation {
  const childHash = hashDelegation({ ...child, signature: '0x' } as Delegation)
  return {
    child,
    childHash,
    signingPayload: delegationSigningPayload(child, chainId),
    expiresAt,
  }
}

/**
 * A's PARENT-CHILD: a self-delegated, period-scoped narrowing of A's own
 * signed budget delegation (`from === to === A's delegate account`). The
 * recipient pin (if the owner set one) lives here so everything beneath it
 * inherits the pin: a caveat the parent carries ANDs into its whole subtree.
 */
export function buildSubBudgetParentChild(req: {
  chainId: number
  subBudgetId: string
  /** A's delegate account — both delegator AND delegate (self). */
  delegateAccountAddress: Address
  /** A's SIGNED budget delegation — the parent this is carved from. */
  budgetDelegation: Delegation
  narrowing: SubBudgetNarrowing
}): BuiltSubBudgetDelegation {
  const child = createDelegation({
    environment: getDelegationEnvironment(req.chainId),
    from: req.delegateAccountAddress,
    to: req.delegateAccountAddress, // self — never ANY_BENEFICIARY
    parentDelegation: req.budgetDelegation,
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: req.narrowing.token,
      periodAmount: req.narrowing.periodAmountAtomic,
      periodDuration: req.narrowing.periodDurationSeconds,
      startDate: req.narrowing.startDate,
    },
    caveats: childCaveats(req.narrowing) as never,
    salt: subBudgetSalt(req.subBudgetId),
  })
  return finish(child, req.chainId, req.narrowing.expiresAt)
}

/**
 * B's GRANT: `from` A's delegate account, `to` B's delegate account, chained
 * under A's SIGNED parent-child. The concrete `to` (owner decision recorded
 * on the card) means B's delegate account is the ONLY redeemer — no
 * RedeemerEnforcer caveat is needed. Scope is period-scoped with the SAME
 * periodDuration/startDate as the parent and periodAmount ≤ its own
 * parent-child's, so the two period meters agree on the window and the
 * PARENT's remaining period budget keeps binding beneath B's allowance.
 */
export function buildSubBudgetGrant(req: {
  chainId: number
  subBudgetId: string
  /** A's delegate account — the child's delegator. */
  delegatingAccountAddress: Address
  /** B's delegate account — the child's delegate (the only redeemer). */
  subAgentAccountAddress: Address
  /** A's SIGNED parent-child — the immediate parent. */
  parentChildDelegation: Delegation
  narrowing: SubBudgetNarrowing
}): BuiltSubBudgetDelegation {
  if (req.subAgentAccountAddress.toLowerCase() === req.delegatingAccountAddress.toLowerCase()) {
    throw new Error('a sub-budget grant to the delegating agent itself is a task budget, not a sub-budget')
  }
  const child = createDelegation({
    environment: getDelegationEnvironment(req.chainId),
    from: req.delegatingAccountAddress,
    to: req.subAgentAccountAddress,
    parentDelegation: req.parentChildDelegation,
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: req.narrowing.token,
      periodAmount: req.narrowing.periodAmountAtomic,
      periodDuration: req.narrowing.periodDurationSeconds,
      startDate: req.narrowing.startDate,
    },
    caveats: childCaveats(req.narrowing) as never,
    salt: subBudgetSalt(req.subBudgetId),
  })
  return finish(child, req.chainId, req.narrowing.expiresAt)
}
