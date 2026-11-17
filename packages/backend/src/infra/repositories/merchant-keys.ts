/**
 * Merchant keys — the receive-only credential's storage (#4896, epic #4885).
 *
 * Every function takes `userId` as a REQUIRED parameter and every statement
 * scopes on it, per this directory's README. The executor comes last and
 * defaults to the pool.
 *
 * The auth lookup is the one statement that cannot take a `userId` — it runs
 * before the caller is known, keyed on the hash. It therefore scopes the
 * account to the key's own user in the JOIN (`sa.user_id = mk.user_id`), so a
 * key can never resolve to an account that is not its own, including the same
 * user's other accounts.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

/** The wire shape of a key row. Never carries the hash or the secret. */
export interface MerchantKeyRow {
  id: string
  key_prefix: string
  created_by: string
  created_at: string
  revoked_by: string | null
  revoked_at: string | null
  last_used_at: string | null
}

/** What the middleware needs to authenticate a merchant request. */
export interface MerchantKeyAuthRow {
  key_id: string
  user_id: string
  account_id: string
  account_address: string
  chain_id: number
  revoked_at: string | null
  is_merchant_account: boolean
  services_enabled: boolean
}

export interface InsertMerchantKeyInput {
  userId: string
  accountId: string
  keyHash: string
  keyPrefix: string
  createdBy: string
}

const KEY_COLUMNS = `id, key_prefix, created_by, created_at, revoked_by, revoked_at, last_used_at`

export const INSERT_MERCHANT_KEY_SQL = `INSERT INTO merchant_keys
         (user_id, account_id, key_hash, key_prefix, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${KEY_COLUMNS}`

/** Newest first. The list returns prefixes only — never the hash, never the secret. */
export const LIST_MERCHANT_KEYS_SQL = `SELECT ${KEY_COLUMNS}
       FROM merchant_keys
       WHERE user_id = $1
       ORDER BY created_at DESC, id`

/**
 * The auth lookup. One row per secret (the UNIQUE index on `key_hash`).
 *
 * `services_enabled` is read from the per-user setting in the same statement,
 * so the middleware cannot authenticate a key for an account whose merchant
 * services are off. A missing setting row reads as `false` — the honest state
 * for a user who never turned the feature on.
 */
export const MERCHANT_KEY_AUTH_SQL = `SELECT mk.id AS key_id, mk.user_id, mk.account_id, mk.revoked_at,
         sa.account_address, sa.chain_id, sa.is_merchant_account,
         COALESCE(ms.enabled, false) AS services_enabled
       FROM merchant_keys mk
       JOIN smart_accounts sa ON sa.id = mk.account_id AND sa.user_id = mk.user_id
       LEFT JOIN merchant_service_settings ms ON ms.user_id = mk.user_id
       WHERE mk.key_hash = $1`

/**
 * Revoke one key. Scoped on the row id AND the user, and only when it is not
 * already revoked — so a second revoke cannot rewrite who revoked it or when.
 * `rowCount === 0` means "not yours, not found, or already revoked"; the route
 * distinguishes the last case with `FIND_MERCHANT_KEY_SQL`.
 */
export const REVOKE_MERCHANT_KEY_SQL = `UPDATE merchant_keys
       SET revoked_by = $3, revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING ${KEY_COLUMNS}`

/** One key of the caller's, revoked or not. */
export const FIND_MERCHANT_KEY_SQL = `SELECT ${KEY_COLUMNS}
       FROM merchant_keys
       WHERE id = $1 AND user_id = $2`

/**
 * Record that the key made an accepted request — at most once per
 * `MERCHANT_KEY_LAST_USED_THROTTLE_SECONDS` per key. The throttle is in the
 * WHERE clause, so a busy kit causes one write a minute, not one per call.
 */
export const TOUCH_MERCHANT_KEY_LAST_USED_SQL = `UPDATE merchant_keys
       SET last_used_at = NOW()
       WHERE id = $1
         AND (last_used_at IS NULL
              OR last_used_at < NOW() - make_interval(secs => $2))`

/** Insert a key row. The secret is NOT passed in — only its hash and prefix. */
export async function insertMerchantKey(
  input: InsertMerchantKeyInput,
  db: Executor = pool,
): Promise<MerchantKeyRow> {
  const result = await db.query<MerchantKeyRow>(INSERT_MERCHANT_KEY_SQL, [
    input.userId,
    input.accountId,
    input.keyHash,
    input.keyPrefix,
    input.createdBy,
  ])
  return result.rows[0]
}

/** The caller's keys, newest first. */
export async function listMerchantKeysForUser(
  userId: string,
  db: Executor = pool,
): Promise<MerchantKeyRow[]> {
  const result = await db.query<MerchantKeyRow>(LIST_MERCHANT_KEYS_SQL, [userId])
  return result.rows
}

/** The auth row for a presented secret's hash, or null. */
export async function findMerchantKeyAuthRowByHash(
  keyHash: string,
  db: Executor = pool,
): Promise<MerchantKeyAuthRow | null> {
  const result = await db.query<MerchantKeyAuthRow>(MERCHANT_KEY_AUTH_SQL, [keyHash])
  return result.rows[0] ?? null
}

/** Revoke the caller's key. Null when no row was revoked (not theirs, or already revoked). */
export async function revokeMerchantKey(
  userId: string,
  keyId: string,
  revokedBy: string,
  db: Executor = pool,
): Promise<MerchantKeyRow | null> {
  const result = await db.query<MerchantKeyRow>(REVOKE_MERCHANT_KEY_SQL, [keyId, userId, revokedBy])
  return result.rows[0] ?? null
}

/** One of the caller's keys, revoked or not. */
export async function findMerchantKeyForUser(
  userId: string,
  keyId: string,
  db: Executor = pool,
): Promise<MerchantKeyRow | null> {
  const result = await db.query<MerchantKeyRow>(FIND_MERCHANT_KEY_SQL, [keyId, userId])
  return result.rows[0] ?? null
}

/** Throttled `last_used_at` write. Returns true when the row was written. */
export async function touchMerchantKeyLastUsedRow(
  keyId: string,
  throttleSeconds: number,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(TOUCH_MERCHANT_KEY_LAST_USED_SQL, [keyId, throttleSeconds])
  return result.rowCount === 1
}
