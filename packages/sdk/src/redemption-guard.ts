/**
 * #3272 (B1 follow-up) — what `DelegationManager.redeemDelegations` actually
 * does with the bytes `haven_sign`'s unbound branch allows through.
 *
 * `assertBoundDirectPaymentUserOp` (then in the signer's `tools.ts`, now
 * `direct-payment-guard.ts`) used to stop at "the inner
 * call decodes as `redeemDelegations`" — it never looked at the ARGUMENTS.
 * MetaMask's DelegationManager (v1.3.0) treats an EMPTY permission context
 * (an ABI-encoded `Delegation[]` of length 0) as self-authorised: with no
 * delegation to check, it calls `IDeleGatorCore(msg.sender).executeFromExecutor`
 * directly — running the paired `executionCallData` AS THE ACCOUNT, with no
 * caveat, no budget, no recipient pin. Since `HybridDeleGator.transferOwnership`
 * / `updateSigners` / `addKey` are `onlyEntryPointOrSelf`, a self-call in that
 * slot captures the account exactly as a bare `execute(self, 0,
 * transferOwnership(attacker))` would — the redeemDelegations wrapper was
 * never inspected past its own selector.
 *
 * This module decodes and verifies the REAL redemption shape Haven's backend
 * emits (`packages/backend/src/rails/delegation-rail.ts` `prepareRedemption`):
 * exactly one permission context, exactly one delegation in it, whose
 * `delegate` is this signer's own account (so the redemption authority is
 * this signer's, not forwarded from elsewhere) and whose `delegator` is a
 * DIFFERENT address (so it is a real grant, not a no-op self-delegation),
 * under `ExecutionMode.SingleDefault`, with no trailing or non-canonical
 * bytes anywhere in the chain.
 *
 * The `Delegation`/`Caveat` tuple shape is vendored from
 * `@metamask/delegation-abis`' `IDelegationManager` ABI (a devDependency
 * only, in `@haven_ai/signer`'s `package.json`) and pinned against the kit's
 * own encoder by `packages/signer/src/redemption-guard.pins.test.ts`.
 *
 * TASK BUDGETS (#3329) widen the accepted chain from exactly one link to ONE
 * OR TWO: `[budget]` (unchanged) or `[task child, budget]` — leaf first, as
 * everywhere else in this file. The two-link case is safe by the SAME
 * reasoning as the one-link case, extended one hop: the task child's own
 * `delegate` AND `delegator` are this signer's OWN account (a
 * SELF-delegation — `assertOwnTaskChild` in `task-budget-guards.ts` is what
 * proves its caveats narrow, never widen, the budget it chains under), and
 * the budget link underneath it keeps the existing (3)/(4) shape: delegate ==
 * own account, delegator != own account (a real grant from elsewhere). A
 * chain redeemed this way can therefore only ever be AS OR MORE restrictive
 * than redeeming the budget directly — the task child ADDS caveats (amount,
 * recipient, expiry); it can never remove one, because
 * `DelegationManager.redeemDelegations` ANDs every caveat of every link in
 * the chain (the same AND-only property `settlement-child.ts`'s header
 * documents). Any OTHER two-link chain — a leaf delegated by a third party, a
 * leaf whose delegate is not this signer's own account, a chain longer than
 * two — is refused exactly as before.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem'
import { HavenSigningError } from './types.js'

/** `Caveat` — `(address enforcer, bytes terms, bytes args)`. */
const CAVEAT_COMPONENTS = [
  { name: 'enforcer', type: 'address' },
  { name: 'terms', type: 'bytes' },
  { name: 'args', type: 'bytes' },
] as const

/** `Delegation` — `(address delegate, address delegator, bytes32 authority, Caveat[] caveats, uint256 salt, bytes signature)`. */
export const DELEGATION_TUPLE_COMPONENTS = [
  { name: 'delegate', type: 'address' },
  { name: 'delegator', type: 'address' },
  { name: 'authority', type: 'bytes32' },
  { name: 'caveats', type: 'tuple[]', components: CAVEAT_COMPONENTS },
  { name: 'salt', type: 'uint256' },
  { name: 'signature', type: 'bytes' },
] as const

