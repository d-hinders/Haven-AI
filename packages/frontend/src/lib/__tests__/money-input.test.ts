import { describe, expect, it } from 'vitest'
import {
  exceedsRawBalance,
  normalizeMoneyInput,
  rawAmountFromBalance,
  validateMoneyInput,
} from '../money-input'

describe('money input utilities', () => {
  it('normalizes shorthand decimal amounts before parsing', () => {
    expect(normalizeMoneyInput(' .5 ')).toBe('0.5')
    expect(validateMoneyInput('.5', 6, { tokenSymbol: 'USDC' })).toEqual({
      ok: true,
      amount: '0.5',
      raw: 500000n,
    })
  })

  it('rejects invalid, zero, negative, and exponent notation amounts', () => {
    expect(validateMoneyInput('', 6).ok).toBe(false)
    expect(validateMoneyInput('0', 6).ok).toBe(false)
    expect(validateMoneyInput('-1', 6).ok).toBe(false)
    expect(validateMoneyInput('1e3', 6).ok).toBe(false)
    expect(validateMoneyInput('1,5', 6).ok).toBe(false)
  })

  it('enforces token decimal precision before parseUnits is called downstream', () => {
    expect(validateMoneyInput('1.123456', 6)).toEqual({
      ok: true,
      amount: '1.123456',
      raw: 1123456n,
    })
    expect(validateMoneyInput('1.1234567', 6)).toEqual({
      ok: false,
      message: 'This token supports up to 6 decimal places',
    })
    expect(validateMoneyInput('1.1', 0, { tokenSymbol: 'ETH' })).toEqual({
      ok: false,
      message: 'ETH supports up to 0 decimal places',
    })
  })

  it('compares parsed raw amounts against raw balances without float rounding', () => {
    const amount = validateMoneyInput('0.100000000000000001', 18)
    expect(amount.ok && amount.raw).toBe(100000000000000001n)
    expect(rawAmountFromBalance('100000000000000000')).toBe(100000000000000000n)
    expect(amount.ok && exceedsRawBalance(amount.raw, '100000000000000000')).toBe(true)
    expect(amount.ok && exceedsRawBalance(amount.raw, '100000000000000001')).toBe(false)
  })
})
