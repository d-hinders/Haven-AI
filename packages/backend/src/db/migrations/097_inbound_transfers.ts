import type { PoolClient } from 'pg'

export const version = '097_inbound_transfers'

/**
 * The receive side (#3333, epic #3328): the persisted inbound-transfer index
 * for the owner's smart accounts.
 *
 * Until this table the `direction: 'in'` rows on the transactions feed were
 * read LIVE from the explorers on every request (`aggregate.ts`) — nothing
 * was stored, so nothing could be MATCHED to a receipt or an x402 settlement
 * the account was `payTo` for, and nothing could hand off to an off-ramp.
 * The live explorer read stays; this index is the matching substrate.
 *
 * One row per inbound USDC transfer observed on an account's address:
 *
 * - `chain_id` + `tx_hash` + `log_index` identify the transfer on-chain. The
 *   (chain, hash) pair is unique across the table — the log index is carried
 *   for forensics, not identity; a hash identifies one transfer for the
 *   matching key (#3333: "key: tx hash").
 * - `payer_address` / `amount_raw` / `block_time` are the explorer's own
 *   fields, persisted so matching and the running balance never re-read the
 *   explorer for history that is already indexed.
 * - `match_kind` / `matched_receipt_id` / `matched_payment_intent_id` are the
 *   match outcome: NULL everywhere = unmatched = UNEARNED. The match is
 *   written once (the columns carry no UPDATE discipline at the schema level;
 *   the repository refuses to overwrite a set match — see
 *   `infra/repositories/inbound-transfers.ts`).
 * - `balance_consumed` marks the row as counted in the receive balance.
 *
 * Deliberately NOT here: no money, no keys, no authority. A matched receipt
 * referenced by `matched_receipt_id` is a merchant receipt the payer or the
 * paying agent supplied for this transfer — a document, never a permission.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS inbound_transfers (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id                UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chain_id                  INTEGER NOT NULL,
      tx_hash                   VARCHAR(66) NOT NULL,
      log_index                 INTEGER,
      payer_address             VARCHAR(42) NOT NULL,
      token_address             VARCHAR(42) NOT NULL,
      amount_raw                VARCHAR(78) NOT NULL,
      block_number              BIGINT,
      block_time                TIMESTAMPTZ NOT NULL,
      match_kind                VARCHAR(24),
      matched_receipt_id        UUID,
      matched_payment_intent_id UUID,
      balance_consumed          BOOLEAN NOT NULL DEFAULT false,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- The dedupe identity: one row per on-chain transfer per chain. Idempotent
    -- ingestion upserts on this key, so a re-read explorer window can never
    -- double-count an inbound payment.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_transfers_chain_hash
      ON inbound_transfers (chain_id, LOWER(tx_hash));

    -- The balance query: one account's consumed rows, newest first.
    CREATE INDEX IF NOT EXISTS idx_inbound_transfers_account_balance
      ON inbound_transfers (account_id, block_time DESC)
      WHERE balance_consumed = true;

    -- The match query: this account's unmatched rows.
    CREATE INDEX IF NOT EXISTS idx_inbound_transfers_account_unmatched
      ON inbound_transfers (account_id, created_at DESC)
      WHERE match_kind IS NULL;

    -- The match key: an x402 settlement the account was payTo for is found by
    -- its transaction hash. Also covers receipt-hash lookups.
    CREATE INDEX IF NOT EXISTS idx_inbound_transfers_hash
      ON inbound_transfers (LOWER(tx_hash));
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS off_ramp_destinations (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id          UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chain_id            INTEGER NOT NULL,
      destination_address VARCHAR(42) NOT NULL,
      destination_kind    VARCHAR(24) NOT NULL DEFAULT 'custody_deposit',
      label               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One saved destination per account+chain. The off-ramp hand-off reads
    -- exactly this row; the owner replaces it, an agent has no route to it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_off_ramp_destinations_account_chain
      ON off_ramp_destinations (account_id, chain_id);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS inbound_receipt_drops (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id    UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chain_id      INTEGER NOT NULL,
      tx_hash       VARCHAR(66) NOT NULL,
      payer_address VARCHAR(42) NOT NULL,
      document      JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- The #3333 receipt drop: unauthenticated but payer-signed. One document
    -- per (chain, hash, payer) — a re-drop is idempotent, a different payer
    -- for the same transfer is a distinct row the matcher ignores.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_receipt_drops_key
      ON inbound_receipt_drops (chain_id, LOWER(tx_hash), payer_address);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS inbound_receipt_drops;`)
  await client.query(`DROP TABLE IF EXISTS off_ramp_destinations;`)
  await client.query(`DROP TABLE IF EXISTS inbound_transfers;`)
}
