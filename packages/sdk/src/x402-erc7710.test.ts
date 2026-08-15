/**
 * #1454 — the SDK's erc7710 direct-settlement path.
 *
 * The backend already refuses every wrong request shape
 * (`modules/x402/scheme-selection.ts`). These tests assert something stricter:
 * that the SDK never CONSTRUCTS those shapes, so the refusal is a backstop
 * rather than the thing that saves us. A client that only fails at the backend
 * is a client that would have sent the wrong thing to a different backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'
import { HavenClient } from './client.js'
import { HavenApiError } from './types.js'
import type { X402PaymentRequired, X402PaymentOption } from './types.js'
import SETTLEMENT_PAYLOAD from './__fixtures__/settlement-delegation-payload.json' with { type: 'json' }

const DELEGATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const DELEGATE = new ethers.Wallet(DELEGATE_KEY).address
const MERCHANT = '0x3333333333333333333333333333333333333333'
const FACILITATOR = '0x4444444444444444444444444444444444444444'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function option(over: Partial<X402PaymentOption> = {}): X402PaymentOption {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: USDC,
    amount: '20000',
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
    ...over,
  }
}

const erc7710Option = (over: Partial<X402PaymentOption> = {}) =>
  option({ extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] }, ...over })

function paymentRequired(accepts: X402PaymentOption[]): X402PaymentRequired {
  return {
    x402Version: 1,
    accepts,
    resource: { url: 'https://merchant.example/paid' },
  } as unknown as X402PaymentRequired
}

/** Records every outbound POST so the tests can assert the request SHAPE. */
function harness(opts: { rail?: 'delegation' | 'legacy'; scheme?: string } = {}) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const client = new HavenClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'sk_test',
    delegateKey: DELEGATE_KEY,
  })

  vi.spyOn(client as never, 'getAgent').mockResolvedValue({
    id: 'agent-1',
    name: 'A',
    status: 'active',
    safeAddress: '0x1111111111111111111111111111111111111111',
    delegateAddress: DELEGATE,
    chainId: 8453,
    executionRail: opts.rail ?? 'delegation',
  } as never)

  vi.spyOn(client as never, 'post').mockImplementation((async (...args: unknown[]) => {
    const path = args[0] as string
    const body = args[1] as Record<string, unknown>
    posts.push({ path, body })
    if (path === '/x402') {
      return {
        payment_id: 'pay_1',
        status: 'awaiting_signature',
        sign_data: {
          hash: '0x' + '11'.repeat(32),
          signature_scheme: opts.scheme ?? 'eip712_delegation',
          typed_data: opts.scheme === 'none' ? undefined : SETTLEMENT_PAYLOAD,
        },
      }
    }
    if (path.endsWith('/settle')) return { payment_header: 'eyJ4NDAyVmVyc2lvbiI6Mn0=' }
    return {}
  }) as never)

  return { client, posts }
}

