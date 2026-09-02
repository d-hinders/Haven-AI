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
 * - Deleting a Safe must not orphan an agent with a pending or active budget
 *   delegation or an in-flight sweep; the transaction locks bound agent rows
 *   before checking this.
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

/** The owner-directory projection (#1167). */
export interface SafeWithAccountTypeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
  /** 'delegator_hybrid' on the delegation rail; null/legacy = Safe rail (#1069). */
  account_type: string | null
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * #2413: the dashboard stops rendering retired-rail accounts.
 *
 * Epic #1440's owner decision of 2026-09-02 is that retirement is DELETION,
 * not accommodation — no effort goes into a legacy-Safe experience, because
 * the population is zero (the census found 15 Base-mainnet Safes worth ~$0.12
 * total). Rather than keep ~25 files branching on `account_type` to render
 * those accounts nicely, the three account-list queries stop returning them
 * and every branch behind them becomes unreachable and deletable.
 *
 * `= 'delegator_hybrid'` is an equality test, not a `<> 'safe'` one, and that
 * is deliberate: it excludes any future value as well as `'safe'`. It does NOT
 * exclude NULL, because there is no NULL to exclude — `041_hybrid_accounts.ts`
 * added the column `NOT NULL DEFAULT 'safe'` under
 * `CHECK (account_type IN ('safe','delegator_hybrid'))`, so pre-existing rows
 * were backfilled to `'safe'` and the column's domain has exactly two values.
 * (An earlier draft of this comment claimed legacy rows "carry NULL" and a
 * test asserted it; the insert failed the not-null constraint in CI, which is
 * where the claim was corrected.)
 *
 * Deliberately a FILTER, not a migration. The rows stay, so this is reversible
 * by deleting one clause — the same reason `rails/execution-rail.ts` was kept.
 * Deleting the rows outright is a separate, still-open decision on the epic,
 * blocked on `payment_intents`' RESTRICT foreign key.
 *
 * This does NOT weaken tenant scoping: every query keeps `user_id = $1`, and
 * this clause only ever narrows further.
 */
const DELEGATION_RAIL_ONLY = `AND account_type = 'delegator_hybrid'`

export const LIST_SAFES_FOR_USER_SQL = `SELECT id, safe_address, chain_id, name, is_default, created_at
       FROM user_safes
       WHERE user_id = $1 ${DELEGATION_RAIL_ONLY}
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
     WHERE user_id = $1 ${DELEGATION_RAIL_ONLY}
     ORDER BY created_at ASC`

export const FIND_OWNED_SAFE_ADDRESS_SQL = `SELECT id, safe_address FROM user_safes WHERE id = $1 AND user_id = $2`

export const FIND_OWNED_SAFE_DEFAULT_FLAG_SQL = `SELECT id, is_default FROM user_safes WHERE id = $1 AND user_id = $2`

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

// `findSafeIdByAddressAndChain` (import duplicate detection), `countSafesForUser`
// (first-Safe-becomes-default) and `findOwnedSafe` (the approver routes'
// ownership check) are DELETED with their callers (#1988). `findOwnedSafeAddress`
// and `findOwnedSafeDefaultFlag` below are the ownership checks the SURVIVING
// routes run — rename, re-default and unlink.

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

/**
 * The `users.safe_address` mirror. Still live: re-defaulting and unlinking both
 * keep the legacy column in step, and both of those routes survive the Safe-rail
 * retirement. Its INFLOW caller (the import path) is gone with #1988.
 */
export const SET_LEGACY_USER_SAFE_ADDRESS_SQL = `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`

// The three INFLOW writers — `insertUserSafe` (the multi-Safe import),
// `linkDefaultUserSafe` (`PUT /user/safe`'s idempotent companion) and the
// `setLegacyUserSafeAddress` wrapper over the SQL above — are DELETED
// (#1988, epic #1440 slice 5). #1984 made all four inflow routes answer 410;
// this slice removed the handler bodies, which were their only callers. Nothing
// writes a NEW `user_safes` row on the Safe rail any more.
//
// `user_safes` itself stays, rows and all: the delegation rail inserts Hybrid
// accounts into the same table through `routes/hybrid-accounts.ts`, which has
// always carried its own INSERT and never used any of these.

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

/** Serialize Safe unlink with delegation creation/activation on its agents. */
export const LOCK_AGENTS_FOR_SAFE_SQL = `SELECT id FROM agents
       WHERE safe_id = $1 AND user_id = $2
       FOR UPDATE`

export const HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL = `SELECT EXISTS (
         SELECT 1
         FROM agent_delegations ad
         JOIN agents a ON a.id = ad.agent_id
         WHERE a.safe_id = $1 AND a.user_id = $2
           AND ad.status IN ('pending', 'active')
       ) AS live`

