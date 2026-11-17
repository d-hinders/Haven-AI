import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import {
  MERCHANT_KEY_INVALID,
  MERCHANT_KEY_LAST_USED_THROTTLE_SECONDS,
  MERCHANT_KEY_PREFIX,
  MERCHANT_KEY_REQUIRED,
  MERCHANT_SERVICES_OFF,
  hashMerchantKey,
} from '../domain/merchant-keys.js'
import {
  findMerchantKeyAuthRowByHash,
  touchMerchantKeyLastUsedRow,
  type MerchantKeyAuthRow,
} from '../infra/repositories/merchant-keys.js'
import type { Executor } from '../infra/transaction.js'

// ── Types ─────────────────────────────────────────────────────────

/**
 * What a merchant request is authenticated as (#4896, epic #4885).
 *
 * `account_id` is the key's account, resolved from the key row and NEVER from
 * the request. A merchant route must scope every read and write on it and must
 * not accept an account id from the caller: that is what makes "a merchant key
 * is refused for any account other than its own, including the same user's
 * other accounts" structural rather than a check somebody has to remember.
 */
export interface MerchantContext {
  key_id: string
  user_id: string
  account_id: string
  account_address: string
  chain_id: number
}

declare module 'fastify' {
  interface FastifyRequest {
    merchant?: MerchantContext
  }
}

/** Minimal queryable surface — matches `db.ts` and a fake for tests. */
export interface QueryableLike {
  query: (text: string, values?: unknown[]) => Promise<unknown>
}

// ── Refusal bodies ────────────────────────────────────────────────

/**
 * The refusal bodies (#4896). `error_code` is the machine-readable part the
 * merchant's server branches on; the sentence is for a human reading a log.
 *
 * TWO bodies for a failed credential, not three, and the split is the existing
 * information boundary rather than a new one: "missing" and "invalid" are
 * already distinguishable to any caller — one presented no key at all. But a
 * revoked key, a key that matches nothing, and a key whose account is no
 * longer a merchant account all answer with the SAME body, because which of
 * those it was is not something an unauthenticated caller is told. The hint is
 * shared by reference so it cannot drift apart into three subtly different
 * sentences that put that distinction back.
 */
const MERCHANT_KEY_DOCS =
  `Present it as \`Authorization: Bearer ${MERCHANT_KEY_PREFIX}…\` or \`X-API-Key\`. Create one on the Sales page; see /openapi.json.`

export const MERCHANT_MISSING_KEY_BODY = {
  error: 'Missing or invalid merchant key',
  error_code: MERCHANT_KEY_REQUIRED,
  hint: `This route needs a merchant key (\`${MERCHANT_KEY_PREFIX}…\`), not an owner session or an agent key. ${MERCHANT_KEY_DOCS}`,
} as const

export const MERCHANT_INVALID_KEY_BODY = {
  error: 'Invalid or revoked merchant key',
  error_code: MERCHANT_KEY_INVALID,
  hint: `This merchant key is not usable. ${MERCHANT_KEY_DOCS}`,
} as const

/**
 * The key is valid, but the owner has turned merchant services off for the
 * account. Every merchant key for that account is refused until they turn it
 * back on — the off switch is the owner's, and it must not leave a live
 * credential behind.
 */
export const MERCHANT_SERVICES_OFF_BODY = {
  error: 'Merchant services are turned off',
  error_code: MERCHANT_SERVICES_OFF,
  detail:
    'The owner has turned merchant services off for this account, so its merchant keys are refused until they turn it back on.',
} as const

// ── Middleware ────────────────────────────────────────────────────

/**
 * Authenticate a merchant request with a receive-only merchant key
 * (`sk_merchant_…`).
 *
 * Accepts the key from:
 *   - `Authorization: Bearer <merchant key>`
 *   - `X-API-Key: <merchant key>`
 *
 * On success, decorates `request.merchant` with the key's account. The
 * middleware writes nothing: the only write on this path is the throttled
 * `last_used_at` in `registerMerchantLastUsedHook`, which runs after an
 * ACCEPTED response.
 *
 * A key with any other prefix is refused here, and a merchant key is refused
 * at every other door by construction: `agentAuthMiddleware` accepts only
 * `sk_agent_`, and `authMiddleware` treats anything else as a session token
 * and fails verification.
 */
export async function merchantAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  let apiKey: string | null = null

  const authHeader = request.headers.authorization
  if (authHeader?.startsWith(`Bearer ${MERCHANT_KEY_PREFIX}`)) {
    apiKey = authHeader.slice(7) // strip "Bearer "
  }

  if (!apiKey) {
    const xApiKey = request.headers['x-api-key']
    if (typeof xApiKey === 'string' && xApiKey.startsWith(MERCHANT_KEY_PREFIX)) {
      apiKey = xApiKey
    }
  }

  if (!apiKey) {
    return reply.code(401).send(MERCHANT_MISSING_KEY_BODY)
  }

  const row = await findMerchantKeyAuthRowByHash(hashMerchantKey(apiKey))

  if (row === null || row.revoked_at !== null || !row.is_merchant_account) {
    return reply.code(401).send(MERCHANT_INVALID_KEY_BODY)
  }

  if (!row.services_enabled) {
    return reply.code(403).send(MERCHANT_SERVICES_OFF_BODY)
  }

  request.merchant = merchantContextFrom(row)
}

/** The context a merchant route reads. Exported for the tests' positive control. */
export function merchantContextFrom(row: MerchantKeyAuthRow): MerchantContext {
  return {
    key_id: row.key_id,
    user_id: row.user_id,
    account_id: row.account_id,
    account_address: row.account_address,
    chain_id: Number(row.chain_id),
  }
}

// ── Last used ─────────────────────────────────────────────────────

/**
 * Record that a merchant key made an accepted request. Best-effort and
 * throttled: the write only happens if the key has not been seen in the last
 * `MERCHANT_KEY_LAST_USED_THROTTLE_SECONDS` (enforced in the repository's
 * SQL), and any failure is swallowed — liveness tracking must never break or
 * slow an authenticated request.
 *
 * Exported for testing; called fire-and-forget from the hook.
 */
export async function touchMerchantKeyLastUsed(
  keyId: string,
  db?: QueryableLike,
): Promise<void> {
  try {
    await touchMerchantKeyLastUsedRow(
      keyId,
      MERCHANT_KEY_LAST_USED_THROTTLE_SECONDS,
      db as unknown as Executor | undefined,
    )
  } catch {
    // Best-effort: the response has its own path; never surface this.
  }
}

/**
 * Register an `onResponse` hook that records merchant-key liveness after each
 * ACCEPTED request. It runs after the route handler, so it never interleaves
 * with the handler's own queries, and it only fires when
 * `merchantAuthMiddleware` set `request.merchant` and the answer was a 2xx —
 * the mockup's list shows when the key was last used to make an accepted
 * request, not when it was last presented.
 *
 * Registered at root scope in `index.ts`, so the merchant routes (#4897) do
 * not have to remember it.
 */
export function registerMerchantLastUsedHook(app: FastifyInstance, db?: QueryableLike): void {
  app.addHook('onResponse', async (request, reply) => {
    const merchant = request.merchant
    if (!merchant) return
    if (reply.statusCode >= 400) return
    await touchMerchantKeyLastUsed(merchant.key_id, db)
  })
}
