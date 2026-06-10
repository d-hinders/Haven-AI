import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'

const DELEGATE_KEY = '0x' + 'a'.repeat(64)
const X402_EXPECTED_AUTH = {
  version: 1 as const,
  message: 'Haven x402 expected context v1\n{}',
  signature: '0x' + '11'.repeat(65),
  signer: '0x000000000000000000000000000000000000bEEF',
}

interface CapturedCall {
  url: string
  method: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
}

let calls: CapturedCall[]

interface RouteDefinition {
  status?: number
  body?: unknown
  /** Extra response headers to include. */
  responseHeaders?: Record<string, string>
}

/** Install a fetch stub that records every request and returns canned bodies. */
function stubFetch(routes: Record<string, RouteDefinition>) {
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
    const responseHeaders = new Headers(route?.responseHeaders ?? {})
    const bodySnapshot = route?.body
    const response = {
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      json: async () => bodySnapshot ?? {},
      clone: () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: responseHeaders,
        json: async () => bodySnapshot ?? {},
      }),
    }
    return response
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

// ── haven_pay ─────────────────────────────────────────────────────────────────

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

// ── haven_submit ──────────────────────────────────────────────────────────────

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

// ── x402 fixtures ─────────────────────────────────────────────────────────────

const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      maxAmountRequired: '1500000',
      // Base USDC — selectStandardPaymentOption only accepts this asset.
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0xMerchant',
      maxTimeoutSeconds: 60,
    },
  ],
}

const X402_INTENT_RESPONSE = {
  payment_id: 'pay_x402',
  status: 'pending_signature',
  merchant_to: '0xMerchant',
  x402_expected_auth: X402_EXPECTED_AUTH,
  sign_data: { hash: '0xfunding' },
}

const AGENT_RESPONSE = {
  id: 'agt_1',
  name: 'A',
  status: 'active',
  delegate_address: '0xDelegate',
  chain_id: 8453,
}

// ── haven_pay_x402_quote ──────────────────────────────────────────────────────

describe('haven_pay_x402_quote', () => {
  it('returns the unsigned funding hash + x402 data for the edge, signing nothing', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      payment_id: string
      payload_hash: string
      x402: Record<string, unknown>
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.x402.funding_to).toBe('0xDelegate')
    expect(result.data.x402.merchant_to).toBe('0xMerchant')
    expect(result.data.x402.expected).toEqual({
      payment_id: 'pay_x402',
      payload_hash: '0xfunding',
      resource_url:
        (PAYMENT_REQUIRED.accepts[0] as { resource?: string }).resource ??
        PAYMENT_REQUIRED.resource.url,
      merchant_to: '0xMerchant',
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
      asset: PAYMENT_REQUIRED.accepts[0].asset,
      network: PAYMENT_REQUIRED.accepts[0].network,
      auth: X402_EXPECTED_AUTH,
    })

    // Custody: the funding request tops up the delegate EOA but carries no key.
    const x402Call = calls.find((c) => c.url.endsWith('/x402'))
    expect(x402Call?.body).toMatchObject({
      payTo: '0xDelegate',
      merchantPayTo: '0xMerchant',
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    })
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(calls)).not.toContain('delegate_key')
  })

  it('surfaces pending_approval (no hash) when the x402 amount is over budget', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 202, body: { payment_id: 'pay_over', status: 'pending_approval' } },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )
    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })
})

// ── haven_quote_x402 ──────────────────────────────────────────────────────────

describe('haven_quote_x402', () => {
  it('probes the merchant, returns payment_required without creating a Haven payment', async () => {
    // The SDK reads payment_required from the PAYMENT-REQUIRED response header (base64 JSON).
    const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))
    stubFetch({
      'GET /paid': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
    })

    const result = ok<{
      payment_required: unknown
      amount: string
      resource_url: string
    }>(await handlers().haven_quote_x402({ url: 'http://merchant.test/paid' }))

    expect(result.data.payment_required).toBeDefined()
    // Haven was never contacted — only the merchant URL.
    expect(calls.every((c) => c.url.includes('merchant.test'))).toBe(true)
    // No x402 intent created.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })
})

