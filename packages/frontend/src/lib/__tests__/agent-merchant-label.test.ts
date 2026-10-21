import { describe, expect, it } from 'vitest'
import { agentMerchantLabel } from '../agent-merchant-label'

const ADDRESS = '0x' + 'ab'.repeat(20)

describe('agentMerchantLabel (#4209)', () => {
  it('prefers the merchant name', () => {
    expect(
      agentMerchantLabel({ merchantName: 'Bitrefill', x402ResourceUrl: 'https://api.bitrefill.com/x', to: ADDRESS }),
    ).toBe('Bitrefill')
  })

  it('falls back to the host of the x402 resource URL', () => {
    expect(
      agentMerchantLabel({ merchantName: null, x402ResourceUrl: 'https://api.exa.ai/search?q=1', to: ADDRESS }),
    ).toBe('api.exa.ai')
  })

  it('returns nothing for a to-only counterparty — never the address', () => {
    expect(agentMerchantLabel({ merchantName: null, x402ResourceUrl: null, to: ADDRESS })).toBeNull()
  })

  it('treats a name that is an address as no name', () => {
    expect(agentMerchantLabel({ merchantName: ADDRESS, x402ResourceUrl: null, to: ADDRESS })).toBeNull()
    expect(
      agentMerchantLabel({ merchantName: ADDRESS, x402ResourceUrl: 'https://shop.example/pay', to: ADDRESS }),
    ).toBe('shop.example')
  })

  it('returns nothing for a blank name, an unparseable URL or no counterparty', () => {
    expect(agentMerchantLabel({ merchantName: '  ', x402ResourceUrl: 'not a url', to: null })).toBeNull()
    expect(agentMerchantLabel(null)).toBeNull()
  })
})
