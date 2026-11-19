/**
 * #4872 part 2b: `HavenClient.getX402StoredPaymentRequired` — the stored
 * challenge the keyless hosted `haven_submit` reads the merchant's
 * checkout-details request from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiError } from './types.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function installFetch(handler: (url: string) => Response): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return handler(String(input))
    }),
  )
  return urls
}

const client = () => new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })

const CHALLENGE = {
  x402Version: 2,
  resource: { url: 'https://merchant.example/pay', description: 'A thing', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      payTo: '0x' + 'ee'.repeat(20),
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    },
  ],
  extensions: { 'haven-checkout-details': { version: 1, fields: [{ name: 'receipt_email', required: true }] } },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HavenClient.getX402StoredPaymentRequired (#4872)', () => {
  it('reads GET /x402/:id/payment-required with the id encoded', async () => {
    const urls = installFetch(() => json({ payment_id: 'p/1', payment_required: CHALLENGE }))
    await client().getX402StoredPaymentRequired('p/1')
    expect(urls).toEqual(['https://haven.test/x402/p%2F1/payment-required'])
  })

  it('returns the normalized challenge with its extensions', async () => {
    installFetch(() => json({ payment_id: 'p1', payment_required: CHALLENGE }))
    const got = await client().getX402StoredPaymentRequired('p1')
    expect(got?.extensions).toEqual(CHALLENGE.extensions)
    expect(got?.accepts[0].payTo).toBe(CHALLENGE.accepts[0].payTo)
  })

  it('returns null when no challenge was stored, and for a stored blob that is not a challenge', async () => {
    installFetch(() => json({ payment_id: 'p1', payment_required: null }))
    expect(await client().getX402StoredPaymentRequired('p1')).toBeNull()
    installFetch(() => json({ payment_id: 'p1', payment_required: { x402Version: 2, accepts: 'nope' } }))
    expect(await client().getX402StoredPaymentRequired('p1')).toBeNull()
  })

  it('throws HavenApiError on a 409 (not an x402 intent) and a 404', async () => {
    installFetch(() => json({ error: 'Not an x402 intent', error_code: 'payment_required_unavailable' }, 409))
    await expect(client().getX402StoredPaymentRequired('p1')).rejects.toMatchObject({ statusCode: 409 })
    installFetch(() => json({ error: 'Payment intent not found' }, 404))
    const err = await client().getX402StoredPaymentRequired('p1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HavenApiError)
    expect((err as HavenApiError).statusCode).toBe(404)
  })
})
