/**
 * #4550: the qa-agent pilot's x402 buyer client must configure spend controls
 * EXPLICITLY.
 *
 * `@x402/*` 2.29 always applies spend controls when it selects a requirement.
 * With none configured, only assets the scheme client's `findDefaultAsset`
 * recognises are allowed — and `@metamask/x402`'s erc7710 client has no
 * `findDefaultAsset`, so EVERY 402 was rejected with "All payment requirements
 * were rejected by spendControls…" whatever the price. The `as never` cast on
 * the selector hid the drift.
 *
 * Nothing tested the pilot before this file.
 */
import { describe, expect, it } from 'vitest'
import { wrapFetchWithPayment } from '@x402/fetch'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { SchemeNetworkClient } from '@x402/core/types'
import { createPilotClient } from './x402-7710-buyer.js'

const NETWORK = 'eip155:84532' as const
// Base Sepolia USDC — the pilot's default chain.
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const PAY_TO = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
// 0.001 USDC, the pilot's VPN_BASIC_PRICE.
const PRICE = '1000'

const CANNED_402 = {
  x402Version: 2,
  resource: { url: 'https://merchant.test/mcp', description: 'canned 402' },
  accepts: [
    {
      scheme: 'exact',
      network: NETWORK,
      asset: USDC,
      amount: PRICE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'erc7710' },
    },
  ],
}

/**
 * Mirrors `@metamask/x402`'s erc7710 client shape: a scheme client with NO
 * `findDefaultAsset`. That absence is exactly what makes 2.29's default spend
 * controls reject the requirement, so a stub that had one would not reproduce
 * the failure this test guards.
 */
const stubSchemeClient: SchemeNetworkClient = {
  scheme: 'exact',
  async createPaymentPayload(x402Version, requirements) {
    return {
      x402Version,
      payload: {
        signature: '0xstub-signature',
        authorization: {
          from: '0x0000000000000000000000000000000000000001',
          to: requirements.payTo,
          value: requirements.amount,
          validAfter: '0',
          validBefore: '9999999999',
          nonce: `0x${'00'.repeat(32)}`,
        },
      },
    }
  },
}

function pilotClient() {
  return createPilotClient({
    network: NETWORK,
    asset: USDC,
    maxAmountPerPayment: PRICE,
    schemeClient: stubSchemeClient,
  })
}

/**
 * A v2 402 carries the challenge in the `PAYMENT-REQUIRED` header; the JSON
 * body is only a human-readable echo (the wrapper reads the header).
 */
function paymentRequiredResponse(paymentRequired: typeof CANNED_402): Response {
  return new Response(JSON.stringify(paymentRequired), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired),
    },
  })
}

describe('qa-agent x402 pilot buyer (#4550)', () => {
  it('pays a canned 402 for the USDC it is configured for', async () => {
    // The wrapper sets the payment header on the Request it re-sends, not on
    // the caller's init — capture the Request objects.
    const sent: Request[] = []
    const fetchStub = async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      sent.push(request)
      if (sent.length === 1) {
        return paymentRequiredResponse(CANNED_402)
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    const fetchWithPay = wrapFetchWithPayment(fetchStub as typeof fetch, pilotClient())
    const response = await fetchWithPay('https://merchant.test/mcp', {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(sent).toHaveLength(2)

    // v2 carries the payload in PAYMENT-SIGNATURE (v1 used X-PAYMENT).
    const header = sent[1].headers.get('PAYMENT-SIGNATURE')
    expect(header).toBeTruthy()
    const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8')) as {
      payload: { signature: string }
    }
    expect(decoded.payload.signature).toBe('0xstub-signature')
  })

  it('rejects a requirement above the configured per-payment cap', async () => {
    const overpriced = {
      ...CANNED_402,
      accepts: [{ ...CANNED_402.accepts[0], amount: '2000' }],
    }
    const fetchStub = async () => paymentRequiredResponse(overpriced)

    const fetchWithPay = wrapFetchWithPayment(fetchStub as typeof fetch, pilotClient())
    // The asset-cap message, not the "no allowedAssets entry" one: this must
    // fail because the cap is enforced, not because controls are missing.
    await expect(
      fetchWithPay('https://merchant.test/mcp', { method: 'POST', body: '{}' }),
    ).rejects.toThrow(/allowedAssets maxAmountPerPayment/)
  })
})
