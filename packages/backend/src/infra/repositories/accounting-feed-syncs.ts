/**
 * Data access for the reporting-feed dedup ledger (#999, epic #980).
 *
 * One aggregate: `accounting_feed_syncs` — what has been fed to which
 * bookkeeping provider (epic #491, P1 #497), keyed uniquely on
 * (provider, payment_id, user_id). Extracted verbatim from
 * `modules/accounting/feed-sync.ts` (which re-exports these functions) and
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

export const CLAIM_SYNC_INSERT_SQL = `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts)
     VALUES ($1, $2, $3, 'pending', 1)
     ON CONFLICT (provider, payment_id, user_id) DO NOTHING
     RETURNING id`

export const CLAIM_SYNC_RECLAIM_FAILED_SQL = `UPDATE accounting_feed_syncs
     SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1 AND status IN ('failed', 'skipped')
     RETURNING id`

export const MARK_SYNC_PUSHED_SQL = `UPDATE accounting_feed_syncs
     SET status = 'pushed', external_ref = $4, error = $5, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

export const MARK_SYNC_FAILED_SQL = `UPDATE accounting_feed_syncs
     SET status = 'failed', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

// #1365: a connector-level skip is a real ledger state now — previously it was
// recorded via markPushed (status 'pushed', NULL external_ref, reason
// DROPPED), which read as "Synced" in the UI and was never revisited by the
// backfill. The reason lands in `error` (the same column the #498 note
// contract already uses for non-fatal detail).
export const MARK_SYNC_SKIPPED_SQL = `UPDATE accounting_feed_syncs
     SET status = 'skipped', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

// #1365: verification-gated reopen for a deleted-in-Fortnox invoice. The
// status predicate keeps the double-post guard intact: only a `pushed` row
// flips, only to `failed` (the normal retry path), and the CALLER must first
// have Fortnox itself confirm the invoice no longer exists — see
// `reopenMissingPushed`'s contract in routes/accounting-feed.ts.
export const REOPEN_PUSHED_SQL = `UPDATE accounting_feed_syncs
     SET status = 'failed', error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1 AND status = 'pushed'
     RETURNING id`

export const GET_SYNC_STATE_SQL = `SELECT * FROM accounting_feed_syncs
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1`

export const LIST_SYNCS_FOR_USER_SQL = `SELECT * FROM accounting_feed_syncs
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`

// #2870: the per-page join the Transactions badge reads. ONE query for the
// whole page (`= ANY($2)` over the page's payment ids), tenant-scoped by
// `user_id` — the sync ledger is keyed per user, so a payment id that
// collides across tenants must never surface another user's row.
export const LIST_SYNCS_FOR_PAYMENT_IDS_SQL = `SELECT provider, payment_id, status, external_ref, error
     FROM accounting_feed_syncs
     WHERE user_id = $1 AND payment_id = ANY($2)`

/**
 * Atomically claim a payment for pushing. The concurrency guard is the unique
 * constraint: the first caller inserts a `pending` row and owns the push; a
 * concurrent caller hits the conflict and does not. A previously `failed` row
 * is re-claimable for retry. A `pushed` row is never re-claimed. (Recovering
 * a stuck in-flight `pending` is NOT done here, to keep the live concurrency
 * guard intact — the retry sweep (#2866) releases one via
 * `releaseStalePending` after `STALE_PENDING_CLAIM_MS`, and only then does
 * this re-claim take it.)
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

/** The projection the Transactions badge (#2870) needs — nothing more. */
export type FeedSyncBadgeRow = Pick<
  FeedSyncRow,
  'provider' | 'payment_id' | 'status' | 'external_ref' | 'error'
>

/**
 * Sync rows for a page of payment ids, in one round trip (#2870). Returns
 * only rows that exist — a payment with no sync row is simply absent, which
 * the caller renders as "no badge" (it predates `feed_from`, or was never
 * fed). An empty `paymentIds` short-circuits without touching the pool.
 */
export async function listSyncsForPaymentIds(
  userId: string,
  paymentIds: string[],
  db: Executor = pool,
): Promise<FeedSyncBadgeRow[]> {
  if (paymentIds.length === 0) return []
  const result = await db.query<FeedSyncBadgeRow>(LIST_SYNCS_FOR_PAYMENT_IDS_SQL, [
    userId,
    paymentIds,
  ])
  return result.rows
}

// ── Backfill selection (moved from modules/accounting/feed-orchestrator.ts, #999)

export const LIST_UNPUSHED_PAYMENT_IDS_SQL = `SELECT COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) AS payment_id
     FROM machine_payment_evidence mpe
     LEFT JOIN accounting_feed_syncs s
       ON s.user_id = mpe.user_id AND s.provider = $2
      AND s.payment_id = COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT)
      AND s.status = 'pushed'
     WHERE mpe.user_id = $1 AND (mpe.amount_sek IS NOT NULL OR mpe.fx_rates IS NOT NULL) AND s.id IS NULL
       AND ($4::timestamptz IS NULL OR COALESCE(mpe.confirmed_at, mpe.created_at) >= $4::timestamptz)
     ORDER BY COALESCE(mpe.confirmed_at, mpe.created_at) DESC
     LIMIT $3`

