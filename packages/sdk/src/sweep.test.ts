import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { ethers } from 'ethers'
import {
  buildSweepTypedData,
  buildSweepAuthorizationMessage,
  sweepUsdcDomain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  SWEEP_BASE_CHAIN_ID,
  SWEEP_BASE_USDC_ADDRESS,
  type SweepAuthorization,
} from './sweep.js'
import { HavenSigningError } from './types.js'

// Hardhat account #0 — never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = privateKeyToAccount(TEST_KEY).address
const SAFE = '0x000000000000000000000000000000000000dEaD'

function baseAuthorization(overrides: Partial<SweepAuthorization> = {}): SweepAuthorization {
  return {
    from: DELEGATE,
    to: SAFE,
    value: '40000',
    validAfter: '0',
    validBefore: '2000000000',
    nonce: '0x' + 'ab'.repeat(32),
    token: SWEEP_BASE_USDC_ADDRESS,
    chainId: SWEEP_BASE_CHAIN_ID,
    ...overrides,
  }
}

describe('buildSweepTypedData', () => {
  it('builds Base USDC typed data with bigint message fields', () => {
    const td = buildSweepTypedData(baseAuthorization())
    expect(td.domain).toEqual(sweepUsdcDomain(SWEEP_BASE_CHAIN_ID))
    expect(td.primaryType).toBe('TransferWithAuthorization')
    expect(td.message.value).toBe(40000n)
    expect(td.message.validAfter).toBe(0n)
    expect(typeof td.message.nonce).toBe('string')
  })

  it('rejects an unsupported chain', () => {
    expect(() => buildSweepTypedData(baseAuthorization({ chainId: 1 }))).toThrow(HavenSigningError)
  })

  it('rejects a token that is not the canonical USDC for the chain', () => {
    expect(() =>
      buildSweepTypedData(baseAuthorization({ token: '0x' + '11'.repeat(20) })),
    ).toThrow(/canonical USDC/)
  })

  it('rejects a malformed nonce', () => {
    expect(() => buildSweepTypedData(baseAuthorization({ nonce: '0xdead' }))).toThrow(/nonce/)
  })
})

describe('buildSweepAuthorizationMessage', () => {
  it('is namespaced and deterministic regardless of address casing', () => {
    const a = buildSweepAuthorizationMessage(baseAuthorization())
    const b = buildSweepAuthorizationMessage(
      baseAuthorization({ from: DELEGATE.toLowerCase(), to: SAFE.toUpperCase() }),
    )
    expect(a).toBe(b)
    expect(a.startsWith('Haven sweep authorization v1\n')).toBe(true)
    expect(a).toContain('haven.sweep.authorization')
  })

  it('changes when any signed field changes', () => {
    const base = buildSweepAuthorizationMessage(baseAuthorization())
    expect(buildSweepAuthorizationMessage(baseAuthorization({ value: '40001' }))).not.toBe(base)
    expect(
      buildSweepAuthorizationMessage(baseAuthorization({ nonce: '0x' + 'cd'.repeat(32) })),
    ).not.toBe(base)
  })
})

describe('cross-framework signature agreement (signer viem ↔ backend ethers)', () => {
  it('a viem-signed authorization recovers to the delegate under ethers.verifyTypedData', async () => {
    const auth = baseAuthorization()
    const td = buildSweepTypedData(auth)

    // Signer side: viem account signs the typed data.
    const account = privateKeyToAccount(TEST_KEY)
    const signature = await account.signTypedData({
      domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as `0x${string}` },
      types: td.types,
      primaryType: td.primaryType,
      message: {
        ...td.message,
        from: td.message.from as `0x${string}`,
        to: td.message.to as `0x${string}`,
        nonce: td.message.nonce as `0x${string}`,
      },
    })

    // Backend side: ethers recovers using the same domain/types/message.
    const recovered = ethers.verifyTypedData(
      td.domain,
      TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    )
    expect(recovered.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })
})
