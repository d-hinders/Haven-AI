import type { PoolClient } from 'pg'

export const version = '002_self_sign_payment_intents'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS self_sign_payment_intents (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id          UUID NOT NULL REFERENCES self_sign_agents(id) ON DELETE CASCADE,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      safe_address      VARCHAR(42) NOT NULL,
      chain_id          INTEGER NOT NULL,
      token_symbol      VARCHAR(20) NOT NULL,
      token_address     VARCHAR(42) NOT NULL,
      to_address        VARCHAR(42) NOT NULL,
      amount_raw        VARCHAR(78) NOT NULL,
      amount_human      VARCHAR(50) NOT NULL,
      delegate_address  VARCHAR(42) NOT NULL,
      sign_hash         VARCHAR(66),
      signature         VARCHAR(200),
      tx_hash           VARCHAR(66),
      status            VARCHAR(30) NOT NULL DEFAULT 'pending_signature',
      error_message     TEXT,
      reason            TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      signed_at         TIMESTAMPTZ,
      submitted_at      TIMESTAMPTZ,
      confirmed_at      TIMESTAMPTZ,
      expires_at        TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ss_payment_agent
      ON self_sign_payment_intents(agent_id);

    CREATE INDEX IF NOT EXISTS idx_ss_payment_status
      ON self_sign_payment_intents(status);

    -- Used for spending window queries
    CREATE INDEX IF NOT EXISTS idx_ss_payment_spending
      ON self_sign_payment_intents(agent_id, token_address, status, confirmed_at);
  `)
}
