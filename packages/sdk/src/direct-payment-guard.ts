/**
 * The direct-payment content allowlist (#3272, moved here by #3283).
 *
 * `assertUserOpTypedDataBinding` (#3271) proves a `PackedUserOperation`'s
 * typed data and its hash describe the SAME operation — necessary, never
 * sufficient, because whoever serves the payload serves both values, so a
 * self-consistent forgery binds perfectly to itself. This module is the rest
 * of the property: the operation described is the ONE shape a delegate key
 * may sign for a direct payment — a redemption of the agent's own budget
 * delegation, for its own account, on a chain the delegation rail runs on.
 * Everything else (another account, a self-call such as `transferOwnership`,
 * a batch `execute`, a call to any contract other than the DelegationManager,
 * an empty-context redemption) is refused.
 *
 * ONE implementation, two callers (epic #3284): `@haven_ai/signer`'s
 * `haven_sign` (which wraps the refusal in its own structured error with a
 * next step) and `HavenClient.signForData` (the SDK's own in-process signing,
 * where a compromised Haven API would otherwise be enough to get an
 * account-capturing UserOp signed).
 */
import { decodeFunctionData, encodeFunctionData, type Address } from 'viem'
import { HavenSigningError } from './types.js'
import {
  DELEGATION_MANAGER,
  verifySettlementChild,
  type SettlementChildExpectation,
  type SettlementChildTypedData,
} from './settlement-child.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { assertRedeemsOwnBudgetDelegation } from './redemption-guard.js'

/** Wire code for a typed-data payload outside the signable allowlist. */
export const TYPED_DATA_NOT_ALLOWED = 'TYPED_DATA_NOT_ALLOWED' as const

/**
 * A typed-data payload was refused before signing because it is not a shape
 * a delegate key may sign. Nothing was signed. `@haven_ai/signer` subclasses
 * this to attach its MCP next step; the `code` is the same on both.
 */
export class HavenTypedDataRefusedError extends HavenSigningError {
  declare readonly code: typeof TYPED_DATA_NOT_ALLOWED

  constructor(message: string) {
    super(message)
    ;(this as { code: string }).code = TYPED_DATA_NOT_ALLOWED
    this.name = 'HavenTypedDataRefusedError'
  }
}

/**
 * Chains the delegation rail has PINNED delegation contracts for
 * (`packages/backend/src/rails/delegation-contracts.ts`) — the only chains a
 * direct-payment UserOp may be scoped to. Gnosis (100) has no pinned
 * DelegationManager/enforcer set, so it is deliberately excluded even though
 * the delegate account itself could exist there.
 */
export const DIRECT_PAYMENT_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 84532])

