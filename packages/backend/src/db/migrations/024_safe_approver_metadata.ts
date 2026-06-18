import type { PoolClient } from 'pg'

export const version = '024_safe_approver_metadata'

/**
 * Approver (Safe owner) metadata.
 *
 * On-chain, a Safe owner is just an address — `getOwners()` is the source of
 * truth for *membership*. This table stores the human metadata the chain does
 * not: a label and whether the owner is an EOA or a passkey signer. It also
 * doubles as the registry of known approvers a user can reuse across their
 * Safes (#417).
 *
 * Rows are best-effort decoration: a missing row just means an owner shows up
 * unlabelled. Membership decisions (add/remove, last-owner guard) are always
 * made against the live on-chain owner set, never this table.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS safe_approver_metadata (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      safe_id     UUID         NOT NULL REFERENCES user_safes(id) ON DELETE CASCADE,
      address     VARCHAR(42)  NOT NULL,
      type        VARCHAR(16)  NOT NULL DEFAULT 'eoa' CHECK (type IN ('eoa', 'passkey')),
      label       VARCHAR(120),
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `)

  // One metadata row per owner address per Safe; address compared lower-cased.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS safe_approver_metadata_safe_addr
      ON safe_approver_metadata (safe_id, LOWER(address))
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS safe_approver_metadata')
}
