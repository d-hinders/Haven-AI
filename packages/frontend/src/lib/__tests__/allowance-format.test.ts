import { describe, expect, it } from 'vitest'
import {
  formatAllowanceAmount,
  formatAllowanceForToken,
  getTokenDecimals,
} from '@/lib/allowance-format'

describe('formatAllowanceAmount', () => {
  it('divides raw 18-decimal bigint by the token decimals', () => {
    expect(formatAllowanceAmount('5000000000000000000', 18)).toBe('5')
  })

  it('handles 6-decimal tokens like USDC', () => {
    expect(formatAllowanceAmount('1500000', 6)).toBe('1.5')
    expect(formatAllowanceAmount('500000000', 6)).toBe('500')
  })

  it('strips trailing zeros after the decimal point', () => {
    // 1.0000 → "1", 1.5000 → "1.5", 1.2500 → "1.25"
    expect(formatAllowanceAmount('1000000', 6)).toBe('1')
    expect(formatAllowanceAmount('1250000', 6)).toBe('1.25')
  })

  it('caps the fractional part at 4 digits', () => {
    // 0.12345678 (8-decimal) should render as 0.1234 — capped to 4
    expect(formatAllowanceAmount('12345678', 8)).toBe('0.1234')
  })

  it('handles sub-unit amounts smaller than a whole token', () => {
    // 0.5 USDC = 500000 at 6 decimals
    expect(formatAllowanceAmount('500000', 6)).toBe('0.5')
  })

  it('falls back gracefully on already-decimal strings (defensive)', () => {
    // If the API or a caller passes "500.000000" we still trim it.
    expect(formatAllowanceAmount('500.000000', 18)).toBe('500')
    expect(formatAllowanceAmount('1.5', 18)).toBe('1.5')
  })

  it('returns the original string on non-numeric input', () => {
    expect(formatAllowanceAmount('not-a-number', 18)).toBe('not-a-number')
  })

  it('handles zero correctly', () => {
    expect(formatAllowanceAmount('0', 18)).toBe('0')
  })

  it('renders negative bigint inputs as a clean signed value', () => {
    // Regression: the old code produced "-5.-5" because BigInt's `%`
    // preserves sign. Now: separate the sign, format the magnitude,
    // re-attach.
    expect(formatAllowanceAmount('-5500000', 6)).toBe('-5.5')
    expect(formatAllowanceAmount('-1000000000000000000', 18)).toBe('-1')
  })

  it('passes scientific-notation inputs through unchanged', () => {
    // `Number('1e20').toFixed(4)` returns a 25-character integer that
    // defeats the formatter and silently loses precision near
    // Number.MAX_SAFE_INTEGER. Pass it through so the bug is visible
    // rather than disguised as a giant decimal.
    expect(formatAllowanceAmount('1e18', 18)).toBe('1e18')
    expect(formatAllowanceAmount('2.5e20', 6)).toBe('2.5e20')
  })
})

describe('getTokenDecimals', () => {
  it('looks up USDC.e on Gnosis Chain (6 decimals)', () => {
    expect(getTokenDecimals(100, 'USDC.e')).toBe(6)
  })

  it('looks up xDAI on Gnosis Chain (18 decimals, native)', () => {
    expect(getTokenDecimals(100, 'xDAI')).toBe(18)
  })

  it('looks up USDC on Base (6 decimals)', () => {
    expect(getTokenDecimals(8453, 'USDC')).toBe(6)
  })

  it('returns undefined for unknown symbol', () => {
    expect(getTokenDecimals(100, 'NOPE')).toBeUndefined()
  })

  it('returns undefined for unknown chain', () => {
    expect(getTokenDecimals(999_999, 'USDC')).toBeUndefined()
  })
})

describe('formatAllowanceForToken', () => {
  it('formats a USDC allowance on Base correctly', () => {
    // 500 USDC at 6 decimals = 500_000_000
    expect(formatAllowanceForToken('500000000', 8453, 'USDC')).toBe('500')
  })

  it('falls back to 18 decimals for unknown tokens', () => {
    // 1 ETH worth of base units
    expect(formatAllowanceForToken('1000000000000000000', 100, 'MYSTERY')).toBe('1')
  })

  it('falls back to 18 decimals when chainId is null', () => {
    expect(formatAllowanceForToken('1000000000000000000', null, 'USDC')).toBe('1')
  })
})
