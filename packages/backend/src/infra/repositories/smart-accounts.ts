/**
 * Data access for the smart-account aggregate (#988, epic #980 M3; renamed
 * #2909, epic #2906): account rows, the default-account pointer, the legacy
 * `users.account_address` mirror, and the approver (Safe owner) metadata
 * decoration table. The underlying table is `smart_accounts` as of #2911
 * (schema rename, epic #2906 phase 3); the SQL text in this file was updated
 * in that same PR.
 *
 * Extracted verbatim from the account routes module (29 `.query` call sites) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Invariants a reader must not break:
 *
 * - Approver membership truth is ON-CHAIN (`getOwners()`); the
 *   `safe_approver_metadata` table only decorates owners with a label + type.
 *   Nothing here grants or removes an owner.
 * - Deleting a Safe must not orphan an agent with a live (pending/active/
 *   replaced) budget delegation or an in-flight sweep; the transaction locks bound agent rows
 *   before checking this.
 * - The legacy `users.account_address` column mirrors the default Safe; every
 *   default-pointer change keeps it in sync.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'
import { stillEnabledDelegationSql } from './delegation-budgets.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface SmartAccountRow {
  id: string
  account_address: string
  chain_id: number
  name: string
  is_default: boolean
  created_at: string
}

/** The owner-directory projection (#1167). */
export interface AccountWithTypeRow {
  id: string
  account_address: string
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
 * `= 'delegator_hybrid'` is an equality test, not a `<> 'legacy_safe'` one,
 * and that is deliberate: it excludes any future value as well as
 * `'legacy_safe'`. It does NOT exclude NULL, because there is no NULL to
 * exclude — `041_hybrid_accounts.ts` added the column `NOT NULL DEFAULT
 * 'safe'` under a two-value CHECK naming that same retired literal, so
 * pre-existing rows were backfilled to the retired value and the column's
 * domain had exactly two values. `085_account_type_legacy_safe.ts` (#2912)
 * later renamed that retired value to `'legacy_safe'` and tightened the CHECK
 * to `('legacy_safe','delegator_hybrid')` — the domain is still exactly two
 * values, the retired one just reads `'legacy_safe'` now.
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

export const LIST_ACCOUNTS_FOR_USER_SQL = `SELECT id, account_address, chain_id, name, is_default, created_at
       FROM smart_accounts
       WHERE user_id = $1 ${DELEGATION_RAIL_ONLY}
       ORDER BY created_at ASC`

/**
 * The owner-directory projection (moved from `routes/user.ts`, #1167). Same
 * scope and ordering as `LIST_ACCOUNTS_FOR_USER_SQL`, but it trades
 * `is_default`/`created_at` for `account_type` — the rail marker the directory
 * needs. Kept as its own statement rather than widening the other: both are
 * PREPARE-checked, and a shared superset would make every caller pay for
 * columns it does not read.
 */
export const LIST_ACCOUNTS_WITH_TYPE_FOR_USER_SQL = `SELECT id, account_address, chain_id, name, account_type
     FROM smart_accounts
     WHERE user_id = $1 ${DELEGATION_RAIL_ONLY}
     ORDER BY created_at ASC`

export const FIND_OWNED_ACCOUNT_ADDRESS_SQL = `SELECT id, account_address FROM smart_accounts WHERE id = $1 AND user_id = $2`

export const FIND_OWNED_ACCOUNT_DEFAULT_FLAG_SQL = `SELECT id, is_default FROM smart_accounts WHERE id = $1 AND user_id = $2`

/**
 * The funding read's ownership check (#2534).
 *
 * `FIND_OWNED_ACCOUNT_ADDRESS_SQL` kept no `account_type` filter because rename/
 * default/unlink manage whatever the user once linked. The funding endpoint is
 * a DELEGATION-rail surface — it tells a human how to fund the account their
 * agent spends from — so it scopes like the surviving account lists
 * (`DELEGATION_RAIL_ONLY`): a legacy-rail row answers 404 exactly as it does
 * on `GET /user/accounts`, rather than funding instructions for a rail nothing
 * new joins. `chain_id` comes back with the row so the route runs ONE query
 * instead of an ownership probe plus a list read.
 */
export const FIND_OWNED_ACCOUNT_FOR_FUNDING_SQL = `SELECT id, account_address, chain_id FROM smart_accounts
       WHERE id = $1 AND user_id = $2 ${DELEGATION_RAIL_ONLY}`

/**
 * `userId` is REQUIRED — the funding route's ownership check runs before any
 * chain read. Null when the id is unknown, another user's, or a legacy-Safe row.
 */
export async function findOwnedAccountForFunding(
  accountId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ id: string; account_address: string; chain_id: number } | null> {
  const result = await db.query<{ id: string; account_address: string; chain_id: number }>(
    FIND_OWNED_ACCOUNT_FOR_FUNDING_SQL,
    [accountId, userId],
  )
  return result.rows[0] ?? null
}

/** `userId` is REQUIRED — tenant scope for the Safe list. */
export async function listAccountsForUser(
  userId: string,
  db: Executor = pool,
): Promise<SmartAccountRow[]> {
  const result = await db.query<SmartAccountRow>(LIST_ACCOUNTS_FOR_USER_SQL, [userId])
  return result.rows
}

/** `userId` is REQUIRED — tenant scope for the owner-directory Safe list. */
export async function listAccountsWithTypeForUser(
  userId: string,
  db: Executor = pool,
): Promise<AccountWithTypeRow[]> {
  const result = await db.query<AccountWithTypeRow>(
    LIST_ACCOUNTS_WITH_TYPE_FOR_USER_SQL,
    [userId],
  )
  return result.rows
}

// `findAccountIdByAddressAndChain` (import duplicate detection), `countAccountsForUser`
// (first-account-becomes-default) and `findOwnedAccount` (the approver routes'
// ownership check) are DELETED with their callers (#1988). `findOwnedAccountAddress`
// and `findOwnedAccountDefaultFlag` below are the ownership checks the SURVIVING
// routes run — rename, re-default and unlink.

export async function findOwnedAccountAddress(
  accountId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ id: string; account_address: string } | null> {
  const result = await db.query<{ id: string; account_address: string }>(FIND_OWNED_ACCOUNT_ADDRESS_SQL, [
    accountId,
    userId,
  ])
  return result.rows[0] ?? null
}

export async function findOwnedAccountDefaultFlag(
  accountId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ id: string; is_default: boolean } | null> {
  const result = await db.query<{ id: string; is_default: boolean }>(
    FIND_OWNED_ACCOUNT_DEFAULT_FLAG_SQL,
    [accountId, userId],
  )
  return result.rows[0] ?? null
}

// The refusal ledger's (#2945) account resolution: the agent's account_address
// + chain against smart_accounts, the post-084 account vocabulary the
// payment_refusals FK targets. Extracted verbatim from
// modules/payments/refusal-ledger.ts so the boundary rules hold (the module
// may not import the pool, and the query is PREPARE-checked in CI like the
// rest of this directory). LIMIT 1 keeps a hypothetical duplicate
// (user_id, account_address, chain_id) row deterministic.

export const FIND_OWNED_ACCOUNT_ID_BY_ADDRESS_AND_CHAIN_SQL = `SELECT id FROM smart_accounts
  WHERE user_id = $1 AND account_address = $2 AND chain_id = $3
  LIMIT 1`

export async function findOwnedAccountIdByAddressAndChain(
  userId: string,
  accountAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_OWNED_ACCOUNT_ID_BY_ADDRESS_AND_CHAIN_SQL, [
    userId,
    accountAddress,
    chainId,
  ])
  return result.rows[0]?.id ?? null
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The `users.account_address` mirror. Still live: re-defaulting and unlinking both
 * keep the legacy column in step, and both of those routes survive the Safe-rail
 * retirement. Its INFLOW caller (the import path) is gone with #1988.
 */
export const SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL = `UPDATE users SET account_address = $1, updated_at = NOW() WHERE id = $2`

// The three INFLOW writers — the multi-Safe import insert,
// `PUT /user/safe`'s idempotent companion, and the legacy-address-set
// wrapper over the SQL above — are DELETED
// (#1988, epic #1440 slice 5). #1984 made all four inflow routes answer 410;
// this slice removed the handler bodies, which were their only callers. Nothing
// writes a NEW `smart_accounts` row on the Safe rail any more.
//
// `smart_accounts` itself stays, rows and all: the delegation rail inserts Hybrid
// accounts into the same table through `routes/hybrid-accounts.ts`, which has
// always carried its own INSERT and never used any of these.

export const RENAME_ACCOUNT_FOR_USER_SQL = `UPDATE smart_accounts SET name = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING id, account_address, chain_id, name, is_default, created_at`

/** `userId` is REQUIRED — the UPDATE is tenant-scoped in its WHERE clause. */
export async function renameAccountForUser(
  name: string,
  accountId: string,
  userId: string,
  db: Executor = pool,
): Promise<SmartAccountRow | null> {
  const result = await db.query<SmartAccountRow>(RENAME_ACCOUNT_FOR_USER_SQL, [name, accountId, userId])
  return result.rows[0] ?? null
}

/**
 * Clears the caller's defaults only when `$2` is an account the caller owns —
 * so a call naming someone else's account leaves the caller's own default
 * alone instead of leaving them with none (#3227).
 */
export const CLEAR_DEFAULT_ACCOUNTS_FOR_USER_SQL = `UPDATE smart_accounts SET is_default = false, updated_at = NOW()
           WHERE user_id = $1
             AND EXISTS (SELECT 1 FROM smart_accounts owned WHERE owned.id = $2 AND owned.user_id = $1)`

export const SET_ACCOUNT_DEFAULT_SQL = `UPDATE smart_accounts SET is_default = true, updated_at = NOW()
           WHERE id = $1 AND user_id = $2`

/**
 * Point the user's default at `accountId` and keep the legacy mirror in sync —
 * one transaction, exactly the route's BEGIN/COMMIT block. The route checks
 * ownership first (`findOwnedAccountAddress`), and every statement here is
 * tenant-scoped as well (#3227): for an account `userId` does not own, the
 * clear and the set match no row and the mirror is left untouched — a silent
 * no-op, the same posture as `renameAccountForUser`.
 */
export async function setDefaultAccountForUser(
  accountId: string,
  accountAddress: string,
  userId: string,
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(CLEAR_DEFAULT_ACCOUNTS_FOR_USER_SQL, [userId, accountId])
    const set = await tx.query(SET_ACCOUNT_DEFAULT_SQL, [accountId, userId])
    if (set.rowCount !== 1) return
    await tx.query(SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL, [accountAddress, userId])
  })
}

