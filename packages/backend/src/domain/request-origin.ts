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
 *    own contract. Same discipline `authRateLimit` already applies to
 *    `x-forwarded-for` (#1670): a forwarded header is evidence only where a
 *    trusted proxy is known to set it. The SCHEME is deliberately not gated —
 *    see the comment at its read.
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

  const forwardedHost = config.trustProxyHops > 0 ? headerValue(request, 'x-forwarded-host') : null
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
  const proto = headerValue(request, 'x-forwarded-proto')
  const scheme = proto ?? 'http'
  return `${scheme}://${host}`.replace(/\/+$/, '')
}

/** First value of a header that may arrive repeated, trimmed; null if absent. */
function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const first = value.split(',')[0].trim()
  return first || null
}
