import type { PoolClient } from 'pg'

export const version = '010_x402_standard_metadata'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS x402_merchant_address VARCHAR(42),
      ADD COLUMN IF NOT EXISTS x402_idempotency_key VARCHAR(128);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_x402_idempotency
      ON payment_intents(agent_id, x402_idempotency_key)
      WHERE x402_idempotency_key IS NOT NULL;
  `)
}
