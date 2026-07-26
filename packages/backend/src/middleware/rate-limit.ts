/**
 * Shared per-route rate-limit configs and key derivation (#794).
 *
 * The @fastify/rate-limit plugin is registered non-global in index.ts with
 * `rateLimitKeyFor` as key generator; routes opt in by spreading one of these
 * into their route `config`. Tiers:
 *
 * - moneyPathRateLimit — authenticated money-path writes (payments, x402,
 *   machine-payments). 60/min per credential is far above any legitimate
 *   agent's payment cadence (the on-chain allowance is the real spend gate;
 *   this is a per-credential request-storm ceiling on the handler — it does
 *   NOT throttle invalid-credential probing, since each distinct credential
 *   value keys its own bucket and auth runs before the route-level limiter;
 *   key entropy is what makes brute force infeasible).
 * - demoRateLimit — public demo reads (demo-mpp). Keyed per IP (no
 *   credential), tighter because the route is unauthenticated.
 * - publicVerifyRateLimit / publicIssuerRateLimit — public passport
 *   verification (#974). These override the shared key generator entirely,
 *   because per-IP is meaningless behind an untrusted proxy; see below.
 *
 * Constants, not env: tuning is a code change with review, and the values are
 * deliberately generous — the goal is a ceiling, not throttling real use.
 */

import { createHash } from 'node:crypto'

/**
 * Bucket key for a request: a hash of the presented credential when there is
 * one, else the client IP. Covers BOTH agent auth channels —
 * `Authorization: Bearer` and `X-API-Key` (see middleware/agentAuth.ts) — so
 * every agent gets its own bucket regardless of network path. Without the
 * X-API-Key branch those agents would all collapse into one shared per-IP
 * bucket behind Railway's proxy (no trustProxy configured) and could 429 each
 * other's legitimate payment writes.
 */
export function rateLimitKeyFor(request: {
  headers: Record<string, string | string[] | undefined>
  ip: string
}): string {
  const auth = request.headers.authorization
  const apiKey = request.headers['x-api-key']
  const credential =
    typeof auth === 'string' && auth.length > 0
      ? auth
      : typeof apiKey === 'string' && apiKey.length > 0
        ? apiKey
        : null
  if (credential) {
    return `cred:${createHash('sha256').update(credential).digest('hex').slice(0, 32)}`
  }
  return `ip:${request.ip}`
}

export const moneyPathRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
  },
} as const

export const demoRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: '1 minute',
  },
} as const

/**
 * Public passport verification (#974). Keyed per **SUBJECT**, not per caller.
 *
 * The endpoint is unauthenticated, so the default key is `ip:` — and there is
 * no `trustProxy` on the Fastify instance, so behind Railway's proxy every
 * external client collapses into ONE bucket (the comment on `rateLimitKeyFor`
 * above says so explicitly, and the demo route accepts that only because it is
 * a demo). Inheriting it here would be much worse than on a demo route: a
 * single unauthenticated client sending 121 requests a minute would 429 passport
 * verification for **every merchant at once**, and the endpoint exists precisely
 * to gate live payments. Raising the ceiling does not fix that; it just makes
 * the shared bucket bigger.
 *
 * Keying on the queried address or UID fixes the blast radius rather than the
 * size. Merchants verifying different agents never collide, and an abusive
 * caller can only exhaust the bucket for the one agent it is hammering. That
 * also happens to be the right shape for the actual threat here — enumerating
 * or hammering a specific subject — rather than for "who is calling", which
 * behind an untrusted proxy we cannot know anyway.
 *
 * 120/min per subject is generous on purpose: receipts carry a 5-minute signed
 * TTL and are explicitly cacheable, so a correctly integrated merchant needs
 * roughly one call per agent per TTL.
 *
 * Making per-caller limits real needs `trustProxy`, which changes `request.ip`
 * semantics for every rate-limited route including the money path. That is a
 * deliberate cross-cutting change, not a rider on this PR.
 */
export const publicVerifyRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request: { query?: unknown }) => {
      const query = (request.query ?? {}) as { address?: string; uid?: string }
      const subject = (query.address ?? query.uid ?? '').toLowerCase()
      // A missing or malformed subject is rejected 400 by the handler anyway;
      // bucketing them together stops that path being a free-for-all.
      return `passport:${subject || 'invalid'}`
    },
  },
} as const

/**
 * `GET /passport/issuer` — one static response, no subject to key on. A single
 * shared bucket is the right shape here, but it gets its own so a flood of
 * malformed `/verify` calls (which bucket as `passport:invalid`) cannot take
 * out the endpoint merchants use to bootstrap their pinned issuer.
 */
export const publicIssuerRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: () => 'passport:issuer',
  },
} as const
