import { describe, expect, it, vi } from 'vitest'
import { DEMO_SELLER, resolveReceiptSeller } from './invoice.js'

/** #4856: the seller block comes from configuration, defaulting to the demo seller. */
const FULL = {
  MERCHANT_SELLER_NAME: 'Example Seller AB',
  MERCHANT_SELLER_ADDRESS: 'Exempelgatan 1, 111 11 Stockholm',
  MERCHANT_SELLER_ORG_NR: '000000-0000',
  MERCHANT_SELLER_MOMS_NR: 'SE000000000001',
}

describe('resolveReceiptSeller (#4856)', () => {
  it('is the demo seller, unchanged, with nothing configured', () => {
    const warn = vi.fn()
    expect(resolveReceiptSeller({}, warn)).toBe(DEMO_SELLER)
    expect(resolveReceiptSeller({ MERCHANT_SELLER_NAME: '  ' }, warn)).toBe(DEMO_SELLER)
    expect(warn).not.toHaveBeenCalled()
  })

  it('is the configured seller with the four required values, and never the demo bank details', () => {
    const seller = resolveReceiptSeller(FULL, vi.fn())
    expect(seller).toEqual({
      name: 'Example Seller AB',
      address: 'Exempelgatan 1, 111 11 Stockholm',
      org_nr: '000000-0000',
      moms_nr: 'SE000000000001',
    })
    expect(Object.keys(seller)).toEqual(['name', 'address', 'org_nr', 'moms_nr'])
  })

  it('adds iban and bic only when each is set, after the required keys', () => {
    const seller = resolveReceiptSeller({ ...FULL, MERCHANT_SELLER_BIC: 'EXAMPLEX', MERCHANT_SELLER_IBAN: 'SE00 0000' }, vi.fn())
    expect(Object.keys(seller)).toEqual(['name', 'address', 'org_nr', 'moms_nr', 'iban', 'bic'])
    expect(resolveReceiptSeller({ ...FULL, MERCHANT_SELLER_BIC: 'EXAMPLEX' }, vi.fn())).not.toHaveProperty('iban')
  })

  it.each(['MERCHANT_SELLER_NAME', 'MERCHANT_SELLER_ADDRESS', 'MERCHANT_SELLER_ORG_NR', 'MERCHANT_SELLER_MOMS_NR'])(
    'warns naming %s and keeps the demo seller when it is missing',
    (missing) => {
      const warn = vi.fn()
      const env: Record<string, string | undefined> = { ...FULL, [missing]: undefined }
      expect(resolveReceiptSeller(env, warn)).toBe(DEMO_SELLER)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain(missing)
    },
  )

  it('treats a set iban or bic alone as a half-configured seller', () => {
    const warn = vi.fn()
    expect(resolveReceiptSeller({ MERCHANT_SELLER_IBAN: 'SE00 0000' }, warn)).toBe(DEMO_SELLER)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
