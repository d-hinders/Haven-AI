/**
 * Signer-floor classification — the pure core.
 *
 * This file used to pin #908's GATE: mainnet accounts below two signers were
 * refused unless a waiver was recorded. #1153 turned that into a
 * recommendation on the owner's decision, so the assertions below are the
 * deliberate reversal — same conditions, opposite consequence. The reason for
 * the floor is unchanged and not softened: a single-signer account has no
 * recovery. What moved is where the user is told.
 */
import { describe, expect, it } from 'vitest'
import { isValueBearingChain, needsBackupSignerRecommendation } from '../mainnet-gate.js'

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

describe('needsBackupSignerRecommendation (#1153, was the #908 gate)', () => {
  it('testnets never recommend — a dev/QA account has nothing to lose', () => {
    expect(needsBackupSignerRecommendation({ chainId: 84532, signerCount: 1 })).toBe(false)
    expect(needsBackupSignerRecommendation({ chainId: 84532, signerCount: 0 })).toBe(false)
  })

  it('REVERSAL: a single-signer mainnet account is recommended a backup, not refused', () => {
    // Was: signerFloorError(...) returned a message and the caller sent 403.
    // Now: the same condition only asks the surfaces to recommend, and the
    // operation proceeds.
    expect(needsBackupSignerRecommendation({ chainId: 8453, signerCount: 1 })).toBe(true)
  })

  it('mainnet at or above two signers needs nothing', () => {
    expect(needsBackupSignerRecommendation({ chainId: 8453, signerCount: 2 })).toBe(false)
    expect(needsBackupSignerRecommendation({ chainId: 8453, signerCount: 3 })).toBe(false)
  })

  it('REVERSAL: a recorded waiver no longer silences it', () => {
    // It never made the account recoverable — it only recorded that someone
    // had been told once. Honouring it here would hide the recommendation
    // from exactly the users who are running the risk.
    expect(needsBackupSignerRecommendation({ chainId: 8453, signerCount: 1, waiverAcknowledged: true })).toBe(true)
  })

  it('unknown chains still count as value-bearing (fail closed)', () => {
    // Over-recommending on an unknown chain is harmless; staying quiet on a
    // real one is not.
    expect(needsBackupSignerRecommendation({ chainId: 424242, signerCount: 1 })).toBe(true)
  })
})
