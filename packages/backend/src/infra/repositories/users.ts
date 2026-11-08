/**
 * Data access for the `users` aggregate — the account row itself: display
 * name, the connected wallet address, the legacy account-address mirror, and
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
 * - `users.account_address` is the LEGACY mirror of the default Safe. This module
 *   only carries the direct `PUT /user/safe` write; the mirror is otherwise
 *   maintained alongside the default-Safe pointer in `smart-accounts.ts`, and the
 *   two must not drift apart.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'
import { DEFAULT_TRANSACTION_CURRENCY } from '../../domain/transaction-currency.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

/** The `PUT /user/profile` payload — the widest of the three user projections. */
export interface UserProfileRow {
  id: string
  name: string | null
  email: string
  wallet_address: string | null
  account_address: string | null
  currency_preference: string | null
  created_at: string
}

/** The narrower projection the wallet + safe writes return. */
export interface UserIdentityRow {
  id: string
  name: string | null
  email: string
  wallet_address: string | null
  account_address: string | null
}

export interface CurrencyPreferenceRow {
  currency_preference: string
}

// ── Profile ──────────────────────────────────────────────────────────────────

export const UPDATE_USER_NAME_SQL = `UPDATE users SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, wallet_address, account_address, currency_preference, created_at`

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
       RETURNING id, name, email, wallet_address, account_address`

// The old direct-address-update SQL constant and its writer function are DELETED
// (#1988). `PUT /user/safe` was their only caller and it is a 410 tombstone.
// The legacy `users.account_address` mirror is still written — by re-default and
// unlink — through `SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL` in `smart-accounts.ts`,
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
 * applies `DEFAULT_TRANSACTION_CURRENCY` to either (`routes/user.ts`) — SEK
 * since #3127, the documented no-preference default. Migration 091 is what
 * makes the stored column agree: pre-existing inherited `'USD'` rows are
 * NULLed so this fallback, not an inherited literal, decides.
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

// ── Visits (#4709) ───────────────────────────────────────────────────────────
//
// The "Since your last visit" marker (migration 124, epic #4701 decision 4).
// It lives on the SERVER so a phone and a laptop agree, and it is written by
// ONE atomic statement so two devices cannot interleave into overlapping
// windows.
//
// The window a line describes is `(previous, current]`. `previous` is the
// instant the PREVIOUS entry opened, `current` the instant this one did — so a
// payment confirmed exactly on a boundary belongs to exactly one window.
//
// Retry safety: the client generates `entryId` and stores it BEFORE calling.
// A retry carrying the same id returns the stored bounds and does NOT move the
// marker; a different id opens a new entry. The accepted residual (stated on
// #4709) is that a retry arriving after ANOTHER device opened a new entry is
// treated as a new entry — the lost window's line is not shown, and nothing is
// counted twice.
//
// `current` never goes backwards: `GREATEST(COALESCE(visit_current_at, NOW()),
// NOW())` keeps a future marker (clock skew) where it is rather than rewinding
// the window.

export interface UserVisitRow {
  /** The previous entry's instant; NULL on the first ever visit. */
  previous: Date | null
  /** This entry's instant. */
  current: Date
}

/**
 * One statement, one row lock. The `locked` CTE takes the row lock with
 * `FOR UPDATE`; a concurrent entry blocks there and, under READ COMMITTED,
 * re-reads the committed row, so the second device's `previous` is the first
 * device's `current` — consecutive windows that do not overlap.
 *
 * `moved` writes only when the entry id differs. When it matches, the second
 * branch of the UNION returns the stored bounds from the SAME locked read, so
 * a retry cannot observe a marker another device moved between two round
 * trips.
 */
export const OPEN_USER_VISIT_SQL = `WITH locked AS (
    SELECT id, visit_current_at, visit_previous_at, visit_entry_id
      FROM users
     WHERE id = $1
     FOR UPDATE
  ), moved AS (
    UPDATE users u
       SET visit_previous_at = l.visit_current_at,
           visit_current_at = GREATEST(COALESCE(l.visit_current_at, NOW()), NOW()),
           visit_entry_id = $2,
           updated_at = NOW()
      FROM locked l
     WHERE u.id = l.id
       AND l.visit_entry_id IS DISTINCT FROM $2
    RETURNING u.visit_previous_at AS previous, u.visit_current_at AS current
  )
  SELECT previous, current FROM moved
  UNION ALL
  SELECT l.visit_previous_at AS previous, l.visit_current_at AS current
    FROM locked l
   WHERE l.visit_entry_id IS NOT DISTINCT FROM $2`

/**
 * Open (or re-open) one visit entry. `userId` is REQUIRED — it is the row
 * scope of the UPDATE. Returns `null` only when no user row matched, which
 * means the account was deleted while a valid token for it was in flight.
 */
export async function openUserVisit(
  entryId: string,
  userId: string,
  db: Executor = pool,
): Promise<UserVisitRow | null> {
  const result = await db.query<UserVisitRow>(OPEN_USER_VISIT_SQL, [userId, entryId])
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
  'INSERT INTO users (name, email, password_hash, via, currency_preference) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, created_at'

export const FIND_USER_CREDENTIALS_BY_EMAIL_SQL =
  'SELECT id, name, email, password_hash, wallet_address, account_address, currency_preference FROM users WHERE email = $1'

export const FIND_USER_PROFILE_BY_ID_SQL =
  'SELECT id, name, email, wallet_address, account_address, currency_preference, created_at FROM users WHERE id = $1'

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
  /**
   * Agent hand-off marker (#2522): `'agent'` when this signup came from a link
   * an agent pasted, else null. Required rather than optional so a new caller
   * has to decide; passing `null` is the ordinary answer.
   */
  via: string | null,
  db: Executor = pool,
): Promise<NewUserRow> {
  const result = await db.query<NewUserRow>(INSERT_USER_SQL, [
    name,
    normalisedEmail,
    passwordHash,
    via,
    DEFAULT_TRANSACTION_CURRENCY,
  ])
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