export const ORPHAN_AGENTS_FOR_ACCOUNT_SQL = `UPDATE agents SET account_id = NULL, updated_at = NOW() WHERE account_id = $1 AND user_id = $2`

// `ORPHAN_SELF_SIGN_AGENTS_FOR_ACCOUNT_SQL` was removed here (#2851, epic
// #1440's final slice): `self_sign_agents` no longer exists as of migration
// `083_drop_dead_safe_rail_tables.ts`, so there is nothing left to orphan.

export const DELETE_USER_ACCOUNT_SQL = `DELETE FROM smart_accounts WHERE id = $1 AND user_id = $2`

/** Serialize Safe unlink with delegation creation/activation on its agents. */
export const LOCK_AGENTS_FOR_ACCOUNT_SQL = `SELECT id FROM agents
       WHERE account_id = $1 AND user_id = $2
       FOR UPDATE`

// "Live" = pending, active AND replaced (#3542) — the revoke-all target set; a
// `replaced` row is still enabled on-chain until its Stop userop lands.
export const HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL = `SELECT EXISTS (
         SELECT 1
         FROM agent_delegations ad
         JOIN agents a ON a.id = ad.agent_id
         WHERE a.account_id = $1 AND a.user_id = $2
           AND ${stillEnabledDelegationSql('ad')}
       ) AS live`

