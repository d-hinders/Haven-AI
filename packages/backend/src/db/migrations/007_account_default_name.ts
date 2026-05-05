import type { PoolClient } from 'pg'

export const version = '007_account_default_name'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes
    ALTER COLUMN name SET DEFAULT 'My account';

    UPDATE user_safes
    SET name = 'My account',
        updated_at = NOW()
    WHERE name = 'My Safe'
      AND is_default = true;
  `)
}
