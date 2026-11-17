/**
 * The Sales key's dashboard routes (#4896, epic #4885).
 *
 * The owner, signed in to the dashboard, creates a receive-only merchant key,
 * lists the account's keys by prefix, and revokes one. No screen is built
 * here (#4905); these are the routes it calls.
 *
 * ## The secret is returned once
 *
 * `POST /merchant-keys` mints the secret, stores only its SHA-256 hash and its
 * display prefix, and returns the secret in that one response. No later read
 * can produce it: `GET /merchant-keys` selects the prefix and the four
 * who/when columns, never the hash, and there is no route that returns a
 * secret for an existing key. A lost secret is replaced by revoking the key
 * and creating another.
 *
 * ## Bound to the merchant account
 *
 * A key is created for the caller's merchant account — the account
 * `POST /merchant-services` created and marked. There is no account id in the
 * request: the account is the caller's merchant account, so a key cannot be
 * minted for another account, including the same user's other accounts. With
 * no merchant account yet the route refuses with
 * `MERCHANT_ACCOUNT_REQUIRED` rather than minting a credential that could
 * never authenticate.
 *
 * ## Revocation
 *
 * `DELETE /merchant-keys/:id` records who revoked the key and when, and the
 * key is refused on the next request. Revoking twice is idempotent: the second
 * call answers the row unchanged, so it cannot rewrite `revoked_by` /
 * `revoked_at`. A key that is not the caller's answers 404 — never 403 — so
 * the URL does not confirm another user's key exists.
 *
 * ## Money path
 *
 * The key is a credential for the receive side: it can describe payments that
 * already reached its account and cannot create one. Creating and revoking it
 * changes who may report sales into the account, so both carry the money-path
 * rate limit and the module sits on the money-path perimeter. Nothing here
 * moves funds or signs anything.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { findMerchantAccountForUser } from '../infra/repositories/merchant-services.js'
import {
  findMerchantKeyForUser,
  insertMerchantKey,
  listMerchantKeysForUser,
  revokeMerchantKey,
  type MerchantKeyRow,
} from '../infra/repositories/merchant-keys.js'
import {
  MERCHANT_ACCOUNT_REQUIRED,
  MERCHANT_KEY_NOT_FOUND,
  generateMerchantKey,
} from '../domain/merchant-keys.js'

/** The wire shape of a key. Never carries the hash or the secret. */
function serializeMerchantKey(row: MerchantKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    key_prefix: row.key_prefix,
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_by: row.revoked_by,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
  }
}

export default async function merchantKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  /**
   * Create a key for the caller's merchant account.
   *
   * 201 with the secret in the body — the only time it is ever returned. The
   * request carries no body: the account is the caller's merchant account and
   * the key has no name (the mockup calls it the Sales key).
   */
  app.post('/', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }

    const account = await findMerchantAccountForUser(sub)
    if (account === null) {
      return reply.code(409).send({
        error: 'Turn merchant services on before creating a Sales key',
        error_code: MERCHANT_ACCOUNT_REQUIRED,
      })
    }

    const generated = generateMerchantKey()
    const row = await insertMerchantKey({
      userId: sub,
      accountId: account.id,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      createdBy: sub,
    })

    return reply.code(201).send({
      ...serializeMerchantKey(row),
      secret: generated.secret,
    })
  })

  /**
   * The list: prefixes only, newest first, scoped to the caller. Revoked keys
   * stay in the list with their revocation time — the owner can see what was
   * revoked and when.
   */
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const keys = await listMerchantKeysForUser(sub)
    return { keys: keys.map(serializeMerchantKey) }
  })

  /**
   * Revoke one of the caller's keys. Idempotent: a second revoke answers the
   * row unchanged. 404 for a key that is not the caller's.
   */
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const revoked = await revokeMerchantKey(sub, id, sub)
      if (revoked !== null) return serializeMerchantKey(revoked)

      const existing = await findMerchantKeyForUser(sub, id)
      if (existing === null) {
        return reply.code(404).send({
          error: 'No such Sales key',
          error_code: MERCHANT_KEY_NOT_FOUND,
        })
      }
      // Already revoked: answer the row as it stands, so a retry cannot
      // rewrite who revoked it or when.
      return serializeMerchantKey(existing)
    },
  )
}
