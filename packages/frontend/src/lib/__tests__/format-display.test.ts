import { describe, expect, it } from 'vitest'
import { formatFiat, formatFiatDisplay, isSubCent, SUB_CENT_THRESHOLD } from '../format'

/**
 * `formatFiatDisplay` (owner decision 2026-10-22, superseding #3897's
 * "<$0.01"): a non-zero figure under a cent renders EXACTLY 4 decimals in
 * the currency's own format, and "<0.0001" when even that would show 0.0000.
 * Exact code points: sv-SE and de-DE separate the symbol with NBSP.
 */
const NBSP = ' '

describe('formatFiatDisplay (sub-cent, owner decision 2026-10-22)', () => {
  const cases: Array<[number, 'USD' | 'EUR' | 'SEK', string]> = [
    // The acceptance table of #4264, USD.
    [0, 'USD', '$0.00'],
    [0.00004, 'USD', '<$0.0001'],
    [0.00008, 'USD', '$0.0001'],
    [0.001, 'USD', '$0.0010'],
    [0.0049, 'USD', '$0.0049'],
    [0.005, 'USD', '$0.01'],
    [0.00995, 'USD', '$0.01'],
    [1.5, 'USD', '$1.50'],
    // Both signs, all three currencies, in the currency's own format.
    [0.001, 'EUR', `0,0010${NBSP}€`],
    [0.0049, 'EUR', `0,0049${NBSP}€`],
    [-0.001, 'EUR', `-0,0010${NBSP}€`],
    [-0.0049, 'EUR', `-0,0049${NBSP}€`],
    [0.001, 'SEK', `0,0010${NBSP}kr`],
    [0.0049, 'SEK', `0,0049${NBSP}kr`],
    [-0.001, 'SEK', `\u22120,0010${NBSP}kr`],
    [-0.0049, 'SEK', `\u22120,0049${NBSP}kr`],
    [0.00004, 'EUR', `<0,0001${NBSP}€`],
    [0.00004, 'SEK', `<0,0001${NBSP}kr`],
    [-0.00004, 'USD', '-<$0.0001'],
    [-0.00004, 'EUR', `-<0,0001${NBSP}€`],
    // sv-SE's minus is U+2212, the same glyph formatFiat(-1, 'SEK') uses.
    [-0.00004, 'SEK', `\u2212<0,0001${NBSP}kr`],
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

  it('switches to "<" exactly at the 4-decimal floor', () => {
    expect(formatFiatDisplay(0.00005, 'USD')).toBe('$0.0001')
    expect(formatFiatDisplay(0.000049, 'USD')).toBe('<$0.0001')
    expect(formatFiatDisplay(-0.00005, 'SEK')).toBe(`\u22120,0001${NBSP}kr`)
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
