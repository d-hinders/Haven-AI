/**
 * Data access for the `account_entitlements` aggregate (#995, epic #980 M3).
 *
 * Extracted verbatim from `lib/entitlements.ts`, which keeps the policy layer
 * (which entitlement gates what, and the hosted/env conjunction) — this module
 * only owns the rows.
 *
 * Convention — see `README.md` in this directory. Executor last, defaulting to
 * the pool; `userId` tenant scope required; SQL in exported constants so
 * `scripts/db-schema-smoke.ts` can PREPARE it by import.
 */

import pool from '../../db.js'
import { type Executor } from '../transaction.js'

export type { Executor }

export const HAS_ENTITLEMENT_SQL = `SELECT 1 FROM account_entitlements
     WHERE user_id = $1 AND entitlement = $2 AND revoked_at IS NULL
     LIMIT 1`

/** True when the user holds the entitlement and it has not been revoked. */
export async function hasEntitlementRow(
  userId: string,
  entitlement: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(HAS_ENTITLEMENT_SQL, [userId, entitlement])
  return result.rows.length > 0
}

export const GRANT_ENTITLEMENT_SQL = `INSERT INTO account_entitlements (user_id, entitlement, granted_at, revoked_at)
     VALUES ($1, $2, NOW(), NULL)
     ON CONFLICT (user_id, entitlement)
     DO UPDATE SET granted_at = NOW(), revoked_at = NULL`

/** Grant an entitlement. Idempotent — re-granting clears any prior revocation. */
export async function grantEntitlementRow(
  userId: string,
  entitlement: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(GRANT_ENTITLEMENT_SQL, [userId, entitlement])
}

export const REVOKE_ENTITLEMENT_SQL = `UPDATE account_entitlements SET revoked_at = NOW()
     WHERE user_id = $1 AND entitlement = $2 AND revoked_at IS NULL`

/** Revoke an entitlement. Idempotent — a no-op if not granted. */
export async function revokeEntitlementRow(
  userId: string,
  entitlement: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(REVOKE_ENTITLEMENT_SQL, [userId, entitlement])
}
