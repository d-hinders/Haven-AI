import { Interface, getAddress } from 'ethers'

/**
 * Safe owner-management transaction construction.
 *
 * Owner changes are Safe *self-calls* (`to == safe`, operation 0) that the
 * user signs with their own owner key and relays via `/safe-exec`. Haven never
 * signs them — it only constructs the calldata and guards the rules. The
 * signature threshold is intentionally held at 1 (see epic #413): we change
 * the owner set, not the threshold.
 */

// Safe's OwnerManager keeps owners in a linked list seeded by this sentinel.
// `removeOwner` needs the node that points *to* the owner being removed.
export const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001'

const OWNER_MANAGER_ABI = [
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
]

const ownerManager = new Interface(OWNER_MANAGER_ABI)

export class LastOwnerError extends Error {
  constructor() {
    super('Cannot remove the last approver — a Safe must keep at least one owner.')
    this.name = 'LastOwnerError'
  }
}

export class OwnerNotFoundError extends Error {
  constructor() {
    super('That address is not an approver on this account.')
    this.name = 'OwnerNotFoundError'
  }
}

export class OwnerExistsError extends Error {
  constructor() {
    super('That address is already an approver on this account.')
    this.name = 'OwnerExistsError'
  }
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Find the linked-list predecessor of `owner` in the Safe's owner array, as
 * `removeOwner` requires. The first owner's predecessor is the sentinel.
 * Throws if the owner is not present.
 */
export function findPrevOwner(owners: string[], owner: string): string {
  const index = owners.findIndex((o) => eq(o, owner))
  if (index === -1) throw new OwnerNotFoundError()
  return index === 0 ? SENTINEL_OWNERS : owners[index - 1]
}

/**
 * Guard the last-owner invariant. Throws `LastOwnerError` when removing
 * `owner` would leave the Safe with zero owners, and `OwnerNotFoundError`
 * when `owner` is not currently an owner. This is the security-critical check
 * that must run before any removal transaction is constructed.
 */
export function assertCanRemoveOwner(owners: string[], owner: string): void {
  if (!owners.some((o) => eq(o, owner))) throw new OwnerNotFoundError()
  if (owners.length <= 1) throw new LastOwnerError()
}

/** Calldata for `addOwnerWithThreshold(newOwner, 1)`. */
export function encodeAddOwner(newOwner: string, threshold = 1): string {
  return ownerManager.encodeFunctionData('addOwnerWithThreshold', [
    getAddress(newOwner),
    BigInt(threshold),
  ])
}

/** Calldata for `removeOwner(prevOwner, owner, 1)`, computing prevOwner. */
export function encodeRemoveOwner(owners: string[], owner: string, threshold = 1): string {
  const prevOwner = findPrevOwner(owners, owner)
  return ownerManager.encodeFunctionData('removeOwner', [
    prevOwner,
    getAddress(owner),
    BigInt(threshold),
  ])
}

export interface OwnerTxBuild {
  to: string
  value: string
  data: string
  operation: 0
}

/**
 * Build the unsigned Safe self-call for adding an approver. Rejects an
 * address that is already an owner.
 */
export function buildAddOwnerTx(safeAddress: string, owners: string[], newOwner: string): OwnerTxBuild {
  if (owners.some((o) => eq(o, newOwner))) throw new OwnerExistsError()
  return {
    to: getAddress(safeAddress),
    value: '0',
    data: encodeAddOwner(newOwner),
    operation: 0,
  }
}

/**
 * Build the unsigned Safe self-call for removing an approver. Enforces the
 * last-owner guard before producing anything.
 */
export function buildRemoveOwnerTx(safeAddress: string, owners: string[], owner: string): OwnerTxBuild {
  assertCanRemoveOwner(owners, owner)
  return {
    to: getAddress(safeAddress),
    value: '0',
    data: encodeRemoveOwner(owners, owner),
    operation: 0,
  }
}
