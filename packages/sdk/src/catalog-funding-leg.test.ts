import { describe, expect, it } from 'vitest'
import { catalogFundingLegExpected } from './catalog-funding-leg.js'

describe('catalogFundingLegExpected (#3839)', () => {
  it('erc7710 in the recorded set: no funding leg expected', () => {
    expect(catalogFundingLegExpected('eip3009,erc7710')).toBe(false)
    expect(catalogFundingLegExpected('erc7710')).toBe(false)
    expect(catalogFundingLegExpected(' eip3009 , ERC7710 ')).toBe(false)
  })

  it('a recorded set without erc7710 (eip3009-only): a funding leg is expected', () => {
    expect(catalogFundingLegExpected('eip3009')).toBe(true)
    expect(catalogFundingLegExpected('eip3009,permit2')).toBe(true)
  })

  it('nothing recorded is "unknown", never null or a guess', () => {
    for (const value of [null, undefined, '', ' , ']) {
      expect(catalogFundingLegExpected(value), String(value)).toBe('unknown')
    }
  })

  it('does not match erc7710 as a substring of another method name', () => {
    expect(catalogFundingLegExpected('erc77100')).toBe(true)
  })
})
