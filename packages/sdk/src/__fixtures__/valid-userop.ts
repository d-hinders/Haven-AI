/**
 * #3271: a synthetic-but-STRUCTURALLY-VALID `PackedUserOperation` sign_data
 * for tests that only care about the funding-leg / direct-payment control
 * flow, not the exact bytes of a real UserOp. Every field the #3271 binding
 * check (`assertUserOpTypedDataBinding`) inspects is well-formed and
 * self-consistent — domain name/version, sender === verifyingContract, the
 * v0.7 EntryPoint, the full 9-field `PackedUserOperation` type list, and a
 * `payload_hash` recomputed from the same message — so tests built before
 * #3271 keep exercising their own scenario (funding, retries, receipts,
 * MCP handshakes) instead of tripping the new corruption check on a toy
 * 3-field fixture that was never a real UserOp shape.
 *
 * Not a real, on-chain-recorded payload (that role is
 * `direct-payment-userop.json`) — use this where the test's point is NOT the
 * binding check itself.
 */
import {
  ENTRY_POINT_V07,
  HYBRID_DELEGATOR_DOMAIN_NAME,
  HYBRID_DELEGATOR_DOMAIN_VERSION,
  PACKED_USER_OPERATION_FIELDS,
  packedUserOperationHash,
} from '../userop-binding.js'

export interface ValidUserOpOverrides {
  sender?: `0x${string}`
  nonce?: bigint | string
  chainId?: number
  callData?: `0x${string}`
}

export interface ValidUserOpSignData {
  hash: `0x${string}`
  signature_scheme: 'eip712_userop'
  typed_data: {
    domain: { chainId: number; name: string; version: string; verifyingContract: `0x${string}` }
    types: { PackedUserOperation: Array<{ name: string; type: string }> }
    primaryType: 'PackedUserOperation'
    message: {
      sender: `0x${string}`
      nonce: string
      initCode: `0x${string}`
      callData: `0x${string}`
      accountGasLimits: `0x${string}`
      preVerificationGas: string
      gasFees: `0x${string}`
      paymasterAndData: `0x${string}`
      entryPoint: `0x${string}`
    }
  }
}

const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const

/** Builds a self-consistent `eip712_userop` sign_data payload for test fixtures. */
export function buildValidUserOpSignData(overrides: ValidUserOpOverrides = {}): ValidUserOpSignData {
  const sender = overrides.sender ?? '0x1111111111111111111111111111111111111111'
  const chainId = overrides.chainId ?? 8453
  const typedData = {
    domain: {
      chainId,
      name: HYBRID_DELEGATOR_DOMAIN_NAME,
      version: HYBRID_DELEGATOR_DOMAIN_VERSION,
      verifyingContract: sender,
    },
    types: {
      PackedUserOperation: PACKED_USER_OPERATION_FIELDS.map((field) => ({ ...field })),
    },
    primaryType: 'PackedUserOperation' as const,
    message: {
      sender,
      nonce: (overrides.nonce ?? 0n).toString(),
      initCode: '0x' as const,
      callData: overrides.callData ?? ('0x' as const),
      accountGasLimits: ZERO_BYTES32,
      preVerificationGas: '0',
      gasFees: ZERO_BYTES32,
      paymasterAndData: '0x' as const,
      entryPoint: ENTRY_POINT_V07 as `0x${string}`,
    },
  }
  const hash = packedUserOperationHash(typedData)
  return { hash, signature_scheme: 'eip712_userop', typed_data: typedData }
}
