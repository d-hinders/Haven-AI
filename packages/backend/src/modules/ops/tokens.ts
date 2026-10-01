/**
 * Ops console tokens (#3509, epic #3507 invariant 7).
 *
 * Two HS256 JWTs, both signed with `OPS_JWT_SECRET` and never with the
 * dashboard's `JWT_SECRET`:
 *
 * - the **ops token** a signed-in founder carries as `Authorization: Bearer`.
 *   It names `purpose: 'ops'`, so the dashboard's `authMiddleware` — which
 *   refuses every purpose-claimed token except the owner-CLI opt-in — rejects
 *   it on every customer route even if the two secrets were ever equal (boot
 *   refuses that too, `config/ops.ts`);
 * - the short-lived **OAuth state**, which carries the return origin and the
 *   ops app's nonce through GitHub's redirect so the callback can trust them.
 *
 * Verification is a standalone `fast-jwt` verifier, not a second
 * `request.jwtVerify(`: the backend keeps exactly one dashboard JWT door
 * (`middleware/__tests__/auth-purpose.test.ts`). The verifier pins the
 * algorithm, audience and issuer, and requires every claim it relies on.
 */
import { createSigner, createVerifier } from 'fast-jwt'

export const OPS_TOKEN_PURPOSE = 'ops'
export const OPS_TOKEN_AUDIENCE = 'haven-ops'
export const OPS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000

export const OPS_STATE_PURPOSE = 'ops_oauth_state'
export const OPS_STATE_AUDIENCE = 'haven-ops-oauth-state'
export const OPS_STATE_TTL_MS = 10 * 60 * 1000

export interface OpsOperator {
  /** Numeric GitHub user id, as a string (the JWT `sub`). */
  githubId: string
  /** GitHub login at sign-in time — display and audit only, never authority. */
  login: string
  /** Token expiry, seconds since the epoch. */
  exp: number
}

export interface OpsOAuthState {
  origin: string
  nonce: string
}

interface TokenOptions {
  secret: string
  /** This backend's public origin: the `iss` of everything it signs. */
  issuer: string
  /** Test seam for the clock; defaults to `Date.now()`. */
  now?: number
}

function signer(opts: TokenOptions, aud: string, ttlMs: number) {
  return createSigner({
    key: opts.secret,
    algorithm: 'HS256',
    aud,
    iss: opts.issuer,
    expiresIn: ttlMs,
    clockTimestamp: opts.now,
  })
}

function verifier(opts: TokenOptions, aud: string, requiredClaims: string[]) {
  return createVerifier({
    key: opts.secret,
    algorithms: ['HS256'],
    allowedAud: aud,
    allowedIss: opts.issuer,
    requiredClaims: ['exp', 'iat', 'aud', 'iss', 'purpose', ...requiredClaims],
    clockTimestamp: opts.now,
  })
}

export function signOpsToken(opts: TokenOptions, operator: { githubId: number; login: string }): string {
  return signer(opts, OPS_TOKEN_AUDIENCE, OPS_TOKEN_TTL_MS)({
    sub: String(operator.githubId),
    login: operator.login,
    purpose: OPS_TOKEN_PURPOSE,
  })
}

/** Verify an ops token. Returns null for anything that is not one. */
export function verifyOpsToken(opts: TokenOptions, token: string): OpsOperator | null {
  let payload: Record<string, unknown>
  try {
    payload = verifier(opts, OPS_TOKEN_AUDIENCE, ['sub', 'login'])(token) as Record<string, unknown>
  } catch {
    return null
  }
  if (payload.purpose !== OPS_TOKEN_PURPOSE) return null
  if (typeof payload.sub !== 'string' || !/^[1-9][0-9]*$/.test(payload.sub)) return null
  if (typeof payload.login !== 'string' || typeof payload.exp !== 'number') return null
  return { githubId: payload.sub, login: payload.login, exp: payload.exp }
}

export function signOpsState(opts: TokenOptions, state: OpsOAuthState): string {
  return signer(opts, OPS_STATE_AUDIENCE, OPS_STATE_TTL_MS)({
    purpose: OPS_STATE_PURPOSE,
    origin: state.origin,
    nonce: state.nonce,
  })
}

/** Verify OAuth state. Returns null for a forged, expired or foreign state. */
export function verifyOpsState(opts: TokenOptions, token: string): OpsOAuthState | null {
  let payload: Record<string, unknown>
  try {
    payload = verifier(opts, OPS_STATE_AUDIENCE, ['origin', 'nonce'])(token) as Record<string, unknown>
  } catch {
    return null
  }
  if (payload.purpose !== OPS_STATE_PURPOSE) return null
  if (typeof payload.origin !== 'string' || typeof payload.nonce !== 'string') return null
  return { origin: payload.origin, nonce: payload.nonce }
}
