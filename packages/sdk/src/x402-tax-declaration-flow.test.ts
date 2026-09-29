import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { MerchantCompletion } from './merchant-completion.js'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import { addressFromKey } from './edge-signing.js'
import { encodeBase64Json } from './base64.js'
import { verifyTaxDeclarationSignature } from './tax-declaration.js'
import { X_TAX_DECLARATION_HEADER } from './client-tax-declaration.js'
import { buildFundingLegSignData } from './__fixtures__/valid-userop.js'
import type { X402PaymentOption, X402PaymentRequired, X402Receipt } from './types.js'

/**
 * #3427 flow tests: the PAID retry on the EIP-3009 path carries
 * `X-Tax-Declaration`, its decoded signature recovers to the delegate EOA,
 * and the header is ABSENT in every case that must not carry it (erc7710
 * payment, first unpaid request, "not available", 404 older backend) and
 * NEVER appears in any request to Haven's API or in the payment payload.
 */

const DELEGATE_KEY = `0x${'01'.repeat(32)}`
const DELEGATE_ADDRESS = addressFromKey(DELEGATE_KEY)
const TX_HASH = `0x${'ab'.repeat(32)}`
const HAVEN_BASE = 'https://haven.example'
const MERCHANT_URL = 'https://api.merchant.example/paid'

const eip3009Accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const erc7710Accepted: X402PaymentOption = {
  ...eip3009Accepted,
  extra: { assetTransferMethod: 'erc7710' },
}

const declaration = {
  version: 'x402-tax-1',
  jurisdiction: 'DE',
  taxableStatus: 'TAXABLE_PERSON',
  taxId: 'DE123456789',
  validUntil: 1790912400000,
}

function paymentRequiredFor(accepted: X402PaymentOption): X402PaymentRequired {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: MERCHANT_URL, description: 'paid resource', mimeType: 'application/json' },
    accepts: [accepted],
  }
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/**
 * Install a route-table fetch stub. The merchant answers its FIRST call with
 * the 402 challenge (the unpaid probe every x402 flow starts with) and every
 * later call with the paid 200. Haven-API paths answer from the route table;
 * an unlisted path 404s (the older-backend shape the content-endpoint tests
 * rely on). Returns every call for the census assertions.
 */
