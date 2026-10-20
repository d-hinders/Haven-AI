/**
 * #4097 — the Holdings rules, as unit tests over `lib/account-holdings.ts`:
 * one token in USD (no value, no rate), one token in SEK (the rate line
 * instead of a value), two tokens (each shows its value), the #4021 filler
 * rule (a zero raw balance renders nowhere), and the degraded marker passing
 * through to the caller.
 */
import { describe, expect, it } from 'vitest'
import { holdingRows, holdingRateLine } from '../account-holdings'
import { formatFiat } from '@/lib/format'
import type { PortfolioBreakdown } from '@/types/transactions'

function token(overrides: Partial<PortfolioBreakdown>): PortfolioBreakdown {
  return {
    symbol: 'USDC',
    balance: '19828500000',
    formatted: '19828.50',
    usdValue: 19828.5,
    eurValue: 18500,
    sekValue: 188400,
    ...overrides,
  }
}

describe('holdingRows (#4097)', () => {
  it('one token in USD shows the amount and NO value — it would repeat the balance', () => {
    const rows = holdingRows([token({ formatted: '19.8285', balance: '19828500', usdValue: 19.83 })], 'USD')
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe('19.8285')
    expect(rows[0].value).toBeNull()
    // A USD display currency shows no rate either — a USD-pegged token
    // would state the same figure a third time.
    expect(rows[0].rate).toBeNull()
    expect(holdingRateLine(rows[0], 'USD')).toBeNull()
  })

  it('one token in SEK shows the rate instead of a value ("1 USDC = 9,50 kr")', () => {
    // 19.8285 USDC worth 188.37 kr → the implied rate is 9.50 kr per USDC.
    const rows = holdingRows(
      [token({ formatted: '19.8285', balance: '19828500', usdValue: 19.83, sekValue: 188.37 })],
      'SEK',
    )
    expect(rows[0].value).toBeNull()
    expect(rows[0].rate).toBeCloseTo(9.5, 3)
    expect(holdingRateLine(rows[0], 'SEK')).toBe(`1 USDC = ${formatFiat(9.5, 'SEK')}`)
  })

  it('two tokens each show their value, and no rate', () => {
    const rows = holdingRows(
      [
        token({ symbol: 'USDC', formatted: '19.8285', sekValue: 188.37, usdValue: 19.83 }),
        token({ symbol: 'ETH', formatted: '0.02', sekValue: 18.4, usdValue: 60, eurValue: 55 }),
      ],
      'SEK',
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].value).toBe(188.37)
    expect(rows[1].value).toBe(18.4)
    expect(rows[0].rate).toBeNull()
    expect(rows[1].rate).toBeNull()
  })

  it('a zero RAW balance renders nowhere (#4021, carried to this page)', () => {
    const rows = holdingRows(
      [
        token({ symbol: 'USDC', formatted: '5.00', balance: '5000000' }),
        // Filler ETH: never read, zero raw balance, zero value.
        token({ symbol: 'ETH', formatted: '0.00', balance: '0', usdValue: 0, sekValue: 0 }),
      ],
      'USD',
    )
    expect(rows.map((row) => row.symbol)).toEqual(['USDC'])
  })

  it('a held but unpriced token still renders, with no rate claim', () => {
    // #4021's rule: hiding is on the RAW balance, never the fiat value —
    // a held-but-unpriced token has fiat 0 and must still render.
    const rows = holdingRows(
      [token({ symbol: 'ETH', formatted: '0.02', usdValue: 0, sekValue: 0 })],
      'SEK',
    )
    expect(rows).toHaveLength(1)
    // No rate can be computed from a zero value: unpriced is not "worth
    // nothing", and the balance's own degraded marker says the rest.
    expect(rows[0].rate).toBeNull()
    expect(holdingRateLine(rows[0], 'SEK')).toBeNull()
  })

  it('a stale read keeps its amount and passes the marker through (#3295)', () => {
    const stale = {
      status: 'stale' as const,
      asOf: '2026-09-25T07:55:00.000Z',
    }
    const rows = holdingRows([token({ formatted: '1200.00', balanceFreshness: stale })], 'USD')
    expect(rows[0].amount).toBe('1200.00')
    expect(rows[0].balanceFreshness).toEqual(stale)
  })
})
