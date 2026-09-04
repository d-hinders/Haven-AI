import type { FastifyRequest } from 'fastify'
import { config } from '../config.js'

/**
 * The public origin this backend is being reached at (#2530).
 *
 * Lifted out of `routes/agent-connection-setups.ts`, where it was a private
 * helper, because three surfaces need the same answer and each getting it
 * slightly differently is how a spec ends up naming another environment's
 * host: the connector command, the API root document, and the OpenAPI
 * `servers[]` list.
 *
 * ## Order, and why
 *
 * 1. `HAVEN_API_URL` / `PUBLIC_API_URL`. A deployment behind a proxy knows its
 *    own public URL better than any header does, and this is the ONLY way to
 *    state a public URL that carries a path prefix — see the note below.
 * 2. `x-forwarded-host`, but only when the deployment says it trusts its proxy
 *    (`TRUST_PROXY_HOPS > 0`). The header is client-supplied and trusting it
 *    unconditionally lets a caller choose the host this service names in its
 *    own contract. The SCHEME is deliberately not gated — see the comment at
 *    its read.
 *
 * `authRateLimit` gates on the same variable (#1670), but do NOT read that as
 * "the same discipline", which an earlier draft of this comment claimed and a
 * reviewer corrected. That path hands the work to Fastify's `proxy-addr`,
 * which walks back exactly `trustProxyHops` entries from the RIGHT of the
 * chain. Selection matters as much as gating: a forwarded header can be
 * APPENDED to, so the leftmost entry is the one an original client could have
 * written, and reading index 0 hands a multi-hop deployment precisely the
 * value an attacker controls. `trustedEntry` below indexes from the right by
 * hop count for that reason.
 * 3. The `Host` header.
 *
 * ## What this deliberately does NOT try to infer
 *
 * The frontend proxies `/api/:path*` to this backend and its rewrite STRIPS
 * the prefix — measured, not assumed: `GET /api/openapi.json` against the
 * backend is a 404, because the backend never sees that path. So a request
 * arriving through the proxy is indistinguishable, by path, from a direct one,
 * and the `/api` segment cannot be derived here. An earlier draft of this file
 * inspected `request.url` for it; that code could never have run, and code
 * that cannot run is worse than absent because it reads as a handled case.
 *
 * A deployment that wants its spec to advertise `https://preview.example/api`
 * sets `HAVEN_API_URL` to exactly that. That is a stated fact rather than an
 * inference, which is the right shape for something a client will call.
 */
export function apiBaseUrl(request: FastifyRequest): string {
  const env = process.env.HAVEN_API_URL ?? process.env.PUBLIC_API_URL
  if (env) return env.replace(/\/+$/, '')

  const forwardedHost = config.trustProxyHops > 0 ? trustedEntry(request, 'x-forwarded-host') : null
  const host = forwardedHost ?? request.headers.host ?? `localhost:${process.env.PORT ?? 3001}`

  // The SCHEME is not gated on proxy trust, and the asymmetry is deliberate.
  // The host is the spoofable TARGET — it decides where a client is told to
  // send its next request — so it needs a trusted proxy behind it. The scheme
  // decides only whether that URL says http or https, and gating it would make
  // every TLS-terminating deployment that has not set TRUST_PROXY_HOPS
  // advertise `http://` for its own API: a downgrade hint introduced in the
  // name of security. A spoofed scheme can only make the URL less useful to
  // the spoofer.
  //
  // `x-forwarded-proto` can carry a comma-separated chain when more than one
  // proxy appended to it; the FIRST entry is the scheme the client used.
  // The SCHEME takes the LEFTMOST entry, unlike the host above, and the split
  // is semantic rather than an oversight. `x-forwarded-proto: https,http`
  // means the client reached the edge over https and an inner hop continued
  // over http; a PUBLIC url should name the client's protocol, which is the
  // left end. Right-indexing it would make a correctly configured two-hop
  // deployment advertise its own internal `http`.
  //
  // That leaves the scheme injectable, and the residue is ACCEPTED rather than
  // closed: gating it on proxy trust makes every TLS-terminating deployment
  // without TRUST_PROXY_HOPS advertise `http://` for its own API, and
  // right-indexing it is wrong for the reason above. The blast radius is
  // bounded by the HOST — the part deciding where a client is told to send its
  // next request — being both trust-gated and right-indexed, so a downgraded
  // scheme on a correct host yields a URL that simply fails against a
  // TLS-only origin. Raised by review; confirming the edge overwrites this
  // header is an infra question this repository cannot answer.
  const proto = leftmostEntry(request, 'x-forwarded-proto')
  const scheme = proto ?? 'http'
  return `${scheme}://${host}`.replace(/\/+$/, '')
}

/**
 * The entry a TRUSTED proxy contributed, counting from the right.
 *
 * A forwarded header can be appended to, so its chain reads
 * `<what the client sent>, <what hop 1 saw>, …, <what the nearest hop saw>`.
 * With `TRUST_PROXY_HOPS = n`, the outermost trusted hop's value sits `n` from
 * the end — the same shape `proxy-addr` uses for `x-forwarded-for`. Taking
 * index 0 instead would read the client's own value whenever anything appended
 * rather than overwrote, which is the spoofing class the hop count exists to
 * close.
 *
 * Clamped: a chain shorter than the configured hop count means the header was
 * overwritten rather than appended (the ordinary single-proxy case), and the
 * only entry is the proxy's own.
 *
 * A header arriving as a repeated field (an array) is treated the same way —
 * flattened first, so `a, b` and `['a', 'b']` cannot disagree.
 */
function trustedEntry(request: FastifyRequest, name: string): string | null {
  const entries = headerEntries(request, name)
  if (entries.length === 0) return null
  const hops = Math.max(config.trustProxyHops, 1)
  return entries[Math.max(entries.length - hops, 0)] || null
}

/** The leftmost entry — what the ORIGINAL client sent. See the scheme's read. */
function leftmostEntry(request: FastifyRequest, name: string): string | null {
  return headerEntries(request, name)[0] ?? null
}

/** A forwarded header's entries, in order, with a repeated field flattened. */
function headerEntries(request: FastifyRequest, name: string): string[] {
  const raw = request.headers[name]
  const flat = Array.isArray(raw) ? raw.join(',') : raw
  if (typeof flat !== 'string') return []
  return flat.split(',').map((part) => part.trim()).filter(Boolean)
}
