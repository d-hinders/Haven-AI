/**
 * Shared SSRF guard for outbound requests to merchant-controlled URLs
 * (epic #1717, #1712; adopted by #1713's probe — do not write a second one).
 *
 * Every request this guard makes goes to a host an ANONYMOUS SUBMITTER chose.
 * That is the whole threat model: without this, `POST /catalog/submit` turns
 * Haven into a request cannon aimed wherever the submitter likes — at cloud
 * instance metadata, at services on the private network, or at a third party
 * Haven would be DDoSing on their behalf.
 *
 * Four controls, and the third is the one a string check cannot give you:
 *
 *   1. **Scheme and shape.** https only, default port only, no embedded
 *      credentials, no IP literals, no locally-bound names.
 *   2. **Resolution-time address validation.** The hostname is resolved and
 *      EVERY returned address is classified (`ip-classification.ts`); a
 *      hostname whose A record is `169.254.169.254` is refused here, where a
 *      hostname regex would wave it through. This is the DNS-rebinding gap
 *      that `modules/reporting/receipt-underlag.ts` documents as a residual.
 *   3. **Connection pinning.** The socket connects to the address we just
 *      validated, because resolution happens INSIDE the connection through
 *      the `lookup` hook. A resolver that answers "public" to our check and
 *      "127.0.0.1" to the connect a millisecond later cannot split the two.
 *   4. **Bounded budgets.** Total deadline, response byte cap, and a redirect
 *      budget where every hop is re-validated from scratch through 1–3.
 *
 * Refusals are values, not exceptions: callers branch on `ok` and persist the
 * `reason`. Nothing here logs a URL body or a secret.
 */
import https from 'node:https'
import dns from 'node:dns'
import { isLocallyBoundHostname, isPublicUnicastAddress } from './ip-classification.js'

/** Machine-readable refusal reasons; persisted by callers, so keep them stable. */
export type SsrfRefusalReason =
  | 'invalid_url'
  | 'scheme_not_https'
  | 'embedded_credentials'
  | 'non_default_port'
  | 'host_not_public'
  | 'address_not_public'
  | 'dns_failure'
  | 'redirect_budget'
  | 'redirect_missing_location'
  | 'response_too_large'
  | 'timeout'
  | 'transport_error'
  | 'http_status'
  | 'redirect_on_post'

export interface SsrfRefusal {
  ok: false
  reason: SsrfRefusalReason
  detail: string
}

export interface SafeResponse {
  ok: true
  status: number
  body: string
  /**
   * Response headers, lowercased. Needed by #1713's probe: MCP Streamable
   * HTTP carries the session id in `mcp-session-id`, and an x402 challenge
   * may arrive in `payment-required` rather than the body.
   */
  headers: Record<string, string>
  /** The URL actually read, after any re-validated redirects. */
  finalUrl: string
}

export type SafeFetchResult = SafeResponse | SsrfRefusal

/** Total wall-clock budget for one guarded read, redirects included. */
export const DEFAULT_TIMEOUT_MS = 5_000
/** Response body cap. A proof document is ~110 bytes; 64 KiB is generous. */
export const DEFAULT_MAX_BYTES = 64 * 1024
/** Redirect hops allowed. Every hop is re-validated; none may leave https. */
export const DEFAULT_MAX_REDIRECTS = 3

function refuse(reason: SsrfRefusalReason, detail: string): SsrfRefusal {
  return { ok: false, reason, detail }
}

