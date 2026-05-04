import type { PoolClient } from 'pg'

export const version = '006_user_passkeys'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_passkeys (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id   TEXT NOT NULL,
      public_key_x    BYTEA NOT NULL,
      public_key_y    BYTEA NOT NULL,
      signer_address  VARCHAR(42) NOT NULL,
      chain_id        INTEGER NOT NULL,
      safe_address    VARCHAR(42),
      raw_attestation BYTEA,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (credential_id),
      UNIQUE (user_id, chain_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_passkeys_signer_address ON user_passkeys(signer_address);
  `)
}
