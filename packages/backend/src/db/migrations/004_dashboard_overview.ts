import type { PoolClient } from 'pg'

export const version = '004_dashboard_overview'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS usd_value NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS eur_value NUMERIC(20,6);

    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS usd_value NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS eur_value NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

    ALTER TABLE self_sign_payment_intents
      ADD COLUMN IF NOT EXISTS usd_value NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS eur_value NUMERIC(20,6);

    CREATE TABLE IF NOT EXISTS user_daily_portfolio_snapshots (
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL,
      total_usd     NUMERIC(20,6) NOT NULL DEFAULT 0,
      total_eur     NUMERIC(20,6) NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_user_daily_portfolio_snapshots_date
      ON user_daily_portfolio_snapshots(snapshot_date);
  `)
}
