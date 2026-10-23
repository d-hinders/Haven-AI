/**
 * #4097 — the Holdings rules, as unit tests over `lib/account-holdings.ts`:
 * one token in USD (no value, no rate), one token in SEK (the rate line
 * instead of a value), two tokens (each shows its value), the #4021 filler
 * rule (a zero raw balance renders nowhere), and the degraded marker passing
 * through to the caller.
 */
import { describe, expect, it } from 'vitest'
import { holdingDisplayAmount, holdingRows, holdingRateLine } from '../account-holdings'
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

describe('holdingDisplayAmount (#4197)', () => {
  // The five owner examples, verbatim from the issue.
  it.each([
    ['8.225255', '8.2252'],
    ['0.99999', '0.9999'],
    ['0.57', '0.57'],
    ['42.00', '42.00'],
    ['0.00005', '<0.0001'],
  ])('%s renders as %s', (served, displayed) => {
    expect(holdingDisplayAmount(served)).toBe(displayed)
  })

  it('rounds DOWN by string truncation, never through floats (0.57 is not 0.5699)', () => {
    // The float path the issue bars: Math.floor(parseFloat('0.57') * 1e4) / 1e4
    // lands at 0.5699. String truncation cannot.
    expect(holdingDisplayAmount('0.570009')).toBe('0.57')
    expect(holdingDisplayAmount('1.999999')).toBe('1.9999')
    expect(holdingDisplayAmount('12.345679')).toBe('12.3456')
  })

  it('keeps the 2-decimal minimum — trailing zeros the cut exposes trim back to it', () => {
    expect(holdingDisplayAmount('42.00')).toBe('42.00')
    expect(holdingDisplayAmount('12.50')).toBe('12.50')
    expect(holdingDisplayAmount('10.00005')).toBe('10.00')
    expect(holdingDisplayAmount('1.230049')).toBe('1.23')
  })

  it('a non-zero amount below 0.0001 reads "<0.0001", never "0.0000"', () => {
    expect(holdingDisplayAmount('0.000099')).toBe('<0.0001')
    // 0.0001 itself is exactly at the threshold and renders as served.
    expect(holdingDisplayAmount('0.0001')).toBe('0.0001')
    expect(holdingDisplayAmount('0.00010')).toBe('0.0001')
  })

  it('a zero read renders as served — "<0.0001" would claim a hidden remainder', () => {
    expect(holdingDisplayAmount('0.00')).toBe('0.00')
    expect(holdingDisplayAmount('0')).toBe('0')
  })

  it('an integer-shaped wire string passes through untouched', () => {
    expect(holdingDisplayAmount('42')).toBe('42')
  })
})
