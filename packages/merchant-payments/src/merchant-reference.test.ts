import { describe, expect, it } from 'vitest'
import { newMerchantReference } from './merchant-reference.js'

describe('the merchant reference (§5)', () => {
  it('is sale_<ulid>: 26 Crockford base32 characters that sort by creation time', () => {
    const a = newMerchantReference(1_800_000_000_000)
    const b = newMerchantReference(1_800_000_000_001)
    expect(a).toMatch(/^sale_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a.slice(0, 15) < b.slice(0, 15)).toBe(true)
  })

  it('differs between two references made in the same millisecond', () => {
    expect(newMerchantReference(1_800_000_000_000)).not.toBe(newMerchantReference(1_800_000_000_000))
  })
})
