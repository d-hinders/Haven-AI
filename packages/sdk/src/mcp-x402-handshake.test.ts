import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

// ── Shared fixtures ───────────────────────────────────────────────

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const delegateKey = `0x${'01'.repeat(32)}`
const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const backendUrl = 'https://haven.example'

const mcpUrl = 'https://mcp.soundside.ai/mcp'
const genericUrl = 'https://api.merchant.example/paid'

function paymentRequiredFor(url: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url, description: 'create_image via luma - $0.02 USDC', mimeType: 'application/json' },
    accepts: [accepted],
    ...extras,
  }
}

/** Frame a JSON-RPC message as a single MCP Streamable-HTTP SSE event. */
function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/event-stream')
  return new Response(body, { status: init.status ?? 200, headers })
}

function initializeOk(sessionId: string): Response {
  return sseResponse(
    sse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'soundside' } } }),
    { headers: { 'mcp-session-id': sessionId } },
  )
}

/** The 202 a server returns for the `notifications/initialized` notification. */
function notificationAccepted(): Response {
  return new Response(null, { status: 202 })
}

function fundingPendingSignature(resourceUrl: string = mcpUrl): Response {
  return new Response(JSON.stringify({
    payment_id: 'pay_123',
    status: 'pending_signature',
    chain_id: 8453,
    safe_address: safeAddress,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    resource_url: resourceUrl,
    sign_data: {
      hash: `0x${'11'.repeat(32)}`,
      components: {
        safe: safeAddress,
        token: accepted.asset,
        to: delegateAddress,
        amount: accepted.amount,
        payment_token: '0x0000000000000000000000000000000000000000',
        payment: '0',
        nonce: 1,
      },
      instructions: 'Sign with delegate key',
    },
  }), { status: 201 })
}

function fundingConfirmed(): Response {
  return new Response(JSON.stringify({
    payment_id: 'pay_123',
    status: 'confirmed',
    tx_hash: '0xabc',
    chain_id: 8453,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    explorer_url: 'https://basescan.org/tx/0xabc',
  }), { status: 200 })
}

function evidenceAccepted(): Response {
  return new Response(JSON.stringify({ evidence: { id: 'evidence-123' } }), { status: 202 })
}

function newClient(): HavenClient {
  return new HavenClient({
    apiKey: 'sk_agent_test',
    delegateKey,
    baseUrl: backendUrl,
  })
}

function headersOf(call: unknown[]): Headers {
  return new Headers((call[1] as RequestInit).headers)
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
}

function isInitializeCall(call: unknown[]): boolean {
  try {
    return bodyOf(call).method === 'initialize'
  } catch {
    return false
  }
}

function isInitializedNotificationCall(call: unknown[]): boolean {
  try {
    return bodyOf(call).method === 'notifications/initialized'
  } catch {
    return false
  }
}

