/**
 * Data access for the user-safes aggregate (#988, epic #980 M3): Safe rows,
 * the default-Safe pointer, the legacy `users.safe_address` mirror, and the
 * approver (Safe owner) metadata decoration table.
 *
 * Extracted verbatim from `routes/user-safes.ts` (29 `.query` call sites) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Invariants a reader must not break:
 *
 * - Approver membership truth is ON-CHAIN (`getOwners()`); the
 *   `safe_approver_metadata` table only decorates owners with a label + type.
 *   Nothing here grants or removes an owner.
 * - Deleting a Safe must orphan `self_sign_agents` rows BEFORE the delete —
 *   their RESTRICT foreign key otherwise blocks it (see the delete test).
 * - The legacy `users.safe_address` column mirrors the default Safe; every
 *   default-pointer change keeps it in sync.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface UserSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
  created_at: string
}

export interface OwnedSafeRow {
  id: string
  safe_address: string
  chain_id: number
}

export interface ApproverMetadataRow {
  address: string
  type: 'eoa' | 'passkey'
  label: string | null
}

export interface KnownApproverRow {
  address: string
  type: 'eoa' | 'passkey'
  label: string | null
  safe_ids: string[]
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const LIST_SAFES_FOR_USER_SQL = `SELECT id, safe_address, chain_id, name, is_default, created_at
       FROM user_safes
       WHERE user_id = $1
       ORDER BY created_at ASC`

export const FIND_SAFE_ID_BY_ADDRESS_AND_CHAIN_SQL = `SELECT id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3`

export const COUNT_SAFES_FOR_USER_SQL = `SELECT COUNT(*) as count FROM user_safes WHERE user_id = $1`

export const FIND_OWNED_SAFE_ADDRESS_SQL = `SELECT id, safe_address FROM user_safes WHERE id = $1 AND user_id = $2`

export const FIND_OWNED_SAFE_DEFAULT_FLAG_SQL = `SELECT id, is_default FROM user_safes WHERE id = $1 AND user_id = $2`

export const FIND_OWNED_SAFE_SQL = `SELECT id, safe_address, chain_id FROM user_safes WHERE id = $1 AND user_id = $2`

/** `userId` is REQUIRED — tenant scope for the Safe list. */
export async function listSafesForUser(
  userId: string,
  db: Executor = pool,
): Promise<UserSafeRow[]> {
  const result = await db.query<UserSafeRow>(LIST_SAFES_FOR_USER_SQL, [userId])
  return result.rows
}

/** `userId` is REQUIRED — duplicate detection is per-tenant. */
export async function findSafeIdByAddressAndChain(
  userId: string,
  safeAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_SAFE_ID_BY_ADDRESS_AND_CHAIN_SQL, [
    userId,
    safeAddress,
    chainId,
  ])
  return result.rows[0]?.id ?? null
}

export async function countSafesForUser(userId: string, db: Executor = pool): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_SAFES_FOR_USER_SQL, [userId])
  return Number(result.rows[0].count)
}

/** `userId` is REQUIRED — the ownership check every /:safeId route runs. */
export async function findOwnedSafe(
  safeId: string,
  userId: string,
  db: Executor = pool,
): Promise<OwnedSafeRow | null> {
  const result = await db.query<OwnedSafeRow>(FIND_OWNED_SAFE_SQL, [safeId, userId])
  return result.rows[0] ?? null
}

export async function findOwnedSafeAddress(
  safeId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ id: string; safe_address: string } | null> {
  const result = await db.query<{ id: string; safe_address: string }>(FIND_OWNED_SAFE_ADDRESS_SQL, [
    safeId,
    userId,
  ])
  return result.rows[0] ?? null
}

export async function findOwnedSafeDefaultFlag(
  safeId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ id: string; is_default: boolean } | null> {
  const result = await db.query<{ id: string; is_default: boolean }>(
    FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
    [safeId, userId],
  )
  return result.rows[0] ?? null
}

// ── Writes ───────────────────────────────────────────────────────────────────

export const INSERT_USER_SAFE_SQL = `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, safe_address, chain_id, name, is_default, created_at`

export const SET_LEGACY_USER_SAFE_ADDRESS_SQL = `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`

export async function insertUserSafe(
  input: {
    userId: string
    safeAddress: string
    chainId: number
    name: string
    isDefault: boolean
  },
  db: Executor = pool,
): Promise<UserSafeRow> {
  const result = await db.query<UserSafeRow>(INSERT_USER_SAFE_SQL, [
    input.userId,
    input.safeAddress,
    input.chainId,
    input.name,
    input.isDefault,
  ])
  return result.rows[0]
}

/**
 * Mirror the default Safe's address into the legacy `users.safe_address`
 * column. `userId` is REQUIRED — it is the row scope of the UPDATE.
 */
export async function setLegacyUserSafeAddress(
  safeAddress: string,
  userId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(SET_LEGACY_USER_SAFE_ADDRESS_SQL, [safeAddress, userId])
}

export const RENAME_SAFE_FOR_USER_SQL = `UPDATE user_safes SET name = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING id, safe_address, chain_id, name, is_default, created_at`

/** `userId` is REQUIRED — the UPDATE is tenant-scoped in its WHERE clause. */
export async function renameSafeForUser(
  name: string,
  safeId: string,
  userId: string,
  db: Executor = pool,
): Promise<UserSafeRow | null> {
  const result = await db.query<UserSafeRow>(RENAME_SAFE_FOR_USER_SQL, [name, safeId, userId])
  return result.rows[0] ?? null
}

export const CLEAR_DEFAULT_SAFES_FOR_USER_SQL = `UPDATE user_safes SET is_default = false, updated_at = NOW()
           WHERE user_id = $1`

