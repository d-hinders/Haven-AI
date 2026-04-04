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
      monthly_limit     NUMERIC(20,6) NOT NULL,
      per_tx_limit      NUMERIC(20,6) NOT NULL,
      allowed_assets    TEXT[] NOT NULL DEFAULT '{USDC}',
      recipient_address VARCHAR(42),
      api_key           VARCHAR(64) UNIQUE NOT NULL,
      status            VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);

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
  `)
}
