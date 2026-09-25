import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import {
  MCP_X402_PAYMENT_META_KEY,
  MCP_X402_PAYMENT_RESPONSE_META_KEY,
  McpMerchantTransport,
  extractMcpPaymentRequired,
  isJsonRpcToolsCallBody,
  mcpSettlementFromToolResult,
  mcpToolResultOf,
  withMcpPaymentMeta,
} from './mcp-merchant-transport.js'
import { X402UnexpectedStatusError } from './types.js'
import type { X402PaymentOption } from './types.js'
import { buildValidUserOpSignData } from './__fixtures__/valid-userop.js'

// #3118: the official x402 MCP transport profile — payment-required as an
// `isError: true` tool RESULT (HTTP 200), payment in
// `params._meta["x402/payment"]`, settlement in
// `result._meta["x402/payment-response"]`. Haven's HTTP-402-over-MCP layering
// is characterized first in each group and must keep working unchanged.

// #3271: a real, self-consistent PackedUserOperation — the binding check
// recomputes its hash and refuses a hand-rolled 3-field toy.
const userOpSignData = buildValidUserOpSignData()
const userOpTypedData = userOpSignData.typed_data

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
const fundingTxHash = `0x${'ab'.repeat(32)}`
const mcpUrl = 'https://mcp.merchant.example/mcp'

function paymentRequiredFor(url: string): Record<string, unknown> {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url, description: 'paid tool - $0.02 USDC', mimeType: 'application/json' },
    accepts: [accepted],
  }
}

/** A profile challenge: `isError: true`, structured content + text fallback. */
function nativeChallenge(url: string, options: { structured?: boolean; text?: boolean | string } = {}): Record<string, unknown> {
  const required = paymentRequiredFor(url)
  const structured = options.structured ?? true
  const text = options.text ?? true
  return {
    isError: true,
    ...(structured ? { structuredContent: required } : {}),
    content: text === false ? [] : [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(required) }],
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'text/event-stream')
  return new Response(body, { status: init.status ?? 200, headers })
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function initializeOk(sessionId: string): Response {
  return sseResponse(sse(rpcResult(1, { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture' } })), {
    headers: { 'mcp-session-id': sessionId },
  })
}

function notificationAccepted(): Response {
  return new Response(null, { status: 202 })
}

/** A real base64-JSON x402 v2 payment envelope, as the funding leg mints it. */
const paymentEnvelope = {
  x402Version: 2,
  resource: { url: mcpUrl },
  accepted,
  payload: { signature: `0x${'55'.repeat(65)}`, authorization: { from: delegateAddress, to: accepted.payTo, value: accepted.amount } },
}
const paymentHeader = btoa(JSON.stringify(paymentEnvelope))

function toolCall(id: unknown, extraParams: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'paid_tool', arguments: { q: 'x' }, ...extraParams } })
}

function fundingPendingSignature(resourceUrl: string): Response {
  return json({
    payment_id: 'pay_123',
    status: 'pending_signature',
    chain_id: 8453,
    account_address: safeAddress,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    resource_url: resourceUrl,
    sign_data: {
      hash: userOpSignData.hash,
      signature_scheme: 'eip712_userop',
      typed_data: userOpTypedData,
      components: {
        payer_account: safeAddress,
        token: accepted.asset,
        to: delegateAddress,
        amount: accepted.amount,
        payment_token: '0x0000000000000000000000000000000000000000',
        payment: '0',
        nonce: 1,
      },
      instructions: 'Sign with delegate key',
    },
  }, { status: 201 })
}

function fundingConfirmed(): Response {
  return json({
    payment_id: 'pay_123',
    status: 'confirmed',
    tx_hash: '0xabc',
    chain_id: 8453,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    explorer_url: 'https://basescan.org/tx/0xabc',
  })
}

function paymentStatusReady(resourceUrl: string): Response {
  return json({
    payment_id: 'pay_123',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'confirmed',
    phase: 'payment_confirmed',
    next_action: 'none',
    amount: '0.02',
    token: 'USDC',
    resource_url: resourceUrl,
    merchant_address: accepted.payTo,
    tx_hash: fundingTxHash,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'Retry the original x402 request.',
  })
}

function agentResponse(): Response {
  return json({ id: 'agt_1', name: 'Hosted Agent', status: 'active', account_address: safeAddress, delegate_address: delegateAddress, chain_id: 8453 })
}

function newClient(): HavenClient {
  return new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl: backendUrl })
}

function newKeylessHostedClient(): HavenClient {
  return new HavenClient({ apiKey: 'sk_agent_test', baseUrl: backendUrl })
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
}

function headersOf(call: unknown[]): Headers {
  return new Headers((call[1] as RequestInit).headers)
}

function isInitializeCall(call: unknown[]): boolean {
  return methodOf(call) === 'initialize'
}

function methodOf(call: unknown[]): string | undefined {
  try {
    return bodyOf(call).method as string | undefined
  } catch {
    return undefined
  }
}

/**
 * Route by URL and JSON-RPC method rather than by call order, so an extra
 * best-effort call (receipt capture, notification) never shifts the fixture.
 */