// ── haven_resume_x402_payment ─────────────────────────────────────────────────

describe('haven_resume_x402_payment', () => {
  it('returns signing context when payment is ready to retry', async () => {
    const resumeState = {
      rail: 'x402' as const,
      paymentId: 'pay_approved',
      idempotencyKey: 'idem_1',
      paymentRequired: PAYMENT_REQUIRED,
      accepted: PAYMENT_REQUIRED.accepts[0],
      url: 'https://merchant.test/paid',
      resourceUrl: 'https://merchant.test/paid',
      description: null,
      amountAtomic: '1500000',
      amount: '1.50',
      token: 'USDC',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'base',
      chainId: 8453,
      merchantAddress: '0xMerchant',
    }

    stubFetch({
      // getPaymentStatus calls /machine-payments/:id/status
      'GET /machine-payments/pay_approved/status': {
        status: 200,
        body: {
          payment_id: 'pay_approved',
          status: 'confirmed',
          next_action: 'retry_original_x402_request',
          tx_hash: '0xfunded',
          rail: 'x402',
        },
      },
    })

    const result = ok<{
      payment_id: string
      payment_required: unknown
      x402: Record<string, unknown>
      tx_hash: string
    }>(await handlers().haven_resume_x402_payment({ resume_state: resumeState }))

    expect(result.data.payment_id).toBe('pay_approved')
    expect(result.data.payment_required).toBeDefined()
    expect(result.data.x402).toBeDefined()
    expect(result.data.tx_hash).toBe('0xfunded')
  })

  it('rejects when no payment_id and no resume_state provided', async () => {
    stubFetch({})
    const result = await handlers().haven_resume_x402_payment({})
    expect(result.success).toBe(false)
    // HavenApiError uses code 'API_ERROR'
    expect((result as any).code).toBe('API_ERROR')
  })
})

// ── haven_list_receipts ───────────────────────────────────────────────────────

describe('haven_list_receipts', () => {
  it('calls the receipts endpoint and returns results', async () => {
    // listReceipts calls /machine-payments/receipts
    stubFetch({
      'GET /machine-payments/receipts': {
        status: 200,
        body: { receipts: [{ id: 'rcpt_1', amount: '1.00', payment_id: 'pay_1', rail: 'x402' }] },
      },
    })

    const result = ok<unknown[]>(await handlers().haven_list_receipts({}))
    expect(Array.isArray(result.data)).toBe(true)
  })
})

// ── haven_get_resume_state ────────────────────────────────────────────────────

describe('haven_get_resume_state', () => {
  it('calls the resume state endpoint', async () => {
    // getResumeState calls /payments/:id/resume_state
    stubFetch({
      'GET /payments/pay_1/resume_state': {
        status: 200,
        body: {
          rail: 'x402',
          paymentId: 'pay_1',
          payment_required: PAYMENT_REQUIRED,
        },
      },
    })

    const result = ok<{ rail: string }>(
      await handlers().haven_get_resume_state({ payment_id: 'pay_1' }),
    )
    expect(result.data.rail).toBe('x402')
  })
})

// ── custody invariant (all tools) ────────────────────────────────────────────

describe('custody invariant', () => {
  it('no tool ever emits a delegate key in the network requests', async () => {
    // Stub enough routes to exercise all tools that touch the Haven API.
    stubFetch({
      'POST /payments': {
        status: 201,
        body: { payment_id: 'p1', status: 'pending_signature', sign_data: { hash: '0x1' } },
      },
      'POST /payments/p1/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xtx' } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': {
        status: 201,
        body: X402_INTENT_RESPONSE,
      },
    })

    const h = handlers()
    await h.haven_pay({ token: 'USDC', amount: '1', to: '0xabc' })
    await h.haven_submit({ payment_id: 'p1', signature: '0x' + '11'.repeat(65) })
    await h.haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED })

    const wire = JSON.stringify(calls)
    expect(wire).not.toContain(DELEGATE_KEY)
    expect(wire).not.toContain('delegate_key')
    expect(wire).not.toContain('private_key')
  })
})

// ── MCP merchant tool calls (issue #316) ───────────────────────────────────────

const MCP_URL = 'https://mcp.merchant.test/mcp'

