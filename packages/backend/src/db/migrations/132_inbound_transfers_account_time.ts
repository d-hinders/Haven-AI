import type { PoolClient } from 'pg'
import { createIndexConcurrently, dropIndexConcurrently } from '../concurrent-index.js'

export const version = '132_inbound_transfers_account_time'

// A plain CREATE INDEX takes a SHARE lock on inbound_transfers for the whole
// build, which blocks the receive index's writes; the concurrent build does not.
export const transactional = false
export const nonTransactionalReason =
  'CREATE INDEX CONCURRENTLY cannot run inside a transaction block (25001); a plain build would block inbound_transfers writes'

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
 */
export async function up(client: PoolClient): Promise<void> {
  await createIndexConcurrently(client, {
    name: 'idx_inbound_transfers_account_time',
    definition: 'ON inbound_transfers (account_id, block_time DESC)',
  })
}

export async function down(client: PoolClient): Promise<void> {
  await dropIndexConcurrently(client, 'idx_inbound_transfers_account_time')
}