/**
 * Settled, FX-ready payment ids for the user with no `pushed` sync row yet.
 * `feedFrom` (#2862) is the active destination's floor: nothing settled
 * before it is enumerated. Null = no floor (the pre-#2862 selection).
 *
 * "FX-ready" is a capture in EITHER form since #2877: `amount_sek` for a SEK
 * ledger, or a rate map for any other. `amount_sek IS NOT NULL` alone was the
 * whole test while SEK was the only thing the feed pushed; once a capture can
 * succeed for EUR and fail for SEK — the price source quotes per currency, and
 * `getBookTimeCapture` returns exactly that — the narrow test silently omitted
 * a row a EUR ledger could be fed from, permanently: this statement is the
 * only path by which a never-fed payment reaches a connector, so an omission
 * here is not a delay, it is a payment that is never fed at all. Found by
 * review (#2877), which followed the same per-currency-failure argument the
 * capture freeze rests on one step further than the freeze did.
 */
export async function listUnpushedPaymentIds(
  userId: string,
  provider: string,
  limit: number,
  feedFrom: Date | null = null,
  db: Executor = pool,
): Promise<string[]> {
  const result = await db.query<{ payment_id: string | null }>(LIST_UNPUSHED_PAYMENT_IDS_SQL, [
    userId,
    provider,
    limit,
    feedFrom,
  ])
  return result.rows.map((r) => r.payment_id).filter((id): id is string => Boolean(id))
}

// ── Retry sweep selection (#2866, epic #2858) ─────────────────────────────────
//
// Backoff is DERIVED from the columns the ledger already has — `attempts` and
// `updated_at` — so the sweep needed no migration. A row is due when
// `updated_at + backoff(attempts)` has passed, where
// backoff(n) = min(base · 2^(n−1), cap): base 1 min, cap 1 h, so a row waits
// 1, 2, 4, 8, 16, 32, 60 min between its attempts and is exhausted at the
// eighth. Every constant is a parameter of the statement so the sweep, the
// status counts and the real-database test read ONE definition.

/** Attempts after which the sweep stops retrying a row (#2866). */
export const RETRY_MAX_ATTEMPTS = 8
/** First backoff step (attempts = 1). */
export const RETRY_BACKOFF_BASE_MS = 60_000
/** The longest a row waits between attempts. */
export const RETRY_BACKOFF_CAP_MS = 60 * 60_000
/**
 * A `pending` row older than this is a claim whose owner died mid-push (the
 * claim IS the concurrency guard, so nothing else releases it). Longer than
 * any single push can take: every Fortnox API call carries an AbortSignal
 * (15 s per JSON request, 60 s for the inbox upload —
 * `FORTNOX_REQUEST_TIMEOUT_MS` / `FORTNOX_UPLOAD_TIMEOUT_MS`) and a push is
 * at most six sequential requests, so a live owner is never older than a
 * few minutes. Releasing a claim whose owner is still alive would let two
 * pushes race — which is why this margin is large, not tight.
 */
export const STALE_PENDING_CLAIM_MS = 15 * 60_000

/** Backoff for a row with `attempts` attempts, in ms — the SQL below, in TypeScript. */
export function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (Math.max(attempts, 1) - 1), RETRY_BACKOFF_CAP_MS)
}

/** What the sweep needs per due row — no `error`/`external_ref` payloads. */
export type DueRetryRow = Pick<FeedSyncRow, 'id' | 'user_id' | 'provider' | 'payment_id' | 'status' | 'attempts'>

/**
 * Rows the sweep may touch, oldest first, grouped by connection. The JOIN
 * is the state gate: only a row whose connection is `connected` AND the
 * user's active destination is enumerated, so a row `skipped` for
 * `connection needs_reauthorisation` (#2863) — or one behind a
 * `scope_missing`/`disconnected` row — is left alone until the cause is
 * gone and the row is `connected` again. FX-not-ready rows carry no state
 * here (the orchestrator no-ops before claiming), so they are due like any
 * other row.
 *
 *   $1 now            the sweep's clock (injectable, so a test never sleeps)
 *   $2 max attempts   RETRY_MAX_ATTEMPTS — the cap, rows at it are never due
 *   $3 base ms / $4 cap ms   the backoff curve
 *   $5 stale claim ms a `pending` row older than this is due (released first)
 *   $6 limit
 *
 * MUTATION TARGETS (accounting-feed-syncs.test.ts): `c.status = 'connected'`
 * (the needs_reauthorisation test), `s.attempts < $2` (the cap test), the
 * backoff predicate (the "not before" test).
 *
 * #2867: a connection with `settings.auto_feed = false` is "manual only" —
 * the user asked that nothing be pushed unless they press Sync now, and the
 * sweep follows the settlement hook's semantics, not the button's. Its rows
 * are not enumerated at all (the same shape as a state-skipped row: they
 * wait until the cause is gone), so a tick never spends its batch on rows
 * it may not push. Absent key = true.
 */
