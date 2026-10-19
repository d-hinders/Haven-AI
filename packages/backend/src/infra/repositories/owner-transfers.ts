/**
 * Data access for `owner_transfers` (migration 116, #4099): the record that an
 * account's OWNER sent a transfer through `POST
 * /accounts/hybrid/:address/transfers/submit`.
 *
 * Attribution only — the payment path never reads it. The submit route writes
 * one row after the UserOp's receipt confirmed the transfer; transaction
 * enrichment reads them back to stamp `initiatedBy: 'human'` on the matching
 * explorer row. Convention: `README.md` in this directory.
 *
 * Invariants a reader must not break:
 *
 * - The read is tenant-scoped twice, like the agent-attribution lookups in
 *   `transaction-history.ts`: `user_id = $2` AND `account_id = ANY($3)` (the
 *   caller's own account ids). A plain `tx_hash` match would let a same-hash
 *   row on another tenant's account claim this user's transaction.
 * - `tx_hash` is stored and compared lowercase.
 * - The insert is idempotent on (chain_id, tx_hash, account_id) — a retried
 *   record is a no-op, never a second row.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export interface OwnerTransferRecord {
  userId: string
  accountId: string
  chainId: number
  txHash: string
  userOpHash: string | null
  tokenAddress: string
  toAddress: string
  amountRaw: string
}

export const RECORD_OWNER_TRANSFER_SQL = `INSERT INTO owner_transfers
       (user_id, account_id, chain_id, tx_hash, user_op_hash, token_address, to_address, amount_raw)
     VALUES ($1, $2, $3, LOWER($4), LOWER($5), LOWER($6), LOWER($7), $8)
     ON CONFLICT (chain_id, tx_hash, account_id) DO NOTHING`

export async function recordOwnerTransfer(
  record: OwnerTransferRecord,
  db: Executor = pool,
): Promise<void> {
  await db.query(RECORD_OWNER_TRANSFER_SQL, [
    record.userId,
    record.accountId,
    record.chainId,
    record.txHash,
    record.userOpHash,
    record.tokenAddress,
    record.toAddress,
    record.amountRaw,
  ])
}

export interface OwnerTransferMatchRow {
  tx_hash: string
  account_id: string
  chain_id: number
}

export const FIND_OWNER_TRANSFER_MATCHES_SQL = `SELECT ot.tx_hash,
              ot.account_id,
              ot.chain_id
       FROM owner_transfers ot
       WHERE ot.tx_hash = ANY($1)
         AND ot.user_id = $2
         AND ot.account_id = ANY($3)`

/** `txHashes` lowercase — the enrichment caller already lowercases them. */
export async function findOwnerTransferMatches(
  txHashes: string[],
  userId: string,
  accountIds: string[],
  db: Executor = pool,
): Promise<OwnerTransferMatchRow[]> {
  const result = await db.query<OwnerTransferMatchRow>(FIND_OWNER_TRANSFER_MATCHES_SQL, [
    txHashes,
    userId,
    accountIds,
  ])
  return result.rows
}