export const HAS_OPEN_SWEEPS_FOR_ACCOUNT_SQL = `SELECT EXISTS (
         SELECT 1
         FROM delegate_sweeps ds
         JOIN agents a ON a.id = ds.agent_id
         WHERE a.account_id = $1 AND a.user_id = $2 AND ds.user_id = $2
           AND ds.status IN ('prepared', 'submitting')
       ) AS open`

export const HAS_IN_FLIGHT_REKEYS_FOR_ACCOUNT_SQL = `SELECT EXISTS (
         SELECT 1
         FROM agent_rekeys ar
         JOIN agents a ON a.id = ar.agent_id
         WHERE a.account_id = $1 AND a.user_id = $2
           AND ar.stage IN ('preflight', 'revoked', 'metered', 'issued')
       ) AS in_flight`

export const FIND_OLDEST_ACCOUNT_FOR_USER_SQL = `SELECT id, account_address FROM smart_accounts
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT 1`

export const PROMOTE_ACCOUNT_TO_DEFAULT_SQL = `UPDATE smart_accounts SET is_default = true, updated_at = NOW() WHERE id = $1`

export const CLEAR_LEGACY_USER_ACCOUNT_ADDRESS_SQL = `UPDATE users SET account_address = NULL, updated_at = NOW() WHERE id = $1`

