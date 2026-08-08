/**
 * Data access for the owner-alias aggregate — the user's PRIVATE labels for
 * the on-chain owner addresses of the Safes they have linked.
 *
 * Extracted verbatim from `routes/user.ts` (#1167) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Invariants a reader must not break:
 *
 * - An alias is per-user, never global. Every statement is scoped by
 *   `user_id`, and `userId` is a REQUIRED parameter on all three functions —
 *   an unscoped read here would leak one user's naming of an address to
 *   another user who happens to share a co-owner.
 * - Aliases are DECORATION, not membership. Owner truth is on-chain
 *   (`getSafeDetails().owners`); a row here for an address that is no longer
 *   an owner grants nothing. The route reads aliases only for addresses it
 *   has just confirmed on-chain, which is what keeps a removed owner's label
 *   from reappearing.
 * - Addresses are stored and matched lower-cased; the route normalises before
 *   calling in, so nothing here re-cases its arguments.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export interface OwnerAliasRow {
  owner_address: string
  name: string
}

export const LIST_OWNER_ALIASES_SQL = `SELECT owner_address, name
         FROM owner_aliases
         WHERE user_id = $1
           AND owner_address = ANY($2::varchar[])`

export const UPSERT_OWNER_ALIAS_SQL = `INSERT INTO owner_aliases (user_id, owner_address, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, owner_address)
         DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
         RETURNING owner_address, name`

export const DELETE_OWNER_ALIAS_SQL = `DELETE FROM owner_aliases
         WHERE user_id = $1 AND owner_address = $2`

/**
 * `userId` is REQUIRED — tenant scope for the alias lookup.
 *
 * `ownerAddresses` is the set the caller has just confirmed on-chain. Passing
 * a wider list than that is what would resurrect a removed owner's label, so
 * the narrowing belongs at the call site, not here.
 */
export async function listOwnerAliases(
  userId: string,
  ownerAddresses: string[],
  db: Executor = pool,
): Promise<OwnerAliasRow[]> {
  const result = await db.query<OwnerAliasRow>(LIST_OWNER_ALIASES_SQL, [userId, ownerAddresses])
  return result.rows
}

/**
 * `userId` is REQUIRED — the alias is written into that user's namespace.
 *
 * Returns the stored row rather than `| null`: `ON CONFLICT … DO UPDATE`
 * always produces exactly one row, on both the insert and the update path.
 */
export async function upsertOwnerAlias(
  userId: string,
  ownerAddress: string,
  name: string,
  db: Executor = pool,
): Promise<OwnerAliasRow> {
  const result = await db.query<OwnerAliasRow>(UPSERT_OWNER_ALIAS_SQL, [
    userId,
    ownerAddress,
    name,
  ])
  return result.rows[0]
}

/** `userId` is REQUIRED — the DELETE is tenant-scoped in its WHERE clause. */
export async function deleteOwnerAlias(
  userId: string,
  ownerAddress: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(DELETE_OWNER_ALIAS_SQL, [userId, ownerAddress])
}
