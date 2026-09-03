/**
 * #1530 — the settlement wallet's gas is a consumable resource, and until now
 * nothing reported it.
 *
 * On 2026-08-17 this wallet held 255 gwei. Every x402 leg needing a
 * merchant-side settlement failed, the merchant said only "Payment failed",
 * and the cause took a day to find. These tests pin the arithmetic that turns
 * that balance into a sentence someone can act on.
 *
 * #2490 — one boolean could not say both "top up soon" and "refuse the run":
 * the warning threshold acted as an incident (#2485: three consecutive
 * qa-dev failures at 24 settlements, one below the floor, ~3 runs of real
 * capacity unused). The signal is now a THREE-state band: `usable`, `warn`
 * (below the warn floor — loud, but the run proceeds) and `fail` (below the
 * fail floor — a run cannot complete, refuse it).
 */
import { describe, it, expect } from 'vitest'
import {
  settlementReadiness,
  SETTLEMENT_COST_WEI,
  MIN_SETTLEMENT_HEADROOM_WARN,
  MIN_SETTLEMENT_HEADROOM_FAIL,
} from './x402.js'

const ADDR = '0xC03F7c03d20f3DC32d3b8dAD6EeA90a3be4822c1' as const

describe('settlementReadiness', () => {
  it('lands the 2026-08-17 outage balance (255 gwei ⇒ 0 settlements) in the FAIL band', () => {
    // The state #1530 was built for: every settlement-requiring leg fails.
    // The fail floor must be far above zero for exactly this state — a run
    // must be refused while it still cannot complete, not merely when the
    // wallet is empty (#2490).
    const ready = settlementReadiness(ADDR, 255_000_000_000n)
    expect(ready.settlementsRemaining).toBe(0)
    expect(ready.status).toBe('fail')
    expect(ready.address).toBe(ADDR)
  })

  it('lands the #2485 state (24 settlements, one below the old floor) in the WARN band, not fail', () => {
    // Three consecutive qa-dev failures at 24 settlements against a floor of
    // 25 — short by one settlement of gas — while ~3 runs of real capacity
    // sat unused. This state must stay loud (warn) but must NOT block a run.
    const ready = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * 24n)
    expect(ready.settlementsRemaining).toBe(24)
    expect(ready.status).toBe('warn')
    expect(ready.status).not.toBe('fail')
  })

  it('reports a funded wallet as usable', () => {
    // ~0.00147 ETH, the balance after the operator topped it up.
    const ready = settlementReadiness(ADDR, 1_469_790_000_000_000n)
    expect(ready.settlementsRemaining).toBeGreaterThan(MIN_SETTLEMENT_HEADROOM_WARN)
    expect(ready.status).toBe('usable')
  })

  it('is fail while headroom is only a handful of settlements', () => {
    // Below the fail floor: the run cannot complete one full run's worth of
    // settling legs, so it is refused rather than started and stranding
    // partial evidence (the #1530 class).
    const ready = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * 3n)
    expect(ready.settlementsRemaining).toBe(3)
    expect(ready.status).toBe('fail')
  })

  it('flips at exactly the fail floor, not one short of it', () => {
    // 12 = one full run (~8 settlements) plus half a run of headroom — the
    // floor a run can still be admitted at. The boundary is inclusive: at the
    // floor the run proceeds; one below, it is refused.
    const atFloor = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * BigInt(MIN_SETTLEMENT_HEADROOM_FAIL))
    const justUnder = settlementReadiness(
      ADDR,
      SETTLEMENT_COST_WEI * BigInt(MIN_SETTLEMENT_HEADROOM_FAIL) - 1n,
    )
    expect(atFloor.status).toBe('warn')
    expect(justUnder.status).toBe('fail')
  })

  it('flips at exactly the warn floor, which stays at the pre-#2490 value of 25', () => {
    const atWarn = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * BigInt(MIN_SETTLEMENT_HEADROOM_WARN))
    const justUnder = settlementReadiness(
      ADDR,
      SETTLEMENT_COST_WEI * BigInt(MIN_SETTLEMENT_HEADROOM_WARN) - 1n,
    )
    expect(MIN_SETTLEMENT_HEADROOM_WARN).toBe(25)
    expect(atWarn.status).toBe('usable')
    expect(justUnder.status).toBe('warn')
  })

  it('treats an empty wallet as zero headroom in the fail band rather than dividing by surprise', () => {
    const ready = settlementReadiness(ADDR, 0n)
    expect(ready.settlementsRemaining).toBe(0)
    expect(ready.status).toBe('fail')
  })

  it('never divides by zero when a caller passes a zero cost', () => {
    const ready = settlementReadiness(ADDR, 10n ** 18n, 0n)
    expect(ready.settlementsRemaining).toBe(0)
    expect(ready.status).toBe('fail')
  })

  it('states headroom in units of work, so the number carries its own meaning', () => {
    // The reason this returns settlementsRemaining at all: "255 gwei" reads as
    // a number, "0 settlements of headroom" reads as a cause.
    const ready = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * 40n)
    expect(ready.settlementsRemaining).toBe(40)
    expect(ready.costPerSettlementWei).toBe(SETTLEMENT_COST_WEI)
  })

  it('ships both floors so /healthz can carry them to the harness (#2490)', () => {
    // The harness renders the band without re-deriving it (preflight rule 1:
    // derive, never restate). It can only do that if the readiness object
    // carries the thresholds the merchant measured against.
    const ready = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * 30n)
    expect(ready.warnFloor).toBe(MIN_SETTLEMENT_HEADROOM_WARN)
    expect(ready.failFloor).toBe(MIN_SETTLEMENT_HEADROOM_FAIL)
  })
})
