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
import { createEdgeSigner, type EdgeSigner, type X402ExpectedPayment } from './core.js'

// Well-known test key (Hardhat account #0). Never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address

// #3272 (criterion 8): every x402 funding intent is delegation-rail typed
// data now — v1's bare `FUNDING_HASH` is retired along with
// `signX402FundingHash`. This fixture's SHAPE does not matter (it is never a
// direct-payment UserOp; the funding leg's shape checks live in
// `signX402FundingTypedData`'s settlement-child branch, exercised below with
// a real Delegation fixture) — only that its digest is what `expectedX402`'s
// `typedDataHash` commits to.
const FUNDING_TYPED_DATA = {
  domain: {
    chainId: 84532,
    name: 'HavenX402Funding',
    version: '1',
    verifyingContract: '0x98ffBf30459a98FD80fAce18f519967769641F76' as const,
  },
  types: { Funding: [{ name: 'note', type: 'string' }] },
  primaryType: 'Funding',
  message: { note: 'x402 funding leg (#3272 test fixture)' },
}
const FUNDING_DIGEST = hashTypedData(FUNDING_TYPED_DATA as Parameters<typeof hashTypedData>[0])

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
  payloadHash: `0x${'cd'.repeat(32)}`,
  resourceUrl: PAYMENT_REQUIRED.resource.url,
  merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
  amount: PAYMENT_REQUIRED.accepts[0].amount,
  asset: PAYMENT_REQUIRED.accepts[0].asset,
  network: PAYMENT_REQUIRED.accepts[0].network,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

/**
 * Builds an x402 expected context. `typedDataHash` defaults to the funding
 * fixture's digest (a v2 context, #3272: v1 no longer exists to default to).
 * Pass `typedDataHash: undefined` explicitly to build a retired v1 context
 * for the version-refusal tests.
 */