type Route = (url: string, init: RequestInit | undefined, method: string | undefined) => Response | undefined
function mockFetch(route: Route) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    let method: string | undefined
    try {
      method = (JSON.parse(init?.body as string) as { method?: string }).method
    } catch {
      method = undefined
    }
    const response = route(url, init, method)
    if (response) return response
    if (url === `${backendUrl}/machine-payments/agent`) return agentResponse()
    if (url.startsWith(backendUrl)) return json({ accepted: true }, { status: 202 })
    throw new Error(`unrouted fetch: ${url} ${method ?? ''}`)
  })
}

function backendCalls(fetchMock: ReturnType<typeof mockFetch>, suffix: string): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Transport helpers ─────────────────────────────────────────────

describe('#3118 native MCP profile — challenge extraction', () => {
  const transport = new McpMerchantTransport()

  it('reads a payment-required tool result from a JSON envelope without consuming the response', async () => {
    const response = json(rpcResult(7, nativeChallenge(mcpUrl)))
    const challenge = await transport.extractToolResultChallenge(response)
    expect(challenge).toMatchObject({ x402Version: 2, resource: { url: mcpUrl } })
    expect(challenge?.accepts).toHaveLength(1)
    expect(challenge?.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:8453', amount: '20000' })
    // Not consumed: the caller can still read the body.
    expect(response.bodyUsed).toBe(false)
    await expect(response.json()).resolves.toMatchObject({ id: 7 })
  })

  it('reads the same challenge from an SSE-framed result', async () => {
    const response = sseResponse(sse(rpcResult(8, nativeChallenge(mcpUrl))))
    await expect(transport.extractToolResultChallenge(response)).resolves.toMatchObject({ resource: { url: mcpUrl } })
  })

  it('falls back to the text content when structuredContent is absent, and skips text that is not JSON', () => {
    expect(extractMcpPaymentRequired(nativeChallenge(mcpUrl, { structured: false }))).toMatchObject({ resource: { url: mcpUrl } })
    // Prose first, JSON second: the first non-JSON item is skipped, not fatal.
    const mixed = {
      isError: true,
      content: [
        { type: 'text', text: 'Payment required: 0.02 USDC' },
        { type: 'text', text: JSON.stringify(paymentRequiredFor(mcpUrl)) },
      ],
    }
    expect(extractMcpPaymentRequired(mixed)).toMatchObject({ resource: { url: mcpUrl } })
    expect(extractMcpPaymentRequired(nativeChallenge(mcpUrl, { structured: false, text: 'Payment required: 0.02 USDC' }))).toBeUndefined()
  })

  it('is not a challenge without isError, without a payable accepts entry, or with a non-JSON body', async () => {
    // A SUCCESSFUL result that happens to carry a PaymentRequired-shaped
    // structuredContent (a tool that returns pricing) is content, not a demand.
    expect(extractMcpPaymentRequired({ ...nativeChallenge(mcpUrl), isError: false })).toBeUndefined()
    expect(extractMcpPaymentRequired({ isError: true, structuredContent: { x402Version: 2, accepts: [] }, content: [] })).toBeUndefined()
    expect(extractMcpPaymentRequired({ isError: true, structuredContent: { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453' }] }, content: [] })).toBeUndefined()
    expect(extractMcpPaymentRequired({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toBeUndefined()
    await expect(transport.extractToolResultChallenge(new Response('not json', { status: 200 }))).resolves.toBeUndefined()
    // A JSON-RPC error (not a tool result) is not a challenge either.
    await expect(transport.extractToolResultChallenge(json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } }))).resolves.toBeUndefined()
  })

  it('mcpToolResultOf unwraps an envelope and accepts an already-surfaced result, nothing else', () => {
    const result = { content: [], isError: false }
    expect(mcpToolResultOf(rpcResult(1, result))).toEqual(result)
    expect(mcpToolResultOf(result)).toEqual(result)
    expect(mcpToolResultOf({ _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true } } })).toBeDefined()
    expect(mcpToolResultOf({ ok: true })).toBeUndefined()
    expect(mcpToolResultOf('text')).toBeUndefined()
    expect(mcpToolResultOf(null)).toBeUndefined()
    expect(mcpToolResultOf(rpcResult(1, 'not an object'))).toBeUndefined()
  })
})

describe('#3118 native MCP profile — payment delivery in params._meta', () => {
  it('adds the decoded envelope under x402/payment and preserves id, method, arguments and unrelated _meta', () => {
    const init = withMcpPaymentMeta(
      { method: 'POST', body: toolCall('call-1', { _meta: { progressToken: 'p1' } }) },
      paymentHeader,
    )
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call' })
    expect(body.params.name).toBe('paid_tool')
    expect(body.params.arguments).toEqual({ q: 'x' })
    expect(body.params._meta.progressToken).toBe('p1')
    expect(body.params._meta[MCP_X402_PAYMENT_META_KEY]).toEqual(paymentEnvelope)
    expect(init.method).toBe('POST')
  })

  it('leaves every non-tools/call body byte-for-byte alone, and a header that is not base64 JSON adds nothing', () => {
    const initializeBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(withMcpPaymentMeta({ body: initializeBody }, paymentHeader).body).toBe(initializeBody)
    expect(withMcpPaymentMeta({ body: '{}' }, paymentHeader).body).toBe('{}')
    expect(withMcpPaymentMeta({ body: 'prompt=lighthouse' }, paymentHeader).body).toBe('prompt=lighthouse')
    const form = new URLSearchParams({ prompt: 'a' })
    expect(withMcpPaymentMeta({ body: form }, paymentHeader).body).toBe(form)
    expect(withMcpPaymentMeta({}, paymentHeader).body).toBeUndefined()
    const call = toolCall(2)
    expect(withMcpPaymentMeta({ body: call }, 'PAYMENT_HEADER_ABC').body).toBe(call)
  })

  it('deliverPayment keeps the HTTP header form (characterized) AND adds the _meta form for a tools/call body', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => json(rpcResult(2, { content: [] })))
    const transport = new McpMerchantTransport({ fetch })
    await transport.deliverPayment(mcpUrl, { method: 'POST', body: toolCall(2) }, paymentHeader)
    const sent = fetch.mock.calls[0][1]!
    const headers = new Headers(sent.headers)
    // EIP-3009 envelope: both header names, as before #3118.
    expect(headers.get('PAYMENT-SIGNATURE')).toBe(paymentHeader)
    expect(headers.get('X-PAYMENT')).toBe(paymentHeader)
    expect(JSON.parse(sent.body as string).params._meta[MCP_X402_PAYMENT_META_KEY]).toEqual(paymentEnvelope)
  })
})

describe('#3118 native MCP profile — settlement in result._meta', () => {
  it('reads a settlement statement only when success is a boolean', () => {
    const settled = { content: [], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xsettle', network: 'eip155:8453', payer: delegateAddress } } }
    expect(mcpSettlementFromToolResult(settled)).toEqual({ success: true, transaction: '0xsettle', network: 'eip155:8453', payer: delegateAddress })
    expect(mcpSettlementFromToolResult({ content: [], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { transaction: '0xsettle' } } })).toBeUndefined()
    expect(mcpSettlementFromToolResult({ content: [], _meta: { other: 1 } })).toBeUndefined()
    expect(mcpSettlementFromToolResult({ content: [] })).toBeUndefined()
    expect(mcpSettlementFromToolResult({ content: [], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false, errorReason: 'expired' } } })).toEqual({ success: false, errorReason: 'expired' })
  })
})