/**
 * Unlink a Safe — one transaction, exactly the route's BEGIN/COMMIT block:
 * Lock bound agents and refuse when any still has live delegation authority;
 * otherwise orphan agents, delete the row, then — when the deleted Safe was
 * the default (`wasDefault`, read by the caller's ownership check) — promote
 * the oldest remaining Safe and re-point the legacy mirror, or clear the
 * mirror when none remain. Returning false means the Safe was kept intact
 * because a delegation, recovery sweep, or re-key is still in flight — or
 * because `userId` does not own it: the orphan and the delete are
 * tenant-scoped (#3227), so that call matches no row, removes nothing and
 * promotes nothing.
 *
 * Used to also orphan leftover `self_sign_agents` rows here, before the
 * delete, because their `NO ACTION` FK would otherwise block it. That step
 * was removed (#2851): the table itself is gone as of migration `083`.
 */
export async function deleteAccountForUser(
  accountId: string,
  userId: string,
  wasDefault: boolean,
  db: Executor = pool,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx.query(LOCK_AGENTS_FOR_ACCOUNT_SQL, [accountId, userId])
    const live = await tx.query<{ live: boolean }>(HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL, [accountId, userId])
    if (live.rows[0]?.live === true) return false
    const openSweep = await tx.query<{ open: boolean }>(HAS_OPEN_SWEEPS_FOR_ACCOUNT_SQL, [accountId, userId])
    if (openSweep.rows[0]?.open === true) return false
    const inFlightRekey = await tx.query<{ in_flight: boolean }>(HAS_IN_FLIGHT_REKEYS_FOR_ACCOUNT_SQL, [
      accountId,
      userId,
    ])
    if (inFlightRekey.rows[0]?.in_flight === true) return false

    await tx.query(ORPHAN_AGENTS_FOR_ACCOUNT_SQL, [accountId, userId])
    const deleted = await tx.query(DELETE_USER_ACCOUNT_SQL, [accountId, userId])
    if (deleted.rowCount !== 1) return false

    if (wasDefault) {
      const next = await tx.query<{ id: string; account_address: string }>(
        FIND_OLDEST_ACCOUNT_FOR_USER_SQL,
        [userId],
      )
      if (next.rows.length > 0) {
        await tx.query(PROMOTE_ACCOUNT_TO_DEFAULT_SQL, [next.rows[0].id])
        await tx.query(SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL, [next.rows[0].account_address, userId])
      } else {
        await tx.query(CLEAR_LEGACY_USER_ACCOUNT_ADDRESS_SQL, [userId])
      }
    }
    return true
  })
}

