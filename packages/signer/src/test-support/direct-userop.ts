/**
 * #3272 — a real-shaped, BOUND direct-payment `PackedUserOperation` for
 * signer tests: `sender` is the counterfactual delegate account for a given
 * owner EOA, and `callData` is `execute(DelegationManager, 0,
 * redeemDelegations(...))` — the ONE shape `haven_sign`'s unbound branch
 * allows through since #3272. Replaces the toy 2-field / empty-callData
 * fixtures the new allowlist correctly refuses.
 *
 * Test-only: not reachable from `index.ts` / `cli.ts`, so `tsup` never bundles
 * it into the published package.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  ENTRY_POINT_V07,
  HYBRID_DELEGATOR_DOMAIN_NAME,
  HYBRID_DELEGATOR_DOMAIN_VERSION,
  PACKED_USER_OPERATION_FIELDS,
  packedUserOperationHash,
} from '@haven_ai/sdk'
import { DELEGATION_MANAGER } from '../settlement-child.js'
import { deriveDelegateAccountAddress } from '../delegate-account.js'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const

const EXECUTE_ABI = [
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

const REDEEM_DELEGATIONS_ABI = [
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

/** `redeemDelegations([], [], [])` — well-formed, empty arrays; never broadcast. */
export function buildRedeemDelegationsCallData(): Hex {
  return encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [[], [], []],
  })
}

/** `execute((address,uint256,bytes))` — selector `0x5c1c6dcd`. */
export function buildExecuteCallData(target: Address, value: bigint, innerCallData: Hex): Hex {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [{ target, value, callData: innerCallData }],
  })
}

export interface BoundDirectUserOpOptions {
  /** The delegate EOA (`signer.delegateAddress`) that owns the account `sender` derives from. */
  delegate: Address
  chainId?: number
  /** Override the execute() target — default DELEGATION_MANAGER (the bound shape). */
  target?: Address
  /** Override the execute() value — default 0n. */
  value?: bigint
  /** Override the full message.callData (bypasses target/value/redeemDelegations construction). */
  callData?: Hex
  /** Override sender/verifyingContract directly instead of deriving it from `delegate`. */
  sender?: Address
}

export interface BoundDirectUserOp {
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address }
    types: { PackedUserOperation: Array<{ name: string; type: string }> }
    primaryType: 'PackedUserOperation'
    message: Record<string, unknown>
  }
  payloadHash: Hex
  sender: Address
}

/**
 * A real-shaped, self-consistent (correct v0.7 hash) `PackedUserOperation`.
 * By default it is fully BOUND per #3272's allowlist: `sender` is the
 * counterfactual account for `delegate`, and `callData` redeems delegations
 * through the DelegationManager. Override `target` / `callData` / `sender`
 * to build the negative-test shapes the allowlist must refuse.
 */
export function buildBoundDirectUserOp(options: BoundDirectUserOpOptions): BoundDirectUserOp {
  const chainId = options.chainId ?? 84532
  const sender = options.sender ?? deriveDelegateAccountAddress(options.delegate)
  const callData =
    options.callData ??
    buildExecuteCallData(
      options.target ?? (DELEGATION_MANAGER as Address),
      options.value ?? 0n,
      buildRedeemDelegationsCallData(),
    )
  const typedData = {
    domain: {
      name: HYBRID_DELEGATOR_DOMAIN_NAME,
      version: HYBRID_DELEGATOR_DOMAIN_VERSION,
      chainId,
      verifyingContract: sender,
    },
    types: { PackedUserOperation: PACKED_USER_OPERATION_FIELDS.map((field) => ({ ...field })) },
    primaryType: 'PackedUserOperation' as const,
    message: {
      sender,
      nonce: '0',
      initCode: '0x',
      callData,
      accountGasLimits: ZERO_BYTES32,
      preVerificationGas: '0',
      gasFees: ZERO_BYTES32,
      paymasterAndData: '0x',
      entryPoint: ENTRY_POINT_V07,
    },
  }
  const payloadHash = packedUserOperationHash(typedData)
  return { typedData, payloadHash, sender }
}

/** A well-formed `execute()` self-call — `target === sender` — for the (d)/self-call negative tests. */
export function buildSelfCallCallData(sender: Address): Hex {
  const TRANSFER_OWNERSHIP_ABI = [
    { type: 'function', name: 'transferOwnership', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  ] as const
  const inner = encodeFunctionData({
    abi: TRANSFER_OWNERSHIP_ABI,
    functionName: 'transferOwnership',
    args: ['0x000000000000000000000000000000000000dEaD' as Address],
  })
  return buildExecuteCallData(sender, 0n, inner)
}
