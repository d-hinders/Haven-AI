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

/** The owner-directory projection (#1167). */
export interface SafeWithAccountTypeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
  /** 'delegator_hybrid' on the delegation rail; null/legacy = Safe rail (#1069). */
  account_type: string | null
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

/**
 * The owner-directory projection (moved from `routes/user.ts`, #1167). Same
 * scope and ordering as `LIST_SAFES_FOR_USER_SQL`, but it trades
 * `is_default`/`created_at` for `account_type` — the rail marker the directory
 * needs. Kept as its own statement rather than widening the other: both are
 * PREPARE-checked, and a shared superset would make every caller pay for
 * columns it does not read.
 */
export const LIST_SAFES_WITH_ACCOUNT_TYPE_FOR_USER_SQL = `SELECT id, safe_address, chain_id, name, account_type
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

/** `userId` is REQUIRED — tenant scope for the owner-directory Safe list. */
export async function listSafesWithAccountTypeForUser(
  userId: string,
  db: Executor = pool,
): Promise<SafeWithAccountTypeRow[]> {
  const result = await db.query<SafeWithAccountTypeRow>(
    LIST_SAFES_WITH_ACCOUNT_TYPE_FOR_USER_SQL,
    [userId],
  )
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

/**
 * The `PUT /user/safe` companion write (moved from `routes/user.ts`, #1167).
 *
 * Distinct from `INSERT_USER_SAFE_SQL`, which the multi-Safe import path uses:
 * this one hard-codes the name and the default flag and is IDEMPOTENT —
 * `DO NOTHING` means re-linking an already-linked Safe is a no-op rather than
 * an error, and in particular does NOT reset a name the user has since
 * changed. It returns nothing, so a conflict is indistinguishable from an
 * insert by design.
 */
export const LINK_DEFAULT_USER_SAFE_SQL = `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default)
       VALUES ($1, $2, $3, 'My account', true)
       ON CONFLICT (user_id, safe_address, chain_id) DO NOTHING`

/** `userId` is REQUIRED — the Safe is linked into that user's namespace. */
export async function linkDefaultUserSafe(
  userId: string,
  safeAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<void> {
  await db.query(LINK_DEFAULT_USER_SAFE_SQL, [userId, safeAddress, chainId])
}

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

// ── Hybrid owner-config source row (moved from rails/hybrid-account-config.ts, #999)

/**
 * chain_id is part of the row identity: the same owner config derives the
 * same address on EVERY chain, so a user can hold rows for one address on
 * both testnet and mainnet. Without the bind, rows[0] of an unordered result
 * could return the OTHER chain's signer set — found by the #908 money-path
 * review (a testnet row's backup passkey must never satisfy the mainnet
 * signer floor).
 */
export const FIND_HYBRID_OWNER_SAFE_ROW_SQL = `SELECT id, owner_address, single_signer_waiver_at FROM user_safes
     WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3`

export interface HybridOwnerSafeRow {
  id: string
  owner_address: string | null
  single_signer_waiver_at: string | null
}

/** `userId` is REQUIRED — owner-scoped account lookup. */
export async function findHybridOwnerSafeRow(
  userId: string,
  safeAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<HybridOwnerSafeRow | null> {
  const result = await db.query<HybridOwnerSafeRow>(FIND_HYBRID_OWNER_SAFE_ROW_SQL, [
    userId,
    safeAddress,
    chainId,
  ])
  return result.rows[0] ?? null
}

// ── Safe-details ownership check (moved from routes/safe-details.ts, #999) ──

export const FIND_OWNED_SAFE_WITH_TYPE_ANY_CHAIN_SQL =
  'SELECT id, chain_id, account_type FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)'

export const FIND_OWNED_SAFE_WITH_TYPE_FOR_CHAIN_SQL =
  'SELECT id, chain_id, account_type FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3'

export interface OwnedSafeWithTypeRow {
  id: string
  chain_id: number
  account_type: string | null
}

/**
 * `userId` is REQUIRED — the ownership check `/safe/:safeAddress/details`
 * runs before probing the chain. `chainId === null` returns every chain the
 * address is owned on; the route decides whether that is ambiguous.
 */
export async function findOwnedSafesWithType(
  userId: string,
  safeAddress: string,
  chainId: number | null,
  db: Executor = pool,
): Promise<OwnedSafeWithTypeRow[]> {
  const result =
    chainId === null
      ? await db.query<OwnedSafeWithTypeRow>(FIND_OWNED_SAFE_WITH_TYPE_ANY_CHAIN_SQL, [
          userId,
          safeAddress,
        ])
      : await db.query<OwnedSafeWithTypeRow>(FIND_OWNED_SAFE_WITH_TYPE_FOR_CHAIN_SQL, [
          userId,
          safeAddress,
          chainId,
        ])
  return result.rows
}

// ── Execution-rail resolution (moved from rails/execution-rail.ts, #999) ────

/**
 * The account's rail for an agent. Lives in THIS aggregate because the only
 * column it returns is `user_safes.execution_rail`; the agent id is just the
 * lookup key. LEFT JOIN so a missing Safe row yields null → legacy
 * (fail-closed), never an error. The join goes through `agents.safe_id` —
 * the agent's bound Safe row — the same resolution the auth middleware uses.
 * NOTE: `agents` has NO `safe_address` column; an address-based join here
 * 500s on the real schema, which mocked route tests cannot catch — found
 * live on the first DoD run (#745).
 */
export const FIND_EXECUTION_RAIL_FOR_AGENT_SQL = `SELECT us.execution_rail
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1`

export async function findExecutionRailForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ execution_rail: string | null }>(
    FIND_EXECUTION_RAIL_FOR_AGENT_SQL,
    [agentId],
  )
  return result.rows[0]?.execution_rail ?? null
}

/**
 * The SESSION payload's safes projection (moved from `routes/auth.ts`, #1180).
 *
 * A third variant, and deliberately so: it is the union of the other two —
 * `is_default` and `created_at` from `LIST_SAFES_FOR_USER_SQL` plus
 * `account_type` from the directory projection. `POST /auth/login` and
 * `GET /auth/me` both return it, and `AuthContext` is what the Connect modal
 * reads, so **`account_type` must stay in this SELECT**: without it the modal
 * cannot tell a delegation account from a legacy one and dead-ends delegation
 * users at the wallet approval (#1069). `auth.test.ts` guards that field.
 */
export const LIST_SESSION_SAFES_FOR_USER_SQL = `SELECT id, safe_address, chain_id, name, is_default, created_at, account_type
       FROM user_safes WHERE user_id = $1 ORDER BY created_at ASC`

/** One row of the session payload's `safes` array. */
export interface SessionSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string | null
  is_default: boolean
  created_at: string
  account_type: string | null
}

/** `userId` is REQUIRED — it is the tenant scope of the whole payload. */
export async function listSessionSafesForUser(
  userId: string,
  db: Executor = pool,
): Promise<SessionSafeRow[]> {
  const result = await db.query<SessionSafeRow>(LIST_SESSION_SAFES_FOR_USER_SQL, [userId])
  return result.rows
}
