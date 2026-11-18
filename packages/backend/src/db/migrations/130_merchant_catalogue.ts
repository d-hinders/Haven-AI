import type { PoolClient } from 'pg'

export const version = '130_merchant_catalogue'

/**
 * 130 — the merchant's product list, read from its kit's discovery document
 * (#4899, epic #4885).
 *
 * ## Two tables, and why neither is `merchant_catalog`
 *
 * `merchant_catalog` is Haven's CURATED marketplace: its `pay_to` fills the
 * recipient of a merchant-locked budget (`routes/agent-delegations.ts`) and it
 * feeds the public catalogue. Nothing a merchant supplies may reach it, so the
 * merchant's own product list lives in tables of its own and this migration
 * writes nothing into `merchant_catalog`. The separation is the point of the
 * slice, not a naming preference: a merchant-supplied `pay_to` that reached
 * `merchant_catalog` would let a merchant choose where an agent's
 * merchant-locked budget pays.
 *
 * - `merchant_catalogue_sources` — one row per merchant account: the public
 *   address the owner saved, and the outcome of the last read. The address is
 *   the account's, so the primary key is the account id and the row is deleted
 *   with the account.
 * - `merchant_products` — the product list itself, keyed
 *   `(merchant_account_id, product_id)`. `product_id` is the kit's own stable
 *   identifier (the products file's `id`), which is also what a sale record
 *   carries, so a sale can be labelled from this table.
 *
 * ## A removed product is kept, not deleted
 *
 * A product that disappears from the document is marked `offered = false` with
 * `removed_at` set, and the row stays. Past sales still name it — the sales
 * read looks the name up here whatever `offered` says — and the owner sees it
 * as no longer offered. Deleting the row would turn a past sale's product name
 * into nothing.
 *
 * ## `price_atomic` is TEXT, never a number
 *
 * The kit prices in whole atomic USDC units as a decimal string (the design's
 * §3: a JSON number is refused because a float cannot represent every atomic
 * amount exactly). Storing it as `NUMERIC` would be exact too, but the value is
 * a label here — this slice never charges it — and TEXT round-trips the
 * merchant's own spelling without a cast anywhere. Nothing in this slice reads
 * it as money.
 *
 * ## The read state
 *
 * `last_read_status` is the outcome of the last attempt, and `last_read_at` is
 * when it happened — the owner's "last read" line (#4900). `mismatch` is true
 * when the document's `pay_to` or `network` is not this account's; a mismatch
 * is recorded and its products are NOT written, so the last good list stays in
 * place. `document_*` columns are what the last GOOD document said, so the
 * owner can see which deployment the list came from.
 *
 * ## Money path
 *
 * This migration adds tables and no column to an existing money-path table. It
 * moves no funds, grants no authority, and cannot change an amount: the
 * catalogue only labels. It is on the money-path list because
 * `db/migrations/**` is.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_catalogue_sources (
      merchant_account_id UUID PRIMARY KEY REFERENCES smart_accounts(id) ON DELETE CASCADE,
      deployment_url      TEXT NOT NULL,
      last_read_at        TIMESTAMPTZ NULL,
      last_read_status    TEXT NOT NULL DEFAULT 'never'
        CHECK (last_read_status IN ('never', 'ok', 'unreachable', 'malformed', 'mismatch', 'refused')),
      last_read_detail    TEXT NULL,
      document_pay_to     TEXT NULL,
      document_network    TEXT NULL,
      document_name       TEXT NULL,
      document_operator_name TEXT NULL,
      document_updated    TEXT NULL,
      mismatch            BOOLEAN NOT NULL DEFAULT false,
      mismatch_reason     TEXT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_products (
      merchant_account_id UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      product_id          TEXT NOT NULL,
      name                TEXT NULL,
      description         TEXT NULL,
      route               TEXT NULL,
      model               TEXT NULL,
      price_atomic        TEXT NOT NULL,
      network             TEXT NOT NULL,
      output_token_cap    INTEGER NULL,
      offered             BOOLEAN NOT NULL DEFAULT true,
      first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at          TIMESTAMPTZ NULL,
      PRIMARY KEY (merchant_account_id, product_id)
    );
  `)
  // The catalogue read lists one account's products, offered first. The
  // primary key already serves the labelling lookup (account + product id).
  await client.query(`
    CREATE INDEX IF NOT EXISTS merchant_products_offered_idx
      ON merchant_products (merchant_account_id, offered, product_id);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS merchant_products;`)
  await client.query(`DROP TABLE IF EXISTS merchant_catalogue_sources;`)
}
