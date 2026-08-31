import { describe, expect, it } from 'vitest'
import {
  formatAllowanceAmount,
  formatAllowanceForToken,
  getTokenDecimals,
  humanAmountToAtomic,
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

  it('uses stablecoin defaults while preserving meaningful sub-cent precision', () => {
    expect(formatAllowanceAmount('1000000', 6, { symbol: 'USDC' })).toBe('1.00')
    expect(formatAllowanceAmount('1500000', 6, { symbol: 'USDC' })).toBe('1.50')
    expect(formatAllowanceAmount('5000', 6, { symbol: 'USDC' })).toBe('0.005')
    expect(formatAllowanceAmount('1', 18, { symbol: 'xDAI' })).toBe('0.000000000000000001')
  })

  it('uses ETH defaults while preserving smaller amounts', () => {
    expect(formatAllowanceAmount('1000000000000000000', 18, { symbol: 'ETH' })).toBe('1.0000')
    expect(formatAllowanceAmount('10000000000000', 18, { symbol: 'ETH' })).toBe('0.00001')
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
    expect(getTokenDecimals(999_999, 'NOPE')).toBeUndefined()
  })

  it('falls back to known token unit decimals when chain metadata is missing', () => {
    expect(getTokenDecimals(999_999, 'USDC')).toBe(6)
    expect(getTokenDecimals(100, 'USDC')).toBe(6)
    expect(getTokenDecimals(8453, 'EURe')).toBe(18)
  })
})

describe('formatAllowanceForToken', () => {
  it('formats a USDC allowance on Base correctly', () => {
    // 500 USDC at 6 decimals = 500_000_000
    expect(formatAllowanceForToken('500000000', 8453, 'USDC')).toBe('500.00')
  })

  it('falls back to 18 decimals for unknown tokens', () => {
    // 1 ETH worth of base units
    expect(formatAllowanceForToken('1000000000000000000', 100, 'MYSTERY')).toBe('1')
  })

  it('falls back to 18 decimals when chainId is null', () => {
    expect(formatAllowanceForToken('1000000000000000000', null, 'MYSTERY')).toBe('1')
  })

  it('formats known tokens correctly when chainId is null', () => {
    expect(formatAllowanceForToken('5000', null, 'USDC')).toBe('0.005')
    expect(formatAllowanceForToken('1000000000000000000', null, 'EURe')).toBe('1.00')
  })
})

/**
 * #2295. `allowance_amount` carries two incompatible wire shapes under one
 * field name, and they are NOT distinguishable at runtime — `'250'` is 250
 * USDC as a human amount and 0.00025 USDC as an atomic one. So this helper
 * does not sniff; the caller states the shape, and the OpenAPI schema
 * (`allowanceHumanAmount` vs `allowanceAtomicAmount`) is what tells it which.
 */
describe('humanAmountToAtomic (#2295)', () => {
  it('scales whole and fractional token units by the decimals', () => {
    expect(humanAmountToAtomic('5.00', 6)).toBe(5_000_000n)
    expect(humanAmountToAtomic('250.000000', 6)).toBe(250_000_000n)
    // A bare integer is a legal human amount — this is the value that no
    // runtime sniff could ever get right, and the reason for the parameter.
    expect(humanAmountToAtomic('250', 6)).toBe(250_000_000n)
    expect(humanAmountToAtomic('0.000001', 6)).toBe(1n)
    expect(humanAmountToAtomic('1', 18)).toBe(10n ** 18n)
    expect(humanAmountToAtomic('12', 0)).toBe(12n)
  })

  it('returns 0n for a zero budget, which is an answer and not a failure', () => {
    // `formatTokenValue` emits a bare '0' for a revoked/zero budget. A null
    // here would make callers report "unknown" for a budget that is known.
    expect(humanAmountToAtomic('0', 6)).toBe(0n)
    expect(humanAmountToAtomic('0.00', 6)).toBe(0n)
  })

  it('truncates precision beyond the token decimals rather than rounding up', () => {
    // Conservative direction for a "does this budget cover the price" test.
    expect(humanAmountToAtomic('1.9999999', 6)).toBe(1_999_999n)
  })

  it('returns null instead of throwing on anything that is not a decimal', () => {
    expect(humanAmountToAtomic('not-a-number', 6)).toBe(null)
    expect(humanAmountToAtomic('', 6)).toBe(null)
    // Scientific notation is rejected for the same reason formatAllowanceAmount
    // refuses it — precision is already lost by the time it is parseable.
    expect(humanAmountToAtomic('1e6', 6)).toBe(null)
    expect(humanAmountToAtomic('0x10', 6)).toBe(null)
    // `BigInt('')` is 0n and `BigInt(' 5 ')` is 5n; neither may leak through.
    expect(humanAmountToAtomic('5.', 6)).toBe(null)
  })

  it('handles a negative amount without corrupting the magnitude', () => {
    // Not a shape the API emits, but sign handling must not silently invert.
    expect(humanAmountToAtomic('-5.00', 6)).toBe(-5_000_000n)
  })
})
