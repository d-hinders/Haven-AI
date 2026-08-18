/**
 * #1530 — the settlement wallet's gas is a consumable resource, and until now
 * nothing reported it.
 *
 * On 2026-08-17 this wallet held 255 gwei. Every x402 leg needing a
 * merchant-side settlement failed, the merchant said only "Payment failed",
 * and the cause took a day to find. These tests pin the arithmetic that turns
 * that balance into a sentence someone can act on.
 */
import { describe, it, expect } from 'vitest'
import {
  settlementReadiness,
  SETTLEMENT_COST_WEI,
  MIN_SETTLEMENT_HEADROOM,
} from './x402.js'

const ADDR = '0xC03F7c03d20f3DC32d3b8dAD6EeA90a3be4822c1' as const

describe('settlementReadiness', () => {
  it('reports the actual 2026-08-17 outage balance as not ok, with zero headroom', () => {
    // 255 gwei — the balance that broke the day.
    const ready = settlementReadiness(ADDR, 255_000_000_000n)
    expect(ready.settlementsRemaining).toBe(0)
    expect(ready.ok).toBe(false)
    expect(ready.address).toBe(ADDR)
  })

  it('reports a funded wallet as ok', () => {
    // ~0.00147 ETH, the balance after the operator topped it up.
    const ready = settlementReadiness(ADDR, 1_469_790_000_000_000n)
    expect(ready.settlementsRemaining).toBeGreaterThan(MIN_SETTLEMENT_HEADROOM)
    expect(ready.ok).toBe(true)
  })

  it('is not ok while headroom is only a handful of settlements', () => {
    // The case a floor of 1 would call healthy — and then exhaust on the very
    // next run. The whole point of the threshold is to fire before empty.
    const ready = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * 3n)
    expect(ready.settlementsRemaining).toBe(3)
    expect(ready.ok).toBe(false)
  })

  it('flips to ok exactly at the threshold, not one short of it', () => {
    const atFloor = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * BigInt(MIN_SETTLEMENT_HEADROOM))
    const justUnder = settlementReadiness(
      ADDR,
      SETTLEMENT_COST_WEI * BigInt(MIN_SETTLEMENT_HEADROOM) - 1n,
    )
    expect(atFloor.ok).toBe(true)
    expect(justUnder.ok).toBe(false)
  })

  it('treats an empty wallet as zero headroom rather than dividing by surprise', () => {
    const ready = settlementReadiness(ADDR, 0n)
    expect(ready.settlementsRemaining).toBe(0)
    expect(ready.ok).toBe(false)
  })

  it('never divides by zero when a caller passes a zero cost', () => {
    const ready = settlementReadiness(ADDR, 10n ** 18n, 0n)
    expect(ready.settlementsRemaining).toBe(0)
    expect(ready.ok).toBe(false)
  })

  it('states headroom in units of work, so the number carries its own meaning', () => {
    // The reason this returns settlementsRemaining at all: "255 gwei" reads as
    // a number, "0 settlements of headroom" reads as a cause.
    const ready = settlementReadiness(ADDR, SETTLEMENT_COST_WEI * 40n)
    expect(ready.settlementsRemaining).toBe(40)
    expect(ready.costPerSettlementWei).toBe(SETTLEMENT_COST_WEI)
  })
})
