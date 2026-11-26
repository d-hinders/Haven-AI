import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiError, type X402PaymentOption } from './types.js'
import { MCP_ACCEPT, McpMerchantTransport } from './mcp-merchant-transport.js'
import { HOSTED_EGRESS_TIMEOUTS, HOSTED_MAX_GET_REDIRECTS, HOSTED_RESPONSE_BYTE_CAPS, type MerchantEgressPolicy } from './merchant-egress.js'

/**
 * #5089: a stateless streamable-HTTP MCP server — one that answers
 * `initialize` with a valid result and NO `Mcp-Session-Id` (common on
 * serverless hosts; Haven's own hosted MCP server is one). The hosted quote
 * and completion accept it and send `Accept` on every MCP request; the local
 * `fetch()` keeps its published behaviour (standard x402 without a session).
 * Anything that is not a real `initialize` result stays "no MCP endpoint".
 */

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}
const backendUrl = 'https://haven.example'
const mcpUrl = 'https://stateless.merchant.example/mcp'
const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'

const challenge = { x402Version: 2, error: 'Payment required', resource: { url: mcpUrl }, accepts: [accepted] }

type InitializeAnswer =
  | 'stateless'
  | 'stateless-sse'
  | 'json-not-initialize'
  | 'html'
  | 'jsonrpc-error'
  | 'wrong-id'
  | 'wrong-jsonrpc'
  | 'no-protocol-version'
  | 'large-html'
  | 'large-json'

interface Call { url: string; method: string; body: Record<string, any> | null; headers: Headers }

/** A routed fetch: Haven's agent read, and an MCP merchant whose initialize answers as asked. */
function installMerchant(answer: InitializeAnswer, opts: { require406?: boolean } = {}) {
  const calls: Call[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : null
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body, headers })
    if (url.startsWith(`${backendUrl}/machine-payments/agent`)) {
      return new Response(JSON.stringify({ id: 'agt_1', name: 'a', status: 'active', delegate_address: delegateAddress, chain_id: 8453 }), { status: 200 })
    }
    if (url === mcpUrl && body?.method === 'initialize') {
      if (answer === 'html') return new Response('<html>hello</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      // Over the hosted 256 KiB mcpSession cap.
      if (answer === 'large-html') return new Response(`<html>${'x'.repeat(300_000)}</html>`, { status: 200, headers: { 'Content-Type': 'text/html' } })
      if (answer === 'large-json') return new Response(JSON.stringify({ pad: 'x'.repeat(300_000) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (answer === 'json-not-initialize') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (answer === 'jsonrpc-error') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'nope' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const id = answer === 'wrong-id' ? Number(body.id) + 1000 : body.id
      const jsonrpc = answer === 'wrong-jsonrpc' ? '1.0' : '2.0'
      const result = answer === 'no-protocol-version'
        ? { capabilities: {}, serverInfo: { name: 'stateless' } }
        : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stateless' } }
      const message = { jsonrpc, id, result }
      if (answer === 'stateless-sse') {
        return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify(message), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === mcpUrl && body?.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (url === mcpUrl && body?.method === 'tools/call') {
      // A strict stateless streamable-HTTP server: no Accept, no service.
      if (opts.require406 && !(headers.get('Accept') ?? '').includes('text/event-stream')) {
        return new Response('Not Acceptable', { status: 406 })
      }
      return new Response(JSON.stringify(challenge), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: `unrouted ${url}` }), { status: 404 })
  })
  return calls
}

const keyless = () => new HavenClient({ apiKey: 'sk_agent_test', baseUrl: backendUrl })
const toolsCall = (calls: Call[]) => calls.filter((c) => c.url === mcpUrl && c.body?.method === 'tools/call')
const notifications = (calls: Call[]) => calls.filter((c) => c.url === mcpUrl && c.body?.method === 'notifications/initialized')
const init = (): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'haiku', arguments: {} } }),
})

