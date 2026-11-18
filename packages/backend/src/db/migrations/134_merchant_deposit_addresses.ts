import type { PoolClient } from 'pg'

export const version = '134_merchant_deposit_addresses'

/**
 * 134 — the Stripe deposit-address registry (#4952, epic #4886; design note on
 * #4902). Dev and Stripe sandbox only.
 *
 * A Sales account's owner registers the address a payment processor receives
 * on the merchant's behalf. A sale paid to a registered address is stored on
 * `merchant_sales` as `held_by = 'stripe'` (migration 131 already carries the
 * column and the CHECK), and never in `inbound_transfers`. The registry is
 * what decides which transfers are attributed to the account, so every row is
 * the OWNER's word: Haven cannot verify the address is theirs.
 *
 * ## The one-active-registration rule
 *
 * The partial unique index `(chain_id, address) WHERE retired_at IS NULL` lets
 * exactly one account hold an address at a time. A retired address can be
 * registered again, by its owner or another account: the retired row stays
 * (rows are never deleted — retiring sets `retired_at`), and a sale is
 * attributed only while the registration was active at the leg's block time.
 *
 * `address` is stored lower-case (the code lower-cases it; the CHECK refuses a
 * row that is not). `chain_id` must equal the Sales account's chain; that is a
 * rule the code holds, because a CHECK cannot read `smart_accounts`.
 *
 * A plain, transactional migration: the table is new and empty.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_deposit_addresses (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chain_id      INTEGER NOT NULL,
      address       TEXT NOT NULL CHECK (address = LOWER(address)),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at    TIMESTAMPTZ
    );
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_deposit_addresses_active
      ON merchant_deposit_addresses (chain_id, address)
      WHERE retired_at IS NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_merchant_deposit_addresses_account
      ON merchant_deposit_addresses (account_id, registered_at DESC);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS merchant_deposit_addresses;`)
}
