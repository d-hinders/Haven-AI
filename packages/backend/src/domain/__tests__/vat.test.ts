import { describe, expect, it } from 'vitest'
import {
  vatTreatmentForCountry,
  reverseChargePurchaseAccount,
  reverseChargeVat,
} from '../vat.js'

describe('vatTreatmentForCountry', () => {
  it('treats the home country (SE) as domestic/standard', () => {
    expect(vatTreatmentForCountry('SE')).toBe('standard')
    expect(vatTreatmentForCountry('se')).toBe('standard')
  })

  it('treats EU, non-EU, and unknown as reverse charge', () => {
    expect(vatTreatmentForCountry('DE')).toBe('reverse_charge')
    expect(vatTreatmentForCountry('US')).toBe('reverse_charge')
    expect(vatTreatmentForCountry(null)).toBe('reverse_charge')
    expect(vatTreatmentForCountry('')).toBe('reverse_charge')
  })
})

describe('reverseChargePurchaseAccount', () => {
  it('uses the EU services account for EU suppliers', () => {
    expect(reverseChargePurchaseAccount('DE')).toBe('4535')
    expect(reverseChargePurchaseAccount('fr')).toBe('4535')
  })

  it('uses the non-EU account for suppliers outside the EU', () => {
    expect(reverseChargePurchaseAccount('US')).toBe('4537')
    expect(reverseChargePurchaseAccount('GB')).toBe('4537')
  })

  it('defaults unknown / malformed country to the EU account (flagged default)', () => {
    expect(reverseChargePurchaseAccount(null)).toBe('4535')
    expect(reverseChargePurchaseAccount('XYZ')).toBe('4535')
  })
})

describe('reverseChargeVat', () => {
  it('is 25% rounded to öre', () => {
    expect(reverseChargeVat(100)).toBe(25)
    expect(reverseChargeVat(0.1)).toBe(0.03)
  })
})
