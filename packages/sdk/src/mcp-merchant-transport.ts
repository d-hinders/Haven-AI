import type { X402McpTransport, X402PaymentRequired } from './types.js'
import { MerchantTimeoutError } from './types.js'
import { decodeBase64Json, encodeBase64Json } from './base64.js'
import { X402_PAYMENT_HEADER_NAMES, normalizePaymentRequired, x402PaymentHeaderNamesFor } from './x402.js'
import { assertSecureX402RetryTarget } from './x402-retry-target.js'

export const DEFAULT_MERCHANT_TIMEOUT = 300_000
export const MCP_NOTIFICATION_TIMEOUT = 10_000
export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MCP_ACCEPT = 'application/json, text/event-stream'

const MCP_CLIENT_INFO = { name: 'haven-sdk', version: '1' } as const

/**
 * #3118: the official x402 MCP transport profile
 * (x402-foundation/x402 `specs/transports-v2/mcp.md`). A merchant following
 * it never answers HTTP 402: the challenge is a tool RESULT with
 * `isError: true` carrying the `PaymentRequired` object as
 * `structuredContent` (and `JSON.stringify` of it as the text content for
 * clients without structured-content support); the payment travels back in
 * the tools/call request's `params._meta["x402/payment"]` as a JSON object
 * (the same envelope the `PAYMENT-SIGNATURE` header carries base64-encoded);
 * settlement comes back in `result._meta["x402/payment-response"]`.
 *
 * Haven's HTTP-402-over-MCP layering (the Streamable-HTTP status code plus
 * `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers) is a
 * valid, distinct integration and is retained unchanged; the profile below is
 * ADDED beside it. Delivery is dual: the header is always sent, and the
 * `_meta` object is added whenever the caller body is a `tools/call` request,
 * so a header-reading merchant and a `_meta`-reading merchant both see the
 * payment and neither has to be told which kind it is.
 */
export const MCP_X402_PAYMENT_META_KEY = 'x402/payment'
export const MCP_X402_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response'
/** The HTTP status an in-band (HTTP 200, `isError: true`) payment-required refusal is reported as. */
export const X402_RETRY_REJECTED_STATUS = 402

/** The settlement object a profile merchant returns in `result._meta["x402/payment-response"]`. */
export interface McpX402SettlementMeta {
  success: boolean
  transaction?: string
  network?: string
  payer?: string
  errorReason?: string
}

/**
 * #3171: the recovery data a merchant attaches to its unknown-session 404
 * (`-32001`) when it guarantees nothing was settled. Only this exact shape
 * licenses the SDK to re-initialize and resend the same payment header: the
 * guarantee is the merchant's, so it must be stated, never inferred from a
 * bare -32001.
 */
export const SESSION_NOT_FOUND_NEXT_ACTION = 'reinitialize_then_retry_same_payment_header'