// ── Client: quoting ───────────────────────────────────────────────

describe('#3118 native MCP profile — quoteMcpX402', () => {
  it('characterization: an HTTP 402 challenge over an MCP session still quotes exactly as before', async () => {
    mockFetch((url, init, method) => {
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-q')
      if (method === 'notifications/initialized') return notificationAccepted()
      if (new Headers(init?.headers).get('mcp-session-id') !== 'sess-q') return new Response('no session', { status: 406 })
      return json(paymentRequiredFor(mcpUrl), { status: 402 })
    })
    const quote = await newKeylessHostedClient().quoteMcpX402(mcpUrl, { method: 'POST', body: toolCall('q') })
    expect(quote).toMatchObject({ rail: 'x402', amount: '0.02', token: 'USDC', mcpTransport: { handshakeRequired: true, source: 'path' } })
  })

  it('quotes a native isError tool result answered with HTTP 200 (JSON and SSE) with the same shape as a 402', async () => {
    for (const framing of ['json', 'sse'] as const) {
      const fetchMock = mockFetch((url, _init, method) => {
        if (url !== mcpUrl) return undefined
        if (method === 'initialize') return initializeOk('sess-n')
        if (method === 'notifications/initialized') return notificationAccepted()
        const result = rpcResult('q', nativeChallenge(mcpUrl))
        return framing === 'json' ? json(result) : sseResponse(sse(result))
      })
      const quote = await newKeylessHostedClient().quoteMcpX402(mcpUrl, { method: 'POST', body: toolCall('q') })
      expect(quote).toMatchObject({
        rail: 'x402',
        amount: '0.02',
        amountAtomic: '20000',
        token: 'USDC',
        resourceUrl: mcpUrl,
        accepted: { payTo: accepted.payTo },
        mcpTransport: { handshakeRequired: true, source: 'path' },
      })
      // The quote never creates a payment.
      expect(backendCalls(fetchMock, '/x402')).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })

  it('quotes from the text fallback when the merchant sends no structuredContent', async () => {
    mockFetch((url, _init, method) => {
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-t')
      if (method === 'notifications/initialized') return notificationAccepted()
      return json(rpcResult('q', nativeChallenge(mcpUrl, { structured: false })))
    })
    const quote = await newKeylessHostedClient().quoteMcpX402(mcpUrl, { method: 'POST', body: toolCall('q') })
    expect(quote.amountAtomic).toBe('20000')
  })

  it('still refuses an HTTP 200 that is an ordinary tool error or an ordinary result (no false quote)', async () => {
    for (const result of [
      { isError: true, content: [{ type: 'text', text: 'unknown tool' }] },
      { isError: true, structuredContent: { x402Version: 2, accepts: [] }, content: [] },
      { content: [{ type: 'text', text: JSON.stringify(paymentRequiredFor(mcpUrl)) }] },
    ]) {
      mockFetch((url, _init, method) => {
        if (url !== mcpUrl) return undefined
        if (method === 'initialize') return initializeOk('sess-e')
        if (method === 'notifications/initialized') return notificationAccepted()
        return json(rpcResult('q', result))
      })
      const attempt = newKeylessHostedClient().quoteMcpX402(mcpUrl, { method: 'POST', body: toolCall('q') })
      await expect(attempt).rejects.toBeInstanceOf(X402UnexpectedStatusError)
      await expect(attempt).rejects.toMatchObject({ statusCode: 200 })
      vi.restoreAllMocks()
    }
  })

  it('quoteX402 on a plain URL: a tool-result challenge quotes without forcing a handshake (the merchant answered without one)', async () => {
    const plainUrl = 'https://api.merchant.example/tools'
    mockFetch((url) => (url === plainUrl ? json(rpcResult('q', nativeChallenge(plainUrl))) : undefined))
    const quote = await newClient().quoteX402(plainUrl, { method: 'POST', body: toolCall('q') })
    expect(quote.amountAtomic).toBe('20000')
    expect(quote.mcpTransport).toBeUndefined()
  })
})

// ── Client: hosted completion leg ─────────────────────────────────

describe('#3118 native MCP profile — completeX402MerchantCall', () => {
  const merchantInit: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: toolCall('haven-mcp-1') }

  function completionRoutes(paidResult: () => Response): Route {
    return (url, _init, method) => {
      if (url === `${backendUrl}/machine-payments/pay_123/status`) return paymentStatusReady(mcpUrl)
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-pay')
      if (method === 'notifications/initialized') return notificationAccepted()
      if (method === 'tools/call') return paidResult()
      return undefined
    }
  }

  it('characterization: a PAYMENT-RESPONSE header still wins, and the paid call now ALSO carries _meta', async () => {
    const fetchMock = mockFetch(completionRoutes(() =>
      sseResponse(sse(rpcResult(2, { content: [{ type: 'text', text: 'a joke' }] })), {
        headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ transaction: '0xheader' })) },
      }),
    ))
    const result = await newClient().completeX402MerchantCall({ url: mcpUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
    const paid = fetchMock.mock.calls.find((c) => methodOf(c) === 'tools/call')!
    expect(headersOf(paid).get('PAYMENT-SIGNATURE')).toBe(paymentHeader)
    expect(bodyOf(paid)).toMatchObject({ id: 'haven-mcp-1', params: { name: 'paid_tool', arguments: { q: 'x' } } })
    expect((bodyOf(paid).params as Record<string, Record<string, unknown>>)._meta[MCP_X402_PAYMENT_META_KEY]).toEqual(paymentEnvelope)
    expect(result.ok).toBe(true)
    expect(result.settlementTxHash).toBe('0xheader')
    const evidence = backendCalls(fetchMock, '/machine-payments/evidence')
    expect(evidence).toHaveLength(1)
    expect(bodyOf(evidence[0])).toMatchObject({ protocolReceiptHeaderName: 'PAYMENT-RESPONSE' })
  })

  it('decodes settlement from result._meta["x402/payment-response"] when there is no header, and reports it as the receipt payload', async () => {
    for (const framing of ['sse', 'json'] as const) {
      const settled = {
        content: [{ type: 'text', text: 'the paid answer' }],
        _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xmeta', network: 'eip155:8453', payer: delegateAddress } },
      }
      const receiptHeaders = { 'x-receipt-json': btoa(JSON.stringify({ invoice: 'inv-1' })) }
      const fetchMock = mockFetch(completionRoutes(() =>
        framing === 'sse' ? sseResponse(sse(rpcResult(2, settled)), { headers: receiptHeaders }) : json(rpcResult(2, settled), { headers: receiptHeaders }),
      ))
      const result = await newClient().completeX402MerchantCall({ url: mcpUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.settlementTxHash).toBe('0xmeta')
      const evidence = backendCalls(fetchMock, '/machine-payments/evidence')
      expect(evidence).toHaveLength(1)
      const reported = bodyOf(evidence[0])
      expect(reported).toMatchObject({
        paymentId: 'pay_123',
        txHash: fundingTxHash,
        merchantStatus: 200,
        paymentProofHeader: paymentHeader,
        protocolReceiptHeaderName: `_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`,
      })
      // The receipt payload decodes to exactly the merchant's settlement object.
      expect(JSON.parse(atob(reported.protocolReceiptHeader as string))).toEqual(settled._meta[MCP_X402_PAYMENT_RESPONSE_META_KEY])
      // The merchant receipt capture (#956) ran, as on the header path.
      expect(backendCalls(fetchMock, '/machine-payments/pay_123/merchant-receipt')).toHaveLength(1)
      vi.restoreAllMocks()
    }
  })

  it('an erc7710 (no funding leg) completion anchors evidence on the _meta settlement transaction', async () => {
    const settled = { content: [{ type: 'text', text: 'ok' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xmeta7710' } } }
    const fetchMock = mockFetch((url, init, method) => {
      if (url === `${backendUrl}/machine-payments/pay_123/status`) {
        return json({
          payment_id: 'pay_123', kind: 'payment_intent', rail: 'x402', status: 'submitted', phase: 'payment_submitted', next_action: 'none',
          amount: '0.02', token: 'USDC', resource_url: mcpUrl, merchant_address: accepted.payTo, tx_hash: null,
          expires_at: '2099-01-01T00:00:00.000Z', chain_id: 8453, message: 'submitted',
        })
      }
      return completionRoutes(() => json(rpcResult(2, settled)))(url, init, method)
    })
    const result = await newClient().completeX402MerchantCall({ url: mcpUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader, noFundingLeg: true })
    expect(result.ok).toBe(true)
    expect(result.settlementTxHash).toBe('0xmeta7710')
    const evidence = backendCalls(fetchMock, '/machine-payments/evidence')
    expect(evidence).toHaveLength(1)
    expect(bodyOf(evidence[0])).toMatchObject({ txHash: '0xmeta7710' })
  })

  it('an HTTP 200 whose tool result is an isError payment-required is a REJECTION: ok false, no success evidence, no receipt', async () => {
    const fetchMock = mockFetch(completionRoutes(() => json(rpcResult(2, nativeChallenge(mcpUrl)))))
    const result = await newClient().completeX402MerchantCall({ url: mcpUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
    expect(result.status).toBe(200)
    expect(result.ok).toBe(false)
    expect(result.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
    // The funded-but-rejected reconciliation event IS recorded (funding leg).
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => /receipt/.test(String(url)))).toBe(false)
  })

  it('a _meta settlement with success:false is a REJECTION even beside a 200 and tool content', async () => {
    const fetchMock = mockFetch(completionRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'should not be trusted' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false, errorReason: 'settlement failed' } } })),
    ))
    const result = await newClient().completeX402MerchantCall({ url: mcpUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
    expect(result.ok).toBe(false)
    expect(result.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('a settlement object without a boolean success is not evidence: no transaction is taken from it', async () => {
    const fetchMock = mockFetch(completionRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'ok' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { transaction: '0xunverified' } } })),
    ))
    const result = await newClient().completeX402MerchantCall({ url: mcpUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
    expect(result.ok).toBe(true)
    expect(result.settlementTxHash).toBeUndefined()
    // Funding-leg evidence still anchors on the funding tx, with no receipt payload.
    const evidence = backendCalls(fetchMock, '/machine-payments/evidence')
    expect(evidence).toHaveLength(1)
    expect(bodyOf(evidence[0]).protocolReceiptHeaderName).toBeUndefined()
  })
})

