/**
 * The #4319 tracking-state derivation — every value of `settlementTracking`
 * and `settlementProof`, from stored state only. Pure unit tests: the
 * function touches no database and no chain, which is the point.
 */
import { describe, expect, it } from 'vitest'
import { deriveSettlementTracking } from '../settlement-tracking.js'

const base = {
  settlementTxHash: null,
  settlementProofLabel: null,
  nonceBound: null,
  nonceDerived: null,
  receiptVerdict: null,
  hasStoredHeader: false,
  confirmedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
}

describe('deriveSettlementTracking (#4319)', () => {
  it('a recorded hash is verified, proof from the flags', () => {
    expect(
      deriveSettlementTracking({ ...base, settlementTxHash: '0x' + 'a'.repeat(64), nonceDerived: true }).settlementProof,
    ).toBe('nonce')
    expect(
      deriveSettlementTracking({ ...base, settlementTxHash: '0x' + 'a'.repeat(64), nonceBound: true }).settlementProof,
    ).toBe('signed_header')
    expect(
      deriveSettlementTracking({ ...base, settlementTxHash: '0x' + 'a'.repeat(64), settlementProofLabel: 'receipt' }).settlementProof,
    ).toBe('receipt')
    // No flags at all: the 2026-09-29 → 10-14 records.
    expect(
      deriveSettlementTracking({ ...base, settlementTxHash: '0x' + 'a'.repeat(64) }),
    ).toEqual({ settlementTracking: 'verified', settlementProof: 'legacy' })
  })

  it('inside the window with a derivable nonce or a stored header: checking', () => {
    expect(deriveSettlementTracking(base)).toEqual({ settlementTracking: 'checking', settlementProof: null })
    expect(deriveSettlementTracking({ ...base, hasStoredHeader: true })).toEqual({
      settlementTracking: 'checking',
      settlementProof: null,
    })
  })

  it('outside the 24-hour window with nothing stored: untracked', () => {
    expect(
      deriveSettlementTracking({ ...base, confirmedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }),
    ).toEqual({ settlementTracking: 'untracked', settlementProof: null })
  })

  it('a refused verdict is final: untracked even inside the window', () => {
    for (const verdict of ['refused_ambiguous', 'refused_mismatch']) {
      expect(deriveSettlementTracking({ ...base, receiptVerdict: verdict }).settlementTracking).toBe('untracked')
      expect(
        deriveSettlementTracking({
          ...base,
          receiptVerdict: verdict,
          confirmedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
        }).settlementTracking,
      ).toBe('untracked')
    }
  })

  it('a retryable verdict is checking even outside the window', () => {
    expect(
      deriveSettlementTracking({
        ...base,
        receiptVerdict: 'retryable',
        confirmedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
      }).settlementTracking,
    ).toBe('checking')
  })
})