describe('MCP-over-x402 auto-handshake (issue #315)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handshakes a /mcp endpoint and threads the session through probe and retry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // 0: MCP initialize handshake
      .mockResolvedValueOnce(initializeOk('sess-abc'))
      // 1: notifications/initialized completes the lifecycle handshake
      .mockResolvedValueOnce(notificationAccepted())
      // 2: probe → 402 with x402 requirements in the JSON body
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequiredFor(mcpUrl)), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      // 3: Haven funding authorize
      .mockResolvedValueOnce(fundingPendingSignature())
      // 4: Haven sign → confirmed
      .mockResolvedValueOnce(fundingConfirmed())
      // 5: paid retry → SSE JSON-RPC result
      .mockResolvedValueOnce(sseResponse(
        sse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'an image' }] } }),
        { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ success: true, transaction: '0xabc', network: accepted.network })) } },
      ))
      // 6: Haven evidence (best-effort)
      .mockResolvedValueOnce(evidenceAccepted())

    const haven = newClient()
    const toolCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_image' } })

    const response = await haven.fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toolCall,
    })

    expect(fetchMock).toHaveBeenCalledTimes(7)

    // Initialize ran first, against the merchant, with a real handshake body.
    expect(String(fetchMock.mock.calls[0][0])).toBe(mcpUrl)
    expect(isInitializeCall(fetchMock.mock.calls[0])).toBe(true)
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })

    // ...followed by the initialized notification carrying the session id.
    expect(isInitializedNotificationCall(fetchMock.mock.calls[1])).toBe(true)
    expect(headersOf(fetchMock.mock.calls[1]).get('mcp-session-id')).toBe('sess-abc')

    // The probe carried the caller's tool-call body untouched.
    expect(String(fetchMock.mock.calls[2][0])).toBe(mcpUrl)
    expect((fetchMock.mock.calls[2][1] as RequestInit).body).toBe(toolCall)

    // Session id + SSE Accept threaded onto both the probe and the retry.
    const probeHeaders = headersOf(fetchMock.mock.calls[2])
    const retryHeaders = headersOf(fetchMock.mock.calls[5])
    expect(probeHeaders.get('mcp-session-id')).toBe('sess-abc')
    expect(retryHeaders.get('mcp-session-id')).toBe('sess-abc')
    expect(probeHeaders.get('mcp-session-id')).toBe(retryHeaders.get('mcp-session-id'))
    expect(probeHeaders.get('Accept')).toBe('application/json, text/event-stream')
    expect(retryHeaders.get('Accept')).toBe('application/json, text/event-stream')
    expect(probeHeaders.get('x402-wallet')).toBe(delegateAddress)
    expect(retryHeaders.get('x402-wallet')).toBe(delegateAddress)

    // The retry still carries the merchant-verifiable x402 header.
    expect(retryHeaders.has('X-PAYMENT')).toBe(true)

    // SSE was collapsed to the JSON-RPC result — the caller never sees raw SSE,
    // and the transport session id is not leaked back to the caller.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.has('mcp-session-id')).toBe(false)
    await expect(response.json()).resolves.toEqual({ content: [{ type: 'text', text: 'an image' }] })
  })

  it('falls back to standard x402 when a /mcp server is not actually MCP', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // 0: initialize → non-MCP server (no mcp-session-id, plain 404)
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      // 1: probe → standard x402 402
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequiredFor(mcpUrl)), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      // 2-3: Haven authorize + sign
      .mockResolvedValueOnce(fundingPendingSignature())
      .mockResolvedValueOnce(fundingConfirmed())
      // 4: plain JSON retry (no SSE)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      // 5: evidence
      .mockResolvedValueOnce(evidenceAccepted())

    const haven = newClient()
    const response = await haven.fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(6)
    // Handshake was attempted...
    expect(isInitializeCall(fetchMock.mock.calls[0])).toBe(true)
    // ...but failed, so no MCP headers leak onto the probe or the retry.
    expect(headersOf(fetchMock.mock.calls[1]).has('mcp-session-id')).toBe(false)
    expect(headersOf(fetchMock.mock.calls[4]).has('mcp-session-id')).toBe(false)

    // Standard x402 result passes through untouched (not SSE-collapsed).
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('falls back when /mcp initialize returns a JSON-RPC error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // 0: initialize returns a session id but a JSON-RPC error body
      .mockResolvedValueOnce(sseResponse(
        sse({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } }),
        { headers: { 'mcp-session-id': 'sess-err' } },
      ))
      // 1: probe → standard x402
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequiredFor(mcpUrl)), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(fundingPendingSignature())
      .mockResolvedValueOnce(fundingConfirmed())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(evidenceAccepted())

    const haven = newClient()
    const response = await haven.fetch(mcpUrl, { method: 'POST', body: JSON.stringify({}) })

    expect(isInitializeCall(fetchMock.mock.calls[0])).toBe(true)
    // JSON-RPC error ⇒ treated as non-MCP, no session header threaded.
    expect(headersOf(fetchMock.mock.calls[1]).has('mcp-session-id')).toBe(false)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('handshakes a non-/mcp endpoint when the 402 body carries the bazaar extension', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // 0: probe → 402 with a Coinbase Bazaar extension (no session yet)
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequiredFor(genericUrl, {
        extensions: { bazaar: { discovery: 'https://bazaar.example/published' } },
      })), { status: 402, headers: { 'Content-Type': 'application/json' } }))
      // 1: initialize triggered by the bazaar signal
      .mockResolvedValueOnce(initializeOk('sess-bazaar'))
      // 2: notifications/initialized
      .mockResolvedValueOnce(notificationAccepted())
      // 3-4: Haven authorize + sign
      .mockResolvedValueOnce(fundingPendingSignature(genericUrl))
      .mockResolvedValueOnce(fundingConfirmed())
      // 5: SSE retry
      .mockResolvedValueOnce(sseResponse(
        sse({ jsonrpc: '2.0', id: 2, result: { ok: true } }),
      ))
      // 6: evidence
      .mockResolvedValueOnce(evidenceAccepted())

    const haven = newClient()
    const response = await haven.fetch(genericUrl, { method: 'POST', body: JSON.stringify({}) })

    expect(fetchMock).toHaveBeenCalledTimes(7)
    // The probe came first and could not have carried a session id...
    expect(String(fetchMock.mock.calls[0][0])).toBe(genericUrl)
    expect(headersOf(fetchMock.mock.calls[0]).has('mcp-session-id')).toBe(false)
    // ...then the bazaar signal triggered the handshake...
    expect(isInitializeCall(fetchMock.mock.calls[1])).toBe(true)
    expect(isInitializedNotificationCall(fetchMock.mock.calls[2])).toBe(true)
    // ...so the paid retry is authorized with the freshly issued session id.
    expect(headersOf(fetchMock.mock.calls[5]).get('mcp-session-id')).toBe('sess-bazaar')
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('does not handshake a plain x402 endpoint with no /mcp path and no bazaar extension', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequiredFor(genericUrl)), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(fundingPendingSignature())
      .mockResolvedValueOnce(fundingConfirmed())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(evidenceAccepted())

    const haven = newClient()
    const response = await haven.fetch(genericUrl, { method: 'POST', body: JSON.stringify({}) })

    // No initialize call anywhere, and no MCP headers on any request.
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.some(isInitializeCall)).toBe(false)
    expect(fetchMock.mock.calls.every((call) => !headersOf(call).has('mcp-session-id'))).toBe(true)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})
