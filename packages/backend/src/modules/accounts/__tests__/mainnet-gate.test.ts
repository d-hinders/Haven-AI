/**
 * #908 mainnet signer floor — the pure gate core. The criterion (recorded by
 * #890, security model §6–7): no mainnet delegation-rail account operates
 * with fewer than two enrolled signers, unless the owner explicitly
 * acknowledged the single-signer risk.
 */
import { describe, expect, it } from 'vitest'
import { isValueBearingChain, signerFloorError } from '../mainnet-gate.js'

describe('isValueBearingChain (#908)', () => {
  it('classifies known testnets as NOT value-bearing', () => {
    expect(isValueBearingChain(84532)).toBe(false) // Base Sepolia
    expect(isValueBearingChain(11155111)).toBe(false) // Ethereum Sepolia
  })

  it('classifies mainnets as value-bearing', () => {
    expect(isValueBearingChain(8453)).toBe(true) // Base
    expect(isValueBearingChain(1)).toBe(true) // Ethereum
    expect(isValueBearingChain(100)).toBe(true) // Gnosis
  })

  it('FAILS CLOSED for unknown chain ids — ungated chains do not exist', () => {
    expect(isValueBearingChain(424242)).toBe(true)
  })
})

describe('signerFloorError (#908)', () => {
  it('testnets always pass — single-signer dev/QA accounts stay cheap', () => {
    expect(signerFloorError({ chainId: 84532, signerCount: 1, waiverAcknowledged: false })).toBeNull()
    expect(signerFloorError({ chainId: 84532, signerCount: 0, waiverAcknowledged: false })).toBeNull()
  })

  it('mainnet below the floor without a waiver is blocked, with actionable copy', () => {
    const err = signerFloorError({ chainId: 8453, signerCount: 1, waiverAcknowledged: false })
    expect(err).toMatch(/at least 2 enrolled signers/)
    expect(err).toMatch(/single_signer_waiver/)
  })

  it('mainnet at or above the floor passes without any waiver', () => {
    expect(signerFloorError({ chainId: 8453, signerCount: 2, waiverAcknowledged: false })).toBeNull()
    expect(signerFloorError({ chainId: 8453, signerCount: 3, waiverAcknowledged: false })).toBeNull()
  })

  it('an explicit waiver passes a single-signer mainnet account', () => {
    expect(signerFloorError({ chainId: 8453, signerCount: 1, waiverAcknowledged: true })).toBeNull()
  })

  it('unknown chains inherit the mainnet floor (fail closed)', () => {
    expect(signerFloorError({ chainId: 424242, signerCount: 1, waiverAcknowledged: false })).not.toBeNull()
  })
})
