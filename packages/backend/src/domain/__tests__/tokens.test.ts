import { describe, it, expect } from 'vitest'
import { formatTokenValue, getTokenByAddress } from '../tokens.js'

/**
 * Unit coverage for the pure token-formatting util. Each expected value is
 * derived from the spec — atomic units → human string, truncated (not rounded),
 * with a minimum of 2 and a maximum of 6 fraction digits — not read off the
 * implementation, so the table is a real oracle.
 */
describe('formatTokenValue', () => {
  const cases: Array<[string, string, number, string]> = [
    ['empty string is zero',            '',                     6,  '0'],
    ['literal zero is zero',            '0',                    6,  '0'],
    ['one USDC keeps 2 min decimals',   '1000000',              6,  '1.00'],
    ['half shows one→padded to 2',      '1500000',              6,  '1.50'],
    ['sub-unit (2 cents)',              '20000',                6,  '0.02'],
    ['one atomic unit, 6 dp',           '1',                    6,  '0.000001'],
    ['one native token (18 dp)',        '1000000000000000000',  18, '1.00'],
    ['half a native token (18 dp)',     '500000000000000000',   18, '0.50'],
    // 18-dp value with >6 fractional digits: truncates at 6, does NOT round up.
    ['caps + truncates at 6 dp',        '1999999999999999999',  18, '1.999999'],
  ]
  it.each(cases)('%s', (_label, raw, decimals, expected) => {
    expect(formatTokenValue(raw, decimals)).toBe(expected)
  })
})

describe('getTokenByAddress', () => {
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

  it('looks up a token case-insensitively', () => {
    const lower = getTokenByAddress(8453, USDC_BASE.toLowerCase())
    const mixed = getTokenByAddress(8453, USDC_BASE)
    expect(lower?.symbol).toBe('USDC')
    expect(mixed?.symbol).toBe('USDC')
  })

  it('returns undefined for an unknown address', () => {
    expect(getTokenByAddress(8453, '0x000000000000000000000000000000000000dEaD')).toBeUndefined()
  })
})