/** Frame a JSON-RPC message as a single MCP Streamable-HTTP SSE event. */
function mcpSse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * Route a single hosted MCP merchant flow by URL, method, and JSON-RPC method.
 * The merchant endpoint multiplexes initialize / notifications / tools/call on
 * one path, so the path-keyed `stubFetch` can't express it.
 */
function stubMcpFlow(opts: { paid: Response }): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined
    calls.push({ url: u, method, body, headers: (init.headers ?? {}) as Record<string, string> })

    if (u.endsWith('/machine-payments/agent')) {
      return new Response(JSON.stringify(AGENT_RESPONSE), { status: 200 })
    }
    if (u === MCP_URL) {
      if (body?.method === 'initialize') {
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-h' } },
        )
      }
      if (body?.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (headers.has('X-PAYMENT')) return opts.paid
      return new Response(JSON.stringify({ ...PAYMENT_REQUIRED, resource: { url: MCP_URL } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u.endsWith('/x402')) {
      return new Response(JSON.stringify(X402_INTENT_RESPONSE), { status: 201 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
}

describe('haven_pay_mcp_tool', () => {
  it('constructs the funding hash from an MCP merchant probe and echoes the tool context', async () => {
    stubMcpFlow({ paid: mcpSse({ jsonrpc: '2.0', id: 'x', result: { ok: true } }) })

    const result = ok<{ payload_hash: string; payment_id: string; mcp: Record<string, unknown> }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: MCP_URL,
        tool_name: 'create_image',
        arguments: { prompt: 'a cat' },
      }),
    )

    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.mcp).toEqual({
      merchant_url: MCP_URL,
      tool_name: 'create_image',
      arguments: { prompt: 'a cat' },
    })

    // The probe carried the JSON-RPC tools/call envelope built from the args.
    const probe = calls.find((c) => c.url === MCP_URL && c.body?.method === 'tools/call')
    expect(probe?.body).toMatchObject({
      method: 'tools/call',
      params: { name: 'create_image', arguments: { prompt: 'a cat' } },
    })
    // Custody invariant: no key material crosses the wire from the hosted server.
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(calls)).not.toContain('delegate_key')
  })

  it('surfaces pending_approval (no hash) when the amount is over budget', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined
      calls.push({ url: u, method: (init.method ?? 'GET').toUpperCase(), body, headers: {} })
      if (u.endsWith('/machine-payments/agent')) return new Response(JSON.stringify(AGENT_RESPONSE), { status: 200 })
      if (u === MCP_URL) {
        if (body?.method === 'initialize') {
          return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n\n`, {
            status: 200, headers: { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-h' },
          })
        }
        if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return new Response(JSON.stringify({ ...PAYMENT_REQUIRED, resource: { url: MCP_URL } }), {
          status: 402, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.endsWith('/x402')) {
        return new Response(JSON.stringify({ payment_id: 'pay_over', status: 'pending_approval' }), { status: 202 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay_mcp_tool({ merchant_url: MCP_URL, tool_name: 'create_image' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })
})

describe('haven_mcp_tool_retry', () => {
  it('replays the tool call with the edge-built X-PAYMENT header and returns the result', async () => {
    stubMcpFlow({
      paid: mcpSse({ jsonrpc: '2.0', id: 'haven-mcp-call-1', result: { content: [{ type: 'text', text: 'a poem' }] } }),
    })

    const result = ok<{ status: number; result: { content: unknown } }>(
      await handlers().haven_mcp_tool_retry({
        merchant_url: MCP_URL,
        tool_name: 'create_text',
        arguments: { prompt: 'haiku' },
        x_payment_header: 'x402-header',
      }),
    )

    expect(result.data.status).toBe(200)
    expect(result.data.result).toEqual({ content: [{ type: 'text', text: 'a poem' }] })

    const retry = calls.find((c) => c.url === MCP_URL && c.body?.method === 'tools/call')
    expect(new Headers(retry?.headers).get('X-PAYMENT')).toBe('x402-header')
    expect(retry?.body).toMatchObject({ params: { name: 'create_text', arguments: { prompt: 'haiku' } } })
  })
})
