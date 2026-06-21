import type { PoolClient } from 'pg'

export const version = '032_account_entitlements'

/**
 * Per-account entitlements (epic #491, P0 #493).
 *
 * The seam paid hosted add-ons gate on. v1 has one entitlement —
 * 'reporting_feed' — granted manually. Modelling it as rows (not a boolean
 * column) means future pricing tiers map plan → {entitlements} without reworking
 * the gate: a tier change just grants/revokes rows here.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS account_entitlements (
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entitlement TEXT NOT NULL,
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at  TIMESTAMPTZ NULL,
      PRIMARY KEY (user_id, entitlement)
    );
  `)
}