export const HAS_OPEN_SWEEPS_FOR_SAFE_SQL = `SELECT EXISTS (
         SELECT 1
         FROM delegate_sweeps ds
         JOIN agents a ON a.id = ds.agent_id
         WHERE a.safe_id = $1 AND a.user_id = $2 AND ds.user_id = $2
           AND ds.status IN ('prepared', 'submitting')
       ) AS open`

export const HAS_IN_FLIGHT_REKEYS_FOR_SAFE_SQL = `SELECT EXISTS (
         SELECT 1
         FROM agent_rekeys ar
         JOIN agents a ON a.id = ar.agent_id
         WHERE a.safe_id = $1 AND a.user_id = $2
           AND ar.stage IN ('preflight', 'revoked', 'metered', 'issued')
       ) AS in_flight`

export const FIND_OLDEST_SAFE_FOR_USER_SQL = `SELECT id, safe_address FROM user_safes
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT 1`

export const PROMOTE_SAFE_TO_DEFAULT_SQL = `UPDATE user_safes SET is_default = true, updated_at = NOW() WHERE id = $1`

export const CLEAR_LEGACY_USER_SAFE_ADDRESS_SQL = `UPDATE users SET safe_address = NULL, updated_at = NOW() WHERE id = $1`

/**
 * Unlink a Safe — one transaction, exactly the route's BEGIN/COMMIT block:
 * Lock bound agents and refuse when any still has live delegation authority;
 * otherwise orphan agents, orphan leftover self-sign agents (their RESTRICT
 * FK would otherwise block the delete), delete the row, then — when the
 * deleted Safe was the default (`wasDefault`, read by the caller's ownership
 * check) — promote the oldest remaining Safe and re-point the legacy mirror,
 * or clear the mirror when none remain. Returning false means the Safe was
 * kept intact because a delegation, recovery sweep, or re-key is still in
 * flight.
 */
export async function deleteSafeForUser(
  safeId: string,
  userId: string,
  wasDefault: boolean,
  db: Executor = pool,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx.query(LOCK_AGENTS_FOR_SAFE_SQL, [safeId, userId])
    const live = await tx.query<{ live: boolean }>(HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL, [safeId, userId])
    if (live.rows[0]?.live === true) return false
    const openSweep = await tx.query<{ open: boolean }>(HAS_OPEN_SWEEPS_FOR_SAFE_SQL, [safeId, userId])
    if (openSweep.rows[0]?.open === true) return false
    const inFlightRekey = await tx.query<{ in_flight: boolean }>(HAS_IN_FLIGHT_REKEYS_FOR_SAFE_SQL, [
      safeId,
      userId,
    ])
    if (inFlightRekey.rows[0]?.in_flight === true) return false

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
    return true
  })
}

// ── Approver metadata — DELETED (#1988, epic #1440 slice 5) ──────────────────
//
// `safe_approver_metadata` had exactly one set of callers, the approver routes
// in `routes/user-safes.ts`, and they are gone. The table itself is dropped in
// #1990 (CODEOWNERS-reviewed migration); leaving readers and writers behind for
// a table on its way out is the residue this epic exists to remove.

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
// Query shape matters here: this runs on every login/me. The count is a
// direct LEFT JOIN + GROUP BY on the PK — user_id filters first, then per-safe
// index lookups on hybrid_account_passkeys(user_safe_id). A GROUP BY derived
// table would hash-aggregate the WHOLE passkey table for every session
// (review finding on the first draft of #1205).
export const LIST_SESSION_SAFES_FOR_USER_SQL = `SELECT us.id, us.safe_address, us.chain_id, us.name, us.is_default, us.created_at, us.account_type,
              us.owner_address,
              COUNT(hap.id)::int AS passkey_count
       FROM user_safes us
       LEFT JOIN hybrid_account_passkeys hap ON hap.user_safe_id = us.id
       WHERE us.user_id = $1 AND us.account_type = 'delegator_hybrid'
       GROUP BY us.id
       ORDER BY us.created_at ASC`

/** One row of the session payload's `safes` array. */
export interface SessionSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string | null
  is_default: boolean
  created_at: string
  account_type: string | null
  /**
   * #1205: raw signer-set inputs for `needsBackupSignerRecommendation`. The
   * repository serves FACTS; the auth route maps them through the predicate
   * (`modules/accounts/mainnet-gate.ts`) so chain classification lives in
   * exactly one place. Passkey count is the delegation-rail signer table
   * (`hybrid_account_passkeys`); legacy-rail safes count 0 there, and their
   * signer truth stays on-chain (the dashboard reads it via approvers).
   */
  owner_address: string | null
  passkey_count: number
}

/** `userId` is REQUIRED — it is the tenant scope of the whole payload. */
export async function listSessionSafesForUser(
  userId: string,
  db: Executor = pool,
): Promise<SessionSafeRow[]> {
  const result = await db.query<SessionSafeRow>(LIST_SESSION_SAFES_FOR_USER_SQL, [userId])
  return result.rows
}
