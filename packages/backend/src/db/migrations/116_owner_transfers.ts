import type { PoolClient } from 'pg'

/**
 * 116 — the record of an owner's own send (#4099, epic #4093).
 *
 * (Numbered 116, not 115: PR #4088 holds `115_feedback_expires_at_fixed_window`
 * for #4084 while this table is on its branch, and landed migration numbers
 * are immutable.)
 *
 * An owner send (`POST /accounts/hybrid/:address/transfers/submit`, #1083)
 * persisted nothing, so the transaction feed could only ever read its
 * explorer row as an unattributed outbound transfer — initiator "Unknown",
 * never "You". This table is that missing record: one row per owner send
 * that landed, written by the submit route AFTER the UserOp's receipt
 * confirmed it (`submitTransfer` waits for the receipt, so the tx hash is
 * known and the transfer did execute). Enrichment matches an explorer row
 * to a row here by (tx hash, account, chain) — the same identity
 * `paymentAgentIdentityKey` uses for intents and sweeps — plus what was
 * sent (token, recipient, amount), and stamps `initiatedBy: 'human'`.
 *
 * Attribution only. Nothing on the payment path reads this table, the row
 * is written after the transfer executed, and a failed or slow write never
 * fails the send nor holds its reply past a short deadline (the route logs
 * and answers success): it can change what the feed CALLS a transfer, never
 * whether or what one moves.
 *
 * Owner decision (2026-10-19): no backfill. A send made before this table
 * existed has no row and stays "Unknown"; no heuristic may claim it.
 *
 * The unique index is the write-side contract: it is the ON CONFLICT
 * arbiter for the repository's idempotent INSERT, so a retried submit
 * response cannot record one transfer twice. `tx_hash` is stored lowercase
 * by the repository; the match lowercases too. A row that outlives its
 * account is meaningless (an unlinked account's feed is not served),
 * hence the cascades.
 */
export const version = '116_owner_transfers'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS owner_transfers (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id     UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      chain_id       INTEGER NOT NULL,
      tx_hash        VARCHAR(66) NOT NULL,
      user_op_hash   VARCHAR(66),
      token_address  VARCHAR(42) NOT NULL,
      to_address     VARCHAR(42) NOT NULL,
      amount_raw     VARCHAR(78) NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // The dedupe identity and the enrichment lookup — see the header. Led by
  // tx_hash because the enrichment read constrains it (and account_id) but
  // not chain_id.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_transfers_identity
      ON owner_transfers (tx_hash, account_id, chain_id)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_owner_transfers_user
      ON owner_transfers (user_id)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS owner_transfers`)
}
