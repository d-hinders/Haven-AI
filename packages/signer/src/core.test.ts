import { describe, it, expect } from 'vitest'
import { hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  AgentPaymentFailureCode,
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
  expiresAt: '2099-01-01T00:00:00.000Z',
}

async function expectedX402(overrides: Partial<typeof EXPECTED_X402_BASE> = {}) {
  const context = { ...EXPECTED_X402_BASE, ...overrides }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      // Derived exactly as the backend derives it (#1138) — a helper that
      // hardcoded v1 would mask the version check instead of exercising it.
      version: ((context as { typedDataHash?: string }).typedDataHash ? 2 : 1) as 1 | 2,
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
    // The single-use property itself is UNCHANGED by #2291 — only how the
    // refusal describes itself. The message moved from the generic
    // "funding binding is required" (which also covers an id the signer never
    // held) to one that says the binding was spent and names the remedy.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    await signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)
    await expect(signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)).rejects.toThrow(
      'already used',
    )
  })

  it('spends the binding on the v2 path too, not just v1 (#2291)', async () => {
    // Found by mutation while shipping #2291: this file's PAYMENT_REQUIRED is
    // x402Version 1, which exits through the early `if (x402Version < 2)`
    // return. The v2 `finally` — the branch production actually takes — had no
    // single-use coverage in this package at all; deleting it left every
    // signer test green and was caught only by a cross-package integration
    // test. Coverage of a security-relevant property should not depend on
    // another package's suite, so the v2 branch is pinned here too.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const v2Required = { ...PAYMENT_REQUIRED, x402Version: 2 }
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402())
    await signer.buildX402PaymentHeader(v2Required, funding.x402Binding)
    await expect(
      signer.buildX402PaymentHeader(v2Required, funding.x402Binding),
    ).rejects.toThrow('already used')
  })

  it('reports an id it never held as unknown, not as re-use (#2291)', async () => {
    // The two refusals need opposite remedies, so a signer that cannot tell
    // them apart sends the caller to the wrong one — the #2291 report.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow('funding binding is required')
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

  it('rejects an expired x402 payment window before signing a merchant header', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = signer.signX402FundingHash(FUNDING_HASH, await expectedX402({
      expiresAt: '2000-01-01T00:00:00.000Z',
    }))

    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toMatchObject({
      code: AgentPaymentFailureCode.PaymentWindowExpired,
      statusCode: 410,
      paymentId: 'pay_x402',
    })
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

/**
 * #1138 — delegation-rail typed-data signing.
 *
 * The property under test is narrow and load-bearing: the *Haven-signed
 * context* decides which payload may be signed, so neither a caller nor a
 * tampered response can pick the weaker path. On this rail `payloadHash` is the
 * bare ERC-4337 hash, which the account does NOT validate — raw-signing it
 * would be a signature the chain rejects, and signing typed data with no
 * commitment to it would be the edge signer endorsing bytes it cannot check.
 */
describe('signX402FundingTypedData (#1138)', () => {
  // A minimally realistic account UserOp payload — shape matters (viem hashes
  // it), the values do not.
  const TYPED_DATA = {
    domain: {
      chainId: 84532,
      name: 'HybridDeleGator',
      version: '1',
      verifyingContract: '0x98ffBf30459a98FD80fAce18f519967769641F76' as const,
    },
    types: {
      PackedUserOperation: [
        { name: 'sender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'callData', type: 'bytes' },
      ],
    },
    primaryType: 'PackedUserOperation',
    message: {
      sender: '0x98ffBf30459a98FD80fAce18f519967769641F76',
      nonce: '1',
      callData: '0xdeadbeef',
    },
  }

  const digest = () => hashTypedData(TYPED_DATA as Parameters<typeof hashTypedData>[0])

  async function expectedV2(overrides: Record<string, unknown> = {}) {
    return expectedX402({ typedDataHash: digest(), ...overrides } as never)
  }

  it('signs the typed data verbatim, recoverable to the delegate key', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const result = await signer.signX402FundingTypedData(TYPED_DATA as never, await expectedV2())
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/i)
    expect(result.x402Binding).toBeTruthy()
    const recovered = await recoverTypedDataAddress({
      ...(TYPED_DATA as unknown as Parameters<typeof recoverTypedDataAddress>[0]),
      signature: result.signature as `0x${string}`,
    })
    // Verbatim (#829): recovery only succeeds against the exact structure sent.
    expect(recovered.toLowerCase()).toBe(addressFromKey(TEST_KEY).toLowerCase())
  })

  it('refuses typed data whose digest is not the one Haven committed to', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedV2()
    // The exact attack the commitment exists to stop: a benign, correctly-bound
    // context arrives alongside typed data that moves something else.
    const swapped = {
      ...TYPED_DATA,
      message: { ...TYPED_DATA.message, callData: '0xc0ffee' },
    }
    await expect(signer.signX402FundingTypedData(swapped as never, expected)).rejects.toThrow(
      /does not match the digest Haven committed to/,
    )
  })

  it('refuses to sign typed data under a v1 context that never committed to it', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const v1 = await expectedX402() // no typedDataHash → v1
    await expect(signer.signX402FundingTypedData(TYPED_DATA as never, v1)).rejects.toThrow(
      /does not commit to it/,
    )
  })

  it('refuses to RAW-sign the bare hash of a v2 (delegation-rail) intent', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedV2()
    // The other direction of the downgrade: the account would reject this
    // signature on-chain, after the intent is already claimed.
    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected)).toThrow(
      /must not be\s+raw-signed/,
    )
  })

  it('refuses a v2 context whose announced auth.version was tampered to 1', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedV2()
    const tampered = { ...expected, auth: { ...expected.auth, version: 1 as const } }
    await expect(signer.signX402FundingTypedData(TYPED_DATA as never, tampered)).rejects.toThrow(
      /authentication message is invalid/,
    )
  })

  it('still refuses when the binding signer is not the trusted Haven key', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: addressFromKey(TEST_KEY) })
    await expect(
      signer.signX402FundingTypedData(TYPED_DATA as never, await expectedV2()),
    ).rejects.toThrow(HavenSigningError)
  })
})

