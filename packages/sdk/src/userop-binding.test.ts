import { describe, expect, it } from 'vitest'
import { getUserOperationHash } from 'viem/account-abstraction'
import { contracts } from '@metamask/smart-accounts-kit'
import { SIGNABLE_USER_OP_TYPED_DATA } from '@metamask/smart-accounts-kit/utils'
import {
  DIRECT_SIGN_CONTEXT_VERSION,
  ENTRY_POINT_V07,
  HYBRID_DELEGATOR_DOMAIN_NAME,
  HYBRID_DELEGATOR_DOMAIN_VERSION,
  HavenUserOpBindingError,
  PACKED_USER_OPERATION_FIELDS,
  assertUserOpTypedDataBinding,
  isPackedUserOperationTypedData,
  packedUserOperationHash,
} from './userop-binding.js'
import fixture from './__fixtures__/direct-payment-userop.json' with { type: 'json' }

type TypedData = typeof fixture.typed_data

function clone(): TypedData {
  return JSON.parse(JSON.stringify(fixture.typed_data)) as TypedData
}

/**
 * Unpacks the fixture's packed `PackedUserOperation` message into viem's
 * v0.7 `UserOperation` shape, so `getUserOperationHash` can be used as an
 * independent cross-check of `packedUserOperationHash`.
 */
function toViemUserOperation(message: TypedData['message']) {
  const accountGasLimits = BigInt(message.accountGasLimits)
  const verificationGasLimit = accountGasLimits >> 128n
  const callGasLimit = accountGasLimits & ((1n << 128n) - 1n)

  const gasFees = BigInt(message.gasFees)
  const maxPriorityFeePerGas = gasFees >> 128n
  const maxFeePerGas = gasFees & ((1n << 128n) - 1n)

  const initCode = message.initCode
  const factory = initCode === '0x' ? undefined : (initCode.slice(0, 42) as `0x${string}`)
  const factoryData = initCode === '0x' ? undefined : (`0x${initCode.slice(42)}` as `0x${string}`)

  const paymasterAndData = message.paymasterAndData
  const hasPaymaster = paymasterAndData && paymasterAndData !== '0x'
  const paymaster = hasPaymaster ? (paymasterAndData.slice(0, 42) as `0x${string}`) : undefined
  const paymasterVerificationGasLimit = hasPaymaster
    ? BigInt(`0x${paymasterAndData.slice(42, 42 + 32)}`)
    : undefined
  const paymasterPostOpGasLimit = hasPaymaster
    ? BigInt(`0x${paymasterAndData.slice(42 + 32, 42 + 64)}`)
    : undefined
  const paymasterData = hasPaymaster ? (`0x${paymasterAndData.slice(42 + 64)}` as `0x${string}`) : undefined

  return {
    sender: message.sender as `0x${string}`,
    nonce: BigInt(message.nonce),
    factory,
    factoryData,
    callData: message.callData as `0x${string}`,
    verificationGasLimit,
    callGasLimit,
    preVerificationGas: BigInt(message.preVerificationGas),
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    paymasterData,
    signature: '0x' as `0x${string}`,
  }
}

describe('assertUserOpTypedDataBinding (#3271) accepts a real direct-payment payload', () => {
  it('accepts the real fixture and returns the recomputed hash', () => {
    const typedData = clone()
    const hash = assertUserOpTypedDataBinding(typedData, fixture.payload_hash)
    expect(hash.toLowerCase()).toBe(fixture.payload_hash.toLowerCase())
  })

  it('packedUserOperationHash agrees with viem getUserOperationHash on the unpacked UserOperation', () => {
    const message = fixture.typed_data.message
    const viemHash = getUserOperationHash({
      chainId: fixture.typed_data.domain.chainId,
      entryPointAddress: message.entryPoint as `0x${string}`,
      entryPointVersion: '0.7',
      userOperation: toViemUserOperation(message),
    })
    expect(viemHash.toLowerCase()).toBe(fixture.payload_hash.toLowerCase())
    expect(packedUserOperationHash(fixture.typed_data).toLowerCase()).toBe(viemHash.toLowerCase())
  })

  it('isPackedUserOperationTypedData recognises the fixture and rejects a non-UserOp shape', () => {
    expect(isPackedUserOperationTypedData(fixture.typed_data)).toBe(true)
    expect(isPackedUserOperationTypedData({ primaryType: 'SettlementDelegation' })).toBe(false)
    expect(isPackedUserOperationTypedData(null)).toBe(false)
  })
})