function stubWire(
  haven: Record<string, unknown>,
  // resumeX402Payment makes no unpaid probe — its first merchant call IS the
  // paid retry, so the 402-then-200 sequence must be skipped for it.
  opts: { paidFromFirstMerchantCall?: boolean } = {},
): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let merchantCalls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.startsWith(HAVEN_BASE)) {
      const path = url.slice(HAVEN_BASE.length)
      if (Object.prototype.hasOwnProperty.call(haven, path)) {
        return new Response(JSON.stringify(haven[path]), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    merchantCalls += 1
    const isProbe = merchantCalls === 1 && !opts.paidFromFirstMerchantCall
    if (isProbe) {
      return new Response(JSON.stringify(paymentRequiredFor(eip3009Accepted)), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { calls }
}

function fundingStubs(
  signData = buildFundingLegSignData({
    asset: eip3009Accepted.asset,
    amount: eip3009Accepted.amount,
    delegateKey: DELEGATE_KEY,
  }),
): Record<string, unknown> {
  return {
    '/x402': {
      payment_id: 'pay_3427',
      status: 'pending_signature',
      expires_at: 'later',
      chain_id: 8453,
      account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      token: 'USDC',
      amount: '0.02',
      to: DELEGATE_ADDRESS,
      merchant_to: eip3009Accepted.payTo,
      resource_url: MERCHANT_URL,
      sign_data: {
        ...signData,
        components: {
          payer_account: '0x135a9215604711AC70d970e12Caa812c53537EF4',
          token: eip3009Accepted.asset,
          to: DELEGATE_ADDRESS,
          amount: eip3009Accepted.amount,
        },
        instructions: 'sign then POST /payments/pay_3427/sign',
      },
    },
    '/payments/pay_3427/sign': {
      payment_id: 'pay_3427',
      status: 'confirmed',
      tx_hash: TX_HASH,
      chain_id: 8453,
      token: 'USDC',
      amount: '0.02',
      to: DELEGATE_ADDRESS,
    },
    '/machine-payments/agent': {
      id: 'agent_3427',
      name: 'tax agent',
      status: 'active',
      account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      delegate_address: DELEGATE_ADDRESS,
      chain_id: 8453,
      execution_rail: 'delegation',
    },
  }
}

function taxIdFromBody(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    return typeof parsed.taxId === 'string' ? parsed.taxId : undefined
  } catch {
    return undefined
  }
}

function decodeHeader(init: RequestInit | undefined): Record<string, unknown> | undefined {
  const header = new Headers(init?.headers).get(X_TAX_DECLARATION_HEADER)
  if (!header) return undefined
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>
}

function newClient(): HavenClient {
  return new HavenClient({ apiKey: 'sk_agent_test', delegateKey: DELEGATE_KEY, baseUrl: HAVEN_BASE })
}

const merchantCallsOf = (calls: FetchCall[]): FetchCall[] => calls.filter((c) => !c.url.startsWith(HAVEN_BASE))
const havenCallsOf = (calls: FetchCall[]): FetchCall[] => calls.filter((c) => c.url.startsWith(HAVEN_BASE))

describe('x402 buyer tax declaration — paid-retry attach (#3427)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('haven.fetch on an EIP-3009 merchant with the declaration available: the paid retry carries the header and its signature recovers to the delegate EOA', async () => {
    const { calls } = stubWire({
      ...fundingStubs(),
      '/agents/agent_3427/tax-declaration': { available: true, declaration },
    })
    const response = await newClient().fetch(MERCHANT_URL, { method: 'GET' })
    expect(response.status).toBe(200)

    // Two merchant calls: the unpaid 402 probe and the paid retry.
    const merchantCalls = merchantCallsOf(calls)
    expect(merchantCalls).toHaveLength(2)
    const signed = decodeHeader(merchantCalls[1].init)
    expect(signed).toBeDefined()
    expect(signed?.taxId).toBe(declaration.taxId)
    expect(signed?.principalId).toBe(`did:pkh:eip155:8453:${DELEGATE_ADDRESS}`)
    const { signature, principalId, principalAttributionHash, ...rest } = signed as never as Record<string, string>
    expect(
      verifyTaxDeclarationSignature(
        { ...rest, principalId, principalAttributionHash } as never,
        signature,
        DELEGATE_ADDRESS,
      ),
    ).toBe(true)
  })

  it('the header value never appears in any request to Haven or in the payment payload', async () => {
    const { calls } = stubWire({
      ...fundingStubs(),
      '/agents/agent_3427/tax-declaration': { available: true, declaration },
    })
    await newClient().fetch(MERCHANT_URL, { method: 'GET' })
    const havenCalls = havenCallsOf(calls)
    expect(havenCalls.length).toBeGreaterThan(0)
    // Census: no Haven request carries the header ...
    for (const call of havenCalls) {
      expect(new Headers(call.init?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
    }
    // ... and no Haven body carries its JSON either.
    for (const call of havenCalls) {
      const bodyText = typeof call.init?.body === 'string' ? call.init.body : undefined
      expect(taxIdFromBody(bodyText)).toBeUndefined()
    }
    // The payment payload (the /x402 authorize body) names no declaration field.
    const authorizeBody = JSON.parse(
      calls.find((c) => c.url.endsWith('/x402'))?.init?.body as string,
    ) as Record<string, unknown>
    expect(JSON.stringify(authorizeBody)).not.toContain('x402-tax-1')
    expect(JSON.stringify(authorizeBody)).not.toContain('DE123456789')
  })

  it('the first (unpaid) request carries no declaration header', async () => {
    const { calls } = stubWire({
      ...fundingStubs(),
      '/agents/agent_3427/tax-declaration': { available: true, declaration },
    })
    await newClient().fetch(MERCHANT_URL, { method: 'GET' })
    const merchantCalls = merchantCallsOf(calls)
    expect(merchantCalls.length).toBe(2)
    // First merchant call = the unpaid 402 probe: no header.
    expect(new Headers(merchantCalls[0].init?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
    // Second = the paid retry: the header IS there (positive control).
    expect(new Headers(merchantCalls[1].init?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(true)
  })

  it('the endpoint answering "not available": paid retry proceeds without the header', async () => {
    const { calls } = stubWire({
      ...fundingStubs(),
      '/agents/agent_3427/tax-declaration': { available: false, reason: 'disabled' },
    })
    const response = await newClient().fetch(MERCHANT_URL, { method: 'GET' })
    expect(response.status).toBe(200)
    const merchantCalls = merchantCallsOf(calls)
    expect(merchantCalls).toHaveLength(2)
    expect(new Headers(merchantCalls[1].init?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
  })

  it('a 404 from the content endpoint (older backend): paid retry proceeds without the header', async () => {
    const { calls } = stubWire(fundingStubs()) // no tax-declaration route → the stub 404s
    const response = await newClient().fetch(MERCHANT_URL, { method: 'GET' })
    expect(response.status).toBe(200)
    const merchantCalls = merchantCallsOf(calls)
    expect(merchantCalls).toHaveLength(2)
    expect(new Headers(merchantCalls[1].init?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
  })

  it('payX402Quote on the same stubbed merchant: the paid retry carries the header with a recovering signature', async () => {
    const { calls } = stubWire({
      ...fundingStubs(),
      '/agents/agent_3427/tax-declaration': { available: true, declaration },
    })
    const client = newClient()
    const quote = await client.quoteX402(MERCHANT_URL, { method: 'GET' }, { idempotencyKey: 'quote-3427' })
    await client.payX402Quote(quote)
    const merchantCalls = merchantCallsOf(calls)
    expect(merchantCalls.length).toBeGreaterThanOrEqual(2)
    const signed = decodeHeader(merchantCalls[merchantCalls.length - 1].init)
    expect(signed?.taxId).toBe(declaration.taxId)
    const { signature, principalId, principalAttributionHash, ...rest } = signed as never as Record<string, string>
    expect(
      verifyTaxDeclarationSignature(
        { ...rest, principalId, principalAttributionHash } as never,
        signature,
        DELEGATE_ADDRESS,
      ),
    ).toBe(true)
  })

  it('resumeX402Payment through the same seam: the paid retry carries the header', async () => {
    const { calls } = stubWire(
      {
        ...fundingStubs(),
        '/agents/agent_3427/tax-declaration': { available: true, declaration },
        '/machine-payments/pay_3427/status': {
          payment_id: 'pay_3427',
          kind: 'payment_intent',
          rail: 'x402',
          status: 'confirmed',
          phase: 'funding_sent',
          next_action: 'retry_original_x402_request',
          amount: '0.02',
          token: 'USDC',
          resource_url: MERCHANT_URL,
          merchant_address: eip3009Accepted.payTo,
          tx_hash: TX_HASH,
          expires_at: 'later',
          chain_id: 8453,
          message: 'ready to retry',
        },
      },
      { paidFromFirstMerchantCall: true },
    )
    await newClient().resumeX402Payment({
      paymentId: 'pay_3427',
      paymentRequired: paymentRequiredFor(eip3009Accepted),
      url: MERCHANT_URL,
      init: { method: 'GET' },
    })
    const merchantCalls = merchantCallsOf(calls)
    expect(merchantCalls.length).toBeGreaterThanOrEqual(1)
    const signed = decodeHeader(merchantCalls[merchantCalls.length - 1].init)
    expect(signed?.taxId).toBe(declaration.taxId)
  })
})

describe('retryRequest scheme split — EIP-3009 only (#3427)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function receiptFor(accepted: X402PaymentOption): X402Receipt {
    return {
      success: true,
      paymentId: 'pay_scheme',
      txHash: TX_HASH,
      token: 'USDC',
      amount: '0.02',
      to: DELEGATE_ADDRESS,
      resourceUrl: MERCHANT_URL,
      explorerUrl: '',
      accepted,
      // The header's own decode decides the scheme, exactly as the wire does.
      paymentHeader: encodeBase64Json({ x402Version: 2, accepted, payload: {} }),
    }
  }

  function completionWith(resolver: ReturnType<typeof vi.fn>): MerchantCompletion {
    const post = (async () => ({})) as unknown as <T>(path: string, body: Record<string, unknown>) => Promise<T>
    return new MerchantCompletion({
      post,
      merchantTransport: new McpMerchantTransport(),
      getPaymentStatus: (async () => {
        throw new Error('status must not be read by the scheme split')
      }) as never,
      getAgent: (async () => {
        throw new Error('agent must not be read by the scheme split')
      }) as never,
      delegateAddress: DELEGATE_ADDRESS,
      x402Wallet: undefined,
      getTaxDeclarationHeader: resolver as never,
      delegateKey: DELEGATE_KEY,
    })
  }

  it('an erc7710 payment: the resolver is never called and the delivered retry carries no header', async () => {
    const resolver = vi.fn(async () => ({ header: 'should-not-be-sent' }) as const)
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const completion = completionWith(resolver)
    await completion.retryRequest(
      MERCHANT_URL,
      { method: 'GET' },
      paymentRequiredFor(erc7710Accepted),
      receiptFor(erc7710Accepted),
    )
    expect(resolver).not.toHaveBeenCalled()
    const delivered = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(new Headers(delivered[1]?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
  })

  it('an EIP-3009 payment through the same seam: the resolver IS called and the header is attached', async () => {
    const resolver = vi.fn(async () => ({ header: 'tax-header-value' }) as const)
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const completion = completionWith(resolver)
    await completion.retryRequest(
      MERCHANT_URL,
      { method: 'GET' },
      paymentRequiredFor(eip3009Accepted),
      receiptFor(eip3009Accepted),
    )
    expect(resolver).toHaveBeenCalledTimes(1)
    const resolverArgs = resolver.mock.calls[0] as unknown as [{ accepted: X402PaymentOption; delegateKey: string }]
    expect(resolverArgs[0].accepted.network).toBe('eip155:8453')
    const delivered = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(new Headers(delivered[1]?.headers).get(X_TAX_DECLARATION_HEADER)).toBe('tax-header-value')
  })

  it('a hosted/keyless completion (no resolver, no key) never resolves — the hosted path is structurally header-free', async () => {
    const resolver = vi.fn(async () => ({ header: 'should-not-be-solved' }) as const)
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const completion = new MerchantCompletion({
      post: (async () => ({})) as unknown as <T>(path: string, body: Record<string, unknown>) => Promise<T>,
      merchantTransport: new McpMerchantTransport(),
      getPaymentStatus: (async () => {
        throw new Error('not read')
      }) as never,
      getAgent: (async () => {
        throw new Error('not read')
      }) as never,
      delegateAddress: DELEGATE_ADDRESS,
      x402Wallet: undefined,
      // Neither getTaxDeclarationHeader nor delegateKey — the hosted shape.
    })
    await completion.retryRequest(
      MERCHANT_URL,
      { method: 'GET' },
      paymentRequiredFor(eip3009Accepted),
      receiptFor(eip3009Accepted),
    )
    expect(resolver).not.toHaveBeenCalled()
    const delivered = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(new Headers(delivered[1]?.headers).has(X_TAX_DECLARATION_HEADER)).toBe(false)
  })
})
