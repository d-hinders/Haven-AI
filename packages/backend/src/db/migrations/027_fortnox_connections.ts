import type { PoolClient } from 'pg'

export const version = '027_fortnox_connections'

/**
 * Fortnox OAuth2 connection per user (epic #462, P2 #465).
 *
 * Stores the access/refresh tokens granted by a customer so Haven can push
 * vouchers on their behalf. Tokens are secrets held server-side only (like the
 * dashboard JWT) — never exposed to agents or the client. One connection per
 * user; reconnecting upserts.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fortnox_connections (
      user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      access_token   TEXT NOT NULL,
      refresh_token  TEXT NOT NULL,
      token_type     VARCHAR(32) NOT NULL DEFAULT 'Bearer',
      scope          TEXT,
      expires_at     TIMESTAMPTZ NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `)
}
