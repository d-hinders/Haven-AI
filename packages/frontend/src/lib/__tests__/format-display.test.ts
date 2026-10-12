import { describe, expect, it } from 'vitest'
import { formatFiat, formatFiatDisplay, isSubCent, SUB_CENT_THRESHOLD } from '../format'

/**
 * `formatFiatDisplay` (#3897, owner decision 2026-10-12): a non-zero figure
 * under a cent renders "<$0.01" instead of a `0.00` that states nothing was
 * spent. Exact code points: sv-SE and de-DE separate the symbol with NBSP.
 */
const NBSP = ' '

describe('formatFiatDisplay (#3897)', () => {
  const cases: Array<[number, 'USD' | 'EUR' | 'SEK', string]> = [
    [0.004, 'USD', '<$0.01'],
    [0.004, 'SEK', `<0,01${NBSP}kr`],
    [0.004, 'EUR', `<0,01${NBSP}€`],
    [-0.004, 'USD', '-<$0.01'],
    // sv-SE's minus is U+2212, the same glyph formatFiat(-1, 'SEK') uses.
    [-0.004, 'SEK', `\u2212<0,01${NBSP}kr`],
    [-0.004, 'EUR', `-<0,01${NBSP}€`],
    [0, 'USD', '$0.00'],
    [0, 'SEK', `0,00${NBSP}kr`],
    [0, 'EUR', `0,00${NBSP}€`],
    [12.5, 'USD', '$12.50'],
    [12.5, 'SEK', `12,50${NBSP}kr`],
    [12.5, 'EUR', `12,50${NBSP}€`],
  ]
  it.each(cases)('%s %s → %j', (value, currency, expected) => {
    expect(formatFiatDisplay(value, currency)).toBe(expected)
  })

  it('switches exactly at the threshold, keyed on the input', () => {
    expect(SUB_CENT_THRESHOLD).toBe(0.005)
    expect(isSubCent(0.0049)).toBe(true)
    expect(isSubCent(0.005)).toBe(false)
    expect(isSubCent(0)).toBe(false)
    expect(formatFiatDisplay(0.005, 'USD')).toBe('$0.01')
  })

  it('signs a negative sub-cent figure with the glyph formatFiat uses for negatives', () => {
    for (const currency of ['USD', 'EUR', 'SEK'] as const) {
      expect(formatFiatDisplay(-0.004, currency)[0]).toBe(formatFiat(-1, currency).match(/[-\u2212]/)?.[0])
    }
  })

  it('leaves formatFiat itself unchanged — the count-up and /accounts keep plain rounding', () => {
    expect(formatFiat(0.004, 'USD')).toBe('$0.00')
  })
})
