import type { PoolClient } from 'pg'

export const version = '001_self_sign_agents'

export async function up(client: PoolClient): Promise<void> {
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
}
