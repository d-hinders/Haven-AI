import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureMerchantResponse,
  DEFAULT_MERCHANT_TIMEOUT,
  MCP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  McpMerchantTransport,
} from './mcp-merchant-transport.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('McpMerchantTransport', () => {
  it('initializes before notification with exact protocol, monotonic ids, and header precedence', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init })
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: calls.length, result: {} }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': `session-${calls.length}` },
        })
      }
      return new Response(null, { status: 202 })
    })
    const transport = new McpMerchantTransport({ fetch })
    const originalHeaders = {
      Accept: 'text/plain',
      'Content-Type': 'text/plain',
      'x402-wallet': '0xCallerWallet',
    }

    await expect(
      transport.initialize('https://merchant.test/mcp', { headers: originalHeaders }, '0xDefaultWallet'),
    ).resolves.toBe('session-1')
    await expect(transport.initialize('https://merchant.test/mcp', undefined, '0xDefaultWallet')).resolves.toBe(
      'session-3',
    )

    expect(calls.map(({ init }) => JSON.parse(String(init.body)).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'initialize',
      'notifications/initialized',
    ])
    const firstInitialize = JSON.parse(String(calls[0].init.body)) as {
      id: number
      params: { protocolVersion: string; clientInfo: unknown }
    }
    const secondInitialize = JSON.parse(String(calls[2].init.body)) as { id: number }
    expect(firstInitialize).toMatchObject({
      id: 1,
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'haven-sdk', version: '1' },
      },
    })
    expect(secondInitialize.id).toBe(2)

    const initializeHeaders = new Headers(calls[0].init.headers)
    const notifyHeaders = new Headers(calls[1].init.headers)
    expect(initializeHeaders.get('accept')).toBe(MCP_ACCEPT)
    expect(initializeHeaders.get('content-type')).toBe('application/json')
    expect(initializeHeaders.get('x402-wallet')).toBe('0xCallerWallet')
    expect(notifyHeaders.get('mcp-session-id')).toBe('session-1')
    expect(notifyHeaders.get('x402-wallet')).toBe('0xCallerWallet')
    expect(new Headers(calls[2].init.headers).get('x402-wallet')).toBe('0xDefaultWallet')
  })

  it('falls back without notifying on non-ok, missing-session, and JSON-RPC error handshakes', async () => {
    const responses = [
      new Response(null, { status: 404 }),
      new Response(JSON.stringify({ jsonrpc: '2.0', result: {} })),
      new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -1 } }), {
        headers: { 'mcp-session-id': 'rejected' },
      }),
    ]
    const fetch = vi.fn(async () => responses.shift()!)
    const transport = new McpMerchantTransport({ fetch })

    await expect(transport.initialize('https://merchant.test/mcp')).resolves.toBeUndefined()
    await expect(transport.initialize('https://merchant.test/mcp')).resolves.toBeUndefined()
    await expect(transport.initialize('https://merchant.test/mcp')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps notification failure best-effort after a valid session is established', async () => {
    const fetch = vi
      .fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => new Response())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', result: {} }), {
          headers: { 'mcp-session-id': 'survives' },
        }),
      )
      .mockRejectedValueOnce(new Error('notification refused'))
    const transport = new McpMerchantTransport({ fetch })

    await expect(transport.initialize('https://merchant.test/mcp')).resolves.toBe('survives')
  })

  it('adds session headers without changing the caller body or method', () => {
    const body = new URLSearchParams({ tool: 'paint' })
    const init = transportFixture().withSessionHeaders(
      { method: 'PATCH', body, headers: { Accept: 'text/plain', 'mcp-session-id': 'stale' } },
      'fresh',
    )

    expect(init.method).toBe('PATCH')
    expect(init.body).toBe(body)
    expect(new Headers(init.headers).get('accept')).toBe(MCP_ACCEPT)
    expect(new Headers(init.headers).get('mcp-session-id')).toBe('fresh')
  })

  it('detects MCP from path or Bazaar without consuming the merchant response', async () => {
    const transport = transportFixture()
    const pathResponse = new Response('{}')
    await expect(transport.detect('https://merchant.test/mcp/?q=1', paymentRequired(), pathResponse)).resolves.toEqual({
      handshakeRequired: true,
      source: 'path',
    })

    const bazaarBody = { extensions: { bazaar: { info: true } }, accepts: [] }
    const bazaarResponse = new Response(JSON.stringify(bazaarBody), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    })
    await expect(
      transport.detect('https://merchant.test/tool', paymentRequired(), bazaarResponse),
    ).resolves.toEqual({ handshakeRequired: true, source: 'bazaar' })
    await expect(bazaarResponse.json()).resolves.toEqual(bazaarBody)
  })

  it('surfaces an SSE result while preserving response metadata and not leaking session framing', async () => {
    const raw = new Response(
      ': keepalive\n\ndata: not-json\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n',
      {
        status: 201,
        statusText: 'Created',
        headers: {
          'content-type': 'text/event-stream',
          'content-length': '123',
          'mcp-session-id': 'secret-session',
          'PAYMENT-RESPONSE': 'receipt',
        },
      },
    )

    const surfaced = await transportFixture().surfaceResult(raw)
    expect(surfaced.status).toBe(201)
    expect(surfaced.statusText).toBe('Created')
    expect(surfaced.headers.get('content-type')).toBe('application/json')
    expect(surfaced.headers.get('payment-response')).toBe('receipt')
    expect(surfaced.headers.has('content-length')).toBe(false)
    expect(surfaced.headers.has('mcp-session-id')).toBe(false)
    await expect(surfaced.json()).resolves.toEqual({ ok: true })
  })

  it('passes through non-SSE and malformed SSE responses with readable bodies', async () => {
    const json = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    await expect(transportFixture().surfaceResult(json)).resolves.toBe(json)
    await expect(json.json()).resolves.toEqual({ ok: true })

    const malformed = new Response('data: not-json\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
    await expect(transportFixture().surfaceResult(malformed)).resolves.toBe(malformed)
    await expect(malformed.text()).resolves.toBe('data: not-json\n\n')
  })

  it('delivers the supplied payment header while preserving caller body and consumes only captured failures', async () => {
    const body = new URLSearchParams({ prompt: 'a lighthouse' })
    const success = new Response('merchant result', { headers: { 'PAYMENT-RESPONSE': 'receipt' } })
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => success,
    )
    const transport = new McpMerchantTransport({ fetch })

    const delivered = await transport.deliverPayment(
      'https://merchant.test/mcp',
      { method: 'POST', body, headers: { 'X-PAYMENT': 'stale' } },
      'signed-payment-header',
    )
    const deliveredInit = fetch.mock.calls[0][1]!
    expect(deliveredInit.body).toBe(body)
    expect(new Headers(deliveredInit.headers).get('x-payment')).toBe('signed-payment-header')
    expect(delivered).toBe(success)
    await expect(delivered.text()).resolves.toBe('merchant result')

    const failed = new Response('declined verbatim', {
      status: 402,
      statusText: 'Payment Required',
      headers: { 'x-merchant-reason': 'expired' },
    })
    await expect(captureMerchantResponse(failed)).resolves.toEqual({
      merchant_status: 402,
      merchant_status_text: 'Payment Required',
      merchant_headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'x-merchant-reason': 'expired',
      },
      merchant_body: 'declined verbatim',
    })
    expect(failed.bodyUsed).toBe(true)
  })

  it('bounds merchant calls but preserves caller cancellation as a non-timeout error', async () => {
    const hangingFetch = vi.fn(
      async (_input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const transport = new McpMerchantTransport({ merchantTimeout: 20, fetch: hangingFetch })
    await expect(transport.fetch('https://merchant.test/slow')).rejects.toMatchObject({
      name: 'MerchantTimeoutError',
      statusCode: 504,
      merchantErrorCode: 'merchant_timeout',
      message: expect.stringMatching(/timed out after 20ms.*merchant\.test\/slow/),
    })

    const controller = new AbortController()
    const pending = transport.fetch('https://merchant.test/cancel', { signal: controller.signal }, 60_000)
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('keeps the default timeout at or above the merchant protocol maximum', () => {
    expect(DEFAULT_MERCHANT_TIMEOUT).toBeGreaterThanOrEqual(300_000)
  })
})

function transportFixture(): McpMerchantTransport {
  return new McpMerchantTransport({ fetch: async () => new Response(null, { status: 204 }) })
}

function paymentRequired(): Parameters<McpMerchantTransport['detect']>[1] {
  return {
    x402Version: 2,
    resource: { url: 'https://merchant.test/tool' },
    accepts: [],
  }
}
