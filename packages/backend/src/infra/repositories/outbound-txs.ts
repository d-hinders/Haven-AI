/**
 * Data access for `outbound_txs` (#1555, epic #1554) — the durable lifecycle
 * of every transaction the relayer key broadcasts.
 *
 * Convention: `README.md` in this directory. Two properties are load-bearing:
 *
 * **The claim is a LEASE, not a state.** `claimNextOutboundTx` sets
 * `claimed_at` under `FOR UPDATE SKIP LOCKED` and leaves `status = 'queued'`:
 * a process that dies between claim and broadcast leaves a row whose lease
 * simply expires (`CLAIM_LEASE_INTERVAL`), and the bump worker (#1558)
 * re-adopts it. A "claiming" status would instead need crash-recovery of the
 * status itself — a phantom state the epic deliberately avoids.
 *
 * **Two concurrent claims can never return the same row.** `SKIP LOCKED`
 * makes the second claimant skip the row the first holds and take the next —
 * proven against real Postgres in the repository test, not asserted on a
 * mock, because the guarantee IS Postgres row-locking.
 *
 * Unlike the watermark repository this one is FAIL-CLOSED: these rows are the
 * authority for "what did we broadcast", not an optimisation, so an error
 * propagates to the caller rather than degrading.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export type OutboundTxStatus = 'queued' | 'broadcast' | 'mined' | 'replaced' | 'failed'

export interface OutboundTxRow {
  id: string
  chain_id: number
  submitter: string
  to_address: string
  data: string
  value_atomic: string
  status: OutboundTxStatus
  claimed_at: Date | null
  nonce: string | null
  max_fee_per_gas: string | null
  max_priority_fee_per_gas: string | null
  tx_hash: string | null
  replaced_by: string | null
  error: string | null
  created_at: Date
  updated_at: Date
}

/**
 * How long a claim lease holds before the row is adoptable again. Longer than
 * any healthy nonce-read→broadcast window (sub-second) by orders of magnitude,
 * so re-adoption only ever happens to a crashed or hung claimant.
 */
export const CLAIM_LEASE_INTERVAL = '2 minutes'

export const ENQUEUE_OUTBOUND_TX_SQL = `INSERT INTO outbound_txs
     (chain_id, submitter, to_address, data, value_atomic)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING *`

/**
 * Oldest-first per chain (id as tiebreaker — NOW() can collide within a
 * millisecond and an unstable order is untestable), skipping rows another
 * claimant holds. The inner SELECT takes the row lock; SKIP LOCKED is what
 * turns "two claimants, one row" into "two claimants, two rows".
 */
export const CLAIM_NEXT_OUTBOUND_TX_SQL = `UPDATE outbound_txs
     SET claimed_at = NOW(), updated_at = NOW()
   WHERE id = (
     SELECT id FROM outbound_txs
      WHERE chain_id = $1
        AND status = 'queued'
        AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '${CLAIM_LEASE_INTERVAL}')
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *`

export const MARK_OUTBOUND_TX_BROADCAST_SQL = `UPDATE outbound_txs
     SET status = 'broadcast', tx_hash = $2, nonce = $3,
         max_fee_per_gas = $4, max_priority_fee_per_gas = $5, updated_at = NOW()
   WHERE id = $1 AND status = 'queued'
   RETURNING *`

export const MARK_OUTBOUND_TX_MINED_SQL = `UPDATE outbound_txs
     SET status = 'mined', updated_at = NOW()
   WHERE id = $1 AND status = 'broadcast'
   RETURNING *`

export const MARK_OUTBOUND_TX_FAILED_SQL = `UPDATE outbound_txs
     SET status = 'failed', error = $2, updated_at = NOW()
   WHERE id = $1 AND status IN ('queued', 'broadcast')
   RETURNING *`

export const MARK_OUTBOUND_TX_REPLACED_SQL = `UPDATE outbound_txs
     SET status = 'replaced', replaced_by = $2, updated_at = NOW()
   WHERE id = $1 AND status = 'broadcast'
   RETURNING *`

/** The bump worker's scan (#1558): broadcast rows nothing has confirmed. */
export const LIST_UNMINED_OUTBOUND_TXS_SQL = `SELECT * FROM outbound_txs
   WHERE chain_id = $1 AND status = 'broadcast'
     AND updated_at < NOW() - ($2 * INTERVAL '1 second')
   ORDER BY created_at, id`

export async function enqueueOutboundTx(
  params: {
    chainId: number
    submitter: string
    toAddress: string
    /** The FULL calldata (0x-hex) — the bump worker re-broadcasts it verbatim. */
    data: string
    valueAtomic?: bigint
  },
  db: Executor = pool,
): Promise<OutboundTxRow> {
  const { rows } = await db.query<OutboundTxRow>(ENQUEUE_OUTBOUND_TX_SQL, [
    params.chainId,
    params.submitter,
    params.toAddress.toLowerCase(),
    params.data.toLowerCase(),
    (params.valueAtomic ?? 0n).toString(),
  ])
  return rows[0]
}

export async function claimNextOutboundTx(
  chainId: number,
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(CLAIM_NEXT_OUTBOUND_TX_SQL, [chainId])
  return rows[0] ?? null
}

/**
 * Guarded on `status = 'queued'`: marking a row that already moved on returns
 * null instead of silently rewriting history — the caller learns it lost.
 */
export async function markOutboundTxBroadcast(
  id: string,
  params: { txHash: string; nonce: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(MARK_OUTBOUND_TX_BROADCAST_SQL, [
    id,
    params.txHash.toLowerCase(),
    params.nonce.toString(),
    params.maxFeePerGas?.toString() ?? null,
    params.maxPriorityFeePerGas?.toString() ?? null,
  ])
  return rows[0] ?? null
}

export async function markOutboundTxMined(
  id: string,
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(MARK_OUTBOUND_TX_MINED_SQL, [id])
  return rows[0] ?? null
}

export async function markOutboundTxFailed(
  id: string,
  error: string,
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(MARK_OUTBOUND_TX_FAILED_SQL, [id, error])
  return rows[0] ?? null
}

export async function markOutboundTxReplaced(
  id: string,
  replacedById: string,
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(MARK_OUTBOUND_TX_REPLACED_SQL, [id, replacedById])
  return rows[0] ?? null
}

export async function listUnminedOutboundTxs(
  chainId: number,
  olderThanSeconds: number,
  db: Executor = pool,
): Promise<OutboundTxRow[]> {
  const { rows } = await db.query<OutboundTxRow>(LIST_UNMINED_OUTBOUND_TXS_SQL, [
    chainId,
    olderThanSeconds,
  ])
  return rows
}