/**
 * #1455 review: `signX402FundingTypedData` had no `Delegation`-shaped case at
 * all, which is exactly why a wiring bug survived — the unit tests in
 * settlement-child.test.ts supply their own expectation and never exercise the
 * derivation this call site performs. These run the production path.
 */
describe('signX402FundingTypedData with a settlement child (#1455)', () => {
  const CHILD = JSON.parse(
    JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')),
  )
  const childDigest = () => hashTypedData(CHILD as Parameters<typeof hashTypedData>[0])

  // The fixture's own values, so a pass means agreement rather than luck.
  const CHILD_EXPECTED = {
    merchantTo: '0x3333333333333333333333333333333333333333',
    amount: '1000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    network: 'eip155:84532',
  }

  it('refuses a child whose chain disagrees with the SIGNED network', async () => {
    // THE bug this suite was missing. The child is built for 84532; the signed
    // context says Base. Deriving the expectation from the payload made these
    // agree by construction, so the check could never fire.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedX402({
      ...CHILD_EXPECTED,
      network: 'eip155:8453',
      typedDataHash: childDigest(),
      expiresAt: '2099-01-01T00:00:00.000Z',
    } as never)
    await expect(signer.signX402FundingTypedData(CHILD as never, expected)).rejects.toThrow(
      /scoped to the wrong chain/,
    )
  })

  it('refuses a child paying an address the signed context does not name', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedX402({
      ...CHILD_EXPECTED,
      merchantTo: '0x9999999999999999999999999999999999999999',
      typedDataHash: childDigest(),
      expiresAt: '2099-01-01T00:00:00.000Z',
    } as never)
    await expect(signer.signX402FundingTypedData(CHILD as never, expected)).rejects.toThrow(
      /pays a different address/,
    )
  })

  it('still refuses on the digest commitment before it ever looks at caveats', async () => {
    // Ordering matters: a child that disagrees with the DECLARED bytes is not
    // a caveat problem, and saying so keeps the two failures distinguishable.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedX402({
      ...CHILD_EXPECTED,
      typedDataHash: `0x${'11'.repeat(32)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    } as never)
    await expect(signer.signX402FundingTypedData(CHILD as never, expected)).rejects.toThrow(
      /does not match the digest Haven committed to/,
    )
  })

  it('names the mapping gap when it cannot map the signed network', async () => {
    // Distinct from a chain mismatch on purpose (#1455 second review): folding
    // this into the comparison reported "expected chain -1" and sent a reader
    // after a phantom mismatch rather than the signer's own gap.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const CHILD2 = JSON.parse(
      JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')),
    )
    const expected = await expectedX402({
      merchantTo: '0x3333333333333333333333333333333333333333',
      amount: '1000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'solana',
      typedDataHash: hashTypedData(CHILD2 as Parameters<typeof hashTypedData>[0]),
      expiresAt: '2099-01-01T00:00:00.000Z',
    } as never)
    await expect(signer.signX402FundingTypedData(CHILD2 as never, expected)).rejects.toThrow(
      /cannot map the network 'solana'/,
    )
  })
})
