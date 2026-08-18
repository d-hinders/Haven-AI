import type { PoolClient } from 'pg'

export const version = '061_outbound_txs'

/**
 * #1555 (epic #1554): the durable record of every transaction the relayer key
 * broadcasts — the table the in-process `withRelayerSendLock` has called
 * "interim until the durable outbound-tx queue lands" since #814.
 *
 * This migration is deliberately BEHAVIOUR-NEUTRAL: the table and its
 * repository land unused, so the schema review is isolated from any call-site
 * change (those are epic slices #1556–#1559).
 *
 * Shape notes:
 * - `status` is the lifecycle the epic defines: queued → broadcast → mined |
 *   replaced | failed. Claiming is NOT a status — it is the `claimed_at`
 *   lease, so a process that dies between claim and broadcast leaves a
 *   `queued` row a later tick can re-adopt (slice #1558) instead of a row
 *   stuck in a phantom state.
 * - the FULL calldata and value are stored, not a hash: the bump worker
 *   (#1558) re-broadcasts the exact payload with higher fees, and a hash can
 *   verify a payload but never reconstruct one. Re-deriving calldata from the
 *   submitter after the fact is not safe — a sweep's EIP-3009 payload embeds
 *   a deadline and a one-time nonce that would not re-derive identically.
 * - fee/value fields are NUMERIC(78,0): wei values are uint256 and bigint
 *   columns overflow at 2^63.
 * - the partial UNIQUE index on (chain_id, nonce) WHERE status = 'broadcast'
 *   makes "at most one LIVE broadcast per nonce" a schema-enforced invariant
 *   instead of worker discipline — replacements legitimately share a nonce,
 *   but only after the replaced row leaves 'broadcast'.
 * - `replaced_by` is a self-FK so a fee-bump chain is walkable in both
 *   directions from either end.
 * - two partial indexes serve the two hot reads (claim-next over queued;
 *   the bump worker's unmined scan over broadcast) without taxing writes for
 *   the terminal tail.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS outbound_txs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chain_id INTEGER NOT NULL,
      submitter TEXT NOT NULL,
      to_address TEXT NOT NULL,
      data TEXT NOT NULL,
      value_atomic NUMERIC(78,0) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'broadcast', 'mined', 'replaced', 'failed')),
      claimed_at TIMESTAMPTZ,
      nonce BIGINT,
      max_fee_per_gas NUMERIC(78,0),
      max_priority_fee_per_gas NUMERIC(78,0),
      tx_hash TEXT,
      replaced_by UUID REFERENCES outbound_txs(id),
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_outbound_txs_lane
      ON outbound_txs (chain_id, created_at)
      WHERE status = 'queued'
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_outbound_txs_unmined
      ON outbound_txs (chain_id, updated_at)
      WHERE status = 'broadcast'
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_txs_live_nonce
      ON outbound_txs (chain_id, nonce)
      WHERE status = 'broadcast'
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_outbound_txs_live_nonce`)
  await client.query(`DROP INDEX IF EXISTS idx_outbound_txs_unmined`)
  await client.query(`DROP INDEX IF EXISTS idx_outbound_txs_lane`)
  await client.query(`DROP TABLE IF EXISTS outbound_txs`)
}
