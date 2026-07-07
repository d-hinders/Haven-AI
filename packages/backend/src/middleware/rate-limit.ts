/**
 * Shared per-route rate-limit configs and key derivation (#794).
 *
 * The @fastify/rate-limit plugin is registered non-global in index.ts with
 * `rateLimitKeyFor` as key generator; routes opt in by spreading one of these
 * into their route `config`. Two tiers:
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
