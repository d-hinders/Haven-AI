import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiError } from './types.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function installFetch(handler: (url: string, init: RequestInit) => Response): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      urls.push(String(input))
      return handler(String(input), init)
    }),
  )
  return urls
}

const client = () => new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })

const WIRE = {
  payment_id: 'pay_1',
  status: 'pending_signature',
  settlement_scheme: 'eip3009',
  resource_url: 'https://merchant.example/pay',
  expires_at: '2026-10-07T12:00:00.000Z',
  window_open: true,
  task_budget_id: null,
  amount_atomic: '10000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  network: 'eip155:8453',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HavenClient.findX402IntentByIdempotencyKey (#3739)', () => {
  it('URL-encodes the key into the path', async () => {
    const urls = installFetch(() => json(WIRE))
    await client().findX402IntentByIdempotencyKey('x402:abc/def?g=1&h=#2 ü')
    expect(urls).toEqual([
      `https://haven.test/x402/by-idempotency-key/${encodeURIComponent('x402:abc/def?g=1&h=#2 ü')}`,
    ])
    expect(urls[0]).not.toContain('abc/def')
  })

  it('maps snake_case wire fields to the camelCase result', async () => {
    installFetch(() => json(WIRE))
    expect(await client().findX402IntentByIdempotencyKey('k')).toEqual({
      paymentId: 'pay_1',
      status: 'pending_signature',
      settlementScheme: 'eip3009',
      resourceUrl: 'https://merchant.example/pay',
      expiresAt: '2026-10-07T12:00:00.000Z',
      windowOpen: true,
      taskBudgetId: null,
      amountAtomic: '10000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
    })
  })

  it('carries erc7710, a task budget id, a null scheme and a closed window through', async () => {
    installFetch(() =>
      json({ ...WIRE, settlement_scheme: 'erc7710', task_budget_id: 'tb_1', window_open: false }),
    )
    const found = await client().findX402IntentByIdempotencyKey('k')
    expect(found?.settlementScheme).toBe('erc7710')
    expect(found?.taskBudgetId).toBe('tb_1')
    expect(found?.windowOpen).toBe(false)

    installFetch(() => json({ ...WIRE, settlement_scheme: null, expires_at: null }))
    const unknown = await client().findX402IntentByIdempotencyKey('k')
    expect(unknown?.settlementScheme).toBeNull()
    expect(unknown?.expiresAt).toBeNull()
  })

  it('returns null on a 404', async () => {
    installFetch(() => json({ error: 'No x402 payment found for this idempotency key' }, 404))
    expect(await client().findX402IntentByIdempotencyKey('nope')).toBeNull()
  })

  it('throws any other error, as the other GETs do', async () => {
    installFetch(() => json({ error: 'boom' }, 500))
    await expect(client().findX402IntentByIdempotencyKey('k')).rejects.toBeInstanceOf(HavenApiError)

    installFetch(() => json({ error: 'nope' }, 401))
    await expect(client().findX402IntentByIdempotencyKey('k')).rejects.toMatchObject({ statusCode: 401 })
  })
})
