import type { PoolClient } from 'pg'

export const version = '013_machine_payment_reconciliation_events'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS machine_payment_reconciliation_events (
      id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_intent_id      UUID REFERENCES payment_intents(id) ON DELETE SET NULL,
      rail                   VARCHAR(32) NOT NULL,
      event_type             VARCHAR(64) NOT NULL,
      status                 VARCHAR(20) NOT NULL DEFAULT 'open',
      tx_hash                VARCHAR(66),
      resource_url           TEXT,
      merchant_address       VARCHAR(42),
      machine_challenge_id   VARCHAR(128),
      machine_idempotency_key VARCHAR(128),
      reason                 TEXT,
      details                JSONB,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_payment_reconciliation_payment_event
      ON machine_payment_reconciliation_events(payment_intent_id, event_type)
      WHERE payment_intent_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_machine_payment_reconciliation_agent_status
      ON machine_payment_reconciliation_events(agent_id, status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_machine_payment_reconciliation_rail_created
      ON machine_payment_reconciliation_events(rail, created_at DESC);
  `)
}
