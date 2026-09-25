/**
 * Task budgets (#3329): independent verification of a task child delegation
 * and its close UserOp, mirroring `settlement-child.ts` / `direct-payment-
 * guard.ts` for a DIFFERENT typed-data class.
 *
 * A task budget's child is a SELF-delegation: the agent's own delegate
 * account grants itself a narrower, time-boxed slice of its budget
 * delegation (`delegate === delegator === the agent's own account`), chained
 * under the budget via `authority`. That is what separates it from an x402
 * settlement child, whose `delegate` is a facilitator/ANY_BENEFICIARY — never
 * the agent's own account. `isSettlementChildTypedData` (`settlement-
 * child.ts`) was narrowed to return `false` for a self-delegated payload so
 * the two classes cannot be confused by either verifier; this file is the
 * task-child counterpart, verified against a different expectation
 * (`GET /task-budgets/:id/sign-context`, never a merchant's 402).
 *
 * Two shapes, two functions:
 *  - `assertOwnTaskChild` verifies the `Delegation` typed data signed to OPEN
 *    a task budget.
 *  - `assertOwnTaskBudgetCloseUserOp` verifies the `PackedUserOperation`
 *    typed data signed to CLOSE one early (an on-chain
 *    `disableDelegation(child)` call from the agent's own account) — an
 *    authority-REDUCING action only, never a grant.
 *
 * `hashDelegation` below reproduces `@metamask/smart-accounts-kit/utils`'s
 * struct hash (via `@metamask/delegation-core`) byte-for-byte, WITHOUT taking
 * the kit as a runtime dependency (this package installs on users' machines —
 * same reasoning `delegate-account.ts` and `settlement-child.ts` give for
 * their own vendored constants). `DELEGATION_TYPEHASH` / `CAVEAT_TYPEHASH`
 * are pinned literals, cross-checked against the kit's own `hashDelegation`
 * by a test vector in `task-budget-guards.test.ts` (which imports the kit
 * ONLY in that test file).
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem'
import { HavenTypedDataRefusedError, DIRECT_PAYMENT_CHAIN_IDS, EXECUTE_ABI } from './direct-payment-guard.js'
import { DELEGATION_MANAGER, ROOT_AUTHORITY, CAVEAT_ENFORCERS } from './settlement-child.js'
import { DELEGATION_TUPLE_COMPONENTS } from './redemption-guard.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'

/** The backend's own ceiling (`MAX_TASK_BUDGET_TTL_SECONDS`), enforced again here. */
export const MAX_TASK_BUDGET_TTL_SECONDS = 86_400

export interface TaskChildTypedData {
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string }
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}

interface Caveat {
  enforcer: string
  terms: string
}

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function hex(value: string): string {
  return value.startsWith('0x') ? value.slice(2).toLowerCase() : value.toLowerCase()
}

function slice(terms: string, start: number, end?: number): string {
  const body = hex(terms)
  return end === undefined ? body.slice(start * 2) : body.slice(start * 2, end * 2)
}

function findCaveat(caveats: Caveat[], enforcer: string): Caveat | undefined {
  return caveats.find((c) => same(c.enforcer, enforcer))
}

/**
 * True when this typed data is a task-budget child: a `Delegation` whose
 * `delegate` equals its own `delegator` (self-delegation). This is the ONLY
 * shape distinguishing it from an x402 settlement child (whose `delegate` is
 * a facilitator or `ANY_BENEFICIARY`) — `isSettlementChildTypedData` is
 * narrowed to return `false` for this same shape so the two verifiers never
 * overlap.
 */
export function isTaskChildTypedData(value: unknown): value is TaskChildTypedData {
  const td = value as TaskChildTypedData | undefined
  if (
    !td ||
    td.primaryType !== 'Delegation' ||
    typeof td.domain?.verifyingContract !== 'string' ||
    !Array.isArray((td.message as { caveats?: unknown })?.caveats)
  ) {
    return false
  }
  const delegate = td.message?.delegate
  const delegator = td.message?.delegator
  return typeof delegate === 'string' && typeof delegator === 'string' && same(delegate, delegator)
}

export interface TaskChildExpectation {
  chainId: number
  tokenAddress: string
  maxAmountAtomic: string
  recipientAddress: string | null
  /** unix seconds — the `TimestampEnforcer`'s `beforeThreshold`. */
  expiresAt: number
  parentDelegationHash: string
}

function refuseTaskChild(what: string, detail: string): never {
  throw new HavenTypedDataRefusedError(
    `Refusing to sign the task-budget child: ${what}. ${detail} ` +
      'This signature opens a self-delegated slice of the agent budget, so it is verified ' +
      'locally against the expectation Haven declared, rather than trusted.',
  )
}