export interface SessionNotFoundRecovery {
  reason: string
  settled: false
  next_action: typeof SESSION_NOT_FOUND_NEXT_ACTION
}

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
    // #3155 review r3: collapse only a real JSON-RPC result or error. A stream
    // whose frames are none of those (a paid SSE resource that is not MCP)
    // would otherwise be reduced to its LAST frame — returned untouched instead.
    if (!message || !('result' in message || 'error' in message)) return response

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

  /**
   * Deliver an already-signed x402 header without changing the caller body.
   *
   * #2289: x402 v2 reads `PAYMENT-SIGNATURE`; v1 reads `X-PAYMENT`. Sending
   * only the legacy name meant a strict v2 merchant never saw the header —
   * indistinguishable, from the merchant's side, from sending no header at
   * all, while on the EIP-3009 bridge the funding leg had already moved the
   * money.
   *
   * #2341: WHICH names go on is per-payload, not always both — see
   * `x402PaymentHeaderNamesFor`. Both for EIP-3009; `PAYMENT-SIGNATURE` alone
   * for erc7710, whose header carries a whole delegation chain and answered
   * HTTP 431 when duplicated. The decision is made here rather than by the
   * caller so every path inherits it, and it is read from the payload rather
   * than passed in, because a flag a caller supplies is a flag a caller can
   * get wrong.
   *
   * Always `set`, never `append`, so a stale header on the caller's `init` is
   * replaced rather than added to — a merchant that reads the first of two
   * values would otherwise verify a superseded authorization. The name NOT
   * being sent is deleted for the same reason: on erc7710 a stale `X-PAYMENT`
   * left in place would be a superseded authorization we chose not to
   * overwrite, which is worse than the duplicate this change removes.
   */
  async deliverPayment(
    url: string,
    init: RequestInit | undefined,
    paymentHeader: string,
  ): Promise<Response> {
    // #3097: the ONE seam every paid retry crosses (plain HTTP, MCP, resume).
    // A signed header never leaves for a public http:// target.
    assertSecureX402RetryTarget(url)
    const headers = new Headers(init?.headers)
    const send = x402PaymentHeaderNamesFor(paymentHeader)
    for (const name of X402_PAYMENT_HEADER_NAMES) {
      if (send.includes(name)) headers.set(name, paymentHeader)
      else headers.delete(name)
    }
    // #3118: a `tools/call` body additionally carries the payment in
    // `params._meta["x402/payment"]` (the official MCP profile). Any other
    // body is sent byte-for-byte as the caller gave it.
    return this.fetch(url, withMcpPaymentMeta({ ...init, headers }, paymentHeader))
  }

  /**
   * #3171: deliver the payment; if the merchant answers its unknown-session
   * 404 WITH the settled-nothing recovery data, re-initialize once and resend
   * the SAME header on the new session. The merchant's own guarantee (#1578:
   * the session guard runs before its payment gate) is what makes the resend
   * safe — a bare -32001, or any other 404, is returned to the caller
   * untouched (body re-wrapped, since reading it consumed the stream). One
   * recovery only: a second 404 is the answer.
   */
  async deliverPaymentRecoveringSession(
    url: string,
    init: RequestInit | undefined,
    paymentHeader: string,
    reinitialize: () => Promise<string | undefined>,
  ): Promise<Response> {
    const first = await this.deliverPayment(url, init, paymentHeader)
    if (first.status !== 404) return first
    let text: string
    try {
      text = await first.clone().text()
    } catch {
      return first
    }
    if (!sessionNotFoundRecovery(text)) return first
    const sessionId = await reinitialize()
    if (!sessionId) return first
    return this.deliverPayment(url, this.withSessionHeaders(init, sessionId), paymentHeader)
  }

  /**
   * #3118: read a native MCP payment-required tool result from a response
   * WITHOUT consuming it — JSON or SSE framed. `undefined` for anything that
   * is not an `isError: true` tool result carrying a valid `PaymentRequired`
   * (structured content first, text fallback second), so an ordinary tool
   * error, a successful result that merely resembles a challenge, or an
   * unparseable body is never mistaken for a payment demand.
   */
  async extractToolResultChallenge(response: Response, init?: RequestInit): Promise<X402PaymentRequired | undefined> {
    const toolResult = await this.readToolResult(response, init)
    return toolResult ? extractMcpPaymentRequired(toolResult) : undefined
  }

  /**
   * #3118: the tool RESULT a response carries, read WITHOUT consuming it, or
   * `undefined`. Only a JSON or SSE body is read at all (#3155 review S2):
   * a non-402 answer used to be returned untouched, and buffering an
   * arbitrary body — a streaming or binary paid resource — to look for a
   * challenge would block the caller until the stream ended or the merchant
   * timeout fired. A merchant that speaks JSON-RPC declares one of those two
   * content types.
   */
  async readToolResult(response: Response, init?: RequestInit): Promise<Record<string, unknown> | undefined> {
    // #3155 partner review: a native challenge can only answer a JSON-RPC
    // `tools/call` request, so when the request is known and is not one, the
    // body is not read at all — a plain `haven.fetch()` of a JSON API pays
    // nothing for this probe.
    if (init !== undefined && !isJsonRpcToolsCallBody(init.body)) return undefined
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.includes('application/json') && !contentType.includes('text/event-stream')) return undefined
    return mcpToolResultOf(await this.readMessage(response))
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

/**
 * #3118: the tool RESULT inside whatever shape a merchant body arrived in —
 * a raw JSON-RPC envelope (`{ jsonrpc, id, result }`), or an already-surfaced
 * result (`surfaceResult` collapses SSE to the bare `result`). `undefined`
 * when the value is neither.
 */
export function mcpToolResultOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if ('jsonrpc' in value) {
    return isRecord(value.result) ? value.result : undefined
  }
  if ('isError' in value || Array.isArray(value.content) || isRecord(value._meta)) return value
  return undefined
}

/**
 * #3118: the `PaymentRequired` a profile merchant put in an `isError: true`
 * tool result. `structuredContent` is preferred; the first text content item
 * that parses as JSON is the fallback. Both go through
 * `normalizePaymentRequired`, so a challenge with no payable `accepts` entry
 * is not a challenge at all.
 */
export function extractMcpPaymentRequired(toolResult: Record<string, unknown>): X402PaymentRequired | undefined {
  if (toolResult.isError !== true) return undefined
  if (isRecord(toolResult.structuredContent)) {
    const parsed = normalizePaymentRequired(toolResult.structuredContent)
    if (parsed) return parsed
  }
  if (Array.isArray(toolResult.content)) {
    for (const item of toolResult.content) {
      if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue
      let candidate: unknown
      try {
        candidate = JSON.parse(item.text)
      } catch {
        continue
      }
      const parsed = normalizePaymentRequired(candidate)
      if (parsed) return parsed
    }
  }
  return undefined
}