// ── Approver metadata — DELETED (#1988, epic #1440 slice 5) ──────────────────
//
// `safe_approver_metadata` had exactly one set of callers, the approver routes
// in the account routes module, and they are gone. The table itself is dropped in
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
export const FIND_HYBRID_OWNER_ACCOUNT_ROW_SQL = `SELECT id, owner_address, single_signer_waiver_at, deploy_salt FROM smart_accounts
     WHERE user_id = $1 AND LOWER(account_address) = LOWER($2) AND chain_id = $3`

export interface HybridOwnerAccountRow {
  id: string
  owner_address: string | null
  single_signer_waiver_at: string | null
  /**
   * The account's per-account deploy salt (#4023): `'0x'` for every account
   * created before migration 114, otherwise the 32-byte hex of the account's
   * never-reused counter value. Deriving or deploying this account at any
   * other salt derives a DIFFERENT account.
   */
  deploy_salt: string
}

/** `userId` is REQUIRED — owner-scoped account lookup. */
export async function findHybridOwnerAccountRow(
  userId: string,
  accountAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<HybridOwnerAccountRow | null> {
  const result = await db.query<HybridOwnerAccountRow>(FIND_HYBRID_OWNER_ACCOUNT_ROW_SQL, [
    userId,
    accountAddress,
    chainId,
  ])
  return result.rows[0] ?? null
}

// ── Safe-details ownership check (moved from routes/safe-details.ts, #999) ──

export const FIND_OWNED_ACCOUNT_WITH_TYPE_ANY_CHAIN_SQL =
  'SELECT id, chain_id, account_type FROM smart_accounts WHERE user_id = $1 AND LOWER(account_address) = LOWER($2)'

export const FIND_OWNED_ACCOUNT_WITH_TYPE_FOR_CHAIN_SQL =
  'SELECT id, chain_id, account_type FROM smart_accounts WHERE user_id = $1 AND LOWER(account_address) = LOWER($2) AND chain_id = $3'

export interface OwnedAccountWithTypeRow {
  id: string
  chain_id: number
  account_type: string | null
}

/**
 * `userId` is REQUIRED — the ownership check `/safe/:safeAddress/details`
 * runs before probing the chain. `chainId === null` returns every chain the
 * address is owned on; the route decides whether that is ambiguous.
 */
export async function findOwnedAccountsWithType(
  userId: string,
  accountAddress: string,
  chainId: number | null,
  db: Executor = pool,
): Promise<OwnedAccountWithTypeRow[]> {
  const result =
    chainId === null
      ? await db.query<OwnedAccountWithTypeRow>(FIND_OWNED_ACCOUNT_WITH_TYPE_ANY_CHAIN_SQL, [
          userId,
          accountAddress,
        ])
      : await db.query<OwnedAccountWithTypeRow>(FIND_OWNED_ACCOUNT_WITH_TYPE_FOR_CHAIN_SQL, [
          userId,
          accountAddress,
          chainId,
        ])
  return result.rows
}

// ── Execution-rail resolution (moved from rails/execution-rail.ts, #999) ────

/**
 * The account's rail for an agent. Lives in THIS aggregate because the only
 * column it returns is `smart_accounts.execution_rail`; the agent id is just the
 * lookup key. LEFT JOIN so a missing Safe row yields null → legacy
 * (fail-closed), never an error. The join goes through `agents.account_id` —
 * the agent's bound Safe row — the same resolution the auth middleware uses.
 * NOTE: `agents` has NO account-address column; an address-based join here
 * 500s on the real schema, which mocked route tests cannot catch — found
 * live on the first DoD run (#745).
 */
export const FIND_EXECUTION_RAIL_FOR_AGENT_SQL = `SELECT us.execution_rail
     FROM agents a
     LEFT JOIN smart_accounts us ON us.id = a.account_id
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
 * The SESSION payload's accounts projection (moved from `routes/auth.ts`, #1180).
 *
 * A third variant, and deliberately so: it is the union of the other two —
 * `is_default` and `created_at` from `LIST_ACCOUNTS_FOR_USER_SQL` plus
 * `account_type` from the directory projection. `POST /auth/login` and
 * `GET /auth/me` both return it, and `AuthContext` is what the Connect modal
 * reads, so **`account_type` must stay in this SELECT**: without it the modal
 * cannot tell a delegation account from a legacy one and dead-ends delegation
 * users at the wallet approval (#1069). `auth.test.ts` guards that field.
 */
// Query shape matters here: this runs on every login/me. The count is a
// direct LEFT JOIN + GROUP BY on the PK — user_id filters first, then per-safe
// index lookups on hybrid_account_passkeys(account_id). A GROUP BY derived
// table would hash-aggregate the WHOLE passkey table for every session
// (review finding on the first draft of #1205).
export const LIST_SESSION_ACCOUNTS_FOR_USER_SQL = `SELECT us.id, us.account_address, us.chain_id, us.name, us.is_default, us.created_at, us.account_type,
              us.owner_address,
              COUNT(hap.id)::int AS passkey_count
       FROM smart_accounts us
       LEFT JOIN hybrid_account_passkeys hap ON hap.account_id = us.id
       WHERE us.user_id = $1 AND us.account_type = 'delegator_hybrid'
       GROUP BY us.id
       ORDER BY us.created_at ASC`

/** One row of the session payload's `accounts` array. */
export interface SessionAccountRow {
  id: string
  account_address: string
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
   * (`hybrid_account_passkeys`); legacy-rail accounts count 0 there, and their
   * signer truth stays on-chain (the dashboard reads it via approvers).
   */
  owner_address: string | null
  passkey_count: number
}

/** `userId` is REQUIRED — it is the tenant scope of the whole payload. */
export async function listSessionAccountsForUser(
  userId: string,
  db: Executor = pool,
): Promise<SessionAccountRow[]> {
  const result = await db.query<SessionAccountRow>(LIST_SESSION_ACCOUNTS_FOR_USER_SQL, [userId])
  return result.rows
}

// ── Hybrid-account provisioning statements (#2911 review) ──────────────────
// Lifted verbatim from routes/hybrid-accounts.ts so the schema smoke PREPAREs
// the statements the signup path actually runs instead of a pasted copy — the
// #757 class: an inline literal that names a renamed object is proven by
// nothing until the first request fails.
export const FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_USER_SQL = `SELECT id FROM smart_accounts
       WHERE user_id = $1 AND LOWER(account_address) = LOWER($2) AND chain_id = $3`
export const COUNT_ACCOUNTS_FOR_USER_SQL = `SELECT COUNT(*) AS count FROM smart_accounts WHERE user_id = $1`
export const COUNT_ACCOUNTS_FOR_USER_ON_CHAIN_SQL = `SELECT COUNT(*) AS count FROM smart_accounts WHERE user_id = $1 AND chain_id = $2`
export const INSERT_HYBRID_ACCOUNT_SQL = `INSERT INTO smart_accounts (user_id, account_address, chain_id, name, is_default, account_type, execution_rail, owner_address, single_signer_waiver_at, deploy_salt, create_idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'delegator_hybrid', 'delegation', $6, $7, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING id, created_at`
export const FIND_OWNED_HYBRID_ACCOUNT_SQL = `SELECT 1 FROM smart_accounts
       WHERE user_id = $1 AND LOWER(account_address) = LOWER($2) AND chain_id = $3
         AND account_type = 'delegator_hybrid'`

// ── Multiple accounts (#4023, epic #4022 slice S1) ───────────────────────────
//
// The deploy salt is the linchpin: one passkey owns several accounts on one
// chain because each account's address is derived at its own salt. The
// The counter lives OUTSIDE smart_accounts on purpose — unlink is a hard DELETE
// of the account row (user-accounts.ts), and a counter kept there would
// reset, re-issuing the deleted account's salt and silently re-linking a
// possibly funded old address. The uniqueness rules are explicit UNIQUE
// constraints in migration 114: one on the derived address
// (user_id, chain_id, LOWER(account_address)) — the app-level duplicate
// check's rule, now carried by the database so a concurrent create cannot
// 500 on a bare constraint violation (the insert is ON CONFLICT DO NOTHING
// and re-reads the winner) — and one on the create idempotency key
// (user_id, create_idempotency_key) so a retried create answers the FIRST
// account, the payments.ts send_idempotency_key pattern.

/**
 * The per-(user, signer) salt counter's allocation. Atomic on the row: two
 * concurrent creates serialize on the UPDATE and return DISTINCT values.
 * `last_allocated` starts at 0; every allocation returns 1, 2, 3, … — the
 * salt stored on the account row is `pad(toHex(value), { size: 32 })`.
 */
export const ALLOCATE_HYBRID_DEPLOY_SALT_SQL = `INSERT INTO hybrid_deploy_salt_counters (user_id, salt_key, last_allocated)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, salt_key)
       DO UPDATE SET last_allocated = hybrid_deploy_salt_counters.last_allocated + 1, updated_at = NOW()
       RETURNING last_allocated`

/** The create-additional replay read: a retried create returns the FIRST account. */
export const FIND_ACCOUNT_BY_CREATE_IDEMPOTENCY_KEY_SQL = `SELECT id, account_address, chain_id, created_at FROM smart_accounts
       WHERE user_id = $1 AND create_idempotency_key = $2`

/** The source account a create-additional copies its owner passkey from — owner-scoped. */
export const FIND_DELEGATOR_HYBRID_ACCOUNT_FOR_USER_SQL = `SELECT id FROM smart_accounts
       WHERE id = $1 AND user_id = $2 AND account_type = 'delegator_hybrid'`

/**
 * The unique-address race loser's read: the winner's row with the fields the
 * 201 response echoes. User-scoped — a foreign row at the same derived
 * address is refused, not answered.
 */
export const FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_REPLAY_SQL = `SELECT id, created_at FROM smart_accounts
       WHERE user_id = $1 AND LOWER(account_address) = LOWER($2) AND chain_id = $3`

// ── Repository entry points for the provisioning route (#4023 round 2) ──────
//
// routes/hybrid-accounts.ts ran these statements through an imported pool —
// the last `pg-only-in-infra` waiver in routes/. Moved VERBATIM: same SQL
// constants, same parameter order, same row shapes; only the executor wiring
// changed. Convention (README): every function takes `userId` as a REQUIRED
// parameter and every statement scopes on it, and the executor comes LAST
// defaulting to the pool so the provisioning transaction can thread its `tx`
// through — the counter bump, the derived row and the copied passkeys commit
// together or not at all, which is the whole point of that transaction.

/** Pool-bound transaction entry point — a route must not import `db.ts`. */
export async function inTransaction<T>(
  fn: (tx: Executor) => Promise<T>,
  db: Executor = pool,
): Promise<T> {
  return withTransaction(db, fn)
}

/** The create-additional source row: null unless it is the caller's delegator_hybrid account. */
export async function findDelegatorHybridAccountForUser(
  userId: string,
  accountId: string,
  db: Executor = pool,
): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string }>(FIND_DELEGATOR_HYBRID_ACCOUNT_FOR_USER_SQL, [
    accountId,
    userId,
  ])
  return result.rows[0] ?? null
}

/** The #4023 soft-cap count: accounts the user already has on ONE chain. */
export async function countAccountsForUserOnChain(
  userId: string,
  chainId: number,
  db: Executor = pool,
): Promise<bigint> {
  const result = await db.query<{ count: string }>(COUNT_ACCOUNTS_FOR_USER_ON_CHAIN_SQL, [
    userId,
    chainId,
  ])
  return BigInt(result.rows[0]?.count ?? '0')
}

/** The create replay read: the FIRST account a retried create answers, or null. */
export async function findAccountByCreateIdempotencyKey(
  userId: string,
  idempotencyKey: string,
  db: Executor = pool,
): Promise<{ id: string; account_address: string; chain_id: number; created_at: string } | null> {
  // `chain_id` is what the replay answers (#4024): the STORED row's chain.
  const result = await db.query<{ id: string; account_address: string; chain_id: number; created_at: string }>(
    FIND_ACCOUNT_BY_CREATE_IDEMPOTENCY_KEY_SQL,
    [userId, idempotencyKey],
  )
  return result.rows[0] ?? null
}

/**
 * The counter bump. Atomic on the (user, salt_key) row — two concurrent
 * creates serialize on the UPDATE and get DISTINCT values. Returns
 * `last_allocated`, which starts at 1 (counter 0 is never issued).
 */
export async function allocateHybridDeploySalt(
  userId: string,
  saltKey: string,
  db: Executor = pool,
): Promise<string> {
  const result = await db.query<{ last_allocated: string }>(ALLOCATE_HYBRID_DEPLOY_SALT_SQL, [
    userId,
    saltKey,
  ])
  return result.rows[0].last_allocated
}

/** The pre-insert duplicate check: the caller's own row at the derived address, or null. */
export async function findHybridAccountByAddressForUser(
  userId: string,
  accountAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string }>(FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_USER_SQL, [
    userId,
    accountAddress,
    chainId,
  ])
  return result.rows[0] ?? null
}

/** The signup-default gate: the user's TOTAL account count across chains. */
export async function countAccountsForUser(userId: string, db: Executor = pool): Promise<bigint> {
  const result = await db.query<{ count: string }>(COUNT_ACCOUNTS_FOR_USER_SQL, [userId])
  return BigInt(result.rows[0]?.count ?? '0')
}

/**
 * The provisioning INSERT. Returns the RETURNING row, or null when the insert
 * lost a UNIQUE race — `ON CONFLICT DO NOTHING` has no target, so that is
 * either (user_id, chain_id, LOWER(account_address)) or (#4024) the
 * (user_id, create_idempotency_key) index — and the caller re-reads the
 * winner instead of 500ing on a bare constraint violation.
 */
export async function insertHybridAccount(
  input: {
    userId: string
    accountAddress: string
    chainId: number
    name: string
    isDefault: boolean
    ownerAddress: string | null
    singleSignerWaiverAt: string | null
    deploySalt: string
    createIdempotencyKey: string | null
  },
  db: Executor = pool,
): Promise<{ id: string; created_at: string } | null> {
  const result = await db.query<{ id: string; created_at: string }>(
    INSERT_HYBRID_ACCOUNT_SQL,
    [
      input.userId,
      input.accountAddress,
      input.chainId,
      input.name,
      input.isDefault,
      input.ownerAddress,
      input.singleSignerWaiverAt,
      input.deploySalt,
      input.createIdempotencyKey,
    ],
  )
  return result.rows[0] ?? null
}

/** The unique-race loser's re-read: the winner's 201-echo fields, or null (then it is a 409). */
export async function findHybridAccountByAddressForReplay(
  userId: string,
  accountAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<{ id: string; created_at: string } | null> {
  const result = await db.query<{ id: string; created_at: string }>(
    FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_REPLAY_SQL,
    [userId, accountAddress, chainId],
  )
  return result.rows[0] ?? null
}

/** The ownership read behind every account-scoped route (`SELECT 1` → boolean). */
export async function findOwnedHybridAccount(
  userId: string,
  accountAddress: string,
  chainId: number,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(FIND_OWNED_HYBRID_ACCOUNT_SQL, [userId, accountAddress, chainId])
  return result.rows.length > 0
}
