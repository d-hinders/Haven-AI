/**
 * #3272 — a real-shaped, BOUND direct-payment `PackedUserOperation` for
 * signer tests: `sender` is the counterfactual delegate account for a given
 * owner EOA, and `callData` is `execute(DelegationManager, 0,
 * redeemDelegations(...))` with a REAL redemption shape — one non-empty
 * `Delegation`, `delegate` = the signer's own account, `delegator` = a
 * distinct treasury address, `ExecutionMode.SingleDefault`, an
 * `encodePacked(target,value,callData)` execution — mirroring
 * `packages/backend/src/rails/delegation-rail.ts`'s `prepareRedemption`.
 * Replaces the toy 2-field / empty-callData / empty-arrays fixtures the
 * allowlist correctly refuses (including the B1 empty-permission-context
 * bypass, `buildEmptyPermissionContextRedemption` below, kept ONLY to
 * reproduce that exact refusal in a test).
 *
 * Moved here from `@haven_ai/signer` by #3283 so the SDK, the signer,
 * `@haven_ai/mcp` and `mcp-server` share ONE guard-valid builder. Published
 * as the `@haven_ai/sdk/test-support` subpath only because a sibling
 * package's tests cannot import this file by relative path (each package's
 * `tsc` `rootDir` is its own `src`). Test fixtures, not a signing API:
 * nothing here signs, and nothing the SDK or signer runs imports it.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type Address,
  type Hex,
} from 'viem'
import {
  ENTRY_POINT_V07,
  HYBRID_DELEGATOR_DOMAIN_NAME,
  HYBRID_DELEGATOR_DOMAIN_VERSION,
  PACKED_USER_OPERATION_FIELDS,
  packedUserOperationHash,
} from '../userop-binding.js'
import { DELEGATION_MANAGER } from '../settlement-child.js'
import { deriveDelegateAccountAddress } from '../delegate-account.js'
import { DELEGATION_TUPLE_COMPONENTS, REDEEM_DELEGATIONS_ABI, SINGLE_DEFAULT_MODE } from '../redemption-guard.js'

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const

/** `Delegation.authority` sentinel for a root (unchained) delegation — `@metamask/delegation-core`'s `ROOT_AUTHORITY`. */
const ROOT_AUTHORITY: Hex = `0x${'ff'.repeat(32)}`

/** Stand-in treasury address — distinct from any derived signer account, matching the real fixture's `delegator`. */
export const DEFAULT_DELEGATOR: Address = '0x98989898989898989898989898989898989898De' as Address

const DELEGATION_ARRAY_PARAM = [
  { type: 'tuple[]', components: DELEGATION_TUPLE_COMPONENTS },
] as const

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

const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

export interface DelegationOverrides {
  /** The redeemer this delegation authorises — normally the signer's own derived account. */
  delegate: Address
  /** Who granted it — must differ from `delegate` for a real (non-self) delegation. */
  delegator?: Address
  authority?: Hex
  caveats?: Array<{ enforcer: Address; terms: Hex; args: Hex }>
  salt?: bigint
  signature?: Hex
}

/** A single, well-formed `Delegation` tuple — the ONE-link chain Haven's backend redeems (`delegations: [[delegation]]`). */
export function buildDelegation(overrides: DelegationOverrides) {
  return {
    delegate: overrides.delegate,
    delegator: overrides.delegator ?? DEFAULT_DELEGATOR,
    authority: overrides.authority ?? ROOT_AUTHORITY,
    caveats: overrides.caveats ?? [
      // A real-shaped (if inert for test purposes) TimestampEnforcer term —
      // real budget delegations always carry at least one caveat.
      { enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069' as Address, terms: `0x${'00'.repeat(32)}` as Hex, args: '0x' as Hex },
    ],
    salt: overrides.salt ?? 1n,
    signature: overrides.signature ?? (`0x${'ab'.repeat(65)}` as Hex),
  }
}

/** `abi.encode(Delegation[])` for a ONE-delegation chain — a Haven-shaped permission context. */
export function buildPermissionContext(delegation: ReturnType<typeof buildDelegation>): Hex {
  return encodeAbiParameters(DELEGATION_ARRAY_PARAM, [[delegation]])
}

/** `abi.encode(Delegation[])` for a MULTI-link chain (leaf first) — never emitted by Haven. */
export function buildChainPermissionContext(chain: ReturnType<typeof buildDelegation>[]): Hex {
  return encodeAbiParameters(DELEGATION_ARRAY_PARAM, [chain])
}

/** `abi.encode(Delegation[])` for an EMPTY chain — the exact B1 bypass shape MetaMask's DelegationManager treats as self-authorised. */
export function buildEmptyPermissionContext(): Hex {
  return encodeAbiParameters(DELEGATION_ARRAY_PARAM, [[]])
}

/** `encodePacked(address,uint256,bytes)` — the single-execution calldata `ExecutionMode.SingleDefault` expects. */
export function buildSingleExecutionCallData(target: Address, value: bigint, innerCallData: Hex): Hex {
  return encodePacked(['address', 'uint256', 'bytes'], [target, value, innerCallData])
}

/** A real-shaped ERC-20 `transfer(to, amount)` execution — what a budget redemption actually spends. */
export function buildTransferExecutionCallData(token: Address, to: Address, amount: bigint): Hex {
  return buildSingleExecutionCallData(
    token,
    0n,
    encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [to, amount] }),
  )
}

