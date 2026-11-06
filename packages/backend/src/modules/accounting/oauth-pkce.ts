/**
 * PKCE for the accounting OAuth2 flow (RFC 7636, #4517, epic #2875).
 *
 * Igdrasil requires PKCE; Fortnox does not use it. A provider opts in with
 * `pkce: 'S256'` on its `OAuth2ProviderConfig`, and `oauth-flow.ts` then
 * sends the challenge on the consent URL and the verifier on the code
 * exchange.
 *
 * ## The verifier is derived, never stored
 *
 * `base64url(HMAC-SHA256(key, "accounting-pkce:" + jti))` — 43 characters
 * from the RFC's unreserved set, its minimum length. The callback recomputes
 * it from the `jti` of the state it has just verified and consumed, so there
 * is nothing to persist: a stored verifier would need a table of its own
 * (`rate_limit_counters`, which already holds the single-use `jti`, carries
 * a key, a count and an expiry, nothing else).
 *
 * ## Why it is never a claim of the state
 *
 * The state is a signed, not encrypted, JWT that rides the consent URL and
 * comes back on the redirect (`oauth-state.ts`). Whoever sees that redirect
 * holds the code AND the state; a verifier inside the state would hand them
 * the one thing PKCE withholds. The `jti` is public; the key is not.
 *
 * The key is the caller's — `JWT_SECRET` in production (`connections.ts`):
 * required at boot and already the key that signs the state, so rotating it
 * invalidates an in-flight state and its verifier together. The
 * `accounting-pkce:` label keeps this MAC apart from JWS signing input under
 * the same key.
 */

import { createHash, createHmac } from 'node:crypto'

const VERIFIER_LABEL = 'accounting-pkce:'

/** The PKCE `code_verifier` for one OAuth state, by its `jti`. */
export function pkceVerifierFor(stateJti: string, key: string): string {
  if (!stateJti) throw new Error('A PKCE verifier needs the state jti.')
  if (!key) throw new Error('A PKCE verifier needs a server key.')
  return createHmac('sha256', key).update(`${VERIFIER_LABEL}${stateJti}`).digest('base64url')
}

/** The `S256` `code_challenge` for a verifier: base64url(SHA-256(verifier)), unpadded. */
export function pkceChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