// ── #3155 review round 1: framing, parity and reporting ──────────

describe('#3155 review — completion without a session still reads SSE-framed in-band signals (B1)', () => {
  const plainUrl = 'https://api.merchant.example/paid-tool'
  const merchantInit: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: toolCall('haven-mcp-2') }
  function plainRoutes(paidResult: () => Response): Route {
    return (url, _init, method) => {
      if (url === `${backendUrl}/machine-payments/pay_123/status`) return paymentStatusReady(plainUrl)
      if (url !== plainUrl) return undefined
      if (method === 'tools/call') return paidResult()
      return undefined
    }
  }

  it('an SSE-framed isError challenge on a plain URL (no handshake) is a rejection, exactly like the JSON control', async () => {
    for (const [framing, expectOk] of [['sse', false], ['json', false]] as const) {
      const fetchMock = mockFetch(plainRoutes(() => {
        const result = rpcResult(2, nativeChallenge(plainUrl))
        return framing === 'sse' ? sseResponse(sse(result)) : json(result)
      }))
      const result = await newClient().completeX402MerchantCall({ url: plainUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
      expect(fetchMock.mock.calls.some(isInitializeCall)).toBe(false)
      expect(result.ok, framing).toBe(expectOk)
      expect(backendCalls(fetchMock, '/machine-payments/evidence'), framing).toHaveLength(0)
      expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events'), framing).toHaveLength(1)
      vi.restoreAllMocks()
    }
  })

  it('an SSE-framed success:false settlement on a plain URL is a rejection, and its transaction is NOT reported as settled (S3)', async () => {
    const fetchMock = mockFetch(plainRoutes(() =>
      sseResponse(sse(rpcResult(2, { content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false, transaction: '0xpartial', errorReason: 'insufficient_funds' } } }))),
    ))
    const result = await newClient().completeX402MerchantCall({ url: plainUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
    expect(result.ok).toBe(false)
    expect(result.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('an SSE-framed SUCCESS on a plain URL is surfaced (collapsed to the result) and its _meta settlement read', async () => {
    const fetchMock = mockFetch(plainRoutes(() =>
      sseResponse(sse(rpcResult(2, { content: [{ type: 'text', text: 'ok' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xplain' } } }))),
    ))
    const result = await newClient().completeX402MerchantCall({ url: plainUrl, init: merchantInit, paymentId: 'pay_123', paymentHeader })
    expect(result.ok).toBe(true)
    expect(result.body).toMatchObject({ content: [{ type: 'text', text: 'ok' }] })
    expect(result.settlementTxHash).toBe('0xplain')
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(1)
  })
})

describe('#3155 review — fetch() parity with the hosted completion (B2, S1) and non-JSON bodies (S2)', () => {
  function paidRoutes(paidResult: () => Response): Route {
    return (url, init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(mcpUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-p')
      if (method === 'notifications/initialized') return notificationAccepted()
      if (method === 'tools/call') {
        const body = JSON.parse(init?.body as string) as { params: { _meta?: Record<string, unknown> } }
        if (body.params._meta?.[MCP_X402_PAYMENT_META_KEY]) return paidResult()
        return json(rpcResult(2, nativeChallenge(mcpUrl)))
      }
      return undefined
    }
  }

  it('B2: a paid retry answered success:false is the post-funding rejection — reconciliation event, no evidence, thrown as 402', async () => {
    const fetchMock = mockFetch(paidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'not delivered' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false, errorReason: 'settlement failed' } } })),
    ))
    const attempt = newClient().fetch(mcpUrl, { method: 'POST', body: toolCall(2) })
    await expect(attempt).rejects.toMatchObject({ statusCode: 402, body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding', merchant_status: 200 }) })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('S1: a paid retry with a _meta settlement and no header reports the re-encoded receipt under its _meta name', async () => {
    const settlement = { success: true, transaction: '0xlocal', network: 'eip155:8453', payer: delegateAddress }
    const fetchMock = mockFetch(paidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: settlement } })),
    ))
    const response = await newClient().fetch(mcpUrl, { method: 'POST', body: toolCall(2) })
    expect(response.status).toBe(200)
    const evidence = backendCalls(fetchMock, '/machine-payments/evidence')
    expect(evidence).toHaveLength(1)
    const reported = bodyOf(evidence[0])
    expect(reported.protocolReceiptHeaderName).toBe(`_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`)
    expect(JSON.parse(atob(reported.protocolReceiptHeader as string))).toEqual(settlement)
  })

  it('S1 control: a PAYMENT-RESPONSE header still wins over _meta on the local retry', async () => {
    const fetchMock = mockFetch(paidRoutes(() =>
      json(rpcResult(2, { content: [], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xmeta' } } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ transaction: '0xheader' })) } }),
    ))
    await newClient().fetch(mcpUrl, { method: 'POST', body: toolCall(2) })
    const reported = bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])
    expect(reported.protocolReceiptHeaderName).toBe('PAYMENT-RESPONSE')
    expect(JSON.parse(atob(reported.protocolReceiptHeader as string))).toEqual({ transaction: '0xheader' })
  })

  it('doc r2: a tool-result challenge carrying extensions.bazaar on a non-/mcp URL triggers the handshake, and the retry carries the session', async () => {
    const bazaarUrl = 'https://api.merchant.example/v1'
    const fetchMock = mockFetch((url, init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(bazaarUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== bazaarUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-bz')
      if (method === 'notifications/initialized') return notificationAccepted()
      const body = JSON.parse(init?.body as string) as { params: { _meta?: Record<string, unknown> } }
      if (body.params._meta?.[MCP_X402_PAYMENT_META_KEY]) return json(rpcResult(2, { content: [{ type: 'text', text: 'paid' }] }))
      const challenge = nativeChallenge(bazaarUrl)
      ;(challenge.structuredContent as Record<string, unknown>).extensions = { bazaar: { info: { input: {} } } }
      return json(rpcResult(2, challenge))
    })
    await newClient().fetch(bazaarUrl, { method: 'POST', body: toolCall(2) })
    expect(fetchMock.mock.calls.some(isInitializeCall)).toBe(true)
    const paid = fetchMock.mock.calls.filter((c) => methodOf(c) === 'tools/call').at(-1)!
    expect(headersOf(paid).get('mcp-session-id')).toBe('sess-bz')
  })

  it('doc r2: after a tool-result challenge on a plain URL (no session) the paid retry\'s SSE is collapsed to the result', async () => {
    const plainUrl = 'https://api.merchant.example/paid-tool'
    mockFetch((url, init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(plainUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== plainUrl || method !== 'tools/call') return undefined
      const body = JSON.parse(init?.body as string) as { params: { _meta?: Record<string, unknown> } }
      if (body.params._meta?.[MCP_X402_PAYMENT_META_KEY]) return sseResponse(sse(rpcResult(2, { content: [{ type: 'text', text: 'paid over sse' }] })))
      return json(rpcResult(2, nativeChallenge(plainUrl)))
    })
    const response = await newClient().fetch(plainUrl, { method: 'POST', body: toolCall(2) })
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({ content: [{ type: 'text', text: 'paid over sse' }] })
  })

  it('code r3 pin: a non-402 SSE pass-through with no session is returned byte-identical — never collapsed to its last frame', async () => {
    // The stream ends in a frame that LOOKS like a JSON-RPC result, so an
    // unconditional collapse would reduce the whole stream to `{"x":1}`; only
    // the session gate keeps it raw.
    const wire = 'event: token\ndata: {"delta":"Hel"}\n\nevent: token\ndata: {"delta":"lo"}\n\nevent: done\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n'
    mockFetch((url) => (url === 'https://api.merchant.example/stream-sse' ? sseResponse(wire) : undefined))
    const response = await newClient().fetch('https://api.merchant.example/stream-sse')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    await expect(response.text()).resolves.toBe(wire)
  })

  it('code r3: a paid retry whose SSE carries no JSON-RPC result is returned as it came, not reduced to its last frame', async () => {
    const plainUrl = 'https://api.merchant.example/paid-stream'
    const wire = 'data: {"delta":"pai"}\n\ndata: {"delta":"d!"}\n\n'
    mockFetch((url, init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(plainUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== plainUrl || method !== 'tools/call') return undefined
      const body = JSON.parse(init?.body as string) as { params: { _meta?: Record<string, unknown> } }
      if (body.params._meta?.[MCP_X402_PAYMENT_META_KEY]) return sseResponse(wire)
      return json(rpcResult(2, nativeChallenge(plainUrl)))
    })
    const response = await newClient().fetch(plainUrl, { method: 'POST', body: toolCall(2) })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    await expect(response.text()).resolves.toBe(wire)
  })

  it('S2: a non-JSON, non-SSE 200 is returned at once with its body untouched — a never-ending stream is not buffered', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulled += 1
        return new Promise(() => undefined) // never closes
      },
    })
    mockFetch((url) => (url === 'https://api.merchant.example/stream' ? new Response(stream, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }) : undefined))
    const started = Date.now()
    const response = await Promise.race([
      newClient().fetch('https://api.merchant.example/stream'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetch() did not resolve — the body was buffered')), 1000)),
    ])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(response.status).toBe(200)
    expect(response.bodyUsed).toBe(false)
    expect(pulled).toBeLessThanOrEqual(1)
    await response.body?.cancel()
  })

  it('S2: the same guard on quoteX402 — a text/plain 200 is the typed unexpected-status error without reading the body', async () => {
    mockFetch((url) => (url === 'https://api.merchant.example/plain' ? new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }) : undefined))
    await expect(newClient().quoteX402('https://api.merchant.example/plain')).rejects.toBeInstanceOf(X402UnexpectedStatusError)
  })
})

