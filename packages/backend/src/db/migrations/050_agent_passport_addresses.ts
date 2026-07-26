import type { PoolClient } from 'pg'

export const version = '050_agent_passport_addresses'

/**
 * The addresses a passport was ATTESTED with (#974, epic #970).
 *
 * ## Why these are stored rather than re-derived
 *
 * The verifier must resolve **either** agent address — the delegate EOA a
 * merchant sees on an EIP-3009 header, or the Hybrid account it sees as the
 * delegator in erc7710 redemption — back to the same passport (#971 binds
 * both, because #946 made settlement a per-payment choice).
 *
 * The Hybrid address is *derived* from the delegate EOA, which is a one-way
 * trip: there is no reverse lookup from a smart account to an agent without
 * deriving it for every agent in the table. A merchant holding only that
 * address could otherwise never verify.
 *
 * Storing them also makes the receipt HONEST. It reports what was actually
 * attested, not a fresh re-derivation — if a derivation input ever changed,
 * a re-derived answer would silently disagree with the on-chain attestation
 * while looking authoritative.
 *
 * ## The zero-address sentinel does not live here
 *
 * EAS has no nullable field, so an agent with no smart account is attested
 * with `smartAccount = 0x0`. That sentinel is an ENCODING detail; in the
 * database "absent" is NULL. This matters because the lookup index below would
 * otherwise collide every EOA-only agent on one "address" and hand a merchant
 * querying the zero address somebody else's passport — the exact failure
 * `lib/passport/binding.ts` exists to prevent.
 *
 * Addresses are stored LOWERCASED so lookups need no checksum handling.
 *
 * Additive and non-destructive. Existing rows keep NULLs: a passport anchored
 * before this migration is still valid on-chain and still resolvable by UID.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_passports
      ADD COLUMN IF NOT EXISTS agent_eoa TEXT,
      ADD COLUMN IF NOT EXISTS smart_account TEXT;
  `)

  // Both lookups the verifier makes. Partial on NOT NULL so the NULLs left by
  // pre-migration rows (and by every EOA-only agent's smart account) cost
  // nothing and can never be matched.
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_passports_agent_eoa_idx
      ON agent_passports (agent_eoa)
      WHERE agent_eoa IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_passports_smart_account_idx
      ON agent_passports (smart_account)
      WHERE smart_account IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_passports_attestation_uid_idx
      ON agent_passports (attestation_uid)
      WHERE attestation_uid IS NOT NULL;
  `)

  // Belt and braces on the sentinel: even a future code path that forgot to
  // map 0x0 → NULL cannot poison the lookup, because the row would be rejected
  // rather than silently indexed under an address every EOA-only agent shares.
  await client.query(`
    ALTER TABLE agent_passports
      DROP CONSTRAINT IF EXISTS agent_passport_addresses_not_zero;
  `)
  await client.query(`
    ALTER TABLE agent_passports
      ADD CONSTRAINT agent_passport_addresses_not_zero
      CHECK (
        agent_eoa IS DISTINCT FROM '0x0000000000000000000000000000000000000000'
        AND smart_account IS DISTINCT FROM '0x0000000000000000000000000000000000000000'
      );
  `)

  // Lowercase-only, so a lookup never has to guess at checksum casing.
  await client.query(`
    ALTER TABLE agent_passports
      DROP CONSTRAINT IF EXISTS agent_passport_addresses_lowercase;
  `)
  await client.query(`
    ALTER TABLE agent_passports
      ADD CONSTRAINT agent_passport_addresses_lowercase
      CHECK (
        agent_eoa IS NOT DISTINCT FROM LOWER(agent_eoa)
        AND smart_account IS NOT DISTINCT FROM LOWER(smart_account)
      );
  `)
}
