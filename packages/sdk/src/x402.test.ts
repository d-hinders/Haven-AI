import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import {
  encodePaymentProof,
  parsePaymentRequired,
  parsePaymentRequiredResponse,
} from './x402.js'
import type { X402PaymentRequired, X402PaymentOption } from './types.js'

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://mcp.soundside.ai/mcp',
    description: 'create_image via luma - $0.02 USDC',
    mimeType: 'application/json',
  },
  accepts: [accepted],
}

function decodeHeader(header: string): unknown {
  return JSON.parse(atob(header))
}

describe('x402 helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses base64 PAYMENT-REQUIRED headers synchronously', () => {
    const response = new Response(null, {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': btoa(JSON.stringify(paymentRequired)),
      },
    })

    expect(parsePaymentRequired(response)).toEqual(paymentRequired)
  })

  it('parses Soundside-style JSON 402 bodies asynchronously', async () => {
    const response = new Response(JSON.stringify(paymentRequired), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    })

    await expect(parsePaymentRequiredResponse(response)).resolves.toEqual(paymentRequired)
  })

  it('encodes a Haven tx-hash proof with the selected x402 option', () => {
    const header = encodePaymentProof({
      txHash: '0xabc',
      paymentId: 'pay_123',
      token: 'USDC',
      amount: '0.02',
      to: accepted.payTo,
      resourceUrl: paymentRequired.resource.url,
      accepted,
      payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chainId: 8453,
    })

    expect(decodeHeader(header)).toEqual({
      x402Version: 2,
      resource: { url: paymentRequired.resource.url },
      accepted,
      payload: {
        type: 'haven_tx_hash',
        txHash: '0xabc',
        paymentId: 'pay_123',
        settledVia: 'haven',
        payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        chainId: 8453,
      },
    })
  })

  it('retries paid fetches with a Haven tx-hash proof', async () => {
    const backendUrl = 'https://haven.example'
    const resourceUrl = paymentRequired.resource.url
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        token: 'USDC',
        amount: '0.02',
        to: accepted.payTo,
        resource_url: resourceUrl,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: '0x135a9215604711AC70d970e12Caa812c53537EF4',
            token: accepted.asset,
            to: accepted.payTo,
            amount: accepted.amount,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'confirmed',
        tx_hash: '0xabc',
        chain_id: 8453,
        token: 'USDC',
        amount: '0.02',
        to: accepted.payTo,
        explorer_url: 'https://basescan.org/tx/0xabc',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
      x402Wallet: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    })

    const response = await haven.fetch(resourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    const retryInit = fetchMock.mock.calls[3][1] as RequestInit
    const retryHeaders = new Headers(retryInit.headers)
    const proof = decodeHeader(retryHeaders.get('PAYMENT-SIGNATURE') ?? '')

    expect(retryHeaders.get('x402-wallet')).toBe('0x135a9215604711AC70d970e12Caa812c53537EF4')
    expect(proof).toMatchObject({
      x402Version: 2,
      resource: { url: resourceUrl },
      accepted,
      payload: {
        type: 'haven_tx_hash',
        txHash: '0xabc',
        paymentId: 'pay_123',
        settledVia: 'haven',
        payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        chainId: 8453,
      },
    })
  })
})
