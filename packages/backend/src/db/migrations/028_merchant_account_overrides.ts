import type { PoolClient } from 'pg'

export const version = '028_merchant_account_overrides'

/**
 * Per-merchant BAS account memory (epic #462, P3 #466).
 *
 * A user (their accountant) sets the expense account for a merchant once; every
 * future entry for that merchant reuses it. Keyed by the merchant's resource URL
 * — the stable catalog identity present on every settlement evidence row.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_account_overrides (
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_url TEXT NOT NULL,
      bas_account  VARCHAR(16) NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, resource_url)
    );
  `)
}
