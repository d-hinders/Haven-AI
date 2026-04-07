import pool from '../db.js'

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email          VARCHAR(255) UNIQUE NOT NULL,
      password_hash  VARCHAR(255) NOT NULL,
      wallet_address VARCHAR(42),
      safe_address   VARCHAR(42),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_preference VARCHAR(3) DEFAULT 'USD';

    CREATE TABLE IF NOT EXISTS agents (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name              VARCHAR(255) NOT NULL,
      type              VARCHAR(50) NOT NULL DEFAULT 'custom',
      monthly_limit     NUMERIC(20,6),
      per_tx_limit      NUMERIC(20,6),
      allowed_assets    TEXT[] NOT NULL DEFAULT '{USDC}',
      recipient_address VARCHAR(42),
      api_key           VARCHAR(64) UNIQUE NOT NULL,
      status            VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);

    -- New columns for AllowanceModule-based agents
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS delegate_address VARCHAR(42);

    -- Make legacy columns nullable for new-style agents
    ALTER TABLE agents ALTER COLUMN monthly_limit DROP NOT NULL;
    ALTER TABLE agents ALTER COLUMN per_tx_limit DROP NOT NULL;
    ALTER TABLE agents ALTER COLUMN type DROP NOT NULL;

    -- Agent allowances: records of on-chain spending limits
    CREATE TABLE IF NOT EXISTS agent_allowances (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      token_address    VARCHAR(42) NOT NULL,
      token_symbol     VARCHAR(20) NOT NULL,
      allowance_amount VARCHAR(78) NOT NULL,
      reset_period_min INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_allowances_agent_id ON agent_allowances(agent_id);

    CREATE TABLE IF NOT EXISTS contacts (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(255) NOT NULL,
      address    VARCHAR(42) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, address)
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);

    -- Payment intents: audit trail for agent-initiated payments
    CREATE TABLE IF NOT EXISTS payment_intents (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id         UUID NOT NULL REFERENCES agents(id),
      user_id          UUID NOT NULL REFERENCES users(id),
      safe_address     VARCHAR(42) NOT NULL,
      token_symbol     VARCHAR(20) NOT NULL,
      token_address    VARCHAR(42) NOT NULL,
      to_address       VARCHAR(42) NOT NULL,
      amount_raw       VARCHAR(78) NOT NULL,
      amount_human     VARCHAR(78) NOT NULL,
      delegate_address VARCHAR(42) NOT NULL,
      allowance_nonce  INTEGER NOT NULL,
      sign_hash        VARCHAR(66) NOT NULL,
      signature        TEXT,
      tx_hash          VARCHAR(66),
      status           VARCHAR(20) NOT NULL DEFAULT 'pending_signature',
      error_message    TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      signed_at        TIMESTAMPTZ,
      submitted_at     TIMESTAMPTZ,
      confirmed_at     TIMESTAMPTZ,
      expires_at       TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payment_intents_agent_id ON payment_intents(agent_id);
    CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);
  `)
}
