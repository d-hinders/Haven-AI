/**
 * Tier 1 — Differential loop: Haven's off-chain allowance mirror vs the
 * AllowanceModule reference model.
 *
 * Runs anywhere (no network, no Foundry): pure functions only. The loop's job
 * is to find inputs where Haven's `computeEffectiveAllowance` — which drives
 * the auto-execute-vs-queue routing decision — disagrees with what the real
 * contract would enforce in the block a transfer mines in.
 *
 * Sections:
 *   1. `arithmetic equivalence` — the property that MUST hold: for the same
 *      chain time, the off-chain mirror reproduces the contract's reset and
 *      decimal arithmetic exactly. This is the green ratchet; if it goes red,
 *      the off-chain math has drifted from the model.
 *   2. `regression guards` — converged findings, kept as permanent tests so the
 *      defect cannot silently return.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { computeEffectiveAllowance } from '../lib/allowance-module.js'
import type { AllowanceInfo } from '../lib/allowance-module.js'
import { referenceEffectiveAllowance } from './reference-allowance-module.js'
import { generateAllowanceCases } from './generators.js'

describe('Tier 1 · computeEffectiveAllowance vs AllowanceModule reference model', () => {
  describe('arithmetic equivalence (evaluated at the same chain time)', () => {
    const BASE_SEED = 0x1234_5678
    const CASE_COUNT = 5_000

    it(`agrees with the reference model across ${CASE_COUNT} fuzzed cases`, () => {
      const mismatches: Array<{
        seed: number
        info: AllowanceInfo
        blockTimeSec: number
        haven: ReturnType<typeof computeEffectiveAllowance>
        chain: ReturnType<typeof referenceEffectiveAllowance>
      }> = []

      for (const { seed, info, blockTimeSec } of generateAllowanceCases(
        BASE_SEED,
        CASE_COUNT,
      )) {
        // Both sides see the same chain timestamp; any divergence is therefore
        // an arithmetic (reset/decimal) bug, not a clock-source bug.
        const haven = computeEffectiveAllowance(info, blockTimeSec)
        const chain = referenceEffectiveAllowance(info, blockTimeSec)

        if (
          haven.remaining !== chain.remaining ||
          haven.isResetPending !== chain.isResetPending ||
          haven.effectiveSpent !== chain.effectiveSpent
        ) {
          mismatches.push({ seed, info, blockTimeSec, haven, chain })
        }
      }

      if (mismatches.length > 0) {
        const sample = mismatches.slice(0, 5).map((m) => ({
          seed: `0x${m.seed.toString(16)}`,
          info: {
            amount: m.info.amount.toString(),
            spent: m.info.spent.toString(),
            resetTimeMin: m.info.resetTimeMin,
            lastResetMin: m.info.lastResetMin,
          },
          blockTimeSec: m.blockTimeSec,
          havenRemaining: m.haven.remaining.toString(),
          chainRemaining: m.chain.remaining.toString(),
        }))
        throw new Error(
          `${mismatches.length}/${CASE_COUNT} arithmetic divergences. ` +
            `Reproduce with the seed. Sample:\n${JSON.stringify(sample, null, 2)}`,
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
    // relayer wall-clock. This guard fails if anyone reintroduces a `Date.now()`
    // dependency, by pinning the system clock far from the chain time we pass in
    // and asserting the output tracks the argument, not the clock.
    it('reset decision tracks the passed chain time, not the relayer wall-clock', () => {
      const resetTimeMin = 1_440 // daily
      const boundaryMin = 28_000_000
      const info: AllowanceInfo = {
        amount: 500_000_000n, // 500 USDC, fully spent
        spent: 500_000_000n,
        resetTimeMin,
        lastResetMin: boundaryMin - resetTimeMin,
        nonce: 7,
      }
      const boundarySec = boundaryMin * 60

      // Chain is one second BEFORE the reset boundary → no reset, remaining 0.
      const chainBeforeSec = boundarySec - 1
      // Wall-clock is wildly AHEAD (a full day past the boundary). A correct
      // implementation must ignore it entirely.
      vi.useFakeTimers()
      vi.setSystemTime((boundarySec + 86_400) * 1000)

      const haven = computeEffectiveAllowance(info, chainBeforeSec)
      const chain = referenceEffectiveAllowance(info, chainBeforeSec)

      expect(haven.isResetPending).toBe(chain.isResetPending)
      expect(haven.remaining).toBe(chain.remaining)
      // Concretely: pre-boundary chain time means the allowance is still spent.
      expect(haven.isResetPending).toBe(false)
      expect(haven.remaining).toBe(0n)
    })
  })
})
