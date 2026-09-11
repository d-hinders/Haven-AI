import {
  grantEntitlementRow,
  hasEntitlementRow,
  revokeEntitlementRow,
} from '../../infra/repositories/account-entitlements.js'
import { config } from '../../config.js'

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
 *   how an account becomes entitled (#2861):
 *     HAVEN_ACCOUNTING_ENTITLEMENT_MODE=all      every account on the deployment
 *                                               (dev; no row needed, none written)
 *     HAVEN_ACCOUNTING_ENTITLEMENT_MODE=granted  the account must hold a row
 *                                               (the default; what prod runs)
 *   In `granted` mode a row is written with grantEntitlement(userId,
 *   'reporting_feed') — there is deliberately no route for it yet; a paid
 *   tier will own that. The hand-written INSERT this comment used to carry is
 *   gone: dev no longer needs it, and prod has no tier to grant.
 */
export const REPORTING_FEED = 'reporting_feed'

/** True when the user holds the entitlement and it has not been revoked. */
export async function hasEntitlement(userId: string, entitlement: string): Promise<boolean> {
  return hasEntitlementRow(userId, entitlement)
}

/** Grant an entitlement. Idempotent — re-granting clears any prior revocation. */
export async function grantEntitlement(userId: string, entitlement: string): Promise<void> {
  await grantEntitlementRow(userId, entitlement)
}

/** Revoke an entitlement. Idempotent — a no-op if not granted. */
export async function revokeEntitlement(userId: string, entitlement: string): Promise<void> {
  await revokeEntitlementRow(userId, entitlement)
}

/**
 * Whether the accounting feed (#491) is available to this account: it must be
 * the hosted deployment, the global flag must be on, AND the account must be
 * entitled. Env alone can never enable it on a self-hosted box.
 *
 * #2861: "entitled" is decided by `config.accountingEntitlementMode`. In
 * `granted` mode (the default, and what prod runs) the account must hold the
 * entitlement row — today's gate, unchanged. In `all` mode every account on the
 * deployment is entitled and the row is not consulted; that is what dev runs so
 * a new user can connect without anyone inserting a row by hand. The
 * hosted + flag checks come FIRST either way, so `all` on a self-hosted box or
 * with the flag off still answers false.
 */
export async function accountingFeedAvailable(userId: string): Promise<boolean> {
  return (await accountingFeedAvailability(userId)).available
}

/** The three-part answer the status endpoint renders, so the UI can say WHY. */
export async function accountingFeedAvailability(userId: string): Promise<{
  available: boolean
  entitled: boolean
  entitlementMode: 'granted' | 'all'
}> {
  const entitlementMode = config.accountingEntitlementMode
  if (!config.hosted || !config.accountingEnabled) {
    return { available: false, entitled: false, entitlementMode }
  }
  const entitled = entitlementMode === 'all' ? true : await hasEntitlement(userId, REPORTING_FEED)
  return { available: entitled, entitled, entitlementMode }
}
