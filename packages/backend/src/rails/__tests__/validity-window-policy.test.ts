import { describe, expect, it } from 'vitest'
import { SWEEP_VALIDITY_SECONDS } from '../sweep.js'

/**
 * EIP-3009 validity-window policy (#715, epic #713).
 *
 * A leaked signed authorization is spendable until `validBefore` — every
 * window in the system must therefore be tight and BOUNDED BY TEST, so it
 * cannot silently grow in a refactor. Widening a bound here is an explicit,
 * reviewed policy decision, not a test fix.
 *
 * The merchant-facing x402 window is bounded in the SDK with its own tests
 * (packages/sdk/src/x402.ts): X402_MAX_AUTHORIZATION_WINDOW_SECONDS clamps the
 * merchant-requested timeout, and since #1256 the signed header's total
 * forward window is that clamp + X402_SETTLEMENT_FORWARD_MARGIN_SECONDS
 * (≤900 s) — the margin is what clears the facilitator's verify rule. This
 * file pins the backend-owned sweep window.
 */
describe('EIP-3009 validity-window policy (#715)', () => {
  it('keeps the sweep authorization window within policy bounds', () => {
    expect(SWEEP_VALIDITY_SECONDS).toBeLessThanOrEqual(600)
    expect(SWEEP_VALIDITY_SECONDS).toBeGreaterThanOrEqual(60)
  })
})
