import { describe, expect, it } from 'vitest'
import type { DashboardSpendGroupRow } from '../../infra/repositories/dashboard.js'
import { accumulateGroup, emptySpendWindow, type GroupPricing } from '../dashboard.js'

/**
 * #4165: the dashboard spend window's "≈" decision per currency, from the one
 * rule (`shouldMarkApprox` in @haven_ai/core), and the separate unpriced
 * flag. A pure fold over one spend group — no database is involved, so none
 * is mocked.
 */

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ETH_KEY = '0x' + 'cc'.repeat(20)

function group(overrides: Partial<DashboardSpendGroupRow>): DashboardSpendGroupRow {
  const zero = '0'
  return {
    agent_id: 'agent-1',
    token_key: BASE_USDC,
    chain_key: 8453,
    gross_usd_7: zero, net_usd_7: zero, gross_eur_7: zero, net_eur_7: zero, gross_sek_7: zero, net_sek_7: zero,
    fb_usd_7: zero, fb_eur_7: zero, fb_sek_7: zero,
    gross_usd_30: zero, net_usd_30: zero, gross_eur_30: zero, net_eur_30: zero, gross_sek_30: zero, net_sek_30: zero,
    fb_usd_30: zero, fb_eur_30: zero, fb_sek_30: zero,
    payments_7: zero, payments_30: '1',
    pace_atomic: zero,
    ...overrides,
  }
}

function pricingFor(
  symbol: string | null,
  rates: GroupPricing['rates'],
  tokenKey = BASE_USDC,
): Map<string, GroupPricing> {
  return new Map([[`8453:${tokenKey}`, { symbol, rates }]])
}

const RATES = { usd: 1, eur: 0.9, sek: 10.76 }

describe('dashboard spend window — the "≈" rule per currency (#4165)', () => {
  it('re-priced USDC is dollars in USD (no mark) and approximate in EUR and SEK', () => {
    const window = emptySpendWindow()
    accumulateGroup(window, group({ fb_usd_30: '5', fb_eur_30: '5', fb_sek_30: '5' }), '30', pricingFor('USDC', RATES))
    expect(window.netUsd).toBe(5)
    expect(window.netSek).toBeCloseTo(53.8)
    expect(window.approx).toBe(true)
    expect(window.approxByCurrency).toEqual({ usd: false, eur: true, sek: true })
    expect(window.unpricedByCurrency).toEqual({ usd: false, eur: false, sek: false })
  })

  it('a token the rule cannot identify keeps the mark even in USD', () => {
    const window = emptySpendWindow()
    accumulateGroup(window, group({ fb_usd_30: '5' }), '30', pricingFor(null, RATES))
    expect(window.approxByCurrency.usd).toBe(true)
  })

  it('a bucket with no rate is unpriced for a FLOAT — left out of the sum, never marked ≈', () => {
    // ETH floats: with no sek quote the SEK bucket is unpriced. (#4288)
    const window = emptySpendWindow()
    accumulateGroup(
      window,
      group({ token_key: ETH_KEY, net_usd_30: '2', gross_usd_30: '2', fb_sek_30: '5' }),
      '30',
      pricingFor('ETH', { usd: 3_000, eur: 0.9, sek: null }, ETH_KEY),
    )
    // The booked USD rows stand; the SEK fallback row is left out and the
    // bucket says so.
    expect(window.netUsd).toBe(2)
    expect(window.netSek).toBe(0)
    expect(window.unpricedByCurrency).toEqual({ usd: false, eur: false, sek: true })
    expect(window.approxByCurrency).toEqual({ usd: false, eur: false, sek: false })
  })

  it('prices a NULL-booked USDC row at exactly 1.0 in the USD bucket — the peg, not the market rate (#4288)', () => {
    // CoinGecko's `usd` for USDC is ≈ 0.9998 and #4165 renders those
    // dollars plain: USDC in the USD bucket is dollars, so the re-price is
    // the peg (1.0), and the bucket is NOT marked — and NOT unpriced even
    // with the USD quote missing.
    const window = emptySpendWindow()
    accumulateGroup(
      window,
      group({ fb_usd_30: '5', fb_eur_30: '5' }),
      '30',
      pricingFor('USDC', { usd: null, eur: 0.9, sek: 10.76 }),
    )
    expect(window.netUsd).toBe(5)
    expect(window.grossUsd).toBe(5)
    expect(window.unpricedByCurrency.usd).toBe(false)
    expect(window.approxByCurrency.usd).toBe(false)
    // The non-peg currencies still take the market rate.
    expect(window.netEur).toBeCloseTo(4.5)
  })

  it('a pegged token still uses the market rate in every other currency (#4288)', () => {
    const window = emptySpendWindow()
    accumulateGroup(window, group({ fb_sek_30: '5', fb_usd_30: '5' }), '30', pricingFor('USDC', RATES))
    expect(window.netSek).toBeCloseTo(53.8)
    expect(window.approxByCurrency.sek).toBe(true)
    // USD: 5 × 1.0 (the peg), never the ≈0.9998 `usd` quote the map carries.
    expect(window.netUsd).toBe(5)
    expect(window.approxByCurrency.usd).toBe(false)
  })

  it('a group the pricing map misses entirely keeps the old behaviour — no peg, no rate, unpriced (#4288)', () => {
    const window = emptySpendWindow()
    accumulateGroup(window, group({ fb_usd_30: '5' }), '30', new Map())
    expect(window.netUsd).toBe(0)
    expect(window.unpricedByCurrency.usd).toBe(true)
  })

  it('a fully booked group sets nothing', () => {
    const window = emptySpendWindow()
    accumulateGroup(window, group({ net_sek_30: '10', gross_sek_30: '10' }), '30', pricingFor('USDC', RATES))
    expect(window.approx).toBe(false)
    expect(window.approxByCurrency).toEqual({ usd: false, eur: false, sek: false })
  })
})