// ── #3155 partner review: the probe is gated on a tools/call request; mcp:// resources ──

describe('#3155 partner review — the tool-result probe runs only for a JSON-RPC tools/call request', () => {
  const apiUrl = 'https://api.merchant.example/data'
  /** A 200 whose JSON body is SHAPED like a native challenge — but the request was a plain GET, so it cannot be one. */
  const lookalike = () => json(rpcResult(1, nativeChallenge(apiUrl)))

  it('quoteX402 on a plain GET: the body is not read and the answer is the typed unexpected-status error', async () => {
    let served: Response | undefined
    mockFetch((url) => (url === apiUrl ? (served = lookalike()) : undefined))
    await expect(newClient().quoteX402(apiUrl)).rejects.toBeInstanceOf(X402UnexpectedStatusError)
    expect(served?.bodyUsed).toBe(false)
  })

  it('fetch() on a plain GET returns the 200 untouched and creates no payment', async () => {
    let served: Response | undefined
    const fetchMock = mockFetch((url) => (url === apiUrl ? (served = lookalike()) : undefined))
    const response = await newClient().fetch(apiUrl)
    expect(response.status).toBe(200)
    expect(served?.bodyUsed).toBe(false)
    await expect(response.json()).resolves.toMatchObject({ jsonrpc: '2.0', result: { isError: true } })
    expect(backendCalls(fetchMock, '/x402')).toHaveLength(0)
  })

  it('the same body on a tools/call POST IS a challenge (control)', async () => {
    mockFetch((url) => (url === apiUrl ? lookalike() : undefined))
    const quote = await newClient().quoteX402(apiUrl, { method: 'POST', body: toolCall('c') })
    expect(quote.amountAtomic).toBe('20000')
  })

  it('isJsonRpcToolsCallBody: only a string JSON-RPC tools/call with object params', () => {
    expect(isJsonRpcToolsCallBody(toolCall(1))).toBe(true)
    expect(isJsonRpcToolsCallBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBe(false)
    expect(isJsonRpcToolsCallBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }))).toBe(false)
    expect(isJsonRpcToolsCallBody('{}')).toBe(false)
    expect(isJsonRpcToolsCallBody(undefined)).toBe(false)
    expect(isJsonRpcToolsCallBody(new URLSearchParams({ a: '1' }))).toBe(false)
  })
})

