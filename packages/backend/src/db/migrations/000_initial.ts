import type { PoolClient } from 'pg'

export const version = '000_initial'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
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

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS delegate_address VARCHAR(42);

    ALTER TABLE agents ALTER COLUMN monthly_limit DROP NOT NULL;
    ALTER TABLE agents ALTER COLUMN per_tx_limit DROP NOT NULL;
    ALTER TABLE agents ALTER COLUMN type DROP NOT NULL;

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
    CREATE INDEX IF NOT EXISTS idx_payment_intents_agent_created ON payment_intents(agent_id, created_at DESC);

    ALTER TABLE agent_allowances ADD COLUMN IF NOT EXISTS approval_threshold VARCHAR(78);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id         UUID NOT NULL REFERENCES agents(id),
      user_id          UUID NOT NULL REFERENCES users(id),
      safe_address     VARCHAR(42) NOT NULL,
      token_symbol     VARCHAR(20) NOT NULL,
      token_address    VARCHAR(42) NOT NULL,
      to_address       VARCHAR(42) NOT NULL,
      amount_raw       VARCHAR(78) NOT NULL,
      amount_human     VARCHAR(78) NOT NULL,
      reason           TEXT,
      status           VARCHAR(20) NOT NULL DEFAULT 'pending',
      tx_hash          VARCHAR(66),
      reviewed_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      expires_at       TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_requests_user_status ON approval_requests(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_agent_id ON approval_requests(agent_id);

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS restrict_recipients BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS agent_allowed_recipients (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      address    VARCHAR(42) NOT NULL,
      label      VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, address)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_allowed_recipients_agent_id ON agent_allowed_recipients(agent_id);

    ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'direct';
    ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS x402_resource_url TEXT;
    ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS x402_category VARCHAR(50);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_x402_per_hour INTEGER DEFAULT 100;

    CREATE TABLE IF NOT EXISTS user_safes (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      safe_address VARCHAR(42) NOT NULL,
      name         VARCHAR(100) NOT NULL DEFAULT 'My account',
      is_default   BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, safe_address)
    );

    CREATE INDEX IF NOT EXISTS idx_user_safes_user_id ON user_safes(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_safes_address ON user_safes(safe_address);

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS safe_id UUID;

    INSERT INTO user_safes (user_id, safe_address, name, is_default)
    SELECT id, safe_address, 'My account', true
    FROM users
    WHERE safe_address IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_safes WHERE user_id = users.id AND safe_address = users.safe_address
      );

    UPDATE agents a
    SET safe_id = us.id
    FROM user_safes us
    WHERE a.user_id = us.user_id
      AND a.safe_id IS NULL
      AND us.is_default = true;

    ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(64);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(12);
    ALTER TABLE agents ALTER COLUMN api_key DROP NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_agents_api_key_hash ON agents(api_key_hash);

    ALTER TABLE user_safes ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 100;

    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_safes_user_id_safe_address_key'
      ) THEN
        ALTER TABLE user_safes DROP CONSTRAINT user_safes_user_id_safe_address_key;
      END IF;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_safes_user_id_safe_address_chain_id_key'
      ) THEN
        ALTER TABLE user_safes ADD CONSTRAINT user_safes_user_id_safe_address_chain_id_key
          UNIQUE (user_id, safe_address, chain_id);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_user_safes_chain_id ON user_safes(chain_id);
    CREATE INDEX IF NOT EXISTS idx_payment_intents_chain_id ON payment_intents(chain_id);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS self_sign_agents (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                VARCHAR(255) NOT NULL,
      description         TEXT,
      delegate_address    VARCHAR(42) NOT NULL,
      safe_id             UUID REFERENCES user_safes(id),
      restrict_recipients BOOLEAN NOT NULL DEFAULT false,
      status              VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, delegate_address)
    );

    CREATE INDEX IF NOT EXISTS idx_self_sign_agents_user_id ON self_sign_agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_self_sign_agents_delegate ON self_sign_agents(delegate_address);

    CREATE TABLE IF NOT EXISTS self_sign_agent_allowances (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id            UUID NOT NULL REFERENCES self_sign_agents(id) ON DELETE CASCADE,
      token_address       VARCHAR(42) NOT NULL,
      token_symbol        VARCHAR(20) NOT NULL,
      allowance_amount    VARCHAR(78) NOT NULL DEFAULT '0',
      reset_period_min    INTEGER NOT NULL DEFAULT 0,
      approval_threshold  VARCHAR(78),
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address)
    );

    CREATE TABLE IF NOT EXISTS self_sign_agent_recipients (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id   UUID NOT NULL REFERENCES self_sign_agents(id) ON DELETE CASCADE,
      address    VARCHAR(42) NOT NULL,
      label      VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, address)
    );
  `)

  const { createHash } = await import('crypto')
  const unhashed = await client.query<{ id: string; api_key: string }>(
    `SELECT id, api_key FROM agents WHERE api_key IS NOT NULL AND api_key_hash IS NULL`,
  )
  for (const row of unhashed.rows) {
    const hash = createHash('sha256').update(row.api_key).digest('hex')
    const prefix = row.api_key.slice(0, 12)
    await client.query(
      `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, api_key = NULL WHERE id = $3`,
      [hash, prefix, row.id],
    )
  }
}
