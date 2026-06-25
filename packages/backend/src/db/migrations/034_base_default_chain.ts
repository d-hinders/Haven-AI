import type { PoolClient } from 'pg'

export const version = '034_base_default_chain'

/**
 * Base (8453) is the primary/default network (see CLAUDE.md). The original
 * schema (000_initial) defaulted `chain_id` to 100 (Gnosis) on the core
 * money-path tables. Repoint the column defaults to Base so that any insert
 * which omits `chain_id` lands on the documented default chain.
 *
 * This only affects FUTURE inserts that omit `chain_id`. Existing rows keep
 * their stored `chain_id` — no data is rewritten, so Gnosis safes/payments are
 * untouched.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes        ALTER COLUMN chain_id SET DEFAULT 8453;
    ALTER TABLE payment_intents   ALTER COLUMN chain_id SET DEFAULT 8453;
    ALTER TABLE approval_requests ALTER COLUMN chain_id SET DEFAULT 8453;
  `)
}
