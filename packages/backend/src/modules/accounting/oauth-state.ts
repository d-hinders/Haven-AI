/**
 * Single-use OAuth `state` (#2862, epic #2858).
 *
 * The `state` a connect-url issues is a signed JWT (the #1640 design: a
 * `purpose` claim `authMiddleware` rejects, the provider carried in the
 * claim, 10-minute expiry). Signed and short-lived is not the same as
 * single-use: within those ten minutes the same state could complete a
 * second callback — with a second authorization code, if an attacker holding
 * the state could obtain one — so the callback now CONSUMES the token's `jti`
 * and refuses a replay.
 *
 * ## The store
 *
 * "Have I seen this key before, across every replica, for the next N
 * minutes" is exactly the shape of `rate_limit_counters` (#1680): an
 * atomic keyed upsert with an expiry, already durable across replicas, already
 * swept. The first `incrementRateLimit` on a key returns `current: 1`; any
 * later one returns more. No new table, no migration, and the key namespace
 * (`accounting-oauth-state:`) keeps these rows apart from the limiter's.
 *
 * Two properties of that table to be honest about:
 *
 * - it is UNLOGGED, so crash recovery truncates it — a state issued before a
 *   Postgres crash and replayed within its 10-minute window after recovery
 *   would be accepted once more. The window is short and the state still
 *   has to verify; accepted.
 * - the limiter's increment is FAIL-OPEN (a database error returns `null`)
 *   because it guards the login door. Here the direction is reversed: a
 *   `null` REFUSES the callback. A connect that cannot prove single-use is
 *   retried by the user in seconds; a replayed grant is not undone.
 *
 * The ttl handed to the store is the state's remaining life plus a minute of
 * slack, so a row never outlives the token it guards by more than that.
 */

import { randomUUID } from 'node:crypto'
import { incrementRateLimit } from '../../infra/repositories/rate-limit-counters.js'

export const OAUTH_STATE_PURPOSE = 'accounting_oauth'
export const OAUTH_STATE_TTL_SECONDS = 10 * 60
const STATE_KEY_PREFIX = 'accounting-oauth-state:'

export interface OAuthStateClaims {
  sub: string
  purpose: typeof OAUTH_STATE_PURPOSE
  provider: string
  jti: string
}

export function newOAuthStateClaims(userId: string, provider: string): OAuthStateClaims {
  return { sub: userId, purpose: OAUTH_STATE_PURPOSE, provider, jti: randomUUID() }
}

export type OAuthStateStore = (key: string, ttlMs: number) => Promise<{ current: number } | null>

/**
 * Consume a state's `jti`. True exactly once per jti; false on replay AND
 * when the store cannot answer (fail closed — see the header).
 */
export async function consumeOAuthState(
  jti: string,
  ttlMs: number = (OAUTH_STATE_TTL_SECONDS + 60) * 1000,
  store: OAuthStateStore = incrementRateLimit,
): Promise<boolean> {
  const seen = await store(`${STATE_KEY_PREFIX}${jti}`, ttlMs)
  if (!seen) return false
  return seen.current === 1
}