async function expectedX402(
  overrides: Partial<typeof EXPECTED_X402_BASE> & { typedDataHash?: string; payerDelegate?: string; payerAgentId?: string } = {},
) {
  const context = {
    ...EXPECTED_X402_BASE,
    typedDataHash: FUNDING_DIGEST,
    ...overrides,
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      // Derived exactly as the backend derives it (#1138/#1690).
      version: (context.payerDelegate ? 3 : context.typedDataHash ? 2 : 1) as 1 | 2 | 3,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

/** Signs the funding leg with the shared fixture typed data — the v2/v3 path, the only one left. */
async function fundV2(
  signer: EdgeSigner,
  overrides: Partial<typeof EXPECTED_X402_BASE> = {},
) {
  const expected = await expectedX402(overrides)
  return signer.signX402FundingTypedData(FUNDING_TYPED_DATA as never, expected as unknown as X402ExpectedPayment)
}

describe('createEdgeSigner', () => {
  it('derives the delegate address from the key', () => {
    const signer = createEdgeSigner(TEST_KEY)
    expect(signer.delegateAddress.toLowerCase()).toBe(addressFromKey(TEST_KEY).toLowerCase())
  })

  it('throws on an invalid key', () => {
    expect(() => createEdgeSigner('not-a-key')).toThrow(HavenSigningError)
  })

  it('#3169/#3272: exposes NO raw-hash signing primitive — a bare hash is never signable', () => {
    const signer = createEdgeSigner(TEST_KEY)
    // Inverted pin: the AllowanceModule-era `signPaymentHash(hash)` is gone,
    // and #3272 (criterion 8) retired its x402 v1 successor
    // `signX402FundingHash` too. The x402 and sweep methods verify a Haven
    // binding before they sign; `signDelegationTypedData` is a verbatim
    // primitive, and the #3272 allowlist that gates it lives in tools.ts.
    expect('signPaymentHash' in signer).toBe(false)
    expect('signX402FundingHash' in signer).toBe(false)
    expect(Object.keys(signer).sort()).toEqual([
      'buildX402PaymentHeader', 'delegateAddress', 'signDelegationTypedData', 'signSweepAuthorization',
      'signX402FundingTypedData',
    ].sort())
  })
})

describe('buildX402PaymentHeader', () => {
  it('builds a merchant header for a Base USDC option', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
    const result = await signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding)
    expect(typeof result.paymentHeader).toBe('string')
    expect(result.paymentHeader.length).toBeGreaterThan(0)
    expect(result.accepted.asset.toLowerCase()).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    )
  })

  it('rejects unsupported payment options', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
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

  // ── #3116: the signer boundary refuses unsupported methods/flows ─────────
  // `buildX402PaymentHeader` selects through `selectStandardPaymentOption`
  // and signs with `exact.evm.createPaymentHeader` — an EIP-3009
  // `authorization` payload by construction. A permit2 entry, or one naming
  // a paymentFlow this SDK does not recognize, must be refused HERE, before
  // this process's delegate key produces any signature. The positive control
  // pins the supported pair (explicit `eip3009` + `authorization`) as
  // byte-for-byte signable — skipping must never widen into refusing it.
  it('skips a permit2 entry listed first and signs the supported one behind it (#3116)', async () => {
    // The binding (expectedX402) is computed from the SUPPORTED entry, so a
    // successful header here proves the signer selected the second option —
    // the permit2 one did not reach the signature.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
    const result = await signer.buildX402PaymentHeader({
      x402Version: 1,
      resource: { url: 'https://merchant.test/paid' },
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          amount: '1000000',
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          payTo: PAYMENT_REQUIRED.accepts[0].payTo,
          maxTimeoutSeconds: 60,
          extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
        },
        { ...PAYMENT_REQUIRED.accepts[0] },
      ],
    }, funding.x402Binding)
    // `accepted` echoes the option actually paid — it must be the PLAIN one,
    // with no permit2 tag leaked into the wire shape.
    expect(result.accepted.extra?.assetTransferMethod).toBeUndefined()
  })

  it('refuses a permit2-ONLY challenge before any signature (#3116)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
    await expect(
      signer.buildX402PaymentHeader({
        x402Version: 1,
        resource: { url: 'https://merchant.test/paid' },
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            amount: '1000000',
            asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            payTo: PAYMENT_REQUIRED.accepts[0].payTo,
            maxTimeoutSeconds: 60,
            extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
          },
        ],
      }, funding.x402Binding),
    ).rejects.toThrow('No compatible payment option')
  })

  it('refuses an unrecognized paymentFlow on every entry (#3116)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
    await expect(
      signer.buildX402PaymentHeader({
        x402Version: 1,
        resource: { url: 'https://merchant.test/paid' },
        accepts: [
          {
            ...PAYMENT_REQUIRED.accepts[0],
            extra: { name: 'USD Coin', version: '2', paymentFlow: 'unrecognized-future-flow' },
          },
        ],
      }, funding.x402Binding),
    ).rejects.toThrow('No compatible payment option')
  })

  it('still signs an explicitly-supported eip3009/authorization entry (#3116 positive control)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
    const result = await signer.buildX402PaymentHeader({
      x402Version: 1,
      resource: { url: 'https://merchant.test/paid' },
      accepts: [
        {
          ...PAYMENT_REQUIRED.accepts[0],
          extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009', paymentFlow: 'authorization' },
        },
      ],
    }, funding.x402Binding)
    expect(typeof result.paymentHeader).toBe('string')
    expect(result.paymentHeader.length).toBeGreaterThan(0)
  })

  it('requires a locally recorded x402 funding binding before header signing', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    await expect(signer.buildX402PaymentHeader(PAYMENT_REQUIRED, 'not-recorded')).rejects.toThrow(
      'funding binding',
    )
  })

  it('rejects unauthenticated or tampered expected contexts before signing the funding typed data', async () => {
    const expected = await expectedX402()
    const unconfigured = createEdgeSigner(TEST_KEY)
    await expect(
      unconfigured.signX402FundingTypedData(FUNDING_TYPED_DATA as never, expected as unknown as X402ExpectedPayment),
    ).rejects.toThrow('verifier is not configured')

    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    await expect(
      signer.signX402FundingTypedData(FUNDING_TYPED_DATA as never, {
        ...expected,
        amount: '2000000',
      } as unknown as X402ExpectedPayment),
    ).rejects.toThrow('authentication message')
    await expect(
      signer.signX402FundingTypedData(FUNDING_TYPED_DATA as never, {
        ...expected,
        typedDataHash: `0x${'ef'.repeat(32)}`,
      } as unknown as X402ExpectedPayment),
    ).rejects.toThrow('does not match the digest')
  })

  // ── v1 x402 PROTOCOL path coverage (#324) ─────────────────────────────────
  // The edge signer mirrors the SDK's v1/v2 split: v2+ headers are re-wrapped
  // as { x402Version, accepted, payload }, but v1 headers must pass the x402
  // library's output through UNCHANGED — v1 facilitators reject the wrap.
  // The PAYMENT_REQUIRED fixture above is x402Version 1 on purpose. This is
  // the x402 PROTOCOL version (the merchant header wire format) — unrelated
  // to, and unaffected by, #3272's retirement of Haven's OWN internal
  // expected-context v1 (the bare-hash binding format).

  it('passes v1 payment headers through unchanged (no accepted wrap)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
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
    const funding = await fundV2(signer)
    const result = await signer.buildX402PaymentHeader(
      { ...PAYMENT_REQUIRED, x402Version: 2 },
      funding.x402Binding,
    )

    const decoded = JSON.parse(
      Buffer.from(result.paymentHeader, 'base64').toString('utf8'),
    ) as Record<string, unknown>

    // #2361: the v2 envelope also echoes the challenge's `resource` verbatim
    // (this fixture carries one; it carries no `extensions`, so that key must
    // be ABSENT — omission is the pre-#2361 shape live merchants settled).
    expect(Object.keys(decoded).sort()).toEqual(['accepted', 'payload', 'resource', 'x402Version'])
    expect(decoded.x402Version).toBe(2)
    expect(decoded.resource).toEqual(PAYMENT_REQUIRED.resource)
    expect(decoded).not.toHaveProperty('extensions')
  })

  it('echoes the challenge extensions verbatim in the v2 envelope (#2361)', async () => {
    // Live-bisected on Base mainnet (#2360): a strict facilitator rejected
    // the echo-less envelope with a bare 400 and settled the identical
    // signature once `resource`/`extensions` were echoed. The echo must be
    // VERBATIM — nested content included — never reconstructed.
    const extensions = {
      bazaar: { info: { input: { method: 'GET' } } },
    }
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
    const result = await signer.buildX402PaymentHeader(
      { ...PAYMENT_REQUIRED, x402Version: 2, extensions },
      funding.x402Binding,
    )

    const decoded = JSON.parse(
      Buffer.from(result.paymentHeader, 'base64').toString('utf8'),
    ) as Record<string, unknown>

    expect(Object.keys(decoded).sort()).toEqual(
      ['accepted', 'extensions', 'payload', 'resource', 'x402Version'],
    )
    expect(decoded.extensions).toEqual(extensions)
    expect(decoded.resource).toEqual(PAYMENT_REQUIRED.resource)
  })

  it('consumes the x402 binding after signing a merchant header', async () => {
    // The single-use property itself is UNCHANGED by #2291 — only how the
    // refusal describes itself. The message moved from the generic
    // "funding binding is required" (which also covers an id the signer never
    // held) to one that says the binding was spent and names the remedy.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer)
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
    const funding = await fundV2(signer)
    await signer.buildX402PaymentHeader(v2Required, funding.x402Binding)
    await expect(
      signer.buildX402PaymentHeader(v2Required, funding.x402Binding),
    ).rejects.toThrow('already used')
  })

  it('a window-expired binding does not claim a header was built (#2291 review)', async () => {
    // Review finding: every retirement path shared one "already used" message,
    // so a client that naively retried after a PAYMENT_WINDOW_EXPIRED error was
    // told to "retry the merchant with THAT header" — when the window closed
    // BEFORE any header was built and no such header exists. A confident lie is
    // worse than the vague message it replaced.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    // First call: the window check retires the binding.
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toThrow(/window/i)
    // Second call with the same id: names what actually happened.
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toThrow('no header exists to retry with')
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
    const funding = await fundV2(signer, { merchantTo: '0x000000000000000000000000000000000000bEEF' })
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toThrow('merchant recipient')
  })

  it('rejects an amount mismatch before signing a header', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer, { amount: '2000000' })
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, funding.x402Binding),
    ).rejects.toThrow('amount')
  })

  it('rejects resource, asset, and network mismatches', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const resourceBinding = await fundV2(signer, { resourceUrl: 'https://merchant.test/other' })
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, resourceBinding.x402Binding),
    ).rejects.toThrow('resource')
    const assetBinding = await fundV2(signer, { asset: '0x000000000000000000000000000000000000bEEF' })
    await expect(
      signer.buildX402PaymentHeader(PAYMENT_REQUIRED, assetBinding.x402Binding),
    ).rejects.toThrow('asset')
    const networkBinding = await fundV2(signer, { network: 'eip155:8453' })
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
    const funding = await fundV2(signer, { amount: '1500000' })
    await expect(signer.buildX402PaymentHeader(paymentRequired, funding.x402Binding)).resolves.toEqual(
      expect.objectContaining({ paymentHeader: expect.any(String) }),
    )

    const mismatch = await fundV2(signer)
    await expect(signer.buildX402PaymentHeader(paymentRequired, mismatch.x402Binding)).rejects.toThrow(
      'amount',
    )
  })

  it('rejects an expired x402 payment window before signing a merchant header', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const funding = await fundV2(signer, { expiresAt: '2000-01-01T00:00:00.000Z' })

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
    const funding = await fundV2(signer)
    const result = await signer.buildX402PaymentHeader(v2PaymentRequired, funding.x402Binding)

    // ── 1. The payment_header is a valid base64-JSON string ─────────────────
    let decoded: Record<string, unknown>
    expect(() => {
      decoded = JSON.parse(atob(result.paymentHeader))
    }).not.toThrow()
    decoded = JSON.parse(atob(result.paymentHeader))

    // ── 2. Top-level shape: { x402Version, resource, accepted, payload } ────
    // (#2361: `resource` is the challenge echo; `extensions` would join it
    // when the challenge advertises one — this fixture does not.)
    const topLevelKeys = Object.keys(decoded).sort()
    expect(topLevelKeys).toEqual(['accepted', 'payload', 'resource', 'x402Version'])

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
 * #1138 — delegation-rail typed-data signing. #3272 (criterion 8) retired the
 * v1 bare-hash rail this describe block used to contrast against — every
 * intent is v2/v3 typed data now, so what remains is: the digest commitment
 * is real (criterion 4), and a v1 context is refused as an unsupported
 * version rather than silently accepted.
 */
describe('signX402FundingTypedData (#1138, #3272)', () => {
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

  it('#3272 criterion 8: refuses a RETIRED v1 context (no typedDataHash) with the structured version-mismatch refusal, whether or not typed data is supplied', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const v1 = await expectedX402({ typedDataHash: undefined } as never)
    // With typed data supplied — must not reach the digest check.
    await expect(signer.signX402FundingTypedData(TYPED_DATA as never, v1)).rejects.toMatchObject({
      code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION',
    })
    // With NO typed data supplied either — the version check must fire before
    // the "typed data required" presence check, not after.
    await expect(signer.signX402FundingTypedData(undefined, v1)).rejects.toMatchObject({
      code: 'UNSUPPORTED_EXPECTED_CONTEXT_VERSION',
    })
  })

  it('refuses when typed data is required but not supplied, for a supported (v2) context', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    await expect(signer.signX402FundingTypedData(undefined, await expectedV2())).rejects.toThrow(
      /which was not supplied/,
    )
  })

  it('refuses a v2 context whose announced auth.version was tampered to 3 (a version this signer supports, but not the one this content encodes)', async () => {
    // #3272: tampering to 1 (the historical version of this test) now hits
    // the EARLIER, stronger version-skew check first, since 1 is no longer
    // supported at all — that is covered by the criterion-8 test above.
    // Tampering to another SUPPORTED version instead still proves the
    // property this test is for: the message is content-derived, so a
    // tampered `auth.version` cannot select a different rule than the signed
    // message encodes.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedV2()
    const tampered = { ...expected, auth: { ...expected.auth, version: 3 as const } }
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
