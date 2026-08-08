/**
 * Data access for the `users` aggregate — the account row itself: display
 * name, the connected wallet address, the legacy `safe_address` mirror, and
 * the currency preference.
 *
 * Extracted verbatim from `routes/user.ts` (#1167) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Invariants a reader must not break:
 *
 * - Every statement is scoped by `users.id`, and `userId` is a REQUIRED
 *   parameter on every function. There is no unscoped read or write of a user
 *   row here, and there must never be one: `id` is the tenant.
 * - `users.safe_address` is the LEGACY mirror of the default Safe. This module
 *   only carries the direct `PUT /user/safe` write; the mirror is otherwise
 *   maintained alongside the default-Safe pointer in `user-safes.ts`, and the
 *   two must not drift apart.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

/** The `PUT /user/profile` payload — the widest of the three user projections. */
export interface UserProfileRow {
  id: string
  name: string | null
  email: string
  wallet_address: string | null
  safe_address: string | null
  currency_preference: string | null
  created_at: string
}

/** The narrower projection the wallet + safe writes return. */
export interface UserIdentityRow {
  id: string
  name: string | null
  email: string
  wallet_address: string | null
  safe_address: string | null
}

export interface CurrencyPreferenceRow {
  currency_preference: string
}

// ── Profile ──────────────────────────────────────────────────────────────────

export const UPDATE_USER_NAME_SQL = `UPDATE users SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, safe_address, currency_preference, created_at`

/**
 * `userId` is REQUIRED — it is the row scope of the UPDATE.
 *
 * Returns `null` when no row matched, which happens only if the account was
 * deleted while a valid token for it was still in flight. The route decides
 * what that means; see the note at its call site.
 */
export async function updateUserName(
  name: string,
  userId: string,
  db: Executor = pool,
): Promise<UserProfileRow | null> {
  const result = await db.query<UserProfileRow>(UPDATE_USER_NAME_SQL, [name, userId])
  return result.rows[0] ?? null
}

// ── Wallet + legacy Safe pointer ─────────────────────────────────────────────

export const UPDATE_USER_WALLET_ADDRESS_SQL = `UPDATE users SET wallet_address = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, safe_address`

export const UPDATE_USER_SAFE_ADDRESS_SQL = `UPDATE users SET safe_address = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, safe_address`

/** `userId` is REQUIRED — it is the row scope of the UPDATE. */
export async function updateUserWalletAddress(
  walletAddress: string,
  userId: string,
  db: Executor = pool,
): Promise<UserIdentityRow | null> {
  const result = await db.query<UserIdentityRow>(UPDATE_USER_WALLET_ADDRESS_SQL, [
    walletAddress,
    userId,
  ])
  return result.rows[0] ?? null
}

/**
 * Write the legacy `users.safe_address` mirror from `PUT /user/safe`.
 * `userId` is REQUIRED — it is the row scope of the UPDATE.
 */
export async function updateUserSafeAddress(
  safeAddress: string,
  userId: string,
  db: Executor = pool,
): Promise<UserIdentityRow | null> {
  const result = await db.query<UserIdentityRow>(UPDATE_USER_SAFE_ADDRESS_SQL, [
    safeAddress,
    userId,
  ])
  return result.rows[0] ?? null
}

// ── Currency preference ──────────────────────────────────────────────────────

export const FIND_CURRENCY_PREFERENCE_SQL = 'SELECT currency_preference FROM users WHERE id = $1'

export const UPDATE_CURRENCY_PREFERENCE_SQL = `UPDATE users SET currency_preference = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING currency_preference`

/**
 * `userId` is REQUIRED — tenant scope for the read.
 *
 * `null` covers both "no such user row" and "the column is null"; the route
 * applies the same `'USD'` default to either, exactly as the inline query did.
 */
export async function findCurrencyPreference(
  userId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ currency_preference: string | null }>(
    FIND_CURRENCY_PREFERENCE_SQL,
    [userId],
  )
  return result.rows[0]?.currency_preference ?? null
}

/** `userId` is REQUIRED — it is the row scope of the UPDATE. */
export async function updateCurrencyPreference(
  currencyPreference: string,
  userId: string,
  db: Executor = pool,
): Promise<CurrencyPreferenceRow | null> {
  const result = await db.query<CurrencyPreferenceRow>(UPDATE_CURRENCY_PREFERENCE_SQL, [
    currencyPreference,
    userId,
  ])
  return result.rows[0] ?? null
}
