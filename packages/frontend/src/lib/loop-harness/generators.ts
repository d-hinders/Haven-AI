/**
 * Deterministic fuzz generators for the frontend allowance differential loop.
 *
 * Seeded (mulberry32) so any divergence the loop reports is replayable from its
 * `seed`. Biased toward the interesting regions: reset boundaries and
 * multi-period-idle allowances (which exercise the period-grid reset logic).
 */

import type { Address } from 'viem'
import type { AllowanceInfo } from '../allowance-math'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function randBigInt(rng: () => number, maxExclusive: bigint): bigint {
  const hi = BigInt(Math.floor(rng() * 0x100000000))
  const lo = BigInt(Math.floor(rng() * 0x100000000))
  const raw = (hi << 32n) | lo
  return maxExclusive > 0n ? raw % maxExclusive : 0n
}

const UINT96_MAX = (1n << 96n) - 1n
const DUMMY_TOKEN = '0x0000000000000000000000000000000000000001' as Address

export interface AllowanceCase {
  seed: number
  info: AllowanceInfo
  /** A plausible block timestamp (seconds) to evaluate the case at. */
  blockTimeSec: number
}

export function* generateAllowanceCases(
  baseSeed: number,
  count: number,
): Generator<AllowanceCase> {
  for (let i = 0; i < count; i++) {
    const seed = (baseSeed + i * 0x9e3779b1) >>> 0
    const rng = mulberry32(seed)

    const amount = randBigInt(rng, UINT96_MAX) + 1n
    const spentBias = rng()
    const spent =
      spentBias < 0.4
        ? amount
        : spentBias < 0.7
          ? amount - (randBigInt(rng, amount) % (amount > 0n ? amount : 1n))
          : randBigInt(rng, amount + 1n)

    const resetTimeMin = rng() < 0.25 ? 0 : randInt(rng, 1, 0xffff)

    const nowMin = Math.floor(Date.now() / 1000 / 60)
    const lastResetMin = randInt(rng, nowMin - 30 * 24 * 60, nowMin)

    const info: AllowanceInfo = {
      token: DUMMY_TOKEN,
      amount,
      spent: spent < 0n ? 0n : spent,
      resetTimeMin,
      lastResetMin,
      nonce: randInt(rng, 0, 0xffff),
    }

    // Candidate block time. For reset-bearing allowances, jump a random number
    // of whole periods past lastReset (to hit multi-period-idle grid logic),
    // plus sub-period jitter to probe the boundary.
    let blockTimeSec: number
    if (resetTimeMin === 0) {
      blockTimeSec = Math.floor(Date.now() / 1000)
    } else {
      const periodsAhead = randInt(rng, 0, 5)
      const jitterMin = randInt(rng, -2, 2)
      blockTimeSec = (lastResetMin + periodsAhead * resetTimeMin + jitterMin) * 60 + randInt(rng, 0, 59)
    }

    yield { seed, info, blockTimeSec }
  }
}
