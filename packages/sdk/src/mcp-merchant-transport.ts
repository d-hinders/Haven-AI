import type { X402McpTransport, X402PaymentRequired } from './types.js'
import { MerchantTimeoutError } from './types.js'

export const DEFAULT_MERCHANT_TIMEOUT = 300_000
export const MCP_NOTIFICATION_TIMEOUT = 10_000
export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MCP_ACCEPT = 'application/json, text/event-stream'

const MCP_CLIENT_INFO = { name: 'haven-sdk', version: '1' } as const

export interface CapturedMerchantResponse {
  merchant_status: number
  merchant_status_text: string
  merchant_headers: Record<string, string>
  merchant_body: string
}

type MerchantFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface McpMerchantTransportOptions {
  merchantTimeout?: number
  fetch?: MerchantFetch
}

/**
 * Per-client MCP-over-HTTP merchant wire transport.
 *
 * This internal seam owns only protocol framing and bounded delivery. It does
 * not create payment authority: callers pass a public wallet address and an
 * already-signed, exact-context-bound payment header.
 */
export class McpMerchantTransport {
  private readonly merchantTimeout: number
  private readonly fetchImpl: MerchantFetch
  private requestId = 0

  constructor(options: McpMerchantTransportOptions = {}) {
    this.merchantTimeout = options.merchantTimeout ?? DEFAULT_MERCHANT_TIMEOUT
    // Resolve the global at call time, matching the former client helper and
    // preserving the SDK's established fetch-mocking/polyfill seam.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  /** Fetch a merchant with a settlement-sized timeout and caller cancellation. */
  async fetch(url: string, init: RequestInit = {}, timeoutMs = this.merchantTimeout): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
    try {
      return await this.fetchImpl(url, { ...init, signal })
    } catch (err) {
      if (timeoutSignal.aborted) {
        throw new MerchantTimeoutError(`Merchant request timed out after ${timeoutMs}ms: ${url}`)
      }
      throw err
    }
  }

  /**
   * Establish an MCP Streamable-HTTP session. Any handshake failure degrades
   * to `undefined`, allowing the caller to fall back to plain x402.
   */
  async initialize(
    url: string,
    init?: RequestInit,
    wallet?: string,
  ): Promise<string | undefined> {
    try {
      const headers = new Headers(init?.headers)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', MCP_ACCEPT)
      if (wallet && !headers.has('x402-wallet')) headers.set('x402-wallet', wallet)

      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO,
          },
        }),
      })

      if (!response.ok) return undefined

      const sessionId = response.headers.get('mcp-session-id')
      if (!sessionId) return undefined

      const message = await this.readMessage(response)
      if (message && 'error' in message) return undefined

      await this.notifyInitialized(url, init, sessionId, wallet)
      return sessionId
    } catch {
      return undefined
    }
  }

  /** Add the MCP session and response-content negotiation headers. */
  withSessionHeaders(init: RequestInit | undefined, sessionId: string): RequestInit {
    const headers = new Headers(init?.headers)
    headers.set('mcp-session-id', sessionId)
    headers.set('Accept', MCP_ACCEPT)
    return { ...init, headers }
  }

  /** Read one JSON-RPC message from a JSON or SSE response without consuming it. */
  async readMessage(response: Response): Promise<Record<string, unknown> | undefined> {
    let text: string
    try {
      text = await response.clone().text()
    } catch {
      return undefined
    }

    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return selectJsonRpcResult(parseSseJsonRpcMessages(text))
    }

    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  /**
   * Collapse an MCP SSE response to the JSON-RPC result. Non-SSE and
   * unparseable responses pass through with their original body untouched.
   */
  async surfaceResult(response: Response): Promise<Response> {
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return response
    }

    let text: string
    try {
      text = await response.clone().text()
    } catch {
      return response
    }

    const message = selectJsonRpcResult(parseSseJsonRpcMessages(text))
    if (!message) return response

    const body = 'result' in message ? message.result : message
    const headers = new Headers(response.headers)
    headers.set('content-type', 'application/json')
    headers.delete('content-length')
    headers.delete('mcp-session-id')

    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  /** Detect MCP transport from the URL or Coinbase Bazaar extension. */
  async detect(
    url: string,
    paymentRequired: X402PaymentRequired,
    response: Response,
  ): Promise<X402McpTransport | undefined> {
    if (isMcpUrl(url)) return { handshakeRequired: true, source: 'path' }
    if (paymentRequired.extensions?.bazaar != null) {
      return { handshakeRequired: true, source: 'bazaar' }
    }
    if (await responseHasBazaarExtension(response)) {
      return { handshakeRequired: true, source: 'bazaar' }
    }
    return undefined
  }

  /** Identify the conventional Streamable-HTTP MCP path without probing it. */
  isMcpUrl(url: string): boolean {
    return isMcpUrl(url)
  }

  /** Detect Bazaar metadata without consuming the merchant response. */
  hasBazaarExtension(response: Response): Promise<boolean> {
    return responseHasBazaarExtension(response)
  }

  /** Deliver an already-signed x402 header without changing the caller body. */
  async deliverPayment(
    url: string,
    init: RequestInit | undefined,
    paymentHeader: string,
  ): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('X-PAYMENT', paymentHeader)
    return this.fetch(url, { ...init, headers })
  }

  private async notifyInitialized(
    url: string,
    init: RequestInit | undefined,
    sessionId: string,
    wallet?: string,
  ): Promise<void> {
    try {
      const headers = new Headers(init?.headers)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', MCP_ACCEPT)
      headers.set('mcp-session-id', sessionId)
      if (wallet && !headers.has('x402-wallet')) headers.set('x402-wallet', wallet)

      await this.fetch(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        },
        MCP_NOTIFICATION_TIMEOUT,
      )
    } catch {
      // The session is established. Notification delivery remains best-effort.
    }
  }
}

/** Consume and preserve every diagnostic field of a failed merchant response. */
export async function captureMerchantResponse(
  response: Response,
): Promise<CapturedMerchantResponse> {
  const merchant_body = await response.text().catch(() => '')
  return {
    merchant_status: response.status,
    merchant_status_text: response.statusText,
    merchant_headers: Object.fromEntries(response.headers.entries()),
    merchant_body,
  }
}

function isMcpUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/mcp')
  } catch {
    return /\/mcp(?:[/?#]|$)/.test(url)
  }
}

async function responseHasBazaarExtension(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { extensions?: { bazaar?: unknown } } | null
    return body?.extensions?.bazaar != null
  } catch {
    return false
  }
}

function parseSseJsonRpcMessages(text: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  let dataLines: string[] = []

  const flush = (): void => {
    if (dataLines.length === 0) return
    try {
      messages.push(JSON.parse(dataLines.join('\n')) as Record<string, unknown>)
    } catch {
      // Ignore keep-alives and non-JSON data frames.
    }
    dataLines = []
  }

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  flush()

  return messages
}

function selectJsonRpcResult(
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return messages.find((message) => 'result' in message || 'error' in message) ?? messages.at(-1)
}