/**
 * Verify a task-budget child delegation is EXACTLY what
 * `GET /task-budgets/:id/sign-context` (purpose `open`) declared, AND that
 * both `delegate` and `delegator` are this signer's OWN account. Throws
 * `HavenTypedDataRefusedError` (never returns) on any disagreement.
 */
export function assertOwnTaskChild(
  typedData: unknown,
  expected: TaskChildExpectation,
  delegateAddress: string,
  now: number = Date.now(),
): void {
  const td = typedData as TaskChildTypedData
  if (td?.primaryType !== 'Delegation') {
    refuseTaskChild('it is not a Delegation payload', `primaryType was '${String(td?.primaryType)}'.`)
  }
  if (!same(td.domain?.verifyingContract, DELEGATION_MANAGER)) {
    refuseTaskChild(
      'the EIP-712 domain names an unknown DelegationManager',
      `Expected ${DELEGATION_MANAGER}, got ${td.domain?.verifyingContract}.`,
    )
  }
  const domainChain = Number(td.domain?.chainId)
  if (!Number.isFinite(domainChain) || domainChain !== expected.chainId) {
    refuseTaskChild(
      'it is scoped to the wrong chain',
      `Expected chain ${expected.chainId}; the child says ${td.domain?.chainId}.`,
    )
  }

  const ownAccount = deriveDelegateAccountAddress(delegateAddress as Address)
  const delegator = td.message?.delegator
  if (typeof delegator !== 'string' || !same(delegator, ownAccount)) {
    refuseTaskChild(
      "it is not delegated by this agent's own account",
      `Expected delegator ${ownAccount}; the child names ${String(delegator)}.`,
    )
  }
  const delegate = td.message?.delegate
  if (typeof delegate !== 'string' || !same(delegate, ownAccount)) {
    refuseTaskChild(
      "it is not self-delegated to this agent's own account",
      `Expected delegate ${ownAccount}; the child names ${String(delegate)}.`,
    )
  }

  const authority = td.message?.authority
  if (typeof authority !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(authority)) {
    refuseTaskChild('its authority is not a 32-byte delegation hash', `Got ${String(authority)}.`)
  }
  if (authority.toLowerCase() === ROOT_AUTHORITY) {
    refuseTaskChild(
      'it is a ROOT delegation, not a re-delegation of the agent budget',
      'A task budget always chains under the agent budget delegation.',
    )
  }
  if (!same(authority, expected.parentDelegationHash)) {
    refuseTaskChild(
      'it chains under a different parent delegation',
      `Expected authority ${expected.parentDelegationHash}; the child says ${authority}.`,
    )
  }

  const caveats = (td.message?.caveats as Caveat[] | undefined) ?? []

  const transfer = findCaveat(caveats, CAVEAT_ENFORCERS.erc20TransferAmount)
  if (!transfer) {
    refuseTaskChild(
      'it has no ERC-20 transfer-amount caveat',
      'Without it the child is not bounded to an amount.',
    )
  }
  const token = `0x${slice(transfer.terms, 0, 20)}`
  if (!same(token, expected.tokenAddress)) {
    refuseTaskChild('it spends a different token', `Expected ${expected.tokenAddress}, child pins ${token}.`)
  }
  const amount = BigInt(`0x${slice(transfer.terms, 20, 52)}`)
  if (amount !== BigInt(expected.maxAmountAtomic)) {
    refuseTaskChild(
      'the amount does not match',
      `Expected ${expected.maxAmountAtomic}; the child allows ${amount.toString()}.`,
    )
  }

  const timestamp = findCaveat(caveats, CAVEAT_ENFORCERS.timestamp)
  if (!timestamp) {
    refuseTaskChild('it never expires', 'A task-budget child without a timestamp caveat is open-ended.')
  }
  const beforeThreshold = Number(BigInt(`0x${slice(timestamp.terms, 16, 32)}`))
  const nowSec = Math.floor(now / 1000)
  if (beforeThreshold <= nowSec) {
    refuseTaskChild('it has already expired', `Expiry ${beforeThreshold} is not in the future.`)
  }
  if (beforeThreshold > nowSec + MAX_TASK_BUDGET_TTL_SECONDS) {
    refuseTaskChild(
      'its window is longer than a task budget may live',
      `Expiry is ${beforeThreshold - nowSec}s out; the ceiling is ${MAX_TASK_BUDGET_TTL_SECONDS}s.`,
    )
  }
  if (beforeThreshold !== expected.expiresAt) {
    refuseTaskChild(
      'its expiry does not match what Haven declared',
      `Expected ${expected.expiresAt}; the child says ${beforeThreshold}.`,
    )
  }

  const calldata = findCaveat(caveats, CAVEAT_ENFORCERS.allowedCalldata)
  if (expected.recipientAddress) {
    if (!calldata) {
      refuseTaskChild(
        'it has no recipient pin',
        'The task budget was opened with a pinned recipient, so the child must carry one.',
      )
    }
    const startIndex = BigInt(`0x${slice(calldata.terms, 0, 32)}`)
    if (startIndex !== 4n) {
      refuseTaskChild(
        'the recipient pin points at the wrong calldata offset',
        `Expected offset 4, got ${startIndex.toString()}.`,
      )
    }
    const paddedRecipient = slice(calldata.terms, 32, 64)
    if (paddedRecipient.slice(0, 24) !== '0'.repeat(24)) {
      refuseTaskChild('the pinned recipient is not a plain address', 'Its 32-byte word is not a padded address.')
    }
    const recipient = `0x${paddedRecipient.slice(24)}`
    if (!same(recipient, expected.recipientAddress)) {
      refuseTaskChild(
        'it pins a different recipient than Haven declared',
        `Expected ${expected.recipientAddress}; the child pins ${recipient}.`,
      )
    }
  } else if (calldata) {
    refuseTaskChild(
      'it pins a recipient the task budget was not opened with',
      'This task budget is open (no recipient pin); the child must not add one.',
    )
  }
}

