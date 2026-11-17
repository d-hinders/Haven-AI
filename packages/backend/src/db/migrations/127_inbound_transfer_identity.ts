import type { PoolClient } from 'pg'

export const version = '127_inbound_transfer_identity'

/**
 * 127 — the inbound index's row identity, the per-account cursor, and the
 * own-address flag (#4903, epic #4885).
 *
 * ## Why the identity changes
 *
 * Migration 097 keyed an inbound row on `(chain_id, LOWER(tx_hash), account_id)`
 * (`idx_inbound_transfers_chain_hash_account`). That is one row per
 * TRANSACTION per account, so a transaction carrying several USDC transfers to
 * the same account collapsed into one row and the other legs were dropped by
 * `ON CONFLICT DO NOTHING`. The receive ledger therefore under-counted a
 * multi-leg payment, and a merchant's sale could be short by the legs that
 * lost the race.
 *
 * The on-chain identity of a transfer is its LOG: `(transaction, log_index)`.
 * The new identity adds `log_index` to the key.
 *
 * ## `log_index` is nullable, and that is the trap this migration answers
 *
 * `log_index` is nullable today (097:45) and stays nullable: the explorer
 * sources do not all report it (Blockscout v2 does, Alchemy's transfers API
 * does not), and the rows written before this migration have no value at all.
 * A single unique index that includes a nullable column treats NULLs as
 * DISTINCT, so it would stop deduping every unknown row and a re-read of an
 * explorer window could count the same transfer twice.
 *
 * **Decision: a separate unique index for the unknown case.** Two partial
 * unique indexes replace the old one:
 *
 * - `idx_inbound_transfers_chain_hash_account_log` — `(chain_id,
 *   LOWER(tx_hash), account_id, log_index) WHERE log_index IS NOT NULL`. The
 *   on-chain identity, for every leg whose log index is known.
 * - `idx_inbound_transfers_chain_hash_account_leg` — `(chain_id,
 *   LOWER(tx_hash), account_id, payer_address, amount_raw) WHERE log_index IS
 *   NULL`. The unknown case keeps a real dedupe key: the same leg re-read from
 *   the same source conflicts, while a SECOND leg of the same transaction is a
 *   distinct row (it differs in payer or amount) instead of being swallowed.
 *   Two byte-identical legs in one transaction are indistinguishable from an
 *   explorer that reports no log index; the chain reader (which always has the
 *   log index) separates them, and the explorer-fed row is adopted by it on the
 *   next pass — see the reconcile rule below.
 *
 * The old index is dropped: it is strictly weaker than the unknown-case index
 * (same columns, minus payer/amount), so keeping it would only refuse the
 * second leg.
 *
 * ## Reconcile rule for rows collapsed before this migration
 *
 * No row is rewritten here. Every pre-existing row has `log_index IS NULL`, so
 * it lands in the unknown-case index and keeps deduping exactly as before.
 * The reconcile happens at INGEST time, in
 * `infra/repositories/inbound-transfers.ts`:
 *
 * 1. A leg whose `log_index` is known first tries to ADOPT an unknown row for
 *    the same `(chain, hash, account, payer_address, amount_raw)` — the row the
 *    old identity wrote from that leg — by filling in its `log_index`. The
 *    adopted row keeps its `amount_raw`, its `match_kind` and its
 *    `balance_consumed` flag.
 * 2. Every other leg of that transaction is inserted as a NEW row with
 *    `balance_consumed = false` and `match_kind = NULL`.
 *
 * So the receive balance — `SUM(amount_raw) WHERE balance_consumed` — is
 * unchanged for an account whose rows were collapsed before this migration,
 * while every leg is now indexed. The extra legs are unearned until they are
 * matched, exactly like any other unmatched row. A row that no leg matches (a
 * row planted through the old caller-supplied ingest route) is left with
 * `log_index IS NULL` and is never adopted; that route now reads the chain
 * itself, so no such row can be created any more.
 *
 * ## The cursor
 *
 * `inbound_index_cursors` is one row per account: the highest block the
 * scheduled pass has fully indexed. The pass reads `last_indexed_block + 1 ..
 * latest` on the next tick, so a merchant account's history is complete
 * without anyone opening a dashboard. The row is created on the first pass,
 * seeded at the block carrying the account's creation time.
 *
 * ## The own-address flag
 *
 * `sender_is_own_address` records, at INDEX time, whether the transfer's payer
 * is one of the owner's own addresses (the set #4897 defines; today it is the
 * user's own `smart_accounts` rows). It is decided when the row is written, not
 * when it is read, so a later change to the owner's account set cannot rewrite
 * history. Defaults to `false` for existing rows: the flag was not recorded
 * then, and `false` is the honest value for "not known to be own".
 *
 * ## Money path
 *
 * Nothing here moves funds, holds a key, or grants authority. The table is the
 * receive index; the cursor is a read position; the flag is a recorded fact
 * about a transfer's sender.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE inbound_transfers
      ADD COLUMN IF NOT EXISTS sender_is_own_address BOOLEAN NOT NULL DEFAULT false;
  `)

  // The old identity: one row per transaction per account. Replaced by the two
  // partial indexes below — see the header for why it cannot simply gain a
  // nullable column.
  await client.query(`DROP INDEX IF EXISTS idx_inbound_transfers_chain_hash_account;`)

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_transfers_chain_hash_account_log
      ON inbound_transfers (chain_id, LOWER(tx_hash), account_id, log_index)
      WHERE log_index IS NOT NULL;
  `)

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_transfers_chain_hash_account_leg
      ON inbound_transfers (chain_id, LOWER(tx_hash), account_id, payer_address, amount_raw)
      WHERE log_index IS NULL;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS inbound_index_cursors (
      account_id         UUID PRIMARY KEY REFERENCES smart_accounts(id) ON DELETE CASCADE,
      chain_id           INTEGER NOT NULL,
      last_indexed_block BIGINT NOT NULL,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

/**
 * NOT lossless, deliberately. Once a transaction has several legs there is no
 * way back to the one-row-per-transaction identity without deleting rows, and
 * deleting money-path rows in a down migration is worse than a loud failure.
 * The old index is recreated as-is: it fails if multi-leg rows exist, which is
 * the honest signal that this migration cannot be undone in place.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS inbound_index_cursors;`)
  await client.query(`DROP INDEX IF EXISTS idx_inbound_transfers_chain_hash_account_leg;`)
  await client.query(`DROP INDEX IF EXISTS idx_inbound_transfers_chain_hash_account_log;`)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_transfers_chain_hash_account
      ON inbound_transfers (chain_id, LOWER(tx_hash), account_id);
  `)
  await client.query(`ALTER TABLE inbound_transfers DROP COLUMN IF EXISTS sender_is_own_address;`)
}