describe('#3155 partner review — the spec\'s canonical mcp://tool/<name> resource', () => {
  const mcpResource = 'mcp://tool/paid_tool'
  function mcpChallenge(): Record<string, unknown> {
    const c = nativeChallenge(mcpUrl)
    ;(c.structuredContent as Record<string, unknown>).resource = { url: mcpResource, description: 'paid tool', mimeType: 'application/json' }
    ;(c.content as Array<{ type: string; text: string }>)[0].text = JSON.stringify(c.structuredContent)
    return c
  }

  it('quoteMcpX402 quotes it, keeping the mcp:// resource url and the merchant URL as the retry target', async () => {
    mockFetch((url, _init, method) => {
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-m')
      if (method === 'notifications/initialized') return notificationAccepted()
      return json(rpcResult('q', mcpChallenge()))
    })
    const quote = await newKeylessHostedClient().quoteMcpX402(mcpUrl, { method: 'POST', body: toolCall('q') })
    expect(quote.resourceUrl).toBe(mcpResource)
    expect(quote.request.url).toBe(mcpUrl)
    expect(quote.amountAtomic).toBe('20000')
  })

  it('fetch() pays an mcp:// resource end to end and retries the merchant URL with the payment in _meta', async () => {
    let paid = false
    const fetchMock = mockFetch((url, init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(mcpResource)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-m2')
      if (method === 'notifications/initialized') return notificationAccepted()
      if (method === 'tools/call') {
        const body = JSON.parse(init?.body as string) as { params: { _meta?: Record<string, unknown> } }
        if (body.params._meta?.[MCP_X402_PAYMENT_META_KEY]) {
          paid = true
          return json(rpcResult(2, { content: [{ type: 'text', text: 'paid' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xmcp' } } }))
        }
        return json(rpcResult(2, mcpChallenge()))
      }
      return undefined
    })
    const response = await newClient().fetch(mcpUrl, { method: 'POST', body: toolCall(2) })
    expect(paid).toBe(true)
    expect(response.status).toBe(200)
    const authorize = backendCalls(fetchMock, '/x402')
    expect(authorize).toHaveLength(1)
    // The mcp:// resource reaches Haven's authorize call as the resource, whatever the wire key.
    expect(JSON.stringify(bodyOf(authorize[0]))).toContain('mcp://tool/paid_tool')
  })
})

describe('#3155 review r6 — the POST-payment read is not gated on the request body', () => {
  const plainUrl = 'https://api.merchant.example/paid-data'
  /** HTTP-402 challenge on a plain GET (header dialect), then a profile-style refusal on the paid answer. */
  function mixedRoutes(paidAnswer: () => Response): Route {
    return (url, init) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(plainUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== plainUrl) return undefined
      const headers = new Headers(init?.headers)
      if (headers.get('PAYMENT-SIGNATURE') || headers.get('X-PAYMENT')) return paidAnswer()
      return json(paymentRequiredFor(plainUrl), { status: 402 })
    }
  }

  it('an isError payment-required on the paid GET answer is the post-funding rejection (402, reconciliation event, no evidence)', async () => {
    const fetchMock = mockFetch(mixedRoutes(() => json(rpcResult(2, nativeChallenge(plainUrl)))))
    await expect(newClient().fetch(plainUrl)).rejects.toMatchObject({ statusCode: 402, body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding' }) })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('a _meta success:false on the paid GET answer is the same rejection', async () => {
    const fetchMock = mockFetch(mixedRoutes(() => json(rpcResult(2, { content: [], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false } } }))))
    await expect(newClient().fetch(plainUrl)).rejects.toMatchObject({ statusCode: 402 })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
  })

  it('control: a real paid answer on the GET path still resolves with evidence', async () => {
    const fetchMock = mockFetch(mixedRoutes(() => json({ data: 'paid' })))
    const response = await newClient().fetch(plainUrl)
    expect(response.status).toBe(200)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(1)
  })
})

// ── Client: local fetch() ─────────────────────────────────────────

describe('#3118 native MCP profile — fetch()', () => {
  it('pays a native HTTP-200 challenge on an MCP session and retries with the payment in _meta', async () => {
    let paidSeen = false
    const fetchMock = mockFetch((url, init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(mcpUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-f')
      if (method === 'notifications/initialized') return notificationAccepted()
      if (method === 'tools/call') {
        const body = JSON.parse(init?.body as string) as { params: { _meta?: Record<string, unknown> } }
        if (body.params._meta?.[MCP_X402_PAYMENT_META_KEY]) {
          paidSeen = true
          return sseResponse(sse(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: '0xsettle' } } })))
        }
        return json(rpcResult(2, nativeChallenge(mcpUrl)))
      }
      return undefined
    })
    const response = await newClient().fetch(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: toolCall(2) })
    expect(paidSeen).toBe(true)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ content: [{ type: 'text', text: 'paid answer' }] })
    const paid = fetchMock.mock.calls.filter((c) => methodOf(c) === 'tools/call').at(-1)!
    expect(headersOf(paid).get('PAYMENT-SIGNATURE')).toBeTruthy()
    expect(headersOf(paid).get('mcp-session-id')).toBe('sess-f')
    expect(backendCalls(fetchMock, '/x402')).toHaveLength(1)
  })

  it('returns an ordinary HTTP-200 tool error unchanged — no payment is created', async () => {
    const fetchMock = mockFetch((url, _init, method) => {
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-o')
      if (method === 'notifications/initialized') return notificationAccepted()
      return json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'unknown tool' }] }))
    })
    const response = await newClient().fetch(mcpUrl, { method: 'POST', body: toolCall(2) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: { isError: true } })
    expect(backendCalls(fetchMock, '/x402')).toHaveLength(0)
  })

  it('a paid retry answered HTTP 200 with a payment-required tool result is a rejection after funding, thrown as 402', async () => {
    const fetchMock = mockFetch((url, _init, method) => {
      if (url === `${backendUrl}/x402`) return fundingPendingSignature(mcpUrl)
      if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
      if (url !== mcpUrl) return undefined
      if (method === 'initialize') return initializeOk('sess-r')
      if (method === 'notifications/initialized') return notificationAccepted()
      return json(rpcResult(2, nativeChallenge(mcpUrl)))
    })
    const attempt = newClient().fetch(mcpUrl, { method: 'POST', body: toolCall(2) })
    await expect(attempt).rejects.toMatchObject({
      statusCode: 402,
      body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding', payment_id: 'pay_123', merchant_status: 200 }),
    })
    expect(fetchMock.mock.calls.filter((c) => methodOf(c) === 'tools/call')).toHaveLength(2)
  })
})
