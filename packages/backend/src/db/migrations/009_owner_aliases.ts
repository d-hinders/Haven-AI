import type { PoolClient } from 'pg'

export const version = '009_owner_aliases'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS owner_aliases (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_address VARCHAR(42) NOT NULL,
      name          VARCHAR(80) NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, owner_address)
    );

    CREATE INDEX IF NOT EXISTS idx_owner_aliases_user_id ON owner_aliases(user_id);
    CREATE INDEX IF NOT EXISTS idx_owner_aliases_owner_address ON owner_aliases(owner_address);
  `)
}
