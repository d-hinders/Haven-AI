/**
 * Frontend allowance differential loop.
 *
 * Pure functions only — runs without the viem/wallet stack. Finds inputs where
 * the dashboard's off-chain allowance mirror (`computeEffectiveAllowance`)
 * disagrees with what the contract would enforce at a given chain time.
 *
 *   1. `arithmetic equivalence` — the green ratchet: for the same chain time,
 *      the mirror must reproduce the contract's reset/grid arithmetic exactly.
 *   2. `regression guards` — converged findings (F-1/F-2 clock source, F-3
 *      next-reset grid), kept permanent so a fixed defect cannot return.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { computeEffectiveAllowance } from '../../allowance-math'
import type { AllowanceInfo, EffectiveAllowance } from '../../allowance-math'
import { referenceEffectiveAllowance } from '../reference-allowance-module'
import { generateAllowanceCases } from '../generators'

function sameReset(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b
  return a.getTime() === b.getTime()
}

function equal(a: EffectiveAllowance, b: EffectiveAllowance): boolean {
  return (
    a.remaining === b.remaining &&
    a.effectiveSpent === b.effectiveSpent &&
    a.isResetPending === b.isResetPending &&
    sameReset(a.nextResetTime, b.nextResetTime)
  )
}

describe('Frontend · computeEffectiveAllowance vs AllowanceModule reference model', () => {
  describe('arithmetic equivalence (evaluated at the same chain time)', () => {
    const BASE_SEED = 0x0f00_d00d
    const CASE_COUNT = 5_000

    it(`agrees with the reference model across ${CASE_COUNT} fuzzed cases`, () => {
      const mismatches: Array<{ seed: number; info: AllowanceInfo; blockTimeSec: number }> = []

      for (const { seed, info, blockTimeSec } of generateAllowanceCases(BASE_SEED, CASE_COUNT)) {
        const haven = computeEffectiveAllowance(info, blockTimeSec)
        const chain = referenceEffectiveAllowance(info, blockTimeSec)
        if (!equal(haven, chain)) mismatches.push({ seed, info, blockTimeSec })
      }

      if (mismatches.length > 0) {
        const sample = mismatches.slice(0, 5).map((m) => {
          const haven = computeEffectiveAllowance(m.info, m.blockTimeSec)
          const chain = referenceEffectiveAllowance(m.info, m.blockTimeSec)
          return {
            seed: `0x${m.seed.toString(16)}`,
            resetTimeMin: m.info.resetTimeMin,
            lastResetMin: m.info.lastResetMin,
            blockTimeSec: m.blockTimeSec,
            havenRemaining: haven.remaining.toString(),
            chainRemaining: chain.remaining.toString(),
            havenNextReset: haven.nextResetTime?.toISOString() ?? null,
            chainNextReset: chain.nextResetTime?.toISOString() ?? null,
          }
        })
        throw new Error(
          `${mismatches.length}/${CASE_COUNT} divergences. Reproduce via seed. Sample:\n` +
            JSON.stringify(sample, null, 2),
        )
      }

      expect(mismatches).toHaveLength(0)
    })
  })

  describe('regression guards (converged findings)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    // F-1 / F-2 (resolved): the reset decision must read chain time, never the
    // user's device clock. Guard fails if a Date.now() dependency returns.
    it('reset decision tracks the passed chain time, not the device wall-clock', () => {
      const resetTimeMin = 1_440 // daily
      const boundaryMin = 28_000_000
      const info: AllowanceInfo = {
        token: '0x0000000000000000000000000000000000000001',
        amount: 500_000_000n,
        spent: 500_000_000n, // fully spent
        resetTimeMin,
        lastResetMin: boundaryMin - resetTimeMin,
        nonce: 7,
      }
      const boundarySec = boundaryMin * 60

      // Chain is one second BEFORE the reset boundary → not reset, remaining 0.
      const chainBeforeSec = boundarySec - 1
      // Device clock is a full day AHEAD — a correct impl must ignore it.
      vi.useFakeTimers()
      vi.setSystemTime((boundarySec + 86_400) * 1000)

      const haven = computeEffectiveAllowance(info, chainBeforeSec)
      const chain = referenceEffectiveAllowance(info, chainBeforeSec)

      // Demonstrate the prior defect: the old impl used Date.now(), which here
      // sits past the boundary and would have shown a phantom full reset.
      const deviceSeesReset =
        Math.floor(Date.now() / 1000) >= (info.lastResetMin + resetTimeMin) * 60
      expect(deviceSeesReset).toBe(true) // wall-clock would have flipped...
      expect(haven.isResetPending).toBe(false) // ...but chain time governs.
      expect(haven.remaining).toBe(0n)
      expect(haven.isResetPending).toBe(chain.isResetPending)
    })

    // F-3 (resolved): nextResetTime for a multi-period-idle allowance must land
    // on the period grid, not the old hardcoded lastReset + 2*period.
    it('nextResetTime for a multi-period-idle allowance lands on the period grid', () => {
      const resetTimeMin = 1_440 // daily
      const lastResetMin = 28_000_000
      const info: AllowanceInfo = {
        token: '0x0000000000000000000000000000000000000001',
        amount: 500_000_000n,
        spent: 500_000_000n,
        resetTimeMin,
        lastResetMin,
        nonce: 0,
      }
      // Three full periods idle, plus a bit.
      const nowSec = (lastResetMin + 3 * resetTimeMin + 100) * 60

      const haven = computeEffectiveAllowance(info, nowSec)
      const chain = referenceEffectiveAllowance(info, nowSec)

      // Old implementation hardcoded the boundary at lastReset + 2*period —
      // correct only when exactly one period is idle.
      const oldNextResetMs = (lastResetMin * 60 + resetTimeMin * 60 * 2) * 1000
      const correctMs = (lastResetMin + 4 * resetTimeMin) * 60 * 1000

      expect(haven.isResetPending).toBe(true)
      expect(haven.nextResetTime!.getTime()).toBe(correctMs)
      expect(haven.nextResetTime!.getTime()).toBe(chain.nextResetTime!.getTime())
      expect(haven.nextResetTime!.getTime()).not.toBe(oldNextResetMs) // the bug we removed
      console.warn(
        `[F-3] old nextReset=${new Date(oldNextResetMs).toISOString()} ` +
          `vs correct=${haven.nextResetTime!.toISOString()}`,
      )
    })
  })
})