/**
 * #3118: the settlement object in `result._meta["x402/payment-response"]`,
 * or `undefined` when the result carries none (or one without a boolean
 * `success`, which is not a settlement statement the SDK will act on).
 */
export function mcpSettlementFromToolResult(toolResult: Record<string, unknown>): McpX402SettlementMeta | undefined {
  const meta = toolResult._meta
  if (!isRecord(meta)) return undefined
  const settlement = meta[MCP_X402_PAYMENT_RESPONSE_META_KEY]
  if (!isRecord(settlement) || typeof settlement.success !== 'boolean') return undefined
  return {
    success: settlement.success,
    ...(typeof settlement.transaction === 'string' ? { transaction: settlement.transaction } : {}),
    ...(typeof settlement.network === 'string' ? { network: settlement.network } : {}),
    ...(typeof settlement.payer === 'string' ? { payer: settlement.payer } : {}),
    ...(typeof settlement.errorReason === 'string' ? { errorReason: settlement.errorReason } : {}),
  }
}

/**
 * #3118: add `params._meta["x402/payment"]` to a `tools/call` request body.
 * The value is the decoded payment envelope (the header is base64 JSON of
 * exactly this object). Unrelated `_meta` keys, `arguments`, the id and the
 * method are preserved. Any body that is not a string-encoded JSON-RPC
 * `tools/call` request — form data, a stream, another method, no body — is
 * returned untouched, as is one whose header does not decode.
 *
 * The `tools/call` body IS re-serialised (`JSON.parse` → `JSON.stringify`),
 * so it is semantically, not byte-, identical: an integer above 2^53 in the
 * id or arguments is rounded by JavaScript's number type, and a caller-set
 * `Content-Length` header would go stale (the runtime recomputes it for a
 * string body). Neither half of the dual delivery is size-bounded here; on
 * erc7710 the decoded envelope is smaller than its base64 header, and only
 * the header half counts against the 16 KB header ceiling (#2341). On erc7710
 * the dual delivery therefore sends the delegation chain twice (header and
 * body) — stated, accepted, and the partner reviewer's to weigh.
 */
export function withMcpPaymentMeta(init: RequestInit, paymentHeader: string): RequestInit {
  const request = parseJsonRpcToolsCall(init.body)
  if (!request) return init
  let envelope: unknown
  try {
    envelope = decodeBase64Json<unknown>(paymentHeader)
  } catch {
    return init
  }
  if (!isRecord(envelope)) return init
  const params = request.params
  const existingMeta = isRecord(params._meta) ? params._meta : {}
  return {
    ...init,
    body: JSON.stringify({
      ...request,
      params: { ...params, _meta: { ...existingMeta, [MCP_X402_PAYMENT_META_KEY]: envelope } },
    }),
  }
}

/**
 * #3118: the `_meta` settlement re-encoded exactly as a `PAYMENT-RESPONSE`
 * header would carry it (base64 JSON), so the evidence report's receipt
 * payload goes through the one existing decoder whichever form arrived.
 */
export function encodeMcpSettlementReceipt(settlement: McpX402SettlementMeta): string {
  return encodeBase64Json(settlement)
}

/** #3155: the request body parsed as a JSON-RPC `tools/call` with an object `params`, else undefined. */
function parseJsonRpcToolsCall(body: unknown): (Record<string, unknown> & { params: Record<string, unknown> }) | undefined {
  if (typeof body !== 'string') return undefined
  let request: unknown
  try {
    request = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(request) || request.method !== 'tools/call' || !isRecord(request.params)) return undefined
  return request as Record<string, unknown> & { params: Record<string, unknown> }
}

/**
 * #3155: whether a request body is a JSON-RPC `tools/call` — the only request a
 * native challenge can answer. Decided boundaries: a `Uint8Array`/`Buffer`
 * body is NOT recognised (the quote path's `snapshotRequestBody` refuses
 * non-string bodies too), and neither is a JSON-RPC batch array, a
 * `resources/read`, or a `tools/call` without an object `params` — a paid
 * request in any of those shapes is returned as an ordinary answer and no
 * payment is created (safe direction; state it, do not widen it silently).
 */
export function isJsonRpcToolsCallBody(body: unknown): boolean {
  return parseJsonRpcToolsCall(body) !== undefined
}

/**
 * #3171: parse a merchant 404 body for the unknown-session recovery data.
 * `undefined` for anything else — a different code, a missing or
 * contradicting `data`, a non-JSON body.
 */
export function sessionNotFoundRecovery(body: string): SessionNotFoundRecovery | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined
  if (parsed.error.code !== -32001) return undefined
  const data = parsed.error.data
  if (!isRecord(data)) return undefined
  if (data.settled !== false || data.next_action !== SESSION_NOT_FOUND_NEXT_ACTION) return undefined
  return {
    reason: typeof data.reason === 'string' ? data.reason : 'session_expired',
    settled: false,
    next_action: SESSION_NOT_FOUND_NEXT_ACTION,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
