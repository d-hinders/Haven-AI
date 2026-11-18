import type { PoolClient } from 'pg'

export const version = '132_inbound_transfers_account_time'

/**
 * 132 — the owner's sales reads need one account's transfers by time (#4897,
 * epic #4885).
 *
 * `GET /merchant-sales/summary` and `/payments` read every indexed transfer
 * into ONE account over a period. The table's indexes are keyed on the
 * transfer's identity (chain, hash, account, log), the balance rows
 * (`balance_consumed`), the unmatched rows (`match_kind IS NULL`) and the hash
 * alone, so none of them serves "this account's transfers between two times":
 * the read scanned the whole table, every account's rows included. This index
 * is that access path: `(account_id, block_time DESC)`.
 *
 * It is not partial: the reads filter on amount and the own-address flag in the
 * aggregate, and the period is a range on `block_time`. 131 is left as shipped
 * (it is in an open PR); this is its own migration. The index is an access
 * path only; no row, column or constraint changes.
 *
 * A plain, transactional CREATE INDEX (review of #4897). It takes a SHARE lock
 * on inbound_transfers for the build, which blocks the receive index's writes
 * meanwhile. The table is days old (#4903, migration 128) and holds one row per
 * inbound USDC transfer into a Haven account: thousands of rows in production,
 * not millions, so the build is sub-second and the lock is accepted, as 072
 * records for its own index. The CONCURRENTLY lane (#2150) was considered and
 * not used: no production migration has run on it yet, and a container killed
 * mid-build there leaves a 'running' row that refuses the next boot.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_inbound_transfers_account_time ON inbound_transfers (account_id, block_time DESC)',
  )
}

export async function down(client: PoolClient): Promise<void> {
  await client.query('DROP INDEX IF EXISTS idx_inbound_transfers_account_time')
}
