import type { PoolClient } from 'pg'

export const version = '044_hybrid_account_passkeys'

/**
 * Passkey signer set for Hybrid DeleGator accounts (#885, epic #836).
 *
 * A Hybrid's address is deterministic from its owner configuration
 * (deployParams [ownerAddress, keyIds[], xs[], ys[]]). Until now user_safes
 * stored only owner_address, so a PURE-PASSKEY account's config could not be
 * reconstructed — grant activation 409'd ("Treasury owner identity unknown")
 * and ensureHybridDeployed (#860) could not derive the account. This table
 * records each account's P256 signers so the config round-trips.
 *
 * The account address in user_safes was computed from EXACTLY these
 * coordinates at provisioning time; this is the durable record of that input,
 * not a new source of truth. x/y are the P256 public-key coordinates as
 * 0x-hex (same encoding hybrid-provisioning derives from). key_id is the
 * WebAuthn credential id the Hybrid stores keys under.
 *
 * Additive; existing EOA-owner Hybrids keep working via owner_address alone.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS hybrid_account_passkeys (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_safe_id  UUID NOT NULL REFERENCES user_safes(id) ON DELETE CASCADE,
      key_id        TEXT NOT NULL,
      public_key_x  TEXT NOT NULL,
      public_key_y  TEXT NOT NULL,
      label         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_safe_id, key_id)
    );

    CREATE INDEX IF NOT EXISTS hybrid_account_passkeys_safe_idx
      ON hybrid_account_passkeys (user_safe_id);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS hybrid_account_passkeys;`)
}
