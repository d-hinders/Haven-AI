import { listUnpushedPaymentIds } from '../../infra/repositories/accounting-feed-syncs.js'
import { getActiveConnection, setStatus } from '../../infra/repositories/accounting-connections.js'
import { accountingFeedAvailable } from '../agents/index.js'
import { buildAccountingEntryForPayment } from './entry.js'
import { toFeedTransaction } from './feed-transaction.js'
import { getConnector, listConnectors, type AccountingConnector } from './connector.js'
import { claimSync, markPushed, markFailed, markSkipped, listSyncs, type FeedSyncRow } from './feed-sync.js'

/**
 * Sync orchestration for the reporting feed (epic #491, P2 #499).
 *
 * Wires settled payments through the feed: gate → resolve connector → build the
 * non-asserting transaction → claim (dedup) → push → record. Best-effort and
 * idempotent; settlement is never blocked or delayed by it.
 */

interface ActiveDestination {
  connector: AccountingConnector
  /** Feed nothing settled before this (#2862 feed-from rule); null = no floor. */
  feedFrom: Date | null
}

/**
 * The user's active destination (#2862): the `accounting_connections` row
 * flagged `is_active_destination` names the provider, and the connector
 * registry supplies the instance. Returns null when the row's connector is
 * not registered on this deployment or reports the user as not connected.
 *
 * Without an active row — a connector that keeps its own connection state,
 * which today is only the in-memory test connector — the first registered
 * connector that reports the user connected is used, as before #2862, with
 * no feed-from floor.
 *
 * The live Fortnox adapter (#496/#498/#956) IS registered at startup when
 * Fortnox is configured (`registerConnector` in `src/index.ts`), so auto-feed
 * and backfill deliver for real — live-proven against a Fortnox sandbox
 * 2026-07-16/18.
 */
async function getActiveDestination(userId: string): Promise<ActiveDestination | null> {
  const active = await getActiveConnection(userId)
  if (active) {
    const connector = getConnector(active.provider)
    if (!connector || !(await connector.isConnected(userId))) return null
    return { connector, feedFrom: active.feed_from ? new Date(active.feed_from) : null }
  }
  for (const connector of listConnectors()) {
    if (await connector.isConnected(userId)) return { connector, feedFrom: null }
  }
  return null
}

/** Feed one settled payment. No-op unless the feed is available + a connector is connected. */
export async function feedSettledPayment(userId: string, paymentId: string): Promise<void> {
  if (!(await accountingFeedAvailable(userId))) return
  const destination = await getActiveDestination(userId)
  if (!destination) return
  const { connector, feedFrom } = destination

  const entry = await buildAccountingEntryForPayment(userId, paymentId)
  if (!entry) return
  const tx = toFeedTransaction(entry)
  // Not ready: no book-time SEK yet. Don't feed an amount-less transaction —
  // backfill/retry picks it up once the FX is captured.
  if (tx.amountSek == null) return
  // Settled before the destination was activated: history stays where it
  // was booked. No claim row either — the backfill (#2867) must be able to
  // feed it later on the user's explicit choice.
  if (feedFrom && new Date(tx.settledAt).getTime() < feedFrom.getTime()) return

  const claim = await claimSync(userId, connector.provider, paymentId)
  if (!claim.owned) return // already pushed or another caller owns it

  try {
    const result = await connector.pushTransaction(userId, tx)
    if (result.status === 'pushed') {
      await markPushed(userId, connector.provider, paymentId, result.externalRef, result.note ?? null)
      // #2862: a post-push finding about the GRANT (e.g. the attachment step
      // lacked a scope) flips the CONNECTION's status so the dashboard can ask
      // for a re-consent. The sync row above stays pushed — never re-pushable.
      if (result.connectionStatus) {
        await setStatus(userId, connector.provider, result.connectionStatus, result.note ?? null)
      }
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
  if (!(await accountingFeedAvailable(userId))) return { fed: 0 }
  const destination = await getActiveDestination(userId)
  if (!destination) return { fed: 0 }

  // Selection SQL lives in infra/repositories/accounting-feed-syncs.ts (#999);
  // the feed-from floor (#2862) is applied there so history is never even
  // enumerated for a freshly activated destination.
  const ids = await listUnpushedPaymentIds(userId, destination.connector.provider, opts.limit ?? 200, destination.feedFrom)
  for (const id of ids) await feedSettledPayment(userId, id)
  return { fed: ids.length }
}

/** Per-user sync status for the Reporting UI (#500). */
export async function getAccountingFeedStatus(userId: string): Promise<FeedSyncRow[]> {
  return listSyncs(userId)
}
