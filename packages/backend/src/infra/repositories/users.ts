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

// `UPDATE_USER_SAFE_ADDRESS_SQL` and `updateUserSafeAddress` are DELETED
// (#1988). `PUT /user/safe` was their only caller and it is a 410 tombstone.
// The legacy `users.safe_address` mirror is still written — by re-default and
// unlink — through `SET_LEGACY_USER_SAFE_ADDRESS_SQL` in `user-safes.ts`,
// which issues the identical UPDATE and is still exercised by the schema smoke.

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

// ── Credentials & signup (#1180) ─────────────────────────────────────────────
//
// The one place in this module where `email` — not `id` — is the lookup key.
// That is not an exception to the tenant rule: these two statements run
// BEFORE there is a session, and establishing which account the caller may
// act as is exactly their job. Everything after authentication is scoped by
// `id` like the rest of the file.
//
// The caller must pass an already-NORMALISED address (trimmed, lower-cased).
// The lookup is an exact match, so normalisation is what makes the address
// unique in practice — pass the raw input and `ADA@Example.com` will not
// collide with a stored `ada@example.com`, letting one person hold two
// accounts with two separate treasuries. `routes/auth.ts::normalizeEmail`
// owns that normalisation and
// `routes/__tests__/auth-sql.characterization.test.ts` pins it.

export const FIND_USER_ID_BY_EMAIL_SQL = 'SELECT id FROM users WHERE email = $1'

export const INSERT_USER_SQL =
  'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at'

export const FIND_USER_CREDENTIALS_BY_EMAIL_SQL =
  'SELECT id, name, email, password_hash, wallet_address, safe_address, currency_preference FROM users WHERE email = $1'

export const FIND_USER_PROFILE_BY_ID_SQL =
  'SELECT id, name, email, wallet_address, safe_address, currency_preference, created_at FROM users WHERE id = $1'

/** The signup INSERT's projection — no `password_hash`, deliberately. */
export interface NewUserRow {
  id: string
  name: string | null
  email: string
  created_at: string
}

/**
 * The login projection. Carries `password_hash` — the ONLY row shape in this
 * module that does — so it must never be spread into a response body.
 */
export interface UserCredentialsRow extends UserProfileRow {
  password_hash: string
}

/**
 * Does an account already exist for this (normalised) address?
 *
 * Returns the id rather than a boolean because the caller may want it, and a
 * boolean would tempt a second round trip.
 */
export async function findUserIdByEmail(
  normalisedEmail: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_USER_ID_BY_EMAIL_SQL, [normalisedEmail])
  return result.rows[0]?.id ?? null
}

/**
 * Create the account. `passwordHash` must ALREADY be hashed — this module
 * never sees a plaintext password and must never learn how to hash one.
 */
export async function insertUser(
  name: string,
  normalisedEmail: string,
  passwordHash: string,
  db: Executor = pool,
): Promise<NewUserRow> {
  const result = await db.query<NewUserRow>(INSERT_USER_SQL, [name, normalisedEmail, passwordHash])
  return result.rows[0]
}

/**
 * The login read. Returns `null` for "no such account" so the route can give
 * the same 401 it gives for a wrong password — distinguishing the two would
 * turn this endpoint into an account-enumeration oracle.
 */
export async function findUserCredentialsByEmail(
  normalisedEmail: string,
  db: Executor = pool,
): Promise<UserCredentialsRow | null> {
  const result = await db.query<UserCredentialsRow>(FIND_USER_CREDENTIALS_BY_EMAIL_SQL, [
    normalisedEmail,
  ])
  return result.rows[0] ?? null
}

/** The `GET /auth/me` profile read. `userId` is the JWT subject, never client input. */
export async function findUserProfileById(
  userId: string,
  db: Executor = pool,
): Promise<UserProfileRow | null> {
  const result = await db.query<UserProfileRow>(FIND_USER_PROFILE_BY_ID_SQL, [userId])
  return result.rows[0] ?? null
}
