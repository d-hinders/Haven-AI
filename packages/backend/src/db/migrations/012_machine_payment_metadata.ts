import type { PoolClient } from 'pg'

export const version = '012_machine_payment_metadata'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS payment_rail VARCHAR(32),
      ADD COLUMN IF NOT EXISTS payment_resource_url TEXT,
      ADD COLUMN IF NOT EXISTS merchant_address VARCHAR(42),
      ADD COLUMN IF NOT EXISTS machine_challenge_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS machine_idempotency_key VARCHAR(128),
      ADD COLUMN IF NOT EXISTS machine_metadata JSONB;

    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS payment_rail VARCHAR(32),
      ADD COLUMN IF NOT EXISTS payment_resource_url TEXT,
      ADD COLUMN IF NOT EXISTS merchant_address VARCHAR(42),
      ADD COLUMN IF NOT EXISTS machine_challenge_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS machine_metadata JSONB;

    UPDATE payment_intents
       SET payment_rail = COALESCE(payment_rail, 'x402'),
           payment_resource_url = COALESCE(payment_resource_url, x402_resource_url),
           merchant_address = COALESCE(merchant_address, x402_merchant_address),
           machine_idempotency_key = COALESCE(machine_idempotency_key, x402_idempotency_key)
     WHERE source = 'x402';

    UPDATE approval_requests
       SET payment_rail = COALESCE(payment_rail, 'x402'),
           payment_resource_url = COALESCE(payment_resource_url, x402_resource_url)
     WHERE source = 'x402';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_machine_idempotency
      ON payment_intents(agent_id, machine_idempotency_key)
      WHERE machine_idempotency_key IS NOT NULL
        AND status NOT IN ('failed', 'expired');

    CREATE TABLE IF NOT EXISTS machine_payment_receipts (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rail               VARCHAR(32) NOT NULL,
      challenge_id       VARCHAR(128) NOT NULL UNIQUE,
      payment_intent_id  UUID REFERENCES payment_intents(id) ON DELETE SET NULL,
      tx_hash            VARCHAR(66) NOT NULL,
      resource_url       TEXT NOT NULL,
      recipient_address  VARCHAR(42) NOT NULL,
      amount_raw         VARCHAR(78) NOT NULL,
      chain_id           INTEGER NOT NULL,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_payment_receipts_payment_intent
      ON machine_payment_receipts(payment_intent_id)
      WHERE payment_intent_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_machine_payment_receipts_rail_created
      ON machine_payment_receipts(rail, created_at DESC);
  `)
}