export const LIST_DUE_RETRY_SYNCS_SQL = `SELECT s.id, s.user_id, s.provider, s.payment_id, s.status, s.attempts
     FROM accounting_feed_syncs s
     JOIN accounting_connections c ON c.user_id = s.user_id AND c.provider = s.provider
     WHERE c.status = 'connected' AND c.is_active_destination
       AND (c.settings -> 'auto_feed') IS DISTINCT FROM 'false'::jsonb
       AND s.attempts < $2::int
       AND (
         (s.status IN ('failed', 'skipped')
            AND s.updated_at + LEAST($3::float8 * power(2, LEAST(GREATEST(s.attempts, 1) - 1, 30)), $4::float8) * interval '1 millisecond' <= $1::timestamptz)
         OR (s.status = 'pending' AND s.updated_at + $5::float8 * interval '1 millisecond' <= $1::timestamptz)
       )
     ORDER BY s.user_id, s.provider, s.updated_at ASC, s.id ASC
     LIMIT $6`

/**
 * Release a stale in-flight claim so the normal re-claim can take it: the
 * row flips `pending → failed` WITHOUT touching `attempts` (the attempt was
 * the claim's; the release is bookkeeping). Guarded on the row still being
 * `pending` and still older than the timeout at `$2`, so a push that
 * completed between the selection and this statement is never undone.
 */
/**
 * The sweep's terminal write (#2866): only a row that is STILL failed/skipped
 * and at the attempt cap takes the `exhausted:` reason. Unlike MARK_SYNC_FAILED_SQL
 * this never flips a row a manual sync re-claimed (pending) or pushed in the
 * meantime — review on #2899.
 */
export const MARK_SYNC_EXHAUSTED_SQL = `UPDATE accounting_feed_syncs
     SET error = $4, updated_at = NOW()
     WHERE provider = $2 AND payment_id = $3 AND user_id = $1
       AND status IN ('failed', 'skipped') AND attempts >= $5::int
     RETURNING id`

export const RELEASE_STALE_PENDING_SQL = `UPDATE accounting_feed_syncs
     SET status = 'failed', error = $4, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
       AND updated_at + $3::float8 * interval '1 millisecond' <= $2::timestamptz
     RETURNING id`

/**
 * The three numbers the dashboard shows next to the sync list (#2866):
 * in-flight, retryable, and given up. `exhausted` is keyed on the SAME
 * predicate the sweep uses (`attempts >= cap`), not on the reason prefix,
 * so a row a manual "Sync now" pushed past the cap counts the same way.
 */
export const COUNT_SYNCS_FOR_USER_SQL = `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'failed' AND attempts < $2::int)::int AS failed,
       COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= $2::int)::int AS exhausted
     FROM accounting_feed_syncs
     WHERE user_id = $1`

export interface FeedSyncCounts {
  pending: number
  failed: number
  exhausted: number
}

export async function listDueRetrySyncs(
  now: Date,
  limit: number,
  db: Executor = pool,
): Promise<DueRetryRow[]> {
  const result = await db.query<DueRetryRow>(LIST_DUE_RETRY_SYNCS_SQL, [
    now,
    RETRY_MAX_ATTEMPTS,
    RETRY_BACKOFF_BASE_MS,
    RETRY_BACKOFF_CAP_MS,
    STALE_PENDING_CLAIM_MS,
    limit,
  ])
  return result.rows
}

/** True when the row was released (it was still a stale `pending`). */
/** See MARK_SYNC_EXHAUSTED_SQL. Returns true when the row took the terminal reason. */
export async function markExhausted(
  userId: string,
  provider: string,
  paymentId: string,
  error: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(MARK_SYNC_EXHAUSTED_SQL, [userId, provider, paymentId, error.slice(0, 1000), RETRY_MAX_ATTEMPTS])
  return (result.rowCount ?? 0) === 1
}

export async function releaseStalePending(
  id: string,
  now: Date,
  reason: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(RELEASE_STALE_PENDING_SQL, [id, now, STALE_PENDING_CLAIM_MS, reason.slice(0, 1000)])
  return result.rows.length > 0
}

export async function countSyncsForUser(userId: string, db: Executor = pool): Promise<FeedSyncCounts> {
  const result = await db.query<FeedSyncCounts>(COUNT_SYNCS_FOR_USER_SQL, [userId, RETRY_MAX_ATTEMPTS])
  const row = result.rows[0]
  return { pending: row?.pending ?? 0, failed: row?.failed ?? 0, exhausted: row?.exhausted ?? 0 }
}
