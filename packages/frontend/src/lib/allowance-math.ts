/**
 * Pure allowance arithmetic, isolated from the viem-coupled contract I/O in
 * `./allowance-module`.
 *
 * This is the off-chain mirror of the Safe AllowanceModule's reset logic used
 * by the dashboard to show "remaining" before the chain is poked. It is the
 * frontend twin of the backend's `computeEffectiveAllowance`, and like that one
 * it must key its reset decision off CHAIN time, never the user's device clock.
 *
 * Kept dependency-light on purpose: the only `viem` reference is the `Address`
 * type, imported as `type` so it is erased at build time. That makes this module
 * unit-testable (and loop-testable) without pulling the wallet stack.
 */

import type { Address } from 'viem'

export interface AllowanceInfo {
  token: Address
  amount: bigint
  spent: bigint
  resetTimeMin: number
  lastResetMin: number
  nonce: number
}

export interface EffectiveAllowance {
  remaining: bigint
  effectiveSpent: bigint
  nextResetTime: Date | null
  isResetPending: boolean
}

/**
 * Compute effective remaining allowance accounting for the AllowanceModule's
 * reset logic.
 *
 * `nowSec` MUST be chain time — a block `timestamp` in seconds — NOT
 * `Date.now()`. The on-chain reset keys off `block.timestamp`; predicting it
 * from the user's local clock makes the dashboard show a phantom reset (or miss
 * a real one) near a period boundary, and is arbitrarily wrong if the device
 * clock is skewed.
 *
 * The contract resets `spent` to 0 once a full reset period has elapsed and
 * re-anchors `lastResetMin` onto the period grid
 * (`lastResetMin + k * resetTimeMin`), so the next reset always lands on that
 * grid — not simply `lastReset + 2 * period`.
 */
export function computeEffectiveAllowance(
  info: AllowanceInfo,
  nowSec: number,
): EffectiveAllowance {
  if (info.resetTimeMin === 0) {
    // One-time allowance — never resets.
    const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
    return { remaining, effectiveSpent: info.spent, nextResetTime: null, isResetPending: false }
  }

  const currentMin = Math.floor(nowSec / 60)
  // Whole reset periods elapsed since the last on-chain reset.
  const elapsedPeriods = Math.floor((currentMin - info.lastResetMin) / info.resetTimeMin)
  const isResetPending = elapsedPeriods >= 1
  // Next reset boundary on the period grid (handles multi-period-idle gaps).
  const nextResetMin =
    info.lastResetMin + (Math.max(elapsedPeriods, 0) + 1) * info.resetTimeMin
  const nextResetTime = new Date(nextResetMin * 60 * 1000)

  if (isResetPending) {
    // Reset has effectively happened — spent is 0 even though the chain has not
    // been poked yet.
    return { remaining: info.amount, effectiveSpent: 0n, nextResetTime, isResetPending: true }
  }

  const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
  return { remaining, effectiveSpent: info.spent, nextResetTime, isResetPending: false }
}
