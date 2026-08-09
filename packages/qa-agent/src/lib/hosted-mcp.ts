/**
 * Minimal Streamable-HTTP MCP client for the **hosted** Haven MCP server (#1154).
 *
 * Why this exists rather than `@modelcontextprotocol/sdk`'s client: the QA
 * harness has to drive the hosted server exactly as a real agent runtime does —
 * bearer-authenticated JSON-RPC over one HTTP endpoint — and the thing under
 * test includes the *transport quirks* an agent runtime absorbs silently. A
 * client that hides those quirks would also hide a regression in them. The three
 * that matter, all observed against the live dev deployment:
 *
 *   1. **Session handshake.** `initialize` returns an `mcp-session-id` response
 *      header that every subsequent request must echo. Omit it and the server
 *      answers 400 for the second call, so a scenario that only ever made one
 *      call would never notice the session broke.
 *   2. **Two response encodings.** The same endpoint answers either SSE
 *      (`data: {...}` lines) or a plain JSON body, depending on the request and
 *      the server's negotiation. Both are valid; a client that handles only one
 *      fails intermittently and looks like a flaky merchant.
 *   3. **The result envelope is doubled.** MCP wraps the tool result in
 *      `content[].text`, and Haven's hosted tools wrap *their* payload again in
 *      `{ success, data }`. The `data` unwrap is the step every hand-written
 *      integration forgets; getting it wrong yields `undefined` fields that read
 *      as "the backend returned nothing".
 *
 * Read-only over HTTP; holds no key and signs nothing. Testnet/dev only.
 */

/** A hosted tool returned `{ success: false, … }` — the error the tool reported. */
export class HostedMcpToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
    readonly paymentId?: string,
  ) {
    super(`${tool} failed (${code}): ${message}`)
    this.name = 'HostedMcpToolError'
  }
}

/** The transport itself failed (HTTP status, unparseable body, JSON-RPC error). */
export class HostedMcpTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostedMcpTransportError'
  }
}

interface JsonRpcResponse {
  id?: number | string
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
  error?: { code?: number; message?: string }
}

/**
 * Parse one Streamable-HTTP response body into its JSON-RPC message.
 *
 * Accepts either a plain JSON body or an SSE stream, and inside an SSE stream
 * picks the LAST `data:` line that carries a JSON-RPC message. Last, not first:
 * the server may emit progress notifications ahead of the response, and taking
 * the first would return a notification as though it were the result.
 *
 * Exported for unit tests — the encodings are exactly the thing a live run
 * cannot cheaply exercise both halves of.
 */
export function parseStreamableHttpBody(body: string): JsonRpcResponse {
  const trimmed = body.trim()
  if (!trimmed) throw new HostedMcpTransportError('hosted MCP returned an empty body')

  // Plain JSON — the simple case.
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse
    } catch {
      throw new HostedMcpTransportError(`hosted MCP returned unparseable JSON: ${trimmed.slice(0, 200)}`)
    }
  }

  // SSE — scan `data:` lines, keep the last one that is a JSON-RPC message
  // (has `result` or `error`), ignoring notifications and keep-alives.
  let found: JsonRpcResponse | null = null
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse
      if (parsed.result !== undefined || parsed.error !== undefined) found = parsed
    } catch {
      /* not a JSON data line — keep scanning */
    }
  }
  if (!found) {
    throw new HostedMcpTransportError(
      `hosted MCP SSE body carried no JSON-RPC result: ${trimmed.slice(0, 200)}`,
    )
  }
  return found
}

/**
 * Unwrap the doubled envelope: MCP `content[].text` → Haven `{ success, data }`.
 *
 * A `success: false` payload is a TOOL-level refusal (policy, expiry, merchant
 * error) and is raised as {@link HostedMcpToolError} so a scenario can tell it
 * apart from a transport fault — the two mean completely different things when
 * a QA leg goes red.
 *
 * Exported for unit tests.
 */