export interface BoundRedeemDelegationsOptions {
  /** The redeemer — normally the signer's own derived account (matches the UserOp's `sender`). */
  delegate: Address
  delegator?: Address
  caveats?: DelegationOverrides['caveats']
  /** Override the single execution's calldata entirely (default: a real-shaped ERC-20 transfer). */
  executionCallData?: Hex
}

/** `redeemDelegations([permissionContext], [SingleDefault], [executionCallData])` — the REAL, bound shape. */
export function buildBoundRedeemDelegationsCallData(options: BoundRedeemDelegationsOptions): Hex {
  const delegation = buildDelegation({ delegate: options.delegate, delegator: options.delegator, caveats: options.caveats })
  const permissionContext = buildPermissionContext(delegation)
  const executionCallData =
    options.executionCallData ??
    buildTransferExecutionCallData(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address, // Base Sepolia USDC, matches the real captured fixture
      '0x98ffBf30459a98FD80fAce18f519967769641F76' as Address,
      10000n,
    )
  return encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [[permissionContext], [SINGLE_DEFAULT_MODE], [executionCallData]],
  })
}

/**
 * #3272 (B1 regression): `redeemDelegations([emptyPermissionContext],
 * [SingleDefault], [selfCallCallData])` — one permission context whose
 * `Delegation[]` decodes EMPTY, paired with a self-call execution. This is
 * the exact live bypass: MetaMask's DelegationManager treats an empty chain
 * as self-authorised and runs `selfCallCallData` AS the account. Exists only
 * so a test can assert this is refused, never to build a shape any code path
 * signs.
 */
export function buildEmptyPermissionContextRedemption(selfCallCallData: Hex): Hex {
  return encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [[buildEmptyPermissionContext()], [SINGLE_DEFAULT_MODE], [selfCallCallData]],
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
  chainId?: number | bigint | string
  /** Override the execute() target — default DELEGATION_MANAGER (the bound shape). */
  target?: Address
  /** Override the execute() value — default 0n. */
  value?: bigint
  /** Override the full message.callData (bypasses target/value/redeemDelegations construction). */
  callData?: Hex
  /** Override sender/verifyingContract directly instead of deriving it from `delegate`. */
  sender?: Address
  /** Override the redemption's delegator (default: a distinct treasury address). */
  delegator?: Address
}

export interface BoundDirectUserOp {
  typedData: {
    domain: { name: string; version: string; chainId: number | bigint | string; verifyingContract: Address }
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
 * counterfactual account for `delegate`, and `callData` redeems ONE real
 * delegation (delegate = `sender`, delegator = a distinct treasury address)
 * through the DelegationManager. Override `target` / `callData` / `sender` /
 * `delegator` to build the negative-test shapes the allowlist must refuse.
 */
export function buildBoundDirectUserOp(options: BoundDirectUserOpOptions): BoundDirectUserOp {
  const chainId = options.chainId ?? 84532
  const sender = options.sender ?? deriveDelegateAccountAddress(options.delegate)
  const callData =
    options.callData ??
    buildExecuteCallData(
      options.target ?? (DELEGATION_MANAGER as Address),
      options.value ?? 0n,
      buildBoundRedeemDelegationsCallData({ delegate: sender, delegator: options.delegator }),
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

/**
 * Re-target a REAL captured direct-payment UserOp (for example
 * `__fixtures__/direct-payment-userop.json`) at `newSender`: the UserOp's
 * `sender` / `verifyingContract` and the redeemed delegation's `delegate`
 * become `newSender`; the delegator, caveats, mode and execution stay the
 * production bytes. The captured fixture is bound to a delegate whose key is
 * not in the repository, so a test signs this rebuilt copy with a test key
 * whose derived account is `newSender` — proving the guard accepts the actual
 * production shape, not only this file's synthetic one.
 */
export function rebuildDirectUserOpForSender(
  fixtureTypedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  },
  newSender: Address,
) {
  const originalCallData = fixtureTypedData.message.callData as Hex
  const { args: executeArgs } = decodeFunctionData({ abi: EXECUTE_ABI, data: originalCallData })
  const execution = executeArgs[0] as { target: Address; value: bigint; callData: Hex }
  const { args: redeemArgs } = decodeFunctionData({ abi: REDEEM_DELEGATIONS_ABI, data: execution.callData })
  const [permissionContexts, modes, executionCallDatas] = redeemArgs as unknown as [
    readonly Hex[],
    readonly Hex[],
    readonly Hex[],
  ]
  const [delegations] = decodeAbiParameters(DELEGATION_ARRAY_PARAM, permissionContexts[0])
  const adjustedDelegations = (delegations as unknown as Array<Record<string, unknown>>).map((d, i) =>
    i === 0 ? { ...d, delegate: newSender } : d,
  )
  const adjustedPermissionContext = encodeAbiParameters(DELEGATION_ARRAY_PARAM, [adjustedDelegations as never])
  const adjustedRedeemCallData = encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [[adjustedPermissionContext], modes as Hex[], executionCallDatas as Hex[]],
  })
  const adjustedCallData = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [{ target: execution.target, value: execution.value, callData: adjustedRedeemCallData }],
  })
  const typedData = {
    ...fixtureTypedData,
    domain: { ...fixtureTypedData.domain, verifyingContract: newSender },
    message: { ...fixtureTypedData.message, sender: newSender, callData: adjustedCallData },
  }
  const payloadHash = packedUserOperationHash(typedData as never) as Hex
  return { typedData, payloadHash }
}
