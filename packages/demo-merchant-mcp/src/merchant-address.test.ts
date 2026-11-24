import { describe, expect, it } from 'vitest'
import { resolveMerchantAddress } from './merchant-address.js'

const CHECKSUMMED = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'

describe('#5070: MERCHANT_ADDRESS is validated at startup', () => {
  it('refuses a missing or empty value, naming the variable', () => {
    for (const raw of [undefined, '', '   ']) {
      const result = resolveMerchantAddress(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/^MERCHANT_ADDRESS env var is required/)
    }
  })

  it('refuses a value that is not an address, naming the variable', () => {
    for (const raw of ['<your other Base Sepolia address>', '0x1234', `${CHECKSUMMED}00`, 'not-an-address']) {
      const result = resolveMerchantAddress(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/^MERCHANT_ADDRESS is not a valid EVM address/)
    }
  })

  it('refuses a mixed-case value whose checksum is wrong', () => {
    const wrongChecksum = CHECKSUMMED.replace('C2d5', 'c2D5')
    expect(resolveMerchantAddress(wrongChecksum).ok).toBe(false)
    // All uppercase is not a checksum either: viem's strict check refuses it.
    expect(resolveMerchantAddress(`0x${CHECKSUMMED.slice(2).toUpperCase()}`).ok).toBe(false)
  })

  it('accepts a checksummed address unchanged', () => {
    expect(resolveMerchantAddress(CHECKSUMMED)).toEqual({ ok: true, address: CHECKSUMMED })
  })

  it('normalises an all-lowercase address to its checksummed form', () => {
    expect(resolveMerchantAddress(CHECKSUMMED.toLowerCase())).toEqual({ ok: true, address: CHECKSUMMED })
    expect(resolveMerchantAddress(`  ${CHECKSUMMED}  `)).toEqual({ ok: true, address: CHECKSUMMED })
  })
})
