/**
 * Sub-budget child guards (#3330) — the SDK-side local verification the
 * signer runs before its delegate key signs a sub-budget child, mirroring
 * `task-budget-guards.ts`'s `assertOwnTaskChild` for the two-row sub-budget
 * tree. ONE verifier covers BOTH rows, because the same signer (the
 * delegating agent A's own key) signs both:
 *
 *  - A's PARENT-CHILD row: `delegate === delegator === A's own account`
 *    (self-delegated, the task-child shape class).
 *  - B's GRANT row: `delegator === A's own account`, `delegate === B's
 *    delegate account` (a real grant to another account).
 *
 * What makes a sub-budget child a sub-budget child (vs a task budget's
 * hard-cap child) is the AMOUNT caveat: an `ERC20PeriodTransferEnforcer`
 * caveat whose terms are `abi.encode(address token, uint256 periodAmount,
 * uint256 periodDuration, uint256 startDate)` — the period-scoped slice of
 * the parent's own period meter, with the parent's periodDuration and
 * startDate reused verbatim. A hard-cap `ERC20TransferAmountEnforcer` caveat
 * is refused: that would be a task budget, which this channel must never
 * sign (two different products, two different sign-context endpoints).
 *
 * Authority, timestamp and recipient-pin checks are byte-for-byte the
 * task-child discipline: authority must equal the declared parent hash and
 * never be ROOT; expiry must be in the future and equal the declared one; a
 * pinned recipient must match exactly, and an unpinned budget must not grow
 * one. Enforcers are the pinned constants from `settlement-child.ts` (no kit
 * dependency) — same reasoning as that file's header documents.
 */

import { type Address, type Hex } from 'viem'
import { HavenTypedDataRefusedError, DIRECT_PAYMENT_CHAIN_IDS } from './direct-payment-guard.js'
import { DELEGATION_MANAGER, ROOT_AUTHORITY, CAVEAT_ENFORCERS } from './settlement-child.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import {
  DELEGATION_TYPEHASH,
  CAVEAT_TYPEHASH,
  hashDelegation,
  type DelegationForHashing,
} from './task-budget-guards.js'

/** The pinned `ERC20PeriodTransferEnforcer` (bytecode-identical on Base + Base Sepolia). */
export const ERC20_PERIOD_TRANSFER_ENFORCER = '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB'

/** The pinned `Delegation` EIP-712 domain (cross-checked by task-budget-guards' pin test). */
const DELEGATION_DOMAIN_NAME = 'DelegationManager'
const DELEGATION_DOMAIN_VERSION = '1'

/** The pinned `types` shape, byte-identical to `task-budget-guards.ts`'s. */
const EXPECTED_DELEGATION_TYPES = {
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
} as const

export interface SubBudgetChildTypedData {
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string }
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** Byte slice [start, end) of a `0x…` string, as lowercase hex without prefix. */
function sliceTerms(terms: string, start: number, end?: number): string {
  const body = terms.startsWith('0x') ? terms.slice(2).toLowerCase() : terms.toLowerCase()
  return end === undefined ? body.slice(start * 2) : body.slice(start * 2, end * 2)
}

function findCaveat(caveats: Array<{ enforcer: string; terms: string }>, enforcer: string) {
  return caveats.find((c) => same(c.enforcer, enforcer))
}

/** The struct hash of a sub-budget child — the redemption chain's link value. */
export function hashSubBudgetDelegation(delegation: DelegationForHashing): Hex {
  return hashDelegation(delegation)
}

// The kit's own struct hashes, re-exported verbatim from task-budget-guards'
// pinned literals so a caller can name them from this module too.
export { DELEGATION_TYPEHASH, CAVEAT_TYPEHASH }

export interface SubBudgetChildExpectation {
  chainId: number
  tokenAddress: string
  /** Per-period amount in atomic units — the child's periodAmount. */
  periodAmountAtomic: string
  /** The PARENT's period duration (seconds), reused verbatim in the caveat. */
  periodDurationSeconds: number
  /** The PARENT's period anchor, reused verbatim in the caveat. */
  startDate: number
  recipientAddress: string | null
  /** unix seconds — the `TimestampEnforcer`'s `beforeThreshold`. */
  expiresAt: number
  /** The hash of the row's parent delegation (`parent_delegation_hash`). */
  parentDelegationHash: string
  /**
   * A's own derived delegate account — the child's `delegator` on BOTH rows.
   */
  delegateAccount: string
  /**
   * The row's own `delegate`: A's account again for the parent-child row,
   * B's delegate account for the grant row. Served in the sign-context's
   * `expected` (read from the stored child JSON, not trusted caller input).
   */
  childDelegateAccount: string
}

function refuseSubBudgetChild(what: string, detail: string): never {
  throw new HavenTypedDataRefusedError(
    `Refusing to sign the sub-budget child: ${what}. ${detail} ` +
      'This signature opens a slice of the delegating agent budget for another agent, so it is ' +
      'verified locally against the expectation Haven declared, rather than trusted.',
  )
}