describe('#5089 McpMerchantTransport.handshake — a stateless server is told apart from a failure', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a valid initialize result with no session id is stateless; notifications/initialized follows, without a session header', async () => {
    const calls = installMerchant('stateless')
    const transport = new McpMerchantTransport()
    expect(await transport.handshake(mcpUrl)).toEqual({ stateless: true })
    expect(notifications(calls)).toHaveLength(1)
    expect(notifications(calls)[0].headers.has('mcp-session-id')).toBe(false)
  })

  it('a valid initialize result framed as an event stream is stateless too', async () => {
    installMerchant('stateless-sse')
    expect(await new McpMerchantTransport().handshake(mcpUrl)).toEqual({ stateless: true })
  })

  it('initialize() still answers undefined for a stateless server (the local fetch() keeps standard x402)', async () => {
    installMerchant('stateless')
    expect(await new McpMerchantTransport().initialize(mcpUrl)).toBeUndefined()
  })

  for (const answer of ['json-not-initialize', 'html', 'jsonrpc-error', 'wrong-id', 'wrong-jsonrpc', 'no-protocol-version'] as const) {
    it(`${answer}: not an MCP endpoint (undefined), and no notification`, async () => {
      const calls = installMerchant(answer)
      expect(await new McpMerchantTransport().handshake(mcpUrl)).toBeUndefined()
      expect(notifications(calls)).toHaveLength(0)
    })
  }

  // Reviewer finding: under the hosted caps a session-less answer over 256 KiB
  // must stay "not an MCP endpoint" (so #1271 discovery runs), never a cap
  // refusal — an HTML page is left unread, a claimed-JSON body that trips
  // the cap is treated as no initialize result.
  const hostedCaps = (): MerchantEgressPolicy => ({
    assertUrl: () => {},
    maxResponseBytes: HOSTED_RESPONSE_BYTE_CAPS.delivery,
    responseByteCaps: { ...HOSTED_RESPONSE_BYTE_CAPS },
    maxGetRedirects: HOSTED_MAX_GET_REDIRECTS,
    timeouts: { ...HOSTED_EGRESS_TIMEOUTS },
  })
  for (const answer of ['large-html', 'large-json'] as const) {
    it(`${answer} under the hosted response cap: not an MCP endpoint (undefined), never a cap refusal`, async () => {
      installMerchant(answer)
      const outcome = await new McpMerchantTransport({ egress: hostedCaps() }).handshake(mcpUrl).catch((e: unknown) => e)
      expect(outcome).toBeUndefined()
    })
  }

  it('withMcpHeaders adds Accept on a stateless handshake and the session headers on a stateful one', () => {
    const transport = new McpMerchantTransport()
    const stateless = new Headers(transport.withMcpHeaders({ headers: { 'Content-Type': 'application/json' } }, { stateless: true }).headers)
    expect(stateless.get('Accept')).toBe(MCP_ACCEPT)
    expect(stateless.has('mcp-session-id')).toBe(false)
    const stateful = new Headers(transport.withMcpHeaders(undefined, { stateless: false, sessionId: 'sess-1' }).headers)
    expect(stateful.get('Accept')).toBe(MCP_ACCEPT)
    expect(stateful.get('mcp-session-id')).toBe('sess-1')
  })
})

describe('#5089 quoteMcpX402 against a stateless server', () => {
  afterEach(() => vi.restoreAllMocks())

  it('quotes: the unpaid tools/call carries Accept (and no session header), and the snapshot keeps it for the paid retry', async () => {
    const calls = installMerchant('stateless', { require406: true })
    const quote = await keyless().quoteMcpX402(mcpUrl, init())
    const probe = toolsCall(calls)
    expect(probe).toHaveLength(1)
    expect(probe[0].headers.get('Accept')).toBe(MCP_ACCEPT)
    expect(probe[0].headers.has('mcp-session-id')).toBe(false)
    expect(quote.paymentRequired.accepts[0].payTo).toBe(accepted.payTo)
    expect(new Headers(quote.request.headers as HeadersInit).get('Accept')).toBe(MCP_ACCEPT)
    expect(quote.mcpTransport?.handshakeRequired).toBe(true)
  })

  for (const answer of ['json-not-initialize', 'html', 'jsonrpc-error'] as const) {
    it(`${answer}: still refuses with the unchanged 502 (mcpSessionNotEstablished), before any tools/call`, async () => {
      const calls = installMerchant(answer)
      const err = await keyless().quoteMcpX402(mcpUrl, init()).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HavenApiError)
      expect((err as HavenApiError).statusCode).toBe(502)
      expect((err as Error).message).toBe('The merchant did not establish an MCP session before the x402 quote. No payment was created.')
      expect((err as HavenApiError).body).toMatchObject({ mcpSessionNotEstablished: true })
      expect(toolsCall(calls)).toHaveLength(0)
    })
  }
})

describe('#5089 the local fetch() against a stateless server keeps today\'s behaviour', () => {
  afterEach(() => vi.restoreAllMocks())

  it('probes as standard x402 (no MCP Accept added), not as an MCP session', async () => {
    const calls = installMerchant('stateless')
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: `0x${'01'.repeat(32)}`, baseUrl: backendUrl })
    // Authorize is unrouted (404), so the paid leg stops there; the probe is what is pinned.
    await haven.fetch(mcpUrl, init()).catch(() => undefined)
    const probe = toolsCall(calls)
    expect(probe.length).toBeGreaterThan(0)
    expect(probe[0].headers.has('Accept')).toBe(false)
    expect(probe[0].headers.has('mcp-session-id')).toBe(false)
  })
})