describe('assertUserOpTypedDataBinding refuses a corrupted or mismatched payload', () => {
  it('refuses a single byte flip in message.callData', () => {
    const typedData = clone()
    // Flip the last hex nibble of callData — a 1-byte-level corruption.
    typedData.message.callData = typedData.message.callData.slice(0, -1) + (typedData.message.callData.endsWith('0') ? '1' : '0')
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
    try {
      assertUserOpTypedDataBinding(typedData, fixture.payload_hash)
    } catch (err) {
      expect((err as { code?: string }).code).toBe('USEROP_BINDING_MISMATCH')
    }
  })

  it('refuses a changed domain.verifyingContract', () => {
    const typedData = clone()
    typedData.domain.verifyingContract = '0x000000000000000000000000000000000000dEaD'
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a changed domain.name', () => {
    const typedData = clone()
    ;(typedData.domain as { name: string }).name = 'NotAHybridDeleGator'
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a changed domain.version', () => {
    const typedData = clone()
    ;(typedData.domain as { version: string }).version = '2'
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a changed entryPoint', () => {
    const typedData = clone()
    typedData.message.entryPoint = '0x0000000000000000000000000000000000dEaD'
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses an extra type added to the typed-data types map', () => {
    const typedData = clone() as unknown as { types: Record<string, unknown> }
    typedData.types.ExtraType = [{ name: 'evil', type: 'bytes' }]
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a reordered PackedUserOperation field list', () => {
    const typedData = clone() as unknown as {
      types: { PackedUserOperation: Array<{ name: string; type: string }> }
    }
    const fields = [...typedData.types.PackedUserOperation]
    ;[fields[0], fields[1]] = [fields[1], fields[0]]
    typedData.types.PackedUserOperation = fields
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a renamed PackedUserOperation field', () => {
    const typedData = clone() as unknown as {
      types: { PackedUserOperation: Array<{ name: string; type: string }> }
    }
    const fields = [...typedData.types.PackedUserOperation]
    fields[0] = { ...fields[0], name: 'senderAddress' }
    typedData.types.PackedUserOperation = fields
    expect(() => assertUserOpTypedDataBinding(typedData, fixture.payload_hash)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a bad payload_hash', () => {
    const typedData = clone()
    expect(() => assertUserOpTypedDataBinding(typedData, `0x${'ab'.repeat(32)}`)).toThrow(HavenUserOpBindingError)
  })

  it('refuses a malformed payload_hash string', () => {
    const typedData = clone()
    expect(() => assertUserOpTypedDataBinding(typedData, 'not-a-hash')).toThrow(HavenUserOpBindingError)
  })

  it('refuses typed data that is not a PackedUserOperation at all', () => {
    expect(() =>
      assertUserOpTypedDataBinding({ primaryType: 'SettlementDelegation', domain: {}, message: {} }, fixture.payload_hash),
    ).toThrow(HavenUserOpBindingError)
  })
})

describe('vendored HybridDeleGator constants stay equal to @metamask/smart-accounts-kit', () => {
  it('domain name and version match contracts.HybridDeleGator.constants', () => {
    expect(HYBRID_DELEGATOR_DOMAIN_NAME).toBe(contracts.HybridDeleGator.constants.NAME)
    expect(HYBRID_DELEGATOR_DOMAIN_VERSION).toBe(contracts.HybridDeleGator.constants.DOMAIN_VERSION)
  })

  it('PACKED_USER_OPERATION_FIELDS matches SIGNABLE_USER_OP_TYPED_DATA.PackedUserOperation', () => {
    expect(PACKED_USER_OPERATION_FIELDS).toEqual(SIGNABLE_USER_OP_TYPED_DATA.PackedUserOperation)
  })
})

describe('module constants', () => {
  it('DIRECT_SIGN_CONTEXT_VERSION and ENTRY_POINT_V07 are the pinned values', () => {
    expect(DIRECT_SIGN_CONTEXT_VERSION).toBe(1)
    expect(ENTRY_POINT_V07.toLowerCase()).toBe(fixture.typed_data.message.entryPoint.toLowerCase())
  })
})
