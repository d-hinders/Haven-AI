/**
 * Shared per-route rate-limit configs (#794).
 *
 * The @fastify/rate-limit plugin is registered non-global in index.ts with a
 * credential-hash key generator; routes opt in by spreading one of these into
 * their route `config`. Two tiers:
 *
 * - moneyPathRateLimit — authenticated money-path writes (payments, x402,
 *   machine-payments). 60/min per credential is far above any legitimate
 *   agent's payment cadence (the on-chain allowance is the real spend gate;
 *   this only caps abusive request storms and brute-force probing).
 * - demoRateLimit — public demo reads (demo-mpp). Keyed per IP (no
 *   credential), tighter because the route is unauthenticated.
 *
 * Constants, not env: tuning is a code change with review, and the values are
 * deliberately generous — the goal is a ceiling, not throttling real use.
 */

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
