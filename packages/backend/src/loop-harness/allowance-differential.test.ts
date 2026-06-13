/**
 * Tier 1 — Differential loop: Haven's off-chain allowance mirror vs the
 * AllowanceModule reference model.
 *
 * Runs anywhere (no network, no Foundry): pure functions only. The loop's job
 * is to find inputs where Haven's `computeEffectiveAllowance` — which drives
 * the auto-execute-vs-queue routing decision — disagrees with what the real
 * contract would enforce in the block a transfer mines in.
 *
 * Two distinct sections:
 *   1. `arithmetic equivalence` — the property that MUST hold when the
 *      relayer's clock equals chain time. This is the green ratchet; if it ever
 *      goes red, the off-chain reset/decimal math has drifted from the model.
 *   2. `FINDINGS` — characterised divergences, encoded with `it.fails` so they
 *      pin the bug in place while keeping the suite green. When the underlying
 *      defect is fixed, the `it.fails` will itself start failing, which is the
 *      signal to delete the finding (the loop has converged on that case).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computeEffectiveAllowance } from '../lib/allowance-module.js'
import type { AllowanceInfo } from '../lib/allowance-module.js'
import { referenceEffectiveAllowance } from './reference-allowance-module.js'
import { generateAllowanceCases } from './generators.js'

describe('Tier 1 · computeEffectiveAllowance vs AllowanceModule reference model', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('arithmetic equivalence (relayer clock == chain time)', () => {
    // With the clocks aligned, the off-chain mirror must reproduce the
    // contract's reset arithmetic and decimal handling exactly.
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
        // Pin the relayer wall-clock to exactly the candidate block time so we
        // isolate arithmetic divergence from clock-source divergence.
        vi.setSystemTime(blockTimeSec * 1000)

        const haven = computeEffectiveAllowance(info)
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

  describe('FINDINGS — known divergences (it.fails until the defect is fixed)', () => {
    // A daily, fully-spent USDC (6dp) allowance sitting right at its reset edge.
    const boundaryMin = 28_000_000 // arbitrary recent-ish minute-since-epoch
    const resetTimeMin = 1_440 // daily
    const info: AllowanceInfo = {
      amount: 500_000_000n, // 500 USDC, fully spent
      spent: 500_000_000n,
      resetTimeMin,
      lastResetMin: boundaryMin - resetTimeMin,
      nonce: 7,
    }
    const boundarySec = boundaryMin * 60

    it.fails(
      'F-1 · routing decision keys off the relayer wall-clock, not chain block.timestamp ' +
        '(clock skew AHEAD → false auto-execute → on-chain revert)',
      () => {
        // Chain has NOT yet crossed the reset boundary: the block this would
        // mine in is one second short, so on-chain `spent` stays at the cap.
        const chainBlockTimeSec = boundarySec - 1
        // The relayer's wall-clock is one minute fast (NTP skew / slow block
        // production). `computeEffectiveAllowance` reads Date.now() internally.
        vi.setSystemTime((boundarySec + 60) * 1000)

        const haven = computeEffectiveAllowance(info)
        const chain = referenceEffectiveAllowance(info, chainBlockTimeSec)

        console.warn(
          `[FINDING F-1] haven.remaining=${haven.remaining} (resetPending=${haven.isResetPending}) ` +
            `vs chain.remaining=${chain.remaining} (resetPending=${chain.isResetPending}) ` +
            `→ Haven would auto-execute; chain would revert.`,
        )

        // PROPERTY THAT SHOULD HOLD: the off-chain routing decision must match
        // what the contract will actually enforce in the mined block.
        // Today it does not — Haven sees a reset (remaining = full 500 USDC)
        // while the chain sees a fully-spent allowance (remaining = 0), so Haven
        // auto-executes a transfer the AllowanceModule reverts.
        expect(haven.isResetPending).toBe(chain.isResetPending)
        expect(haven.remaining).toBe(chain.remaining)
      },
    )

    it.fails(
      'F-2 · clock skew BEHIND → false queue (a valid in-budget payment is sent to manual approval)',
      () => {
        // Chain HAS crossed the boundary (reset has effectively happened),
        // but the relayer wall-clock lags one minute behind.
        const chainBlockTimeSec = boundarySec + 1
        vi.setSystemTime((boundarySec - 60) * 1000)

        const haven = computeEffectiveAllowance(info)
        const chain = referenceEffectiveAllowance(info, chainBlockTimeSec)

        // Haven still sees the allowance as fully spent and queues for approval,
        // while the chain would happily accept the transfer post-reset.
        expect(haven.isResetPending).toBe(chain.isResetPending)
        expect(haven.remaining).toBe(chain.remaining)
      },
    )
  })
})
