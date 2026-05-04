import { describe, expect, it } from 'vitest'

import {
  getSafePasskeyConfig,
  predictSafePasskeySignerAddress,
} from '@/lib/safePasskeySigner'

const X = '0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff'
const Y = '0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'

describe('predictSafePasskeySignerAddress', () => {
  it('returns the same address for the same inputs', () => {
    const first = predictSafePasskeySignerAddress({ x: X, y: Y, chainId: 8453 })
    const second = predictSafePasskeySignerAddress({ x: X, y: Y, chainId: 8453 })

    expect(first).toBe(second)
  })

  it('returns different addresses for Base and Gnosis with the same key coordinates', () => {
    const baseAddress = predictSafePasskeySignerAddress({ x: X, y: Y, chainId: 8453 })
    const gnosisAddress = predictSafePasskeySignerAddress({ x: X, y: Y, chainId: 100 })

    expect(baseAddress).not.toBe(gnosisAddress)
  })

  it('matches the pinned Base fixture for a known key pair', () => {
    // Verified against the live SafeWebAuthnSignerFactory.getSigner(...) deployment on Base.
    expect(predictSafePasskeySignerAddress({ x: X, y: Y, chainId: 8453 })).toBe(
      '0xe54122F41f7ADF87fB6d5Ab36BAe42FC2AAc882C',
    )
  })

  it('matches the pinned Gnosis fixture for a known key pair', () => {
    // Verified against the live SafeWebAuthnSignerFactory.getSigner(...) deployment on Gnosis.
    expect(predictSafePasskeySignerAddress({ x: X, y: Y, chainId: 100 })).toBe(
      '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
    )
  })
})

describe('getSafePasskeyConfig', () => {
  it('returns the expected verifier config for supported chains', () => {
    expect(getSafePasskeyConfig(8453).verifierAddress).toBe('0x0000000000000000000000000000000000000100')
    expect(getSafePasskeyConfig(100).verifierAddress).toBe('0x445a0683e494ea0c5af3e83c5159fbe47cf9e765')
  })

  it('throws for unsupported chains', () => {
    expect(() => getSafePasskeyConfig(1)).toThrow('Unsupported chain: 1')
  })
})
