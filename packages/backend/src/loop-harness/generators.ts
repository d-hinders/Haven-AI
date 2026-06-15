/**
 * Deterministic fuzz generators for the allowance differential loop.
 *
 * Reproducibility is a hard requirement for a loop harness: a divergence the
 * loop reports on iteration N must be replayable on iteration N+1 so a fix can
 * be verified. We therefore use a small seeded PRNG (mulberry32) rather than
 * `Math.random`, and every generated case carries the seed that produced it.
 */

import type { AllowanceInfo } from '../lib/allowance-module.js'

/** mulberry32 — tiny, fast, deterministic 32-bit PRNG. */
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
  // Build a bigint from 32-bit chunks so amounts can exceed Number range
  // (uint96 caps well above 2^53).
  const hi = BigInt(Math.floor(rng() * 0x100000000))
  const lo = BigInt(Math.floor(rng() * 0x100000000))
  const raw = (hi << 32n) | lo
  return maxExclusive > 0n ? raw % maxExclusive : 0n
}

const UINT96_MAX = (1n << 96n) - 1n

/**
 * One fuzzed allowance case, tagged with the seed and a candidate block time
 * so any divergence is fully reproducible from its `seed`.
 */
export interface AllowanceCase {
  seed: number
  info: AllowanceInfo
  /** A plausible block timestamp (seconds) to evaluate the case at. */
  blockTimeSec: number
}

/**
 * Generate `count` allowance cases from a base seed. Biases toward the
 * interesting regions: fully-spent allowances, near-cap spends, short reset
 * windows, and timestamps clustered around the reset boundary.
 */
export function* generateAllowanceCases(
  baseSeed: number,
  count: number,
): Generator<AllowanceCase> {
  for (let i = 0; i < count; i++) {
    const seed = (baseSeed + i * 0x9e3779b1) >>> 0
    const rng = mulberry32(seed)

    const amount = randBigInt(rng, UINT96_MAX) + 1n

    // Bias spent toward the cap so boundary behaviour dominates.
    const spentBias = rng()
    const spent =
      spentBias < 0.4
        ? amount // fully spent
        : spentBias < 0.7
          ? amount - (randBigInt(rng, amount) % (amount > 0n ? amount : 1n))
          : randBigInt(rng, amount + 1n)

    // resetTimeMin: uint16; include 0 (one-time) and small windows.
    const resetTimeMin =
      rng() < 0.25 ? 0 : randInt(rng, 1, 0xffff)

    // lastResetMin: uint32 minutes-since-epoch in a realistic recent range.
    const nowMin = Math.floor(Date.now() / 1000 / 60)
    const lastResetMin = randInt(rng, nowMin - 10 * 24 * 60, nowMin)

    const nonce = randInt(rng, 0, 0xffff)

    const info: AllowanceInfo = {
      amount,
      spent: spent < 0n ? 0n : spent,
      resetTimeMin,
      lastResetMin,
      nonce,
    }

    // Candidate block time near the reset boundary when there is one.
    const boundarySec = (lastResetMin + resetTimeMin) * 60
    const jitter = randInt(rng, -120, 120)
    const blockTimeSec = resetTimeMin === 0
      ? Math.floor(Date.now() / 1000)
      : boundarySec + jitter

    yield { seed, info, blockTimeSec }
  }
}
