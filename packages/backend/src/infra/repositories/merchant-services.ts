/**
 * Merchant services — the per-user setting and the per-account marker (#4895,
 * epic #4885).
 *
 * Two facts, two homes (migration 126 says why): the setting is a row in
 * `merchant_service_settings` keyed by `user_id`, and the marker is
 * `smart_accounts.is_merchant_account`, a partial unique index away from being
 * an invariant rather than a convention.
 *
 * Every function takes `userId` as a REQUIRED parameter and every statement
 * scopes on it, per this directory's README. The executor comes last and
 * defaults to the pool, so the turn-on route can thread its transaction
 * through and commit the setting, the account and the marker together.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export interface MerchantSettingRow {
  user_id: string
  enabled: boolean
  enabled_at: Date | string | null
  disabled_at: Date | string | null
}

export interface MerchantAccountRow {
  id: string
  account_address: string
  chain_id: number
  name: string
  created_at: string
}

/**
 * Ensure the caller's setting row exists AND lock it for the rest of the
 * transaction.
 *
 * The `DO UPDATE` is a deliberate no-op write: it takes the row lock that
 * serialises two concurrent turn-ons for one user, which is what makes the
 * "is there already a merchant account?" read below authoritative. Without it
 * two tabs could both read "no merchant account" and both create one — the
 * partial unique index would then refuse the second MARK, but only after a
 * second account row had been created and its salt counter bumped.
 *
 * A missing row is created with `enabled = false`; the caller enables it.
 */
export const LOCK_MERCHANT_SETTING_SQL = `INSERT INTO merchant_service_settings (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = merchant_service_settings.updated_at
       RETURNING user_id, enabled, enabled_at, disabled_at`

/** The caller's merchant account, or null. At most one row — the partial unique index. */
export const FIND_MERCHANT_ACCOUNT_FOR_USER_SQL = `SELECT id, account_address, chain_id, name, created_at
       FROM smart_accounts
       WHERE user_id = $1 AND is_merchant_account`

/**
 * Mark one account as the caller's merchant account.
 *
 * Tenant-scoped on both the row id and the user, so a caller cannot mark
 * somebody else's account even if it somehow held the id. A second mark for
 * the same user raises `23505` on `smart_accounts_one_merchant_per_user` —
 * that is the database refusing a second merchant account, not a bug.
 */
export const MARK_MERCHANT_ACCOUNT_SQL = `UPDATE smart_accounts
       SET is_merchant_account = true, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`

/**
 * Turn the setting on. `enabled_at` keeps the FIRST enable time — turning the
 * feature off and on again does not rewrite when it was first turned on.
 */
export const ENABLE_MERCHANT_SETTING_SQL = `UPDATE merchant_service_settings
       SET enabled = true,
           enabled_at = COALESCE(enabled_at, NOW()),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, enabled, enabled_at, disabled_at`

/** Turn the setting off. The account and its history stay; only the flag moves. */
export const DISABLE_MERCHANT_SETTING_SQL = `UPDATE merchant_service_settings
       SET enabled = false,
           disabled_at = NOW(),
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, enabled, enabled_at, disabled_at`

/** The dashboard read. Null when the user never turned the feature on. */
export const READ_MERCHANT_SETTING_SQL = `SELECT user_id, enabled, enabled_at, disabled_at
       FROM merchant_service_settings
       WHERE user_id = $1`

/** Ensure-and-lock the caller's setting row. See `LOCK_MERCHANT_SETTING_SQL`. */
export async function lockMerchantSetting(
  userId: string,
  db: Executor = pool,
): Promise<MerchantSettingRow> {
  const result = await db.query<MerchantSettingRow>(LOCK_MERCHANT_SETTING_SQL, [userId])
  return result.rows[0]
}

/** The caller's merchant account, or null. */
export async function findMerchantAccountForUser(
  userId: string,
  db: Executor = pool,
): Promise<MerchantAccountRow | null> {
  const result = await db.query<MerchantAccountRow>(FIND_MERCHANT_ACCOUNT_FOR_USER_SQL, [userId])
  return result.rows[0] ?? null
}

/** Mark `accountId` as the caller's merchant account. */
export async function markMerchantAccount(
  userId: string,
  accountId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_MERCHANT_ACCOUNT_SQL, [accountId, userId])
}

/** Turn the setting on and return the row. */
export async function enableMerchantSetting(
  userId: string,
  db: Executor = pool,
): Promise<MerchantSettingRow> {
  const result = await db.query<MerchantSettingRow>(ENABLE_MERCHANT_SETTING_SQL, [userId])
  return result.rows[0]
}

/** Turn the setting off and return the row. */
export async function disableMerchantSetting(
  userId: string,
  db: Executor = pool,
): Promise<MerchantSettingRow> {
  const result = await db.query<MerchantSettingRow>(DISABLE_MERCHANT_SETTING_SQL, [userId])
  return result.rows[0]
}

/** The caller's setting, or null when they never turned the feature on. */
export async function readMerchantSetting(
  userId: string,
  db: Executor = pool,
): Promise<MerchantSettingRow | null> {
  const result = await db.query<MerchantSettingRow>(READ_MERCHANT_SETTING_SQL, [userId])
  return result.rows[0] ?? null
}
