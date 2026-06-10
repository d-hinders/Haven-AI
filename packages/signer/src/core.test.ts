import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  addressFromKey,
  buildX402ExpectedMessage,
  verifySignature,
  HavenSigningError,
} from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'

// Well-known test key (Hardhat account #0). Never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const HASH = '0x' + 'ab'.repeat(32)
const FUNDING_HASH = '0x' + 'cd'.repeat(32)

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

const EXPECTED_X402_BASE = {
  paymentId: 'pay_x402',
  payloadHash: FUNDING_HASH,
  resourceUrl: PAYMENT_REQUIRED.resource.url,
  merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
  amount: PAYMENT_REQUIRED.accepts[0].amount,
  asset: PAYMENT_REQUIRED.accepts[0].asset,
  network: PAYMENT_REQUIRED.accepts[0].network,
}

async function expectedX402(overrides: Partial<typeof EXPECTED_X402_BASE> = {}) {
  const context = { ...EXPECTED_X402_BASE, ...overrides }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      version: 1 as const,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
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
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    const result = await signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)
    expect(typeof result.paymentHeader).toBe('string')
    expect(result.paymentHeader.length).toBeGreaterThan(0)
    expect(result.accepted.asset.toLowerCase()).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    )
  })

  it('rejects unsupported payment options', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    await expect(
      signer.buildX402PaymentHeader({
        x402Version: 1,
        resource: { url: 'https://m.test' },
        accepts: [
          { scheme: 'exact', network: 'base', amount: '1', asset: '0xNotUsdc', payTo: '0x1', maxTimeoutSeconds: 60 },
        ],
      }, funding.x402Binding),
    ).rejects.toThrow()
  })

  it('requires a locally recorded x402 funding binding before header signing', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    await expect(signer.buildX402PaymentHeader(PAYMENT_REQUIRED, 'not-recorded')).rejects.toThrow(
      'funding binding',
    )
  })

  it('rejects unauthenticated or tampered expected contexts before signing the funding hash', async () => {
    const expected = await expectedX402()
    const unconfigured = createEdgeSigner(TEST_KEY)
    expect(() => unconfigured.signX402FundingHash(FUNDING_HASH, expected)).toThrow(
      'verifier is not configured',
    )

    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    expect(() =>
      signer.signX402FundingHash(FUNDING_HASH, {
        ...expected,
        amount: '2000000',
      }),
    ).toThrow('authentication message')
    expect(() =>
      signer.signX402FundingHash('0x' + 'ef'.repeat(32), expected),
    ).toThrow('funding hash')
  })

  // ── v1 x402 path coverage (#324) ────────────────────────────────────────
  // The edge signer mirrors the SDK's v1/v2 split: v2+ headers are re-wrapped
  // as { x402Version, accepted, payload }, but v1 headers must pass the x402
  // library's output through UNCHANGED — v1 facilitators reject the wrap.
  // The PAYMENT_REQUIRED fixture above is x402Version 1 on purpose.

  it('passes v1 payment headers through unchanged (no accepted wrap)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    const result = await signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)

    const decoded = JSON.parse(
      Buffer.from(result.paymentHeader, 'base64').toString('utf8'),
    ) as Record<string, unknown>

    // V1 shape: the raw library envelope — no top-level `accepted` key.
    expect(decoded).not.toHaveProperty('accepted')
    expect(decoded.x402Version).toBe(1)
    expect(Object.keys(decoded).sort()).toEqual(['network', 'payload', 'scheme', 'x402Version'])
  })

  it('wraps v2 headers with accepted — the v1/v2 split is on x402Version', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    const result = await signer.buildX402PaymentHeader(
      { ...PAYMENT_REQUIRED, x402Version: 2 },
      funding.x402Binding,
    )

    const decoded = JSON.parse(
      Buffer.from(result.paymentHeader, 'base64').toString('utf8'),
    ) as Record<string, unknown>

    expect(Object.keys(decoded).sort()).toEqual(['accepted', 'payload', 'x402Version'])
    expect(decoded.x402Version).toBe(2)
  })

  it('consumes the x402 binding after signing a merchant header', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    await signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)
    await expect(signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)).rejects.toThrow(
      'funding binding',
    )
  })

  it('rejects a merchant mismatch before signing a header', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      merchantTo: '0x000000000000000000000000000000000000bEEF',
    }))
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toThrow('merchant recipient')
  })

  it('rejects an amount mismatch before signing a header', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      amount: '2000000',
    }))
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toThrow('amount')
  })

  it('rejects resource, asset, and network mismatches', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const resourceBinding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      resourceUrl: 'https://merchant.test/other',
    }))
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, resourceBinding.x402Binding),
    ).rejects.toThrow('resource')
    const assetBinding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      asset: '0x000000000000000000000000000000000000bEEF',
    }))
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, assetBinding.x402Binding),
    ).rejects.toThrow('asset')
    const networkBinding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      network: 'eip155:8453',
    }))
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, networkBinding.x402Binding),
    ).rejects.toThrow('network')
  })

  it('uses maxAmountRequired for the bound merchant header amount when present', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const paymentRequired = {
      ...PAYMENT_REQUIRED,
      accepts: [
        {
          ...PAYMENT_REQUIRED.accepts[0],
          amount: '1000000',
          maxAmountRequired: '1500000',
        },
      ],
    }
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      amount: '1500000',
    }))
    await expect(signer.buildX402PaymentHeader(paymentRequired, funding.x402Binding)).resolves.toEqual(
      expect.objectContaining({ paymentHeader: expect.any(String) }),
    )

    const mismatch = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    await expect(signer.buildX402PaymentHeader(paymentRequired, mismatch.x402Binding)).rejects.toThrow(
      'amount',
    )
  })

  it('wire-format regression: v2 payment_header decodes to spec-compliant {x402Version, accepted, payload}', async () => {
    // Use x402Version=2 to exercise the wrapped {x402Version, accepted, payload} format.
    const v2PaymentRequired = {
      ...PAYMENT_REQUIRED,
      x402Version: 2,
    }
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const delegateAddress = signer.delegateAddress

    // Wire the x402 expected context exactly as the hosted MCP would return it.
    const expected = await expectedX402()
    const funding = signer.signX402FundingHash(FUNDING_HASH, expected)
    const result = await signer.buildX402PaymentHeader(v2PaymentRequired, funding.x402Binding)

    // ── 1. The payment_header is a valid base64-JSON string ─────────────────
    let decoded: Record<string, unknown>
    expect(() => {
      decoded = JSON.parse(atob(result.paymentHeader))
    }).not.toThrow()
    decoded = JSON.parse(atob(result.paymentHeader))

    // ── 2. Top-level shape: { x402Version, accepted, payload } ──────────────
    const topLevelKeys = Object.keys(decoded).sort()
    expect(topLevelKeys).toEqual(['accepted', 'payload', 'x402Version'])

    // ── 3. x402Version matches the request ──────────────────────────────────
    expect(decoded.x402Version).toBe(2)

    // ── 4. payload has a signature ──────────────────────────────────────────
    const payload = decoded.payload as Record<string, unknown>
    expect(typeof payload.signature).toBe('string')
    expect((payload.signature as string)).toMatch(/^0x[0-9a-fA-F]+$/)

    // ── 5. Authorization.from is the delegate address (key-bound custody) ───
    const auth = payload.authorization as Record<string, unknown>
    expect(auth).toBeDefined()
    expect((auth.from as string).toLowerCase()).toBe(delegateAddress.toLowerCase())
  })
})
