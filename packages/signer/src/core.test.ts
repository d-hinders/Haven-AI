import { describe, it, expect } from 'vitest'
import { addressFromKey, verifySignature, HavenSigningError } from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'

// Well-known test key (Hardhat account #0). Never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const HASH = '0x' + 'ab'.repeat(32)

const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 60,
    },
  ],
}

describe('createEdgeSigner', () => {
  it('derives the delegate address from the key', () => {
    const signer = createEdgeSigner(TEST_KEY)
    expect(signer.delegateAddress.toLowerCase()).toBe(addressFromKey(TEST_KEY).toLowerCase())
  })

  it('throws on an invalid key', () => {
    expect(() => createEdgeSigner('not-a-key')).toThrow(HavenSigningError)
  })

  it('signs a hash so it recovers to the delegate address', () => {
    const signer = createEdgeSigner(TEST_KEY)
    const sig = signer.signPaymentHash(HASH)
    // 0x + r(32) + s(32) + v(1) = 132 chars
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i)
    expect(verifySignature(HASH, sig, signer.delegateAddress)).toBe(true)
  })
})

describe('buildX402PaymentHeader', () => {
  it('builds a merchant header for a Base USDC option', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const result = await signer.buildX402PaymentHeader(PAYMENT_REQUIRED)
    expect(typeof result.paymentHeader).toBe('string')
    expect(result.paymentHeader.length).toBeGreaterThan(0)
    expect(result.accepted.asset.toLowerCase()).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    )
  })

  it('rejects unsupported payment options', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    await expect(
      signer.buildX402PaymentHeader({
        x402Version: 1,
        resource: { url: 'https://m.test' },
        accepts: [
          { scheme: 'exact', network: 'base', amount: '1', asset: '0xNotUsdc', payTo: '0x1', maxTimeoutSeconds: 60 },
        ],
      }),
    ).rejects.toThrow()
  })
})
