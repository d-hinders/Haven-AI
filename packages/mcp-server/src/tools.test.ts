import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'

const DELEGATE_KEY = '0x' + 'a'.repeat(64)

interface CapturedCall {
  url: string
  method: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
}

let calls: CapturedCall[]

/** Install a fetch stub that records every request and returns canned bodies. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname
    calls.push({
      url,
      method,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    const route = routes[`${method} ${path}`]
    const status = route?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body ?? {},
    }
  })
}

function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

function handlers() {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
  return createToolHandlers(haven)
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('haven_pay', () => {
  it('returns the unsigned payload hash for an in-budget payment', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xdeadbeef' },
        },
      },
    })

    const result = ok<{ payload_hash: string; payment_id: string; status: string }>(
      await handlers().haven_pay({ token: 'USDC', amount: '12.50', to: '0xabc' }),
    )

    expect(result.data.payment_id).toBe('pay_1')
    expect(result.data.payload_hash).toBe('0xdeadbeef')
    expect(result.data.status).toBe('pending_signature')
  })

  it('surfaces pending_approval (no hash) when over budget', async () => {
    stubFetch({
      'POST /payments': {
        status: 202,
        body: {
          payment_id: 'pay_over',
          status: 'pending_approval',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay({ token: 'USDC', amount: '999999', to: '0xabc' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })

  it('never sends a delegate key in the construct request', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: { payment_id: 'pay_1', status: 'pending_signature', sign_data: { hash: '0x1' } },
      },
    })

    await handlers().haven_pay({ token: 'USDC', amount: '1', to: '0xabc' })

    const payCall = calls.find((c) => c.url.endsWith('/payments'))
    expect(payCall?.body).toEqual({ token: 'USDC', amount: '1', to: '0xabc' })
    // Custody invariant: no field anywhere in the request carries key material.
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(calls)).not.toContain('delegate_key')
  })
})

describe('haven_submit', () => {
  it('relays ONLY { signature } and returns the tx hash', async () => {
    stubFetch({
      'POST /payments/pay_1/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xtx' },
      },
    })

    const sig = '0x' + '11'.repeat(65)
    const result = ok<{ status: string; tx_hash: string }>(
      await handlers().haven_submit({ payment_id: 'pay_1', signature: sig }),
    )

    expect(result.data.status).toBe('confirmed')
    expect(result.data.tx_hash).toBe('0xtx')

    const signCall = calls.find((c) => c.url.includes('/sign'))
    // The relay payload is exactly the signature — nothing else crosses the wire.
    expect(signCall?.body).toEqual({ signature: sig })
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
  })

  it('rejects a malformed signature before any network call', async () => {
    stubFetch({})
    const payload = await handlers().haven_submit({ payment_id: 'pay_1', signature: 'not-hex' })
    expect(payload.success).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
