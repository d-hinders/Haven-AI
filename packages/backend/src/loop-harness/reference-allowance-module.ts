/**
 * Reference model of the Safe AllowanceModule reset/spend semantics.
 *
 * This is the ORACLE for the differential loop. It is a deliberately small,
 * side-effect-free port of the on-chain reset arithmetic that the real
 * AllowanceModule applies inside `executeAllowanceTransfer`. Haven's own
 * off-chain mirror — `computeEffectiveAllowance` in
 * `../lib/allowance-module.ts` — is tested against this model.
 *
 * IMPORTANT — this model is not machine-certified against the live contract
 * (that would need a forked-chain conformance run, which this repo does not
 * currently set up). Treat a divergence from this model as a *candidate*
 * finding to triage, not an automatically-confirmed bug — with one exception:
 * divergence caused purely by the CLOCK SOURCE. The contract can only ever read
 * `block.timestamp`, so any decision that flips based on the relayer's wall
 * clock is a real defect regardless of model fidelity.
 *
 * On-chain logic being modelled (AllowanceModule.executeAllowanceTransfer →
 * the reset branch applied before the spend check):
 *
 *   if (resetTimeMin > 0 &&
 *       lastResetMin <= block.timestamp / 60 - resetTimeMin) {
 *       spent = 0;
 *       lastResetMin = block.timestamp / 60;   // floored to the minute
 *   }
 *   require(spent + amount <= amount_cap);      // the spend that follows
 *
 * Note the contract floors the *current* time to whole minutes
 * (`block.timestamp / 60`) and only ever uses chain time.
 */

import type { AllowanceInfo, EffectiveAllowance } from '../lib/allowance-module.js'

/**
 * What the real contract would compute as the effective remaining allowance
 * if a transfer were submitted in a block with the given timestamp.
 *
 * @param info          Raw allowance storage as returned by `getTokenAllowance`.
 * @param blockTimeSec  The block timestamp (seconds) the transfer would mine at.
 *                      The contract reads `block.timestamp` — never wall-clock.
 */
export function referenceEffectiveAllowance(
  info: AllowanceInfo,
  blockTimeSec: number,
): EffectiveAllowance {
  if (info.resetTimeMin === 0) {
    // One-time allowance: never resets.
    const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
    return { remaining, effectiveSpent: info.spent, isResetPending: false }
  }

  // The contract floors current time to whole minutes BEFORE comparing.
  const currentMin = Math.floor(blockTimeSec / 60)
  const resetPending = info.lastResetMin <= currentMin - info.resetTimeMin

  if (resetPending) {
    return { remaining: info.amount, effectiveSpent: 0n, isResetPending: true }
  }

  const remaining = info.amount > info.spent ? info.amount - info.spent : 0n
  return { remaining, effectiveSpent: info.spent, isResetPending: false }
}
