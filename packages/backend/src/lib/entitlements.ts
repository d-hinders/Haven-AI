import pool from '../db.js'
import { config } from '../config.js'

/**
 * Account entitlements (epic #491, P0 #493) — the gate paid hosted add-ons sit
 * behind.
 *
 * v1 has one entitlement, granted manually. Future pricing tiers will map a plan
 * to a set of entitlements:
 *
 *   free       → {}
 *   pro        → { 'reporting_feed' }
 *   enterprise → { 'reporting_feed', ... }
 *
 * …by granting/revoking rows in `account_entitlements`. No code in this gate
 * changes when tiers land — only who holds which entitlement.
 *
 * **Manual grant/revoke (v1, until billing exists):**
 *   grant:  SELECT entitlement … or call grantEntitlement(userId, 'reporting_feed')
 *   psql:   INSERT INTO account_entitlements (user_id, entitlement)
 *           VALUES ('<uuid>', 'reporting_feed')
 *           ON CONFLICT (user_id, entitlement) DO UPDATE SET revoked_at = NULL;
 *   revoke: UPDATE account_entitlements SET revoked_at = NOW()
 *           WHERE user_id = '<uuid>' AND entitlement = 'reporting_feed';
 */
export const REPORTING_FEED = 'reporting_feed'

/** True when the user holds the entitlement and it has not been revoked. */
export async function hasEntitlement(userId: string, entitlement: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM account_entitlements
     WHERE user_id = $1 AND entitlement = $2 AND revoked_at IS NULL
     LIMIT 1`,
    [userId, entitlement],
  )
  return result.rows.length > 0
}

/** Grant an entitlement. Idempotent — re-granting clears any prior revocation. */
export async function grantEntitlement(userId: string, entitlement: string): Promise<void> {
  await pool.query(
    `INSERT INTO account_entitlements (user_id, entitlement, granted_at, revoked_at)
     VALUES ($1, $2, NOW(), NULL)
     ON CONFLICT (user_id, entitlement)
     DO UPDATE SET granted_at = NOW(), revoked_at = NULL`,
    [userId, entitlement],
  )
}

/** Revoke an entitlement. Idempotent — a no-op if not granted. */
export async function revokeEntitlement(userId: string, entitlement: string): Promise<void> {
  await pool.query(
    `UPDATE account_entitlements SET revoked_at = NOW()
     WHERE user_id = $1 AND entitlement = $2 AND revoked_at IS NULL`,
    [userId, entitlement],
  )
}

/**
 * Whether the reporting feed (#491) is available to this account: it must be the
 * hosted deployment, the global flag must be on, AND the account must hold the
 * entitlement. All three — env alone can never enable it on a self-hosted box.
 */
export async function reportingFeedAvailable(userId: string): Promise<boolean> {
  if (!config.hosted || !config.reportingFeedEnabled) return false
  return hasEntitlement(userId, REPORTING_FEED)
}
