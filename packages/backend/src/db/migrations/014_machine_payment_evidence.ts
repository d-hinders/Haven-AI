import type { PoolClient } from 'pg'

export const version = '014_machine_payment_evidence'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS machine_payment_evidence (
      id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_intent_id            UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
      agent_id                     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id                      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rail                         VARCHAR(32) NOT NULL,
      proof_status                 VARCHAR(48) NOT NULL DEFAULT 'payment_confirmed',
      tx_hash                      VARCHAR(66) NOT NULL,
      chain_id                     INTEGER NOT NULL,
      resource_url                 TEXT NOT NULL,
      merchant_address             VARCHAR(42),
      payer_address                VARCHAR(42) NOT NULL,
      settlement_address           VARCHAR(42) NOT NULL,
      token_symbol                 VARCHAR(20) NOT NULL,
      token_address                VARCHAR(42) NOT NULL,
      amount_raw                   VARCHAR(78) NOT NULL,
      amount_human                 VARCHAR(78) NOT NULL,
      challenge_id                 VARCHAR(128),
      idempotency_key              VARCHAR(128),
      challenge_payload            JSONB,
      selected_payment             JSONB,
      payment_proof_header_name    VARCHAR(128),
      payment_proof_header         TEXT,
      protocol_receipt_header_name VARCHAR(128),
      protocol_receipt_header      TEXT,
      protocol_receipt_payload     JSONB,
      merchant_status              INTEGER,
      confirmed_at                 TIMESTAMPTZ,
      created_at                   TIMESTAMPTZ DEFAULT NOW(),
      updated_at                   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(payment_intent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_machine_payment_evidence_user_created
      ON machine_payment_evidence(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_machine_payment_evidence_agent_created
      ON machine_payment_evidence(agent_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_machine_payment_evidence_rail_status
      ON machine_payment_evidence(rail, proof_status, created_at DESC);
  `)
}