/** A permission context is `abi.encode(Delegation[])` — ONE dynamic array parameter. */
const DELEGATION_ARRAY_PARAM = [
  { type: 'tuple[]', components: DELEGATION_TUPLE_COMPONENTS },
] as const

/** `DelegationManager.redeemDelegations(bytes[],bytes32[],bytes[])` — selector `0xcef6d209`. */
export const REDEEM_DELEGATIONS_ABI = [
  {
    type: 'function',
    name: 'redeemDelegations',
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * `ExecutionMode.SingleDefault` — all-zero `bytes32`
 * (`@metamask/smart-accounts-kit`'s `ExecutionMode` enum). The backend never
 * emits any other mode (`delegation-rail.ts`'s `prepareRedemption` always
 * passes `[ExecutionMode.SingleDefault]`), so any other value here is refused
 * rather than interpreted.
 */
export const SINGLE_DEFAULT_MODE: Hex = `0x${'00'.repeat(32)}`

function refuse(detail: string): never {
  throw new HavenSigningError(
    `Refusing to sign: this UserOperation's redeemDelegations call ${detail}. This signer only ` +
      "signs one of two shapes: a single grant to the agent's own account, or a self-delegated " +
      'task-budget child redeemed under it (the two-link [task child, budget] chain).',
  )
}

/**
 * Verify `redeemCalldata` (the bytes passed to `execute()`, selector already
 * confirmed to be `redeemDelegations` by the caller) is EXACTLY Haven's own
 * shape: one delegation, redeemed by `ownAccount`, granted by someone else,
 * in `SingleDefault` mode, with no encoding slack anywhere. Throws
 * `HavenSigningError` (never returns) on any disagreement.
 */
export function assertRedeemsOwnBudgetDelegation(redeemCalldata: Hex, ownAccount: Address): void {
  let permissionContexts: readonly Hex[]
  let modes: readonly Hex[]
  let executionCallDatas: readonly Hex[]
  try {
    const { args } = decodeFunctionData({ abi: REDEEM_DELEGATIONS_ABI, data: redeemCalldata })
    ;[permissionContexts, modes, executionCallDatas] = args as unknown as [
      readonly Hex[],
      readonly Hex[],
      readonly Hex[],
    ]
  } catch {
    refuse('is not a well-formed redeemDelegations(bytes[],bytes32[],bytes[]) call')
  }

  // (6a) Canonical encoding: re-encoding what was decoded must reproduce the
  // EXACT bytes — refuses trailing bytes or any other non-canonical padding
  // `decodeFunctionData` silently tolerates.
  const reEncoded = encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [permissionContexts as Hex[], modes as Hex[], executionCallDatas as Hex[]],
  })
  if (reEncoded.toLowerCase() !== redeemCalldata.toLowerCase()) {
    refuse('does not re-encode to the exact bytes signed (trailing or non-canonical bytes)')
  }

  // (1) Arrays present, equal length, non-empty. Haven always redeems
  // exactly one delegation chain against exactly one execution.
  if (
    permissionContexts.length === 0 ||
    permissionContexts.length !== modes.length ||
    permissionContexts.length !== executionCallDatas.length
  ) {
    refuse(
      `has mismatched or empty argument arrays (permissionContexts=${permissionContexts.length}, ` +
        `modes=${modes.length}, executionCallDatas=${executionCallDatas.length})`,
    )
  }
  if (permissionContexts.length !== 1) {
    refuse(`redeems ${permissionContexts.length} delegation chains at once, not exactly one`)
  }

  // (5) Mode: SingleDefault only — the only mode Haven's backend ever emits.
  if (modes[0].toLowerCase() !== SINGLE_DEFAULT_MODE.toLowerCase()) {
    refuse(`uses execution mode ${modes[0]}, not ExecutionMode.SingleDefault`)
  }

  // (2) THE B1 FIX: the permission context must decode as a NON-EMPTY
  // Delegation[]. An empty array (`abi.encode([])`) is exactly the shape
  // MetaMask's DelegationManager treats as self-authorised — the bypass this
  // function exists to close. A malformed context is refused the same way.
  let delegations: ReadonlyArray<{
    delegate: Address
    delegator: Address
    authority: Hex
    caveats: readonly unknown[]
    salt: bigint
    signature: Hex
  }>
  try {
    const [decoded] = decodeAbiParameters(DELEGATION_ARRAY_PARAM, permissionContexts[0])
    delegations = decoded as typeof delegations
  } catch {
    refuse("carries a permission context that does not decode as an ABI-encoded Delegation[]")
  }
  if (delegations.length === 0) {
    refuse(
      'carries an EMPTY delegation chain — DelegationManager treats this as self-authorised ' +
        "and runs the paired execution as the account, with no caveat, budget or recipient pin",
    )
  }
  // (2b) One OR TWO links (#3329). Haven's budget delegation is a single
  // grant from the user's account to this agent's account (`delegations:
  // [[delegation]]` in the backend's prepareRedemption) — one link. A task
  // budget payment redeems `[task child, budget]` — two links, leaf first.
  // Anything else is never emitted.
  if (delegations.length !== 1 && delegations.length !== 2) {
    refuse(
      `carries a ${delegations.length}-link delegation chain, not the single budget grant or the ` +
        'two-link [task child, budget] chain Haven emits',
    )
  }

  // (6b) Canonical encoding of the permission context itself.
  const reEncodedContext = encodeAbiParameters(DELEGATION_ARRAY_PARAM, [delegations as never])
  if (reEncodedContext.toLowerCase() !== permissionContexts[0].toLowerCase()) {
    refuse('carries a permission context with trailing or non-canonical bytes')
  }

  // (3) Leaf delegation — index 0, the redeemer's own link in the chain
  // (mirrors the backend's `delegations: [[delegation]]`, a one-link chain
  // whose sole entry IS the leaf) — must delegate to THIS signer's own
  // account. A delegate naming any other address means this redemption
  // authorises a DIFFERENT account's spend, and this signer's key would be
  // the one producing that authority.
  const leaf = delegations[0]
  if (leaf.delegate.toLowerCase() !== ownAccount.toLowerCase()) {
    refuse(
      `is redeemed for delegate ${leaf.delegate}, not this signer's own account (${ownAccount})`,
    )
  }

  if (delegations.length === 2) {
    // #3329: the two-link task-budget chain. The leaf (the task child) must
    // be SELF-delegated — `delegator` is this signer's own account too — the
    // shape `assertOwnTaskChild` (`task-budget-guards.ts`) already proved is
    // a narrowing re-delegation, never a grant from elsewhere.
    if (leaf.delegator.toLowerCase() !== ownAccount.toLowerCase()) {
      refuse(
        `carries a two-link chain whose leaf is delegated by ${leaf.delegator}, not this signer's ` +
          `own account (${ownAccount}) — a task-budget child is always self-delegated`,
      )
    }
    const budget = delegations[1]
    if (budget.delegate.toLowerCase() !== ownAccount.toLowerCase()) {
      refuse(
        `carries a two-link chain whose second link delegates to ${budget.delegate}, not this ` +
          `signer's own account (${ownAccount})`,
      )
    }
    if (budget.delegator.toLowerCase() === ownAccount.toLowerCase()) {
      refuse(
        "carries a two-link chain whose budget link is granted by this signer's OWN account — a " +
          'real budget delegation always comes from elsewhere',
      )
    }
    return
  }

  // (4) One-link chain: the delegation's own delegator must NOT be this
  // signer's own account — a self-to-self delegation is exactly the B1 shape
  // restated: it authorises nothing beyond what the account already is, so
  // it must be a real grant FROM somewhere else (the treasury/budget owner).
  const root = delegations[delegations.length - 1]
  if (root.delegator.toLowerCase() === ownAccount.toLowerCase()) {
    refuse(
      "carries a root delegation granted by this signer's OWN account — a real budget " +
        'delegation always comes from elsewhere',
    )
  }
}