/** The DeleGator's single-execution `execute((address,uint256,bytes))` — selector `0x5c1c6dcd`. */
export const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      {
        name: '_execution',
        type: 'tuple',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const

/**
 * The content + provenance allowlist (#3272 criteria 1–2). Call ONLY after
 * `assertUserOpTypedDataBinding` has already proven `typedData` is a
 * well-formed `PackedUserOperation` matching its own hash — this function
 * trusts `typedData.domain`/`message` are shaped correctly and checks only
 * what they SAY. Throws `HavenTypedDataRefusedError` (never returns) on any
 * disagreement.
 */
export function assertBoundDirectPaymentUserOp(
  typedData: Record<string, unknown>,
  delegateAddress: string,
): void {
  const domain = (typedData.domain ?? {}) as Record<string, unknown>
  const message = (typedData.message ?? {}) as Record<string, unknown>

  // (N1) chainId must already be a number/bigint. `Number(domain.chainId)`
  // below would happily parse a numeric STRING, but viem's own EIP-712
  // domain encoding does not accept a string chainId the same way — passing
  // one through to the signer can silently drop it from the domain the
  // digest actually covers, producing a different signed payload than this
  // check evaluated. Refuse before that gap can matter.
  if (typeof domain.chainId !== 'number' && typeof domain.chainId !== 'bigint') {
    throw new HavenTypedDataRefusedError(
      `This UserOperation's domain.chainId is ${typeof domain.chainId} (${String(domain.chainId)}), ` +
        'not a number — refusing rather than risk signing a different EIP-712 domain than this ' +
        'check evaluated.',
    )
  }

  // (c) chain: only where the delegation rail has pinned contracts.
  const chainId = Number(domain.chainId)
  if (!DIRECT_PAYMENT_CHAIN_IDS.has(chainId)) {
    throw new HavenTypedDataRefusedError(
      'This signer only signs direct payments on chains the delegation rail has pinned ' +
        `contracts for (${[...DIRECT_PAYMENT_CHAIN_IDS].join(', ')}); this typed data names ` +
        `chain ${String(domain.chainId)}. Refusing.`,
    )
  }

  // (d) sender: only this key's OWN counterfactual delegate account —
  // `assertUserOpTypedDataBinding` already proved `sender === verifyingContract`.
  const ownAccount = deriveDelegateAccountAddress(delegateAddress as Address)
  const sender = typeof message.sender === 'string' ? message.sender : ''
  if (sender.toLowerCase() !== ownAccount.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This UserOperation's account (${sender || 'unknown'}) is not this signer's own delegate ` +
        `account (${ownAccount}) — signing it would authorize a DIFFERENT account's operation. ` +
        'Sign only your own agent\'s Haven-prepared payloads.',
    )
  }

  // (e) callData: a single execute(DelegationManager, 0, redeemDelegations(...)) —
  // never a batch execute (ERC-7579 `execute(bytes32,bytes)`, selector
  // `0xe9ae5c53`), an executeFromExecutor, a self-call, or a call to any
  // other contract.
  const callData = message.callData as `0x${string}`
  let decoded: { target: `0x${string}`; value: bigint; callData: `0x${string}` }
  try {
    const { args } = decodeFunctionData({
      abi: EXECUTE_ABI,
      data: callData,
    })
    decoded = args[0] as unknown as typeof decoded
  } catch {
    throw new HavenTypedDataRefusedError(
      "This UserOperation's callData is not a single execute((address,uint256,bytes)) call " +
        '— a batch execute, executeFromExecutor, or any other selector is refused. This ' +
        'signer only signs direct payments.',
    )
  }
  // Canonical encoding: re-encoding the decoded call must reproduce the EXACT
  // bytes, or `decodeFunctionData`'s tolerance of trailing/non-canonical
  // padding would let calldata smuggle bytes past every check below.
  const reEncodedExecute = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [decoded],
  })
  if (reEncodedExecute.toLowerCase() !== callData.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      "This UserOperation's execute() call does not re-encode to the exact callData bytes " +
        '(trailing or non-canonical bytes). Refusing.',
    )
  }
  if (decoded.target.toLowerCase() !== DELEGATION_MANAGER.toLowerCase()) {
    throw new HavenTypedDataRefusedError(
      `This UserOperation's execute() calls ${decoded.target}, not the DelegationManager ` +
        `(${DELEGATION_MANAGER}). A direct payment only ever redeems the agent's own budget ` +
        'delegation — refusing what looks like a self-call (e.g. transferOwnership, ' +
        'updateSigners, upgradeToAndCall) or a call to an unrelated contract.',
    )
  }
  if (decoded.value !== 0n) {
    throw new HavenTypedDataRefusedError(
      `This UserOperation's execute() sends ${decoded.value} wei of native value alongside the ` +
        'DelegationManager call — a direct payment never does. Refusing.',
    )
  }
  // #3272 (B1): decode the redemption ARGUMENTS, not just the selector — an
  // empty (or otherwise not-this-key's) delegation chain is a capture
  // vector, not a shape the redeemDelegations selector alone rules out.
  try {
    assertRedeemsOwnBudgetDelegation(decoded.callData, ownAccount)
  } catch (err) {
    throw new HavenTypedDataRefusedError(err instanceof Error ? err.message : String(err))
  }
}

export type { SettlementChildExpectation }

/**
 * The settlement-child half of the same surface (#3283): verify an erc7710
 * child against `expectation` (from somewhere Haven did not write — the
 * merchant's 402 in the SDK, the Haven-signed expected context in the
 * signer), AND that it is re-delegated from this key's OWN account. Throws
 * `HavenTypedDataRefusedError` (code `TYPED_DATA_NOT_ALLOWED`) on any
 * disagreement.
 */
export function assertOwnSettlementChild(
  typedData: unknown,
  expectation: SettlementChildExpectation,
  delegateAddress: string,
): void {
  try {
    verifySettlementChild(typedData as SettlementChildTypedData, {
      ...expectation,
      delegatorAccount: deriveDelegateAccountAddress(delegateAddress as Address),
    })
  } catch (err) {
    // One refusal code for everything this surface refuses, so an agent sees
    // TYPED_DATA_NOT_ALLOWED for a bad child exactly as for a bad UserOp.
    if (err instanceof HavenSigningError && !(err instanceof HavenTypedDataRefusedError)) {
      throw new HavenTypedDataRefusedError(err.message)
    }
    throw err
  }
}
