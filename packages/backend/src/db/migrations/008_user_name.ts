import type { PoolClient } from 'pg'

export const version = '008_user_name'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS name VARCHAR(80);
  `)
}