/**
 * Verify a sub-budget child delegation is EXACTLY what
 * `GET /sub-budgets/:id/sign-context` (purpose `open`) declared, that its
 * `delegator` is this signer's own account, and that its `delegate` is the
 * declared child delegate. Throws `HavenTypedDataRefusedError` (never
 * returns) on any disagreement.
 */
export function assertOwnSubBudgetChild(
  typedData: unknown,
  expected: SubBudgetChildExpectation,
  delegateAddress: string,
  now: number = Date.now(),
): void {
  const td = typedData as SubBudgetChildTypedData
  if (td?.primaryType !== 'Delegation') {
    refuseSubBudgetChild('it is not a Delegation payload', `primaryType was '${String(td?.primaryType)}'.`)
  }
  if (!same(td.domain?.verifyingContract, DELEGATION_MANAGER)) {
    refuseSubBudgetChild(
      'the EIP-712 domain names an unknown DelegationManager',
      `Expected ${DELEGATION_MANAGER}, got ${td.domain?.verifyingContract}.`,
    )
  }
  if (td.domain?.name !== DELEGATION_DOMAIN_NAME || td.domain?.version !== DELEGATION_DOMAIN_VERSION) {
    refuseSubBudgetChild(
      'the EIP-712 domain name/version does not match the pinned DelegationManager domain',
      `Expected name '${DELEGATION_DOMAIN_NAME}' version '${DELEGATION_DOMAIN_VERSION}'; got name ` +
        `'${String(td.domain?.name)}' version '${String(td.domain?.version)}'.`,
    )
  }
  if (
    JSON.stringify(td.types?.Caveat) !== JSON.stringify(EXPECTED_DELEGATION_TYPES.Caveat) ||
    JSON.stringify(td.types?.Delegation) !== JSON.stringify(EXPECTED_DELEGATION_TYPES.Delegation)
  ) {
    refuseSubBudgetChild(
      'its EIP-712 type definitions do not match the pinned Delegation/Caveat shape',
      'A renamed, reordered, or additional field on Delegation or Caveat could change what the ' +
        'caveats below mean without changing this check\'s field-by-field comparisons.',
    )
  }
  const domainChain = Number(td.domain?.chainId)
  if (!Number.isFinite(domainChain) || !DIRECT_PAYMENT_CHAIN_IDS.has(domainChain)) {
    refuseSubBudgetChild(
      'it is scoped to a chain the delegation rail has no pinned contracts for',
      `Chains with pinned contracts: ${[...DIRECT_PAYMENT_CHAIN_IDS].join(', ')}; the child says ${String(td.domain?.chainId)}.`,
    )
  }
  if (domainChain !== expected.chainId) {
    refuseSubBudgetChild(
      'it is scoped to the wrong chain',
      `Expected chain ${expected.chainId}; the child says ${td.domain?.chainId}.`,
    )
  }

  const ownAccount = deriveDelegateAccountAddress(delegateAddress as Address)
  const delegator = td.message?.delegator
  if (typeof delegator !== 'string' || !same(delegator, ownAccount)) {
    refuseSubBudgetChild(
      "it is not delegated by this agent's own account",
      `Expected delegator ${ownAccount}; the child names ${String(delegator)}.`,
    )
  }
  if (!same(delegator, expected.delegateAccount)) {
    refuseSubBudgetChild(
      'its delegator does not match the account Haven declared',
      `Expected ${expected.delegateAccount}; the child names ${String(delegator)}.`,
    )
  }
  const delegate = td.message?.delegate
  if (typeof delegate !== 'string' || !same(delegate, expected.childDelegateAccount)) {
    refuseSubBudgetChild(
      'its delegate does not match the declared child delegate',
      `Expected ${expected.childDelegateAccount}; the child names ${String(delegate)}.`,
    )
  }

  const authority = td.message?.authority
  if (typeof authority !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(authority)) {
    refuseSubBudgetChild('its authority is not a 32-byte delegation hash', `Got ${String(authority)}.`)
  }
  if (authority.toLowerCase() === ROOT_AUTHORITY) {
    refuseSubBudgetChild(
      'it is a ROOT delegation, not a re-delegation of the delegating agent budget',
      'A sub-budget always chains under the delegating agent budget delegation.',
    )
  }
  if (!same(authority, expected.parentDelegationHash)) {
    refuseSubBudgetChild(
      'it chains under a different parent delegation',
      `Expected authority ${expected.parentDelegationHash}; the child says ${authority}.`,
    )
  }

  const caveats = (td.message?.caveats as Array<{ enforcer: string; terms: string }> | undefined) ?? []

  // The PERIOD caveat is what makes this a sub-budget — a hard-cap
  // `ERC20TransferAmountEnforcer` caveat is the task-budget shape and is
  // refused on this channel.
  if (findCaveat(caveats, CAVEAT_ENFORCERS.erc20TransferAmount)) {
    refuseSubBudgetChild(
      'it carries a hard-cap transfer-amount caveat (the task-budget shape)',
      'A sub-budget is period-scoped: its amount caveat must be an ERC20PeriodTransferEnforcer ' +
        'caveat slicing the parent period meter, never a lifetime cap.',
    )
  }
  const period = findCaveat(caveats, ERC20_PERIOD_TRANSFER_ENFORCER)
  if (!period) {
    refuseSubBudgetChild(
      'it has no ERC-20 period-transfer caveat',
      'Without it the child is not bounded to a per-period amount.',
    )
  }
  // terms = abi.encodePacked(address token, uint256 periodAmount,
  // uint256 periodDuration, uint256 startDate) — the kit's TIGHT packing
  // (20 + 32×3 = 116 bytes, verified against `createDelegation`'s own
  // output), the same layout `task-budget-guards.ts` decodes for the
  // ERC20TransferAmountEnforcer. NOT head/tail-padded words: the address
  // occupies bytes [0,20) and the amount starts at byte 20.
  const token = `0x${sliceTerms(period.terms, 0, 20)}`
  if (!same(token, expected.tokenAddress)) {
    refuseSubBudgetChild('it spends a different token', `Expected ${expected.tokenAddress}, child pins ${token}.`)
  }
  const periodAmount = BigInt(`0x${sliceTerms(period.terms, 20, 52)}`)
  if (periodAmount !== BigInt(expected.periodAmountAtomic)) {
    refuseSubBudgetChild(
      'the period amount does not match',
      `Expected ${expected.periodAmountAtomic}; the child allows ${periodAmount.toString()}.`,
    )
  }
  const periodDuration = Number(BigInt(`0x${sliceTerms(period.terms, 52, 84)}`))
  if (periodDuration !== expected.periodDurationSeconds) {
    refuseSubBudgetChild(
      'its period duration does not match the parent window Haven declared',
      `Expected ${expected.periodDurationSeconds}s; the child says ${periodDuration}s. A sub-budget is a ` +
        'slice of the parent period meter — same window, smaller amount — never a different clock.',
    )
  }
  const startDate = Number(BigInt(`0x${sliceTerms(period.terms, 84, 116)}`))
  if (startDate !== expected.startDate) {
    refuseSubBudgetChild(
      'its period start does not match the parent anchor Haven declared',
      `Expected ${expected.startDate}; the child says ${startDate}.`,
    )
  }

  const timestamp = findCaveat(caveats, CAVEAT_ENFORCERS.timestamp)
  if (!timestamp) {
    refuseSubBudgetChild('it never expires', 'A sub-budget child without a timestamp caveat is open-ended.')
  }
  const beforeThreshold = Number(BigInt(`0x${sliceTerms(timestamp.terms, 16, 32)}`))
  const nowSec = Math.floor(now / 1000)
  if (beforeThreshold <= nowSec) {
    refuseSubBudgetChild('it has already expired', `Expiry ${beforeThreshold} is not in the future.`)
  }
  if (beforeThreshold !== expected.expiresAt) {
    refuseSubBudgetChild(
      'its expiry does not match what Haven declared',
      `Expected ${expected.expiresAt}; the child says ${beforeThreshold}.`,
    )
  }

  const calldata = findCaveat(caveats, CAVEAT_ENFORCERS.allowedCalldata)
  if (expected.recipientAddress) {
    if (!calldata) {
      refuseSubBudgetChild(
        'it has no recipient pin',
        'The sub-budget was issued with a pinned recipient, so the child must carry one.',
      )
    }
    const startIndex = BigInt(`0x${sliceTerms(calldata.terms, 0, 32)}`)
    if (startIndex !== 4n) {
      refuseSubBudgetChild(
        'the recipient pin points at the wrong calldata offset',
        `Expected offset 4, got ${startIndex.toString()}.`,
      )
    }
    const paddedRecipient = sliceTerms(calldata.terms, 32, 64)
    if (paddedRecipient.slice(0, 24) !== '0'.repeat(24)) {
      refuseSubBudgetChild('the pinned recipient is not a plain address', 'Its 32-byte word is not a padded address.')
    }
    const recipient = `0x${paddedRecipient.slice(24)}`
    if (!same(recipient, expected.recipientAddress)) {
      refuseSubBudgetChild(
        'it pins a different recipient than Haven declared',
        `Expected ${expected.recipientAddress}; the child pins ${recipient}.`,
      )
    }
  } else if (calldata) {
    refuseSubBudgetChild(
      'it pins a recipient the sub-budget was not issued with',
      'This sub-budget is open (no recipient pin); the child must not add one.',
    )
  }
}

/** Close UserOp verification — byte-for-byte the task-budget discipline. */
export function assertOwnSubBudgetCloseUserOp(
  typedData: Record<string, unknown>,
  expected: { delegationHash: string },
  delegateAddress: string,
): void {
  // The close UserOp shape is identical to the task budget's: a
  // disableDelegation(child) call from the agent's own delegate account.
  // Reuse the task-budget verifier — the only expectation that differs is
  // the delegation hash, which is an input here either way. Static import,
  // not lazy: these modules share no init-time cycle.
  assertOwnTaskBudgetCloseUserOp(typedData, expected, delegateAddress)
}

// The close-UserOp verifier is imported for the re-export above.
import { assertOwnTaskBudgetCloseUserOp } from './task-budget-guards.js'
