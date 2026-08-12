/**
 * Data access for the reporting-feed dedup ledger (#999, epic #980).
 *
 * One aggregate: `reporting_feed_syncs` — what has been fed to which
 * bookkeeping provider (epic #491, P1 #497), keyed uniquely on
 * (provider, payment_id, user_id). Extracted verbatim from
 * `modules/reporting/feed-sync.ts` (which re-exports these functions) and
 * `feed-orchestrator.ts`. Convention: `README.md` in this directory.
 *
 * Invariants a reader must not break:
 *
 * - `claimSync`'s two statements ARE the concurrency guard: the unique
 *   constraint decides the first writer, and only a previously `failed` row
 *   is re-claimable. They travel together — exposing either alone lets a
 *   caller double-post into a customer's ledger.
 * - `markPushed` never flips a pushed row back to retryable: a retry after a
 *   successful push would double-post the invoice. The `note` (#498) carries
 *   a non-fatal degradation into the `error` column WITHOUT changing status.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export type SyncStatus = 'pending' | 'pushed' | 'failed' | 'skipped'

export interface FeedSyncRow {
  id: string
  user_id: string
  provider: string
  payment_id: string
  external_ref: string | null
  status: SyncStatus
  error: string | null
  attempts: number
  created_at: string
  updated_at: string
}

export interface ClaimResult {
  /** True when this caller now owns the push (fresh claim or retry of a failed row). */
  owned: boolean
  /** The current status after the claim attempt (e.g. 'pushed' when a re-push is short-circuited). */
  status: SyncStatus | null
}

export const CLAIM_SYNC_INSERT_SQL = `INSERT INTO reporting_feed_syncs (user_id, provider, payment_id, status, attempts)
     VALUES ($1, $2, $3, 'pending', 1)
     ON CONFLICT (provider, payment_id, user_id) DO NOTHING
     RETURNING id`

export const CLAIM_SYNC_RECLAIM_FAILED_SQL = `UPDATE reporting_feed_syncs
     SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1 AND status IN ('failed', 'skipped')
     RETURNING id`

export const MARK_SYNC_PUSHED_SQL = `UPDATE reporting_feed_syncs
     SET status = 'pushed', external_ref = $4, error = $5, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

export const MARK_SYNC_FAILED_SQL = `UPDATE reporting_feed_syncs
     SET status = 'failed', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

// #1365: a connector-level skip is a real ledger state now — previously it was
// recorded via markPushed (status 'pushed', NULL external_ref, reason
// DROPPED), which read as "Synced" in the UI and was never revisited by the
// backfill. The reason lands in `error` (the same column the #498 note
// contract already uses for non-fatal detail).
export const MARK_SYNC_SKIPPED_SQL = `UPDATE reporting_feed_syncs
     SET status = 'skipped', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

// #1365: verification-gated reopen for a deleted-in-Fortnox invoice. The
// status predicate keeps the double-post guard intact: only a `pushed` row
// flips, only to `failed` (the normal retry path), and the CALLER must first
// have Fortnox itself confirm the invoice no longer exists — see
// `reopenMissingPushed`'s contract in routes/reporting.ts.
export const REOPEN_PUSHED_SQL = `UPDATE reporting_feed_syncs
     SET status = 'failed', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1 AND status = 'pushed'
     RETURNING id`

export const GET_SYNC_STATE_SQL = `SELECT * FROM reporting_feed_syncs
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

export const LIST_SYNCS_FOR_USER_SQL = `SELECT * FROM reporting_feed_syncs
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`

/**
 * Atomically claim a payment for pushing. The concurrency guard is the unique
 * constraint: the first caller inserts a `pending` row and owns the push; a
 * concurrent caller hits the conflict and does not. A previously `failed` row
 * is re-claimable for retry. A `pushed` row is never re-claimed. (Recovering
 * a stuck in-flight `pending` is a separate sweep concern, not handled here,
 * to keep the live concurrency guard intact.)
 *
 * `userId` is REQUIRED — it is part of the ledger key.
 */
