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
     SET status = 'failed', error = $2, nonce = COALESCE($3, nonce), updated_at = NOW()
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

/**
 * Claim ONE orphaned queued row (#1558): queued, past the orphan age, lease
 * free or stale. The age predicate is what separates an orphan from an
 * in-flight inline submission — slice-2 sites broadcast within seconds of
 * enqueueing without ever claiming, so a young unclaimed row is NOT ours to
 * take. Same lease + SKIP LOCKED shape as the ordinary claim.
 */
export const CLAIM_ORPHANED_OUTBOUND_TX_SQL = `UPDATE outbound_txs
     SET claimed_at = NOW(), updated_at = NOW()
   WHERE id = (
     SELECT id FROM outbound_txs
      WHERE chain_id = $1
        AND status = 'queued'
        AND created_at < NOW() - ($2 * INTERVAL '1 second')
        AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '${CLAIM_LEASE_INTERVAL}')
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *`

/**
 * How many replacement ATTEMPTS a (chain, nonce) lane has burned (#1558).
 * Counts successful bumps (`replaced`) AND failed ones (`failed` rows that
 * carry the nonce they tried to replace) — review finding: counting only
 * successes let a lane whose bump broadcasts kept THROWING retry forever
 * without ever tripping the incident cap, the exact loop the cap exists to
 * stop.
 */
export const COUNT_LANE_ATTEMPTS_AT_NONCE_SQL = `SELECT COUNT(*)::int AS n FROM outbound_txs
   WHERE chain_id = $1 AND nonce = $2 AND status IN ('replaced', 'failed')`

/**
 * The durable record for one broadcast hash (#1745).
 *
 * Chain-scoped because `tx_hash` is only unique WITHIN a chain — the same
 * relayer key signing identical calldata at the same nonce on two chains
 * produces the same hash, and an unscoped read would hand back the wrong
 * chain's nonce, which is the one fact the caller is here for.
 *
 * `ORDER BY created_at DESC` is not decoration: a bump writes a NEW row for
 * the replacement, and while `passport_attest` is never replaced (#1735),
 * this read is generic. Newest-first means the caller sees the row that
 * describes the current attempt.
 *
 * No index backs this (061 indexes the lane, the unmined scan and the live
 * nonce, not the hash). Deliberate — the only caller is the passport
 * recovery path, which runs at most once per stuck anchor per backoff tick,
 * and a migration for it would gate this fix on CODEOWNERS review. If a hot
 * path ever wants this read, add the index then.
 */
export const FIND_OUTBOUND_TX_BY_HASH_SQL = `SELECT * FROM outbound_txs
   WHERE chain_id = $1 AND tx_hash = $2
   ORDER BY created_at DESC, id
   LIMIT 1`

export async function findOutboundTxByHash(
  chainId: number,
  txHash: string,
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(FIND_OUTBOUND_TX_BY_HASH_SQL, [
    chainId,
    txHash.toLowerCase(),
  ])
  return rows[0] ?? null
}

/**
 * The transaction that carried one exact payload, newest-useful first (#1758).
 *
 * The passport revoke's convergence path needs an EVIDENCE POINTER: migration
 * 049 refuses `revocation_status = 'confirmed'` without a
 * `revocation_tx_hash`, so "the chain says this UID is revoked" is not by
 * itself a representable conclusion. This is where the hash comes from.
 *
 * Keyed on the CALLDATA rather than on an agent id, because `outbound_txs`
 * deliberately knows nothing about agents — the revoke's calldata encodes the
 * attestation UID, so it identifies the intent exactly without inventing a
 * join. `to_address` is not in the predicate: the same submitter on the same
 * chain has one EAS deployment, and adding it would only let a lowercase
 * mismatch silently drop the row.
 *
 * **Only `mined` counts, and that is the whole point.**
 * `markOutboundTxMined` is called only after a status-1 receipt read (see
 * `outbound-bump-worker.ts`), so a mined row is a transaction PROVEN to have
 * succeeded. Nothing weaker is accepted:
 *
 * - a `broadcast` row says only "we sent this". It is tempting to accept one
 *   for the window between a transaction mining and the bump worker's next
 *   scan closing the row — but several `broadcast` rows for the SAME calldata
 *   is a NORMAL state here, not an exotic one: every revoke retry opens a
 *   fresh record, and migration 061's partial unique key only stops two of
 *   them sharing a nonce. When the chain then says the UID is revoked, exactly
 *   one of those rows is the transaction that did it and the rest are reverts
 *   the worker has not closed yet — and this query cannot tell which. Picking
 *   the newest would write a plausible-looking wrong hash into an audit
 *   column, which is worse than waiting one more backoff tick for the worker
 *   to close the real one (review finding, #1758);
 * - `failed` and `replaced` rows are excluded for the blunter version of the
 *   same reason: a reverted or superseded transaction is precisely the hash we
 *   must not record as the one that did the work.
 *
 * The cost of the strictness is a delay, never a wrong answer: until a mined
 * row exists the caller keeps the row pending and keeps alarming.
 *
 * No index backs this, for the same reason `FIND_OUTBOUND_TX_BY_HASH_SQL` has
 * none: the only caller is a cold recovery path that runs at most once per
 * stuck revoke per backoff tick, and a migration for it would gate this fix on
 * CODEOWNERS review. Add the index when a hot path wants the read.
 */
export const FIND_OUTBOUND_EVIDENCE_TX_HASH_SQL = `SELECT tx_hash FROM outbound_txs
   WHERE chain_id = $1 AND submitter = $2 AND data = $3
     AND tx_hash IS NOT NULL
     AND status = 'mined'
   ORDER BY created_at DESC, id
   LIMIT 1`

export async function findOutboundEvidenceTxHash(
  chainId: number,
  submitter: string,
  data: string,
  db: Executor = pool,
): Promise<string | null> {
  const { rows } = await db.query<{ tx_hash: string }>(FIND_OUTBOUND_EVIDENCE_TX_HASH_SQL, [
    chainId,
    submitter,
    data.toLowerCase(),
  ])
  return rows[0]?.tx_hash ?? null
}

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
  /** Set for a failed same-nonce bump ATTEMPT, so the lane cap counts it. */
  nonce?: bigint,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(MARK_OUTBOUND_TX_FAILED_SQL, [
    id,
    error,
    nonce?.toString() ?? null,
  ])
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

export async function claimOrphanedOutboundTx(
  chainId: number,
  olderThanSeconds: number,
  db: Executor = pool,
): Promise<OutboundTxRow | null> {
  const { rows } = await db.query<OutboundTxRow>(CLAIM_ORPHANED_OUTBOUND_TX_SQL, [
    chainId,
    olderThanSeconds,
  ])
  return rows[0] ?? null
}

export async function countLaneAttemptsAtNonce(
  chainId: number,
  nonce: bigint,
  db: Executor = pool,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(COUNT_LANE_ATTEMPTS_AT_NONCE_SQL, [
    chainId,
    nonce.toString(),
  ])
  return rows[0]?.n ?? 0
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