/**
 * Is this hostname an IP LITERAL, and if so which range does it fall in?
 *
 * Returns the stable range name (`'public-unicast'`, `'loopback'`, …) when the
 * host is a bare address, and `null` when it is a name. Brackets are stripped
 * first, so the IPv6 URL form `[::1]` classifies the same as `::1`.
 *
 * Exported because the refusal it powers is NOT a URL-level rule — it is a
 * claim-level one, and #1959 is what that distinction cost. `assertSafeUrl`
 * could only apply it to paths that build a URL, so the DNS-TXT half of the
 * ownership proof (`modules/catalog/ownership.ts`) had no equivalent refusal:
 * a canonical dotted-decimal IPv4 host survives that module's URL round-trip
 * byte-identically and reached `resolveTxt` unchallenged. The fix is one
 * predicate consulted by both, not a second copy of the range logic — so this
 * function, and `ip-classification.ts` behind it, stay the single source of
 * truth for "that is an address, not a domain".
 *
 * Callers outside this file want the boolean; the range is here so the guard's
 * own refusal detail stays specific.
 */
export function ipLiteralRange(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, '')
  const verdict = isPublicUnicastAddress(bare)
  return verdict.range === 'unparseable' ? null : verdict.range
}

/**
 * Policy check on a URL, before any I/O. Pure — this is where most of the
 * guard's security logic lives, and it is directly unit-testable.
 */
export function assertSafeUrl(raw: string): { ok: true; url: URL } | SsrfRefusal {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refuse('invalid_url', 'not a parseable absolute URL')
  }
  if (url.protocol !== 'https:') {
    // https only: the well-known proof leans on TLS for host authentication.
    // Over http an on-path attacker could serve the proof for a domain they
    // do not control, which is exactly what the proof exists to rule out.
    return refuse('scheme_not_https', `scheme ${url.protocol} is not https:`)
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('embedded_credentials', 'url carries embedded credentials')
  }
  if (url.port !== '' && url.port !== '443') {
    // A merchant proving domain ownership serves on 443. Allowing arbitrary
    // ports turns the guard into a port scanner for the submitter.
    return refuse('non_default_port', `port ${url.port} is not the default https port`)
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalRange = ipLiteralRange(hostname)
  if (literalRange !== null) {
    // The hostname IS an IP literal. Refuse regardless of range: ownership of
    // a domain is the claim, and a bare address cannot make it. Same predicate
    // the DNS-TXT path now consults (#1959), so the two cannot drift apart.
    return refuse('host_not_public', `host is an IP literal (${literalRange})`)
  }
  if (isLocallyBoundHostname(hostname)) {
    return refuse('host_not_public', 'host is a locally-bound name')
  }
  return { ok: true, url }
}

export interface ResolvedAddress {
  address: string
  family: number
}

/** Injectable resolver seam, so the address policy is testable without a network. */
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>

const systemResolver: AddressResolver = async (hostname) =>
  await new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err)
      else resolve(addresses as ResolvedAddress[])
    })
  })

/**
 * Resolve a hostname and keep only public unicast addresses.
 *
 * Returns a refusal when resolution fails OR when nothing survives
 * classification. "Nothing survived" is the interesting case: it is a
 * hostname deliberately pointed at private space, and it is refused before a
 * single packet leaves for it.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: AddressResolver = systemResolver,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | SsrfRefusal> {
  let resolved: ResolvedAddress[]
  try {
    resolved = await resolver(hostname)
  } catch (err) {
    return refuse('dns_failure', `could not resolve host: ${(err as Error).message}`)
  }
  if (resolved.length === 0) return refuse('dns_failure', 'host resolved to no addresses')

  const kept: ResolvedAddress[] = []
  const rejected: string[] = []
  for (const entry of resolved) {
    const verdict = isPublicUnicastAddress(entry.address)
    if (verdict.allowed) kept.push(entry)
    else rejected.push(verdict.range)
  }
  if (kept.length === 0) {
    return refuse('address_not_public', `host resolves only into blocked ranges (${[...new Set(rejected)].join(', ')})`)
  }
  return { ok: true, addresses: kept }
}

/** One transport read of an already-validated URL, pinned to `address`. */
export interface PinnedRequest {
  url: URL
  address: string
  family: number
  timeoutMs: number
  maxBytes: number
  /** #1713: the probe needs POST; the ownership proof stays GET. */
  method: 'GET' | 'POST'
  /** Request body, POST only. Never contains a secret — see `safePostJson`. */
  body: string | null
  headers: Record<string, string>
}

