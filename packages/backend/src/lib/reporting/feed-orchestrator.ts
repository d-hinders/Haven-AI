import pool from '../../db.js'
import { reportingFeedAvailable } from '../entitlements.js'
import { buildAccountingEntryForPayment } from '../accounting-entry.js'
import { toReportingTransaction } from './reporting-transaction.js'
import { listConnectors, type AccountingConnector } from './connector.js'
import { claimSync, markPushed, markFailed, listSyncs, type FeedSyncRow } from './feed-sync.js'

/**
 * Sync orchestration for the reporting feed (epic #491, P2 #499).
 *
 * Wires settled payments through the feed: gate → resolve connector → build the
 * non-asserting transaction → claim (dedup) → push → record. Best-effort and
 * idempotent; settlement is never blocked or delayed by it.
 */

/**
 * The user's active connector = the first registered one they're connected to.
 *
 * Returns null in production today: no live connector is registered yet (the
 * Fortnox adapter #496/#498 is deferred — see `connector.ts` and
 * `docs/research/fortnox-non-asserting-feed.md`). So auto-feed and backfill are
 * inert no-ops until that follow-up lands; the surrounding machinery is fully
 * built and tested against the in-memory connector.
 */
async function getActiveConnector(userId: string): Promise<AccountingConnector | null> {
  for (const connector of listConnectors()) {
    if (await connector.isConnected(userId)) return connector
  }
  return null
}

/** Feed one settled payment. No-op unless the feed is available + a connector is connected. */
export async function feedSettledPayment(userId: string, paymentId: string): Promise<void> {
  if (!(await reportingFeedAvailable(userId))) return
  const connector = await getActiveConnector(userId)
  if (!connector) return

  const entry = await buildAccountingEntryForPayment(userId, paymentId)
  if (!entry) return
  const tx = toReportingTransaction(entry)
  // Not ready: no book-time SEK yet. Don't feed an amount-less transaction —
  // backfill/retry picks it up once the FX is captured.
  if (tx.amountSek == null) return

  const claim = await claimSync(userId, connector.provider, paymentId)
  if (!claim.owned) return // already pushed or another caller owns it

  try {
    const result = await connector.pushTransaction(userId, tx)
    if (result.status === 'pushed' || result.status === 'skipped') {
      await markPushed(userId, connector.provider, paymentId, result.externalRef)
    } else {
      await markFailed(userId, connector.provider, paymentId, result.reason ?? 'push_failed')
    }
  } catch (err) {
    await markFailed(userId, connector.provider, paymentId, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Settlement hook — fire-and-forget so the feed never blocks or delays
 * settlement. Idempotent, so a cut-off mid-push is recovered by the next sync.
 */
export function feedSettledPaymentBestEffort(userId: string, paymentId: string): void {
  void feedSettledPayment(userId, paymentId).catch(() => {})
}

/**
 * Backfill / retry — feed every settled, FX-ready payment that hasn't been
 * pushed yet (covers connect-time backfill and retry of failed/never-attempted).
 * Idempotent and resumable via the dedup ledger.
 */
export async function syncUser(userId: string, opts: { limit?: number } = {}): Promise<{ fed: number }> {
  if (!(await reportingFeedAvailable(userId))) return { fed: 0 }
  const connector = await getActiveConnector(userId)
  if (!connector) return { fed: 0 }

  const ids = await listUnpushedPaymentIds(userId, connector.provider, opts.limit ?? 200)
  for (const id of ids) await feedSettledPayment(userId, id)
  return { fed: ids.length }
}

/** Settled, FX-ready payment ids for the user with no `pushed` sync row yet. */
async function listUnpushedPaymentIds(
  userId: string,
  provider: string,
  limit: number,
): Promise<string[]> {
  const result = await pool.query<{ payment_id: string | null }>(
    `SELECT COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) AS payment_id
     FROM machine_payment_evidence mpe
     LEFT JOIN reporting_feed_syncs s
       ON s.user_id = mpe.user_id AND s.provider = $2
      AND s.payment_id = COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT)
      AND s.status = 'pushed'
     WHERE mpe.user_id = $1 AND mpe.amount_sek IS NOT NULL AND s.id IS NULL
     ORDER BY COALESCE(mpe.confirmed_at, mpe.created_at) DESC
     LIMIT $3`,
    [userId, provider, limit],
  )
  return result.rows.map((r) => r.payment_id).filter((id): id is string => Boolean(id))
}

/** Per-user sync status for the Reporting UI (#500). */
export async function getReportingStatus(userId: string): Promise<FeedSyncRow[]> {
  return listSyncs(userId)
}
