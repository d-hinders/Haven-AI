import type { PoolClient } from 'pg'

export const version = '131_merchant_sales'

/**
 * 131 — the merchant sale record (#4897, epic #4885).
 *
 * ## Its own table, not a match kind
 *
 * A sale is a merchant's statement that a transaction was for a product,
 * accepted only against a transfer Haven read from the chain. It is NOT a
 * third `inbound_transfers.match_kind`: a match is set once
 * (`AND match_kind IS NULL`) and feeds the receive balance, so a sale stored
 * there could block a receipt or an x402 match and move the balance. This
 * table never touches `match_kind`, `balance_consumed` or the balance.
 *
 * ## One record per transaction per account
 *
 * The unique index is `(chain_id, LOWER(tx_hash), account_id)`: whatever the
 * number of transfers in the transaction, one sale record. A second, different
 * record for the same transaction is refused by the route and, underneath it,
 * by this index; an identical resend is answered from the first row.
 *
 * ## What is copied from the chain, and what is the merchant's word
 *
 * `amount_raw`, `token_address`, `payer_address`, `several_payers`,
 * `sender_is_own_address`, `block_number` and `block_time` are copied from the
 * legs the chain read returned, at ingest. The record's own `amount` and
 * `payer` are validated and stored NOWHERE: there is no column for them, so a
 * record that states a different amount cannot change what is shown.
 * `product_id`, `product_name`, `merchant_reference`, `receipt_number` and
 * `vat_treatment` are the merchant's word, stored as stated.
 *
 * ## Why two columns exist before anything writes them
 *
 * `held_by` and `receiving_address` are for #4952 (a payer's funds held by a
 * processor rather than the account). This slice writes only `'account'` and
 * NULL; the CHECK keeps the set closed until #4952 widens it.
 *
 * Number 130 is #4945's (`130_merchant_catalogue.ts`).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_sales (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id            UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chain_id              INTEGER NOT NULL,
      tx_hash               VARCHAR(66) NOT NULL,
      held_by               TEXT NOT NULL DEFAULT 'account'
                              CHECK (held_by IN ('account', 'stripe')),
      receiving_address     TEXT,
      record_version        INTEGER NOT NULL DEFAULT 1,
      product_id            TEXT NOT NULL,
      product_name          TEXT,
      merchant_reference    TEXT NOT NULL,
      receipt_number        TEXT,
      vat_treatment         TEXT CHECK (vat_treatment IN ('SE_25', 'REVERSE_CHARGE')),
      amount_raw            NUMERIC(78, 0) NOT NULL,
      token_address         VARCHAR(42) NOT NULL,
      payer_address         VARCHAR(42),
      several_payers        BOOLEAN NOT NULL DEFAULT false,
      sender_is_own_address BOOLEAN NOT NULL DEFAULT false,
      block_number          BIGINT NOT NULL,
      block_time            TIMESTAMPTZ NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_sales_chain_hash_account
      ON merchant_sales (chain_id, LOWER(tx_hash), account_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_merchant_sales_account_time
      ON merchant_sales (account_id, block_time DESC);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS merchant_sales;`)
}
