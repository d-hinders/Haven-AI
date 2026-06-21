import pool from '../../db.js'

/**
 * Idempotency / dedup ledger for the reporting feed (epic #491, P1 #497).
 *
 * Persists what's been fed to which provider so re-syncs, backfills, and retries
 * never double-post into the customer's ledger — duplicate entries are the
 * fastest way to lose trust. Keyed uniquely on (provider, payment_id, user_id).
 */
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

/**
 * Atomically claim a payment for pushing. The concurrency guard is the unique
 * constraint: the first caller inserts a `pending` row and owns the push; a
 * concurrent caller hits the conflict and does not. A previously `failed` row is
 * re-claimable for retry. A `pushed` row is never re-claimed (re-push
 * short-circuited). (Recovering a stuck in-flight `pending` is a separate sweep
 * concern, not handled here, to keep the live concurrency guard intact.)
 */
export async function claimSync(
  userId: string,
  provider: string,
  paymentId: string,
): Promise<ClaimResult> {
  // Fresh claim — first writer wins via the unique constraint.
  const inserted = await pool.query(
    `INSERT INTO reporting_feed_syncs (user_id, provider, payment_id, status, attempts)
     VALUES ($1, $2, $3, 'pending', 1)
     ON CONFLICT (provider, payment_id, user_id) DO NOTHING
     RETURNING id`,
    [userId, provider, paymentId],
  )
  if (inserted.rows.length > 0) return { owned: true, status: 'pending' }

  // Existing row — re-claim for retry only if it previously failed.
  const reclaimed = await pool.query(
    `UPDATE reporting_feed_syncs
     SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1 AND status = 'failed'
     RETURNING id`,
    [userId, provider, paymentId],
  )
  if (reclaimed.rows.length > 0) return { owned: true, status: 'pending' }

  // Already pushed, skipped, or in-flight pending — not ours.
  const state = await getSyncState(userId, provider, paymentId)
  return { owned: false, status: state?.status ?? null }
}

export async function markPushed(
  userId: string,
  provider: string,
  paymentId: string,
  externalRef: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE reporting_feed_syncs
     SET status = 'pushed', external_ref = $4, error = NULL, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`,
    [userId, provider, paymentId, externalRef],
  )
}

export async function markFailed(
  userId: string,
  provider: string,
  paymentId: string,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE reporting_feed_syncs
     SET status = 'failed', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`,
    [userId, provider, paymentId, error.slice(0, 1000)],
  )
}

export async function getSyncState(
  userId: string,
  provider: string,
  paymentId: string,
): Promise<FeedSyncRow | null> {
  const result = await pool.query<FeedSyncRow>(
    `SELECT * FROM reporting_feed_syncs
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`,
    [userId, provider, paymentId],
  )
  return result.rows[0] ?? null
}

/** Per-user listing for the Reporting UI (#500). */
export async function listSyncs(userId: string, limit = 100): Promise<FeedSyncRow[]> {
  const result = await pool.query<FeedSyncRow>(
    `SELECT * FROM reporting_feed_syncs
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit],
  )
  return result.rows
}
