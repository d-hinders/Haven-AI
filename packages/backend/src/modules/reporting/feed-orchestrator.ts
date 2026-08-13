import { listUnpushedPaymentIds } from '../../infra/repositories/reporting-feed-syncs.js'
import { reportingFeedAvailable } from '../agents/index.js'
import { buildAccountingEntryForPayment } from '../accounting/index.js'
import { toReportingTransaction } from './reporting-transaction.js'
import { listConnectors, type AccountingConnector } from './connector.js'
import { claimSync, markPushed, markFailed, markSkipped, listSyncs, type FeedSyncRow } from './feed-sync.js'

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
 * The live Fortnox adapter (#496/#498/#956) IS registered at startup when
 * Fortnox is configured (`registerConnector` in `src/index.ts`), so auto-feed
 * and backfill deliver for real — live-proven against a Fortnox sandbox
 * 2026-07-16/18. Returns null only when the user has no connected provider.
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
    if (result.status === 'pushed') {
      await markPushed(userId, connector.provider, paymentId, result.externalRef, result.note ?? null)
    } else if (result.status === 'skipped') {
      // #1365: a connector skip used to be recorded via markPushed — ledger
      // status 'pushed' with NULL external_ref and the reason DROPPED. The
      // dashboard then showed "Synced" for a payment never delivered, and the
      // backfill (which excludes pushed rows) never revisited it, so a
      // transient skip (e.g. a disconnect race between connector selection
      // and push) was permanently lost. Now the row is a real 'skipped' with
      // its reason preserved, and skipped rows are re-claimable exactly like
      // failed ones.
      await markSkipped(userId, connector.provider, paymentId, result.reason ?? 'skipped')
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

  // Selection SQL lives in infra/repositories/reporting-feed-syncs.ts (#999).
  const ids = await listUnpushedPaymentIds(userId, connector.provider, opts.limit ?? 200)
  for (const id of ids) await feedSettledPayment(userId, id)
  return { fed: ids.length }
}

/** Per-user sync status for the Reporting UI (#500). */
export async function getReportingStatus(userId: string): Promise<FeedSyncRow[]> {
  return listSyncs(userId)
}
