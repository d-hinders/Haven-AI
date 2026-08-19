import type { PoolClient } from 'pg'

export const version = '043_delegation_intents'

/**
 * Payment intents on the delegation rail (#829, epic #821 Phase 3).
 *
 * The rail is pinned at authorize time exactly as #745 pinned the session
 * rail: an intent is verified and executed on the rail whose payload the
 * client actually signed, even if account state changes in between.
 *
 * - payment_intents.delegation_hash — which delegation (identity per #827)
 *   authorized this payment. The budget/recipient/expiry live in that
 *   delegation's caveats; the enforcers are the authority.
 * - payment_intents.prepared_user_op — the sponsored redemption UserOp whose
 *   hash the agent signs. A separate column from session_user_op on purpose:
 *   the session column kept its exact meaning for as long as the session rail
 *   lived (#834 has since retired it outright), so neither rail could ever
 *   read the other's state.
 *
 * Additive; NULL on every existing row.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS delegation_hash VARCHAR(66),
      ADD COLUMN IF NOT EXISTS prepared_user_op JSONB;
  `)
}

/**
 * Best-effort structural reverse (#1139) — mirrors what up() created. The
 * runner never calls down(); this exists for operator rollback tooling only.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      DROP COLUMN IF EXISTS prepared_user_op,
      DROP COLUMN IF EXISTS delegation_hash
  `)
}
