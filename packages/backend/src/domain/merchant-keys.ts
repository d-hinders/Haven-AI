import { createHash, randomBytes } from 'node:crypto'

/**
 * The receive-only merchant key's vocabulary (#4896, epic #4885).
 *
 * Kept in `domain/` because three layers need the same strings and a second
 * copy is how a scrubber and a route drift apart: the middleware sends the
 * refusal codes, the routes build the prefix, and the secret scrubbers in
 * five packages recognise the prefix. `node:crypto` is a stdlib import, so
 * `domain-stays-pure` is satisfied (it forbids fastify/pg/ethers/viem and the
 * backend's own layers, not the standard library).
 */

/**
 * The fixed prefix. It does NOT follow the mockup's display name for the key
 * ("Sales key"): it is baked into the secret scrubbers of two PUBLISHED
 * packages (`@haven_ai/cli`, `@haven_ai/connect`), so changing it is a
 * breaking change for every installed client, not a copy edit.
 *
 * A key with this prefix is refused at every existing route by construction:
 * `agentAuthMiddleware` accepts only `sk_agent_`, and `authMiddleware` treats
 * anything else as a session token and fails verification. The merchant
 * routes are the only door that accepts it.
 */
export const MERCHANT_KEY_PREFIX = 'sk_merchant_'

/** 24 random bytes, hex-encoded — the same entropy as an agent key. */
export const MERCHANT_KEY_SECRET_BYTES = 24

/**
 * How much of the secret the list shows: the prefix plus twelve hex
 * characters (48 bits). Long enough that two keys of one account are
 * distinguishable at a glance, short enough that it authenticates nothing.
 */
export const MERCHANT_KEY_PREFIX_LENGTH = MERCHANT_KEY_PREFIX.length + 12

/**
 * `last_used_at` is written at most once per this many seconds per key. The
 * throttle lives in the UPDATE's WHERE clause, so a busy kit causes one write
 * a minute, not one per call.
 */
export const MERCHANT_KEY_LAST_USED_THROTTLE_SECONDS = 60

/**
 * Refusal codes. The merchant's server branches on these; it never reads the
 * sentence.
 *
 * - `MERCHANT_KEY_REQUIRED` — no `sk_merchant_` credential was presented.
 * - `MERCHANT_KEY_INVALID` — the key matches nothing, is revoked, or its
 *   account is no longer a merchant account. Deliberately ONE code for all
 *   three: which of them it was is not something an unauthenticated caller is
 *   told (the same information boundary `agentAuth.ts` keeps).
 * - `MERCHANT_SERVICES_OFF` — the key is valid, but the owner has turned
 *   merchant services off for the account. Every merchant key for that
 *   account is refused until they turn it back on.
 * - `MERCHANT_ACCOUNT_REQUIRED` — the owner tried to create a key before
 *   turning merchant services on, so there is no merchant account to bind it
 *   to.
 * - `MERCHANT_KEY_NOT_FOUND` — the owner tried to revoke a key that is not
 *   theirs (or does not exist).
 */
export const MERCHANT_KEY_REQUIRED = 'MERCHANT_KEY_REQUIRED'
export const MERCHANT_KEY_INVALID = 'MERCHANT_KEY_INVALID'
export const MERCHANT_SERVICES_OFF = 'MERCHANT_SERVICES_OFF'
export const MERCHANT_ACCOUNT_REQUIRED = 'MERCHANT_ACCOUNT_REQUIRED'
export const MERCHANT_KEY_NOT_FOUND = 'MERCHANT_KEY_NOT_FOUND'

export interface GeneratedMerchantKey {
  /** The secret. Returned by the create call only; never stored. */
  secret: string
  /** SHA-256 hex of the secret — the only form that is stored. */
  hash: string
  /** The display prefix the list returns. */
  prefix: string
}

/** True for a value carrying the merchant-key prefix. */
export function isMerchantKey(value: string): boolean {
  return value.startsWith(MERCHANT_KEY_PREFIX)
}

/** SHA-256 hex of a merchant secret. The one hashing rule, shared by auth and creation. */
export function hashMerchantKey(secret: string): string {
  // Imported lazily at module scope so the domain file stays a pure function
  // module: `createHash` is a stdlib call, not a layer dependency.
  return createHash('sha256').update(secret).digest('hex')
}

/** Mint a new secret, its hash and its display prefix. */
export function generateMerchantKey(): GeneratedMerchantKey {
  const secret = `${MERCHANT_KEY_PREFIX}${randomBytes(MERCHANT_KEY_SECRET_BYTES).toString('hex')}`
  return {
    secret,
    hash: hashMerchantKey(secret),
    prefix: secret.slice(0, MERCHANT_KEY_PREFIX_LENGTH),
  }
}
