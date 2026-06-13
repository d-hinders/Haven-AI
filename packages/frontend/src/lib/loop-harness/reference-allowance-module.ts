/**
 * Reference model of the Safe AllowanceModule reset semantics — the ORACLE for
 * the frontend allowance differential loop.
 *
 * Side-effect-free port of the on-chain reset arithmetic the AllowanceModule
 * applies inside `executeAllowanceTransfer`. The frontend's
 * `computeEffectiveAllowance` (in `../allowance-math`) is differential-tested
 * against this model.
 *
 * IMPORTANT — like its backend sibling, this model is hand-derived from the
 * contract source, not machine-certified against the live deployment. Treat a
 * divergence as a *candidate* finding to triage, EXCEPT divergence caused purely
 * by the CLOCK SOURCE: the contract can only read `block.timestamp`, so any UI
 * value that flips on the user's wall clock is a real defect regardless.
 *
 * On-chain reset branch being modelled:
 *
 *   if (resetTimeMin > 0 && lastResetMin <= block.timestamp / 60 - resetTimeMin) {
 *       spent = 0;
 *       // re-anchor onto the period grid, not just to "now":
 *       lastResetMin = currentMin - ((currentMin - lastResetMin) % resetTimeMin);
 *   }
 *
 * The next reset therefore always lands on the grid `lastResetMin + k*period`.
 */

import type { AllowanceInfo, EffectiveAllowance } from '../allowance-math'

/** Non-negative modulo (period and the elapsed gap are always ≥ 0 here). */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

/**
 * What the contract would enforce / the UI should show if evaluated at a block
 * with timestamp `blockTimeSec`.
 */
export function referenceEffectiveAllowance(
  info: AllowanceInfo,
  blockTimeSec: number,
): EffectiveAllowance {
  if (info.resetTimeMin === 0) {
    const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
    return { remaining, effectiveSpent: info.spent, nextResetTime: null, isResetPending: false }
  }

  const currentMin = Math.floor(blockTimeSec / 60)
  // Contract reset condition.
  const isResetPending = info.lastResetMin <= currentMin - info.resetTimeMin

  let nextResetMin: number
  if (isResetPending) {
    // Re-anchor onto the period grid exactly as the contract does, then the
    // next reset is one period beyond the anchor.
    const anchored = currentMin - mod(currentMin - info.lastResetMin, info.resetTimeMin)
    nextResetMin = anchored + info.resetTimeMin
  } else {
    nextResetMin = info.lastResetMin + info.resetTimeMin
  }
  const nextResetTime = new Date(nextResetMin * 60 * 1000)

  if (isResetPending) {
    return { remaining: info.amount, effectiveSpent: 0n, nextResetTime, isResetPending: true }
  }

  const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
  return { remaining, effectiveSpent: info.spent, nextResetTime, isResetPending: false }
}
