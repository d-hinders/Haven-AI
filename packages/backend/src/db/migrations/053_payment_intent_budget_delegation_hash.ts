import type { PoolClient } from 'pg'

export const version = '053_payment_intent_budget_delegation_hash'

/**
 * The METERING budget behind a delegation-rail intent (#1059, from the #1053
 * review finding 5).
 *
 * `delegation_hash` records the instrument the agent SIGNED for this intent —
 * which is scheme-dependent: the per-payment settlement CHILD on erc7710, the
 * budget itself on the 3009 funding leg and on direct /payments transfers.
 * That asymmetry made the metering budget unrecoverable for erc7710 intents
 * without parsing `prepared_user_op`, which is exactly the kind of derived
 * answer the accounting feed must not depend on.
 *
 * `budget_delegation_hash` is the SAME question answered uniformly: which
 * budget delegation metered this payment. On erc7710 it differs from
 * `delegation_hash` (child vs parent); on the other delegation-rail paths the
 * two coincide — written anyway, so consumers read ONE column regardless of
 * scheme.
 *
 * Additive and nullable: legacy-rail intents have no budget, and rows created
 * before this migration stay NULL (their value is derivable from stored state
 * if ever needed — we do not backfill derived data).
 *
 * 053 (not 052): 052 is taken by the in-flight #1112 passport opt-in
 * migration; the migration runner orders by the index registration, not the
 * filename, so the gap is harmless either way.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS budget_delegation_hash TEXT
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      DROP COLUMN IF EXISTS budget_delegation_hash
  `)
}
