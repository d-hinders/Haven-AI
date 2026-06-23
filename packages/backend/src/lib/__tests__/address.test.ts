import { describe, it, expect } from 'vitest'
import { isAddress, ETH_ADDRESS_RE } from '../address.js'

describe('isAddress', () => {
  it('accepts a 40-hex address (any casing)', () => {
    expect(isAddress('0x' + 'a'.repeat(40))).toBe(true)
    expect(isAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true) // mixed case
    expect(isAddress('0x' + '0'.repeat(40))).toBe(true)
  })

  it('rejects wrong length, missing prefix, or non-hex', () => {
    expect(isAddress('0x' + 'a'.repeat(39))).toBe(false) // too short
    expect(isAddress('0x' + 'a'.repeat(41))).toBe(false) // too long
    expect(isAddress('a'.repeat(40))).toBe(false) // no 0x
    expect(isAddress('0x' + 'g'.repeat(40))).toBe(false) // non-hex
    expect(isAddress('')).toBe(false)
  })

  it('is a type guard that rejects non-strings', () => {
    expect(isAddress(null)).toBe(false)
    expect(isAddress(undefined)).toBe(false)
    expect(isAddress(123)).toBe(false)
    expect(isAddress({})).toBe(false)
  })

  it('ETH_ADDRESS_RE matches isAddress for strings', () => {
    const a = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
    expect(ETH_ADDRESS_RE.test(a)).toBe(isAddress(a))
  })
})