export const SET_SAFE_DEFAULT_SQL = `UPDATE user_safes SET is_default = true, updated_at = NOW()
           WHERE id = $1`

/**
 * Point the user's default at `safeId` and keep the legacy mirror in sync —
 * one transaction, exactly the route's BEGIN/COMMIT block. The caller has
 * already verified ownership (`findOwnedSafeAddress`); the clear is scoped to
 * `userId`, the set is by id, verbatim from the route.
 */
export async function setDefaultSafeForUser(
  safeId: string,
  safeAddress: string,
  userId: string,
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(CLEAR_DEFAULT_SAFES_FOR_USER_SQL, [userId])
    await tx.query(SET_SAFE_DEFAULT_SQL, [safeId])
    await tx.query(SET_LEGACY_USER_SAFE_ADDRESS_SQL, [safeAddress, userId])
  })
}

export const ORPHAN_AGENTS_FOR_SAFE_SQL = `UPDATE agents SET safe_id = NULL, updated_at = NOW() WHERE safe_id = $1`

export const ORPHAN_SELF_SIGN_AGENTS_FOR_SAFE_SQL = `UPDATE self_sign_agents SET safe_id = NULL, updated_at = NOW() WHERE safe_id = $1`

export const DELETE_USER_SAFE_SQL = `DELETE FROM user_safes WHERE id = $1`

export const FIND_OLDEST_SAFE_FOR_USER_SQL = `SELECT id, safe_address FROM user_safes
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT 1`

export const PROMOTE_SAFE_TO_DEFAULT_SQL = `UPDATE user_safes SET is_default = true, updated_at = NOW() WHERE id = $1`

export const CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL = `UPDATE users SET safe_address = NULL, updated_at = NOW() WHERE id = $1`

/**
 * Unlink a Safe — one transaction, exactly the route's BEGIN/COMMIT block:
 * orphan agents, orphan leftover self-sign agents (their RESTRICT FK would
 * otherwise block the delete), delete the row, then — when the deleted Safe
 * was the default (`wasDefault`, read by the caller's ownership check) —
 * promote the oldest remaining Safe and re-point the legacy mirror, or clear
 * the mirror when none remain.
 */
export async function deleteSafeForUser(
  safeId: string,
  userId: string,
  wasDefault: boolean,
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(ORPHAN_AGENTS_FOR_SAFE_SQL, [safeId])
    await tx.query(ORPHAN_SELF_SIGN_AGENTS_FOR_SAFE_SQL, [safeId])
    await tx.query(DELETE_USER_SAFE_SQL, [safeId])

    if (wasDefault) {
      const next = await tx.query<{ id: string; safe_address: string }>(
        FIND_OLDEST_SAFE_FOR_USER_SQL,
        [userId],
      )
      if (next.rows.length > 0) {
        await tx.query(PROMOTE_SAFE_TO_DEFAULT_SQL, [next.rows[0].id])
        await tx.query(SET_LEGACY_USER_SAFE_ADDRESS_SQL, [next.rows[0].safe_address, userId])
      } else {
        await tx.query(CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL, [userId])
      }
    }
  })
}

// ── Approver metadata ────────────────────────────────────────────────────────

export const LIST_KNOWN_APPROVERS_FOR_USER_SQL = `SELECT DISTINCT ON (LOWER(m.address))
              m.address,
              m.type,
              m.label,
              (SELECT array_agg(m2.safe_id::text)
                 FROM safe_approver_metadata m2
                 JOIN user_safes s2 ON s2.id = m2.safe_id
                WHERE s2.user_id = $1 AND LOWER(m2.address) = LOWER(m.address)) AS safe_ids
         FROM safe_approver_metadata m
         JOIN user_safes s ON s.id = m.safe_id
        WHERE s.user_id = $1
        ORDER BY LOWER(m.address), m.updated_at DESC`

export const LIST_APPROVER_METADATA_FOR_SAFE_SQL = `SELECT address, type, label FROM safe_approver_metadata WHERE safe_id = $1`

export const UPSERT_APPROVER_METADATA_SQL = `INSERT INTO safe_approver_metadata (safe_id, address, type, label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (safe_id, LOWER(address))
         DO UPDATE SET type = EXCLUDED.type, label = EXCLUDED.label, updated_at = NOW()`

export const DELETE_APPROVER_METADATA_SQL = `DELETE FROM safe_approver_metadata WHERE safe_id = $1 AND LOWER(address) = LOWER($2)`

/** `userId` is REQUIRED — the registry is per-tenant across all their Safes. */
export async function listKnownApproversForUser(
  userId: string,
  db: Executor = pool,
): Promise<KnownApproverRow[]> {
  const result = await db.query<KnownApproverRow>(LIST_KNOWN_APPROVERS_FOR_USER_SQL, [userId])
  return result.rows
}

/**
 * Not tenant-scoped in SQL: every caller resolves `safeId` through
 * `findOwnedSafe` first — authorization stays in the route per #988.
 */
export async function listApproverMetadataForSafe(
  safeId: string,
  db: Executor = pool,
): Promise<ApproverMetadataRow[]> {
  const result = await db.query<ApproverMetadataRow>(LIST_APPROVER_METADATA_FOR_SAFE_SQL, [safeId])
  return result.rows
}

/** Same gating contract as `listApproverMetadataForSafe`. Idempotent. */
export async function upsertApproverMetadata(
  safeId: string,
  address: string,
  type: 'eoa' | 'passkey',
  label: string | null,
  db: Executor = pool,
): Promise<void> {
  await db.query(UPSERT_APPROVER_METADATA_SQL, [safeId, address, type, label])
}

/** Same gating contract as `listApproverMetadataForSafe`. */
export async function deleteApproverMetadata(
  safeId: string,
  address: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(DELETE_APPROVER_METADATA_SQL, [safeId, address])
}
