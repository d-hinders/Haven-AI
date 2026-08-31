import type { PoolClient } from 'pg'

export const version = '073_drop_x402_resource_tables'

/**
 * Retire the exploratory Haven-as-merchant resource registry and its receipt
 * store (#2257, epic #1440). This is separate from the live delegation-rail
 * x402 payment flow and from the standalone demo merchant.
 *
 * Drop the child table first so the migration does not need CASCADE. That
 * keeps the destructive scope explicit: only the two retired tables and
 * their own indexes are removed, while unrelated historical tables remain
 * untouched.
 *
 * Rollback restores the original schema shape from migration 003. Data is not
 * restored; this migration retires an unused surface rather than migrating it.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS x402_receipts;
    DROP TABLE IF EXISTS x402_resources;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS x402_resources (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      safe_id       UUID REFERENCES user_safes(id) ON DELETE SET NULL,
      name          VARCHAR(255) NOT NULL,
      description   TEXT,
      price_amount  VARCHAR(78) NOT NULL,
      token_address VARCHAR(42) NOT NULL,
      token_symbol  VARCHAR(20) NOT NULL,
      chain_id      INTEGER NOT NULL,
      active        BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_x402_resources_user
      ON x402_resources(user_id);

    CREATE TABLE IF NOT EXISTS x402_receipts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resource_id   UUID NOT NULL REFERENCES x402_resources(id) ON DELETE CASCADE,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tx_hash       VARCHAR(66) NOT NULL,
      payer_address VARCHAR(42),
      amount_raw    VARCHAR(78) NOT NULL,
      chain_id      INTEGER NOT NULL,
      verified_at   TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tx_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_x402_receipts_resource
      ON x402_receipts(resource_id);
    CREATE INDEX IF NOT EXISTS idx_x402_receipts_user
      ON x402_receipts(user_id);
  `)
}