// ── Close UserOp verification ──────────────────────────────────────────────

/** `DelegationManager.disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))`. */
const DISABLE_DELEGATION_ABI = [
  {
    type: 'function',
    name: 'disableDelegation',
    inputs: [{ name: 'delegation', type: 'tuple', components: DELEGATION_TUPLE_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export interface TaskBudgetCloseExpectation {
  /** The child delegation's own struct hash (`agent_task_budgets.delegation_hash`). */
  delegationHash: string
}

/**
 * Verify a task-budget close UserOp is EXACTLY an on-chain
 * `disableDelegation(child)` call from the agent's own delegate account —
 * authority-REDUCING only, never a grant. Throws `HavenTypedDataRefusedError`
 * (never returns) on any disagreement.
 */
export function assertOwnTaskBudgetCloseUserOp(
  typedData: Record<string, unknown>,
  expected: TaskBudgetCloseExpectation,
  delegateAddress: string,
): void {
  const domain = (typedData.domain ?? {}) as Record<string, unknown>
  const message = (typedData.message ?? {}) as Record<string, unknown>

  if (typeof domain.chainId !== 'number' && typeof domain.chainId !== 'bigint') {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation's domain.chainId is ${typeof domain.chainId} (${String(domain.chainId)}), ` +
        'not a number — refusing rather than risk signing a different EIP-712 domain than this check evaluated.',
    )
  }
  const chainId = Number(domain.chainId)
  if (!DIRECT_PAYMENT_CHAIN_IDS.has(chainId)) {
    throw new HavenTypedDataRefusedError(
      'This signer only signs a task-budget close on chains the delegation rail has pinned ' +
        `contracts for (${[...DIRECT_PAYMENT_CHAIN_IDS].join(', ')}); this typed data names chain ` +
        `${String(domain.chainId)}. Refusing.`,
    )
  }

  const ownAccount = deriveDelegateAccountAddress(delegateAddress as Address)
  const sender = typeof message.sender === 'string' ? message.sender : ''
  if (sender.toLowerCase() !== ownAccount.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation's account (${sender || 'unknown'}) is not this signer's own delegate ` +
        `account (${ownAccount}). Sign only your own agent's Haven-prepared payloads.`,
    )
  }

  const callData = message.callData as Hex
  let decoded: { target: Hex; value: bigint; callData: Hex }
  try {
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: callData })
    decoded = args[0] as unknown as typeof decoded
  } catch {
    throw new HavenTypedDataRefusedError(
      "This close UserOperation's callData is not a single execute((address,uint256,bytes)) call. " +
        'This signer only signs a task-budget close of that exact shape.',
    )
  }
  const reEncodedExecute = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [decoded] })
  if (reEncodedExecute.toLowerCase() !== callData.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      "This close UserOperation's execute() call does not re-encode to the exact callData bytes " +
        '(trailing or non-canonical bytes). Refusing.',
    )
  }
  if (decoded.target.toLowerCase() !== DELEGATION_MANAGER.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation's execute() calls ${decoded.target}, not the DelegationManager ` +
        `(${DELEGATION_MANAGER}). Refusing what looks like a self-call or a call to an unrelated contract.`,
    )
  }
  if (decoded.value !== 0n) {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation's execute() sends ${decoded.value} wei of native value alongside the ` +
        'DelegationManager call — a task-budget close never does. Refusing.',
    )
  }

  let delegation: {
    delegate: Address
    delegator: Address
    authority: Hex
    caveats: readonly { enforcer: Address; terms: Hex; args: Hex }[]
    salt: bigint
    signature: Hex
  }
  try {
    const { args } = decodeFunctionData({ abi: DISABLE_DELEGATION_ABI, data: decoded.callData })
    delegation = args[0] as unknown as typeof delegation
  } catch {
    throw new HavenTypedDataRefusedError(
      "This close UserOperation's execute() does not call disableDelegation(Delegation) — this " +
        'signer only signs a task-budget close of that exact shape.',
    )
  }
  const reEncodedDisable = encodeFunctionData({
    abi: DISABLE_DELEGATION_ABI,
    functionName: 'disableDelegation',
    args: [delegation],
  })
  if (reEncodedDisable.toLowerCase() !== decoded.callData.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      'This close UserOperation\'s disableDelegation call does not re-encode to the exact bytes ' +
        'signed (trailing or non-canonical bytes). Refusing.',
    )
  }
  if (delegation.delegator.toLowerCase() !== ownAccount.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation disables a delegation granted by ${delegation.delegator}, not this ` +
        `signer's own account (${ownAccount}). Refusing.`,
    )
  }
  if (delegation.delegate.toLowerCase() !== ownAccount.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation disables a delegation granted to ${delegation.delegate}, not this ` +
        `signer's own account (${ownAccount}) — a task-budget child is always self-delegated. Refusing.`,
    )
  }
  if (delegation.authority.toLowerCase() === ROOT_AUTHORITY) {
    throw new HavenTypedDataRefusedError(
      'This close UserOperation disables a ROOT delegation, not a re-delegation of the agent budget. ' +
        'A task-budget child always chains under the agent budget delegation. Refusing.',
    )
  }
  const actualHash = hashDelegation(delegation)
  if (actualHash.toLowerCase() !== expected.delegationHash.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This close UserOperation disables delegation ${actualHash}, not the task budget's own child ` +
        `(${expected.delegationHash}). Refusing.`,
    )
  }
}

