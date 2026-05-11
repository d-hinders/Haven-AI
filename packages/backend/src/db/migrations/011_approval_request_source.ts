import type { PoolClient } from 'pg'

export const version = '011_approval_request_source'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'direct',
      ADD COLUMN IF NOT EXISTS x402_resource_url TEXT;
  `)
}