export function unwrapToolPayload<T>(tool: string, response: JsonRpcResponse): T {
  if (response.error) {
    throw new HostedMcpTransportError(
      `hosted MCP JSON-RPC error on ${tool}: ${response.error.message ?? JSON.stringify(response.error)}`,
    )
  }
  const text = response.result?.content?.find((entry) => typeof entry.text === 'string')?.text
  if (!text) {
    throw new HostedMcpTransportError(
      `hosted MCP ${tool} returned no text content: ${JSON.stringify(response.result).slice(0, 200)}`,
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    // isError with a non-JSON body is how an unhandled server-side throw
    // surfaces; report the text rather than a parse failure.
    throw new HostedMcpTransportError(`hosted MCP ${tool} returned non-JSON content: ${text.slice(0, 200)}`)
  }
  const envelope = payload as { success?: boolean; data?: unknown; code?: string; message?: string; paymentId?: string }
  if (envelope.success === false) {
    throw new HostedMcpToolError(
      tool,
      envelope.code ?? 'UNKNOWN_ERROR',
      envelope.message ?? 'no message',
      envelope.paymentId,
    )
  }
  if (envelope.success === true) return envelope.data as T
  // No envelope at all — an older/other server shape. Return it verbatim rather
  // than inventing a `data` that isn't there.
  return payload as T
}

/**
 * Bearer-authenticated client for one hosted MCP endpoint.
 *
 * `initialize` is performed lazily on the first tool call, so constructing the
 * client does no I/O and a scenario's skip guards run before any network hop.
 */
export class HostedMcpClient {
  private sessionId: string | null = null
  private initialized = false
  private nextId = 1

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  /** Server identity from the `initialize` handshake, e.g. `@haven_ai/mcp-server@0.1.18-alpha.0`. */
  serverInfo: { name?: string; version?: string } | null = null

  private async post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Both encodings are advertised because the server picks one; see the
      // module comment.
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.apiKey}`,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    return fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'haven-qa-agent', version: '0.0.0' },
      },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new HostedMcpTransportError(
        `hosted MCP initialize returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    // Captured BEFORE parsing: without it every later call 400s, and the
    // resulting failure names the tool rather than the handshake.
    this.sessionId = res.headers.get('mcp-session-id')
    const parsed = parseStreamableHttpBody(text)
    if (parsed.error) {
      throw new HostedMcpTransportError(`hosted MCP initialize failed: ${parsed.error.message}`)
    }
    this.serverInfo =
      (parsed.result as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo ?? null
    this.initialized = true
    // The spec requires the notification after initialize; the hosted server
    // tolerates its absence today, but a client that skips it is not modelling
    // a real runtime.
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)
  }

  /** Call a hosted tool and return its unwrapped `data` payload. */
  async callTool<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    await this.initialize()
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new HostedMcpTransportError(
        `hosted MCP ${tool} returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    return unwrapToolPayload<T>(tool, parseStreamableHttpBody(text))
  }
}

/** The `x402.expected` signing context the hosted quote hands to the local signer. */
export interface HostedX402Expected {
  payment_id: string
  payload_hash: string
  resource_url: string
  merchant_to: string
  amount: string
  asset: string
  network: string
  expires_at: string
  /** #1138: present ⇒ delegation-rail (v2) context; the signer must sign typed data. */
  typed_data_hash?: string
  auth: { version: number; message: string; signature: string; signer: string }
}

/** `haven_pay_mcp_tool`'s result, as far as this scenario needs it. */
export interface HostedPayMcpToolResult {
  payment_id: string
  status?: string
  payload_hash: string | null
  expires_at?: string
  signature_scheme?: string
  typed_data?: Record<string, unknown>
  x402?: { expected?: HostedX402Expected }
  payment_required?: Record<string, unknown>
  amount_atomic?: string
  amount?: string
  token?: string
  mcp_transport?: { handshake_required: boolean; source: 'path' | 'bazaar' }
}

/** `haven_settle_mcp_tool`'s result. */
export interface HostedSettleMcpToolResult {
  payment_id?: string
  funding_status?: string
  funding_tx_hash?: string | null
  settled?: boolean
  settlement_tx_hash?: string | null
  result?: unknown
}
