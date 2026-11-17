/**
 * Forwarding a settled payment's request to the upstream
 * (docs/architecture/12-merchant-kit.md §7, §6 "What the upstream call failed
 * means"). Called only after settlement is confirmed; it is the only place the
 * upstream key is ever put on a request.
 */
import type { ProxyConfig } from './config.js'

/** Request headers removed before forwarding (§7). Compared lower-case. */
export const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set(
  [
    'PAYMENT-SIGNATURE',
    'X-PAYMENT',
    'X-Tax-Declaration',
    'SIGN-IN-WITH-X',
    'Authorization',
    'Cookie',
    'Proxy-Authorization',
    'Host',
    'Content-Length',
    'Transfer-Encoding',
    'Connection',
    'Keep-Alive',
    'TE',
    'Trailer',
    'Upgrade',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'Forwarded',
    'X-Real-IP',
    'x402-wallet',
    'mcp-session-id',
  ].map((h) => h.toLowerCase()),
)

/** Response headers never passed to the buyer: the upstream's payment and receipt headers (§7), and framing the proxy re-does. */
export const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'payment-required',
  'payment-response',
  'x-receipt-json',
  'x-receipt-url',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'trailer',
  'upgrade',
])

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export type UpstreamFailureReason =
  | 'upstream_timeout'
  | 'upstream_unreachable'
  | 'upstream_status'
  | 'upstream_auth_refused'
  | 'response_too_large'
  | 'buyer_disconnected'

export type UpstreamResult =
  | { kind: 'delivered'; status: number; headers: [string, string][]; body: Buffer }
  | { kind: 'failed'; reason: UpstreamFailureReason; upstreamStatus?: number }

/** The headers the upstream call carries: the buyer's, minus the stripped ones, plus the merchant's key. */
export function buildUpstreamHeaders(
  incoming: Readonly<Record<string, string | string[] | undefined>>,
  upstream: ProxyConfig['upstream'],
): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  // `set` replaces whatever the buyer sent under this name, case-insensitively.
  headers.set(upstream.authHeader, upstream.authScheme ? `${upstream.authScheme} ${upstream.apiKey}` : upstream.apiKey)
  return headers
}

export function upstreamUrl(config: ProxyConfig, subPath: string, search: string): URL {
  const url = new URL(config.upstream.baseUrl.href)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${subPath === '/' ? '' : subPath}` || '/'
  url.search = search
  return url
}

/** 5xx, 408 and 429 failed; 401/402/403/407 mean the merchant's own key was refused. */
export function classifyUpstreamStatus(status: number): 'delivered' | 'failed' | 'auth_refused' {
  if (status >= 500 || status === 408 || status === 429) return 'failed'
  if (status === 401 || status === 402 || status === 403 || status === 407) return 'auth_refused'
  return 'delivered'
}

export async function callUpstream(params: {
  config: ProxyConfig
  method: string
  subPath: string
  search: string
  incomingHeaders: Readonly<Record<string, string | string[] | undefined>>
  body: Buffer | undefined
  signal: AbortSignal
  /** Why the signal fired, when it did. */
  abortReason: () => 'timeout' | 'buyer_disconnected' | undefined
  fetchImpl: typeof fetch
}): Promise<UpstreamResult> {
  const { config } = params
  const failedByAbort = (): UpstreamResult => ({
    kind: 'failed',
    reason: params.abortReason() === 'buyer_disconnected' ? 'buyer_disconnected' : 'upstream_timeout',
  })
  let response: Response
  try {
    response = await params.fetchImpl(upstreamUrl(config, params.subPath, params.search), {
      method: params.method,
      headers: buildUpstreamHeaders(params.incomingHeaders, config.upstream),
      ...(params.body && params.method !== 'GET' && params.method !== 'HEAD' ? { body: new Uint8Array(params.body) } : {}),
      // A 3xx is not followed (§6).
      redirect: 'manual',
      signal: params.signal,
    })
  } catch {
    return params.signal.aborted ? failedByAbort() : { kind: 'failed', reason: 'upstream_unreachable' }
  }

  const status = response.status
  const classification = classifyUpstreamStatus(status)
  if (classification !== 'delivered') {
    // The body is not needed: release the connection.
    void response.body?.cancel().catch(() => undefined)
    return {
      kind: 'failed',
      reason: classification === 'auth_refused' ? 'upstream_auth_refused' : 'upstream_status',
      upstreamStatus: status,
    }
  }

  // Buffer the body up to the cap; the whole call, headers and body, is under the one deadline (the signal).
  const chunks: Buffer[] = []
  let total = 0
  try {
    const reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined)
          return { kind: 'failed', reason: 'response_too_large', upstreamStatus: status }
        }
        chunks.push(Buffer.from(value))
      }
    }
  } catch {
    return params.signal.aborted ? failedByAbort() : { kind: 'failed', reason: 'upstream_unreachable', upstreamStatus: status }
  }
  const body = Buffer.concat(chunks)

  // A body shorter than the upstream's own Content-Length is truncated.
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && !response.headers.get('content-encoding') && Number(declared) !== body.length) {
    return { kind: 'failed', reason: 'upstream_unreachable', upstreamStatus: status }
  }
  // An SSE stream without the terminal event is truncated (§6).
  if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream') && !body.toString('utf8').includes('data: [DONE]')) {
    return { kind: 'failed', reason: 'upstream_unreachable', upstreamStatus: status }
  }

  const headers: [string, string][] = []
  response.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.push([name, value])
  })
  return { kind: 'delivered', status, headers, body }
}

/**
 * Set or lower the output-token cap on a chat-completions body (§7). The cap
 * is carried by `max_tokens`; `max_completion_tokens` is set too when the
 * buyer sent it. A value the buyer set lower is never raised. Returns
 * undefined when the cap cannot be set (the body is not a chat completion).
 */
export function applyOutputTokenCap(body: unknown, cap: number): Buffer | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.messages)) return undefined
  const lowered = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1 && value < cap ? value : cap
  record.max_tokens = lowered(record.max_tokens)
  if ('max_completion_tokens' in record) record.max_completion_tokens = lowered(record.max_completion_tokens)
  return Buffer.from(JSON.stringify(record), 'utf8')
}