export async function claimSync(
  userId: string,
  provider: string,
  paymentId: string,
  db: Executor = pool,
): Promise<ClaimResult> {
  // Fresh claim — first writer wins via the unique constraint.
  const inserted = await db.query(CLAIM_SYNC_INSERT_SQL, [userId, provider, paymentId])
  if (inserted.rows.length > 0) return { owned: true, status: 'pending' }

  // Existing row — re-claim for retry only if it previously failed.
  const reclaimed = await db.query(CLAIM_SYNC_RECLAIM_FAILED_SQL, [userId, provider, paymentId])
  if (reclaimed.rows.length > 0) return { owned: true, status: 'pending' }

  // Already pushed, skipped, or in-flight pending — not ours.
  const state = await getSyncState(userId, provider, paymentId, db)
  return { owned: false, status: state?.status ?? null }
}

/** Mark a claim delivered — see the header for the `note` (#498) contract. */
export async function markPushed(
  userId: string,
  provider: string,
  paymentId: string,
  externalRef: string | null,
  note: string | null = null,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_SYNC_PUSHED_SQL, [
    userId,
    provider,
    paymentId,
    externalRef,
    note ? note.slice(0, 1000) : null,
  ])
}

export async function markFailed(
  userId: string,
  provider: string,
  paymentId: string,
  error: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_SYNC_FAILED_SQL, [userId, provider, paymentId, error.slice(0, 1000)])
}

/** #1365: record a connector skip with its reason — re-claimable like failed. */
export async function markSkipped(
  userId: string,
  provider: string,
  paymentId: string,
  reason: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_SYNC_SKIPPED_SQL, [userId, provider, paymentId, reason.slice(0, 1000)])
}

/**
 * #1365: flip a `pushed` row back to retryable `failed` — ONLY valid after
 * Fortnox itself confirmed the pushed invoice no longer exists (the caller
 * runs the #1362 read-back first; this function just enforces the row-state
 * half). Returns false when the row is not currently `pushed` (nothing
 * written) — the pushed-is-final double-post guard stays intact for every
 * other path, because the only transition added is pushed→failed on an
 * invoice the provider says is gone.
 */
export async function reopenMissingPushed(
  userId: string,
  provider: string,
  paymentId: string,
  reason: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(REOPEN_PUSHED_SQL, [userId, provider, paymentId, reason.slice(0, 1000)])
  return result.rows.length > 0
}

export async function getSyncState(
  userId: string,
  provider: string,
  paymentId: string,
  db: Executor = pool,
): Promise<FeedSyncRow | null> {
  const result = await db.query<FeedSyncRow>(GET_SYNC_STATE_SQL, [userId, provider, paymentId])
  return result.rows[0] ?? null
}

/** Per-user listing for the Reporting UI (#500). */
export async function listSyncs(
  userId: string,
  limit = 100,
  db: Executor = pool,
): Promise<FeedSyncRow[]> {
  const result = await db.query<FeedSyncRow>(LIST_SYNCS_FOR_USER_SQL, [userId, limit])
  return result.rows
}

// ── Backfill selection (moved from modules/reporting/feed-orchestrator.ts, #999)

export const LIST_UNPUSHED_PAYMENT_IDS_SQL = `SELECT COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) AS payment_id
     FROM machine_payment_evidence mpe
     LEFT JOIN reporting_feed_syncs s
       ON s.user_id = mpe.user_id AND s.provider = $2
      AND s.payment_id = COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT)
      AND s.status = 'pushed'
     WHERE mpe.user_id = $1 AND mpe.amount_sek IS NOT NULL AND s.id IS NULL
     ORDER BY COALESCE(mpe.confirmed_at, mpe.created_at) DESC
     LIMIT $3`

/** Settled, FX-ready payment ids for the user with no `pushed` sync row yet. */
export async function listUnpushedPaymentIds(
  userId: string,
  provider: string,
  limit: number,
  db: Executor = pool,
): Promise<string[]> {
  const result = await db.query<{ payment_id: string | null }>(LIST_UNPUSHED_PAYMENT_IDS_SQL, [
    userId,
    provider,
    limit,
  ])
  return result.rows.map((r) => r.payment_id).filter((id): id is string => Boolean(id))
}