// ── Delegation struct hashing, vendored (no kit at runtime) ────────────────

/**
 * `@metamask/delegation-core`'s `DELEGATION_TYPEHASH` — pinned, cross-checked
 * against the kit by a test vector in `task-budget-guards.test.ts`.
 */
export const DELEGATION_TYPEHASH: Hex = '0x88c1d2ecf185adf710588203a5f263f0ff61be0d33da39792cde19ba9aa4331e'

/** `@metamask/delegation-core`'s `CAVEAT_TYPEHASH` — pinned, same cross-check. */
export const CAVEAT_TYPEHASH: Hex = '0x80ad7e1b04ee6d994a125f4714ca0720908bd80ed16063ec8aee4b88e9253e2d'

export interface DelegationForHashing {
  delegate: Address
  delegator: Address
  authority: Hex
  caveats: readonly { enforcer: Address; terms: Hex }[]
  salt: bigint
}

function hashCaveat(caveat: { enforcer: Address; terms: Hex }): Hex {
  const termsHash = keccak256(caveat.terms)
  const encoded = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
    [CAVEAT_TYPEHASH, caveat.enforcer, termsHash],
  )
  return keccak256(encoded)
}

function hashCaveatsArray(caveats: readonly { enforcer: Address; terms: Hex }[]): Hex {
  const concatenated = `0x${caveats.map((c) => hashCaveat(c).slice(2)).join('')}` as Hex
  return keccak256(concatenated)
}

/**
 * Reproduces `@metamask/smart-accounts-kit/utils`'s `hashDelegation`
 * byte-for-byte, WITHOUT the kit at runtime (see the file header). Ignores
 * `signature` — the kit's own `hashDelegation` does the same (it hashes with
 * `signature: '0x'` regardless of what the caller passes).
 */
export function hashDelegation(delegation: DelegationForHashing): Hex {
  const caveatsHash = hashCaveatsArray(delegation.caveats)
  const encoded = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'address' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
    ],
    [DELEGATION_TYPEHASH, delegation.delegate, delegation.delegator, delegation.authority, caveatsHash, delegation.salt],
  )
  return keccak256(encoded)
}