export interface PinnedResponse {
  status: number
  location: string | null
  body: string
  /** Lowercased response headers. Absent from a fake transport means none. */
  headers?: Record<string, string>
}

export type PinnedTransport = (req: PinnedRequest) => Promise<PinnedResponse | SsrfRefusal>

/**
 * The real transport: `node:https` with the resolved address forced in through
 * the `lookup` hook, so the socket cannot be re-pointed between our check and
 * the connect. Redirects are NOT followed here — `safeGetText` follows them,
 * re-validating each hop, so the hop policy stays visible and testable.
 */
const httpsTransport: PinnedTransport = async (req) =>
  await new Promise<PinnedResponse | SsrfRefusal>((resolve) => {
    let settled = false
    const done = (value: PinnedResponse | SsrfRefusal) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const request = https.request(
      req.url,
      {
        method: req.method,
        // Pin the connection to the address we validated.
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all === true) {
            ;(callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [
              { address: req.address, family: req.family },
            ])
          } else {
            callback(null, req.address, req.family)
          }
        },
        headers: req.headers,
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > req.maxBytes) {
            res.destroy()
            request.destroy()
            done(refuse('response_too_large', `response exceeded ${req.maxBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const location = res.headers.location
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[name.toLowerCase()] = value
            else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ')
          }
          done({
            status: res.statusCode ?? 0,
            location: typeof location === 'string' ? location : null,
            body: Buffer.concat(chunks).toString('utf8'),
            headers,
          })
        })
        res.on('error', (err) => done(refuse('transport_error', err.message)))
      },
    )

    request.on('timeout', () => {
      request.destroy()
      done(refuse('timeout', `no response within ${req.timeoutMs}ms`))
    })
    request.on('error', (err) => done(refuse('transport_error', err.message)))
    if (req.body !== null) request.write(req.body)
    request.end()
  })

export interface SafeFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  resolver?: AddressResolver
  transport?: PinnedTransport
  /**
   * Extra request headers, `safePostJson` only. Restricted to
   * `ALLOWED_CALLER_HEADERS` — a caller may carry an MCP session id, and may
   * NOT set `host`, `content-type`, `authorization`, or anything else that
   * would let it retarget or re-authenticate the guarded request. Values are
   * rejected outright if they contain CR or LF (header injection).
   */
  extraHeaders?: Record<string, string>
}

/** The only headers a caller may add to a guarded POST. */
export const ALLOWED_CALLER_HEADERS = new Set(['mcp-session-id', 'mcp-protocol-version'])

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** What one guarded call sends, beyond the URL. */
interface RequestShape {
  method: 'GET' | 'POST'
  body: string | null
  headers: Record<string, string>
  /**
   * When true a non-200 response is RETURNED rather than refused.
   *
   * The ownership proof wants a document and nothing else, so a 404 is a
   * failure. #1713's probe is the opposite: `402 Payment Required` IS the
   * successful outcome it is looking for, and refusing every non-200 would
   * throw away the only response that matters.
   */
  acceptAnyStatus: boolean
}

const HAVEN_USER_AGENT = 'Haven-CatalogVerification/1.0 (+https://haven.xyz)'

/**
 * The single guarded-read loop. Both public entry points below go through
 * here, so there is exactly one place where the hop policy lives — a second
 * copy for POST is how the two drift until one of them stops re-validating.
 *
 * Every redirect hop restarts the policy from the top — `assertSafeUrl` then
 * `resolvePublicAddresses` — so a public front door that 302s to
 * `http://169.254.169.254/` is refused at the hop, not followed. Because
 * `assertSafeUrl` enforces https, a cross-scheme redirect is refused by
 * construction rather than by a separate rule that could drift out of sync.
 */
async function safeFetch(
  raw: string,
  shape: RequestShape,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const resolver = options.resolver ?? systemResolver
  const transport = options.transport ?? httpsTransport

  const deadline = Date.now() + timeoutMs
  let current = raw

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return refuse('timeout', `budget of ${timeoutMs}ms exhausted`)

    const checked = assertSafeUrl(current)
    if (!checked.ok) return checked

    const resolved = await resolvePublicAddresses(checked.url.hostname, resolver)
    if (!resolved.ok) return resolved

    const pinned = resolved.addresses[0]!
    const response = await transport({
      url: checked.url,
      address: pinned.address,
      family: pinned.family,
      timeoutMs: remaining,
      maxBytes,
      method: shape.method,
      body: shape.body,
      headers: shape.headers,
    })
    if ('ok' in response && response.ok === false) return response

    const res = response as PinnedResponse
    if (REDIRECT_STATUSES.has(res.status)) {
      if (shape.method === 'POST') {
        // A POST redirect is NOT followed, at any status, however public the
        // target resolves. Re-sending a body we composed to a host the first
        // host names turns the guard into a request forwarder with an
        // attacker-chosen payload and an attacker-chosen victim — an
        // amplifier that address classification cannot see, because the
        // victim is a perfectly ordinary public host. 307/308 preserve the
        // method and 301/302/303 downgrade it to GET; neither is a shape a
        // JSON-RPC endpoint has any business asking us for.
        return refuse('redirect_on_post', `HTTP ${res.status} redirect on a POST is not followed`)
      }
      if (res.location === null) {
        return refuse('redirect_missing_location', `HTTP ${res.status} without a Location header`)
      }
      // Resolve relative Locations against the hop we are on, then loop —
      // the next iteration re-validates it completely.
      current = new URL(res.location, checked.url).toString()
      continue
    }

    if (!shape.acceptAnyStatus && res.status !== 200) {
      return refuse('http_status', `HTTP ${res.status}`)
    }
    return {
      ok: true,
      status: res.status,
      body: res.body,
      headers: res.headers ?? {},
      finalUrl: checked.url.toString(),
    }
  }

  return refuse('redirect_budget', `more than ${maxRedirects} redirects`)
}

/**
 * Read a merchant-controlled URL under the full guard. 200 or a refusal —
 * used by the domain-ownership proof (#1712), which wants a document.
 */
export async function safeGetText(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  return safeFetch(
    raw,
    {
      method: 'GET',
      body: null,
      headers: {
        // Identify ourselves so a merchant reading their access log can see
        // who asked and why.
        'user-agent': 'Haven-DomainVerification/1.0 (+https://haven.xyz)',
        accept: 'text/plain, */*;q=0.1',
      },
      acceptAnyStatus: false,
    },
    options,
  )
}

/**
 * POST a JSON document to a merchant-controlled URL under the full guard, and
 * return whatever status comes back (#1713).
 *
 * `payload` is serialised by the CALLER and must never contain a credential,
 * a signature, or anything derived from a key: this sends a body to a host an
 * anonymous submitter named. The catalogue probe sends only JSON-RPC
 * envelopes with literal method names — see `modules/catalog/probe.ts`.
 */
export async function safePostJson(
  raw: string,
  payload: unknown,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'user-agent': HAVEN_USER_AGENT,
    'content-type': 'application/json',
    // MCP Streamable HTTP servers negotiate between JSON and SSE here.
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(body)),
  }
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
    const lower = name.toLowerCase()
    // Allowlist, then injection check. Both, in that order: an allowlisted
    // name with a newline in its value still splits the request.
    if (!ALLOWED_CALLER_HEADERS.has(lower)) continue
    if (/[\r\n]/.test(value)) continue
    headers[lower] = value
  }
  return safeFetch(raw, { method: 'POST', body, headers, acceptAnyStatus: true }, options)
}
