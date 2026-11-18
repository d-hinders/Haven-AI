import type { PoolClient } from 'pg'

export const version = '133_inbound_transfers_own_flag_backfill'

/**
 * 133 — a one-time backfill of `inbound_transfers.sender_is_own_address`
 * (#4897, epic #4885).
 *
 * The flag is decided ONCE, when a transfer is indexed, and stored. Rows indexed
 * before migration 128 never had it (DEFAULT false), and rows indexed between
 * 128 and the sales ingest were stamped against the smart-accounts-only set. A
 * transfer from one of the owner's agent delegates therefore counted as revenue
 * while the sales reads showed its payer as one of the owner's own addresses.
 *
 * This sets the flag to true on every existing row whose payer is in the
 * widened own set of the row's own `user_id`: the same three-way union as
 * `listOwnAccountAddresses` (smart accounts, agent delegate addresses, and
 * delegates replaced by rotation), done in SQL. It only ever sets true, and
 * runs once: rows indexed afterwards are stamped at ingest, so a later new
 * account or rotation still never rewrites past revenue.
 *
 * Residual: an ingest whose own-address lookup fails stamps false
 * (`modules/transactions/receive.ts`) and nothing repairs that row.
 *
 * `down()` is a no-op: the previous value of the flag is not recorded, and
 * reverting would only reintroduce the miscount this fixes.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE inbound_transfers t
       SET sender_is_own_address = true
     WHERE NOT t.sender_is_own_address
       AND LOWER(t.payer_address) IN (
         SELECT LOWER(account_address) FROM smart_accounts WHERE user_id = t.user_id
         UNION
         SELECT LOWER(delegate_address) FROM agents
          WHERE user_id = t.user_id AND delegate_address IS NOT NULL
         UNION
         SELECT LOWER(r.old_delegate_address)
           FROM agent_rekeys r JOIN agents a ON a.id = r.agent_id
          WHERE a.user_id = t.user_id
       )
  `)
}

export async function down(_client: PoolClient): Promise<void> {
  // Intentionally empty: see the header.
}