describe('settleX402Erc7710 (#1454)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('completes authorize -> sign -> settle and returns the merchant header', async () => {
    const { client, posts } = harness()
    const result = await client.settleX402Erc7710(paymentRequired([erc7710Option()]))

    expect(result.paymentHeader).toBe('eyJ4NDAyVmVyc2lvbiI6Mn0=')
    expect(result.paymentId).toBe('pay_1')
    expect(result.merchantPayTo).toBe(MERCHANT)
    expect(result.facilitatorAddresses).toEqual([FACILITATOR])
    expect(posts.map((p) => p.path)).toEqual(['/x402', '/x402/pay_1/settle'])
  })

  describe('request shapes the backend would refuse are never constructed', () => {
    it('payTo is the MERCHANT, never the delegate EOA', async () => {
      // The shape IS the scheme selector server-side. payTo = the delegate EOA
      // with settlementScheme erc7710 is a 400 — and worse, getting this
      // backwards is how a payment silently takes the funding-leg path.
      const { client, posts } = harness()
      await client.settleX402Erc7710(paymentRequired([erc7710Option()]))

      const authorize = posts[0].body
      expect(authorize.payTo).toBe(MERCHANT)
      expect(authorize.payTo).not.toBe(DELEGATE)
      expect(authorize.settlementScheme).toBe('erc7710')
      // merchantPayTo belongs to the 3009 funding shape only; sending it here
      // is the shape disagreement the backend 400s on.
      expect(authorize).not.toHaveProperty('merchantPayTo')
    })

    it('OMITS facilitatorAddresses when the merchant advertises none', async () => {
      // Not `[]`: the backend 400s on an empty redeemer list, so an empty pin
      // is an unbuildable delegation rather than a narrower one.
      const { client, posts } = harness()
      await client.settleX402Erc7710(
        paymentRequired([erc7710Option({ extra: { assetTransferMethod: 'erc7710' } })]),
      )
      expect(posts[0].body).not.toHaveProperty('facilitatorAddresses')
    })

    it('OMITS facilitatorAddresses when the merchant advertises an EMPTY array', async () => {
      const { client, posts } = harness()
      await client.settleX402Erc7710(
        paymentRequired([
          erc7710Option({ extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [] } }),
        ]),
      )
      expect(posts[0].body).not.toHaveProperty('facilitatorAddresses')
    })

    it("round-trips the merchant's maxTimeoutSeconds rather than a default", async () => {
      // The v2 header echoes the accepted entry field-for-field; a substituted
      // timeout makes the merchant reject the echo (#1064).
      const { client, posts } = harness()
      await client.settleX402Erc7710(paymentRequired([erc7710Option({ maxTimeoutSeconds: 120 })]))
      expect(posts[0].body.maxTimeoutSeconds).toBe(120)
    })

    it('never posts anything when the account is on the legacy rail', async () => {
      const { client, posts } = harness({ rail: 'legacy' })
      await expect(
        client.settleX402Erc7710(paymentRequired([erc7710Option()])),
      ).rejects.toThrow(/delegation-rail account/)
      expect(posts).toEqual([])
    })
  })

  describe('refuses loudly instead of rerouting', () => {
    it('names the missing erc7710 entry on a delegation-rail account', async () => {
      const { client, posts } = harness()
      await expect(client.settleX402Erc7710(paymentRequired([option()]))).rejects.toThrow(
        /does not advertise an erc7710 settlement option/,
      )
      // The remedy is named, and nothing was attempted on the other scheme.
      await expect(client.settleX402Erc7710(paymentRequired([option()]))).rejects.toThrow(
        /authorizeX402\(\) for the standard EIP-3009 path/,
      )
      expect(posts).toEqual([])
    })

    it('names the rail, not the merchant, when the account is wrong', async () => {
      // Different halves of the condition have different remedies: an account
      // cannot be changed per payment, a resource might advertise erc7710.
      const { client } = harness({ rail: 'legacy' })
      await expect(
        client.settleX402Erc7710(paymentRequired([erc7710Option()])),
      ).rejects.toThrow(/requires a delegation-rail account/)
    })

    it('refuses to sign when authorize returns a different scheme', async () => {
      // Signing whatever came back is exactly the silent reroute this path
      // exists to make impossible.
      const { client, posts } = harness({ scheme: 'eip712_userop' })
      await expect(
        client.settleX402Erc7710(paymentRequired([erc7710Option()])),
      ).rejects.toThrow(/did not return an erc7710 settlement child/)
      // Authorize happened; settle did NOT.
      expect(posts.map((p) => p.path)).toEqual(['/x402'])
    })

    it('refuses when settle returns no payment_header', async () => {
      const { client } = harness()
      vi.spyOn(client as never, 'post').mockImplementation((async (...args: unknown[]) =>
        args[0] === '/x402'
          ? {
              payment_id: 'pay_1',
              sign_data: {
                hash: '0x' + '11'.repeat(32),
                signature_scheme: 'eip712_delegation',
                typed_data: SETTLEMENT_PAYLOAD,
              },
            }
          : {}) as never)
      await expect(
        client.settleX402Erc7710(paymentRequired([erc7710Option()])),
      ).rejects.toThrow(/no payment_header/)
    })

    it('throws a typed HavenApiError, not a bare Error', async () => {
      const { client } = harness({ rail: 'legacy' })
      await expect(
        client.settleX402Erc7710(paymentRequired([erc7710Option()])),
      ).rejects.toBeInstanceOf(HavenApiError)
    })
  })

  it('signs the child that authorize returned, recovering to the delegate', async () => {
    // The signature is the authority. Prove it is over the backend's payload.
    const { client, posts } = harness()
    await client.settleX402Erc7710(paymentRequired([erc7710Option()]))

    const signature = posts[1].body.signature as string
    const types = { ...(SETTLEMENT_PAYLOAD.types as Record<string, unknown>) }
    delete types.EIP712Domain
    expect(
      ethers
        .verifyTypedData(
          SETTLEMENT_PAYLOAD.domain as never,
          types as never,
          SETTLEMENT_PAYLOAD.message as never,
          signature,
        )
        .toLowerCase(),
    ).toBe(DELEGATE.toLowerCase())
  })
})
