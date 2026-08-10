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
import { isValueBearingChain, needsBackupSignerRecommendation, sessionSafePayload } from '../mainnet-gate.js'

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

describe('sessionSafePayload (#1205 — the production call site)', () => {
  const base = {
    id: 's1',
    safe_address: '0x' + 'aa'.repeat(20),
    chain_id: 8453,
    name: null,
    is_default: true,
    created_at: 'now',
    account_type: 'delegator_hybrid',
    owner_address: null,
    passkey_count: 1,
  }

  it('recommends a backup for a single-signer delegation account on mainnet', () => {
    const payload = sessionSafePayload(base)
    expect(payload.needs_backup_recommendation).toBe(true)
    expect(payload.value_bearing_chain).toBe(true)
  })

  it('stays quiet once a second signer exists (passkey + EOA owner counts)', () => {
    expect(
      sessionSafePayload({ ...base, owner_address: '0x' + 'bb'.repeat(20) })
        .needs_backup_recommendation,
    ).toBe(false)
    expect(sessionSafePayload({ ...base, passkey_count: 2 }).needs_backup_recommendation).toBe(
      false,
    )
  })

  it('is always false on a testnet — a dev account has nothing to lose', () => {
    const payload = sessionSafePayload({ ...base, chain_id: 84532 })
    expect(payload.needs_backup_recommendation).toBe(false)
    expect(payload.value_bearing_chain).toBe(false)
  })

  it('is null for non-delegation accounts, whose signer truth is on-chain', () => {
    const payload = sessionSafePayload({ ...base, account_type: 'safe' })
    expect(payload.needs_backup_recommendation).toBeNull()
    // ...but chain classification is still served, from the same single home.
    expect(payload.value_bearing_chain).toBe(true)
  })

  it('never leaks the raw signer-set inputs into the payload', () => {
    const payload = sessionSafePayload(base) as Record<string, unknown>
    expect('owner_address' in payload).toBe(false)
    expect('passkey_count' in payload).toBe(false)
  })
})
