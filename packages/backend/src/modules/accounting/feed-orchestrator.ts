import { listUnpushedPaymentIds, countSyncsForUser, type FeedSyncCounts } from '../../infra/repositories/accounting-feed-syncs.js'
import { connectionSettings, getActiveConnection, listConnections, type ConnectionSettings } from '../../infra/repositories/accounting-connections.js'
import { flagConnectionStatus } from './ops-signals.js'
import { accountingFeedAvailable } from '../agents/index.js'
import { buildAccountingEntryForPayment } from './entry.js'
import { toFeedTransaction } from './feed-transaction.js'
import { getConnector, listConnectors, type AccountingConnector, type DegradedConnectionStatus } from './connector.js'
import { isTokenDeadStatus } from './oauth-flow.js'
import { missingScopesReason } from './provider.js'
import { claimSync, markPushed, markFailed, markSkipped, listSyncs, type FeedSyncRow } from './feed-sync.js'

/**
 * Sync orchestration for the reporting feed (epic #491, P2 #499).
 *
 * Wires settled payments through the feed: gate → resolve connector → build the
 * non-asserting transaction → claim (dedup) → push → record. Best-effort and
 * idempotent; settlement is never blocked or delayed by it.
 */

/**
 * Feed nothing settled before `feedFrom` (#2862 feed-from rule); null = no
 * floor. `settings` (#2867) is the row's user settings — `autoFeed` gates the
 * automatic paths, `suggestedAccount` is the hint the connector may surface.
 */
type ActiveDestination =
  | { kind: 'ready'; provider: string; connector: AccountingConnector; feedFrom: Date | null; settings: ConnectionSettings }
  /**
   * #2863: the active row's grant is dead (`needs_reauthorisation`,
   * `revoked_at_provider`). Nothing is pushed and nothing is refreshed; each
   * payment that would have been fed gets a `skipped` row naming the state,
   * re-claimable once the user re-consents.
   */
  | { kind: 'degraded'; provider: string; status: DegradedConnectionStatus; reason: string | null; feedFrom: Date | null; settings: ConnectionSettings }

/** A user with no row at all (the registry-scan fallback) has no settings: the defaults. */
const DEFAULT_SETTINGS: ConnectionSettings = { suggestedAccount: null, autoFeed: true }

/**
 * The user's active destination (#2862): the `accounting_connections` row
 * flagged `is_active_destination` names the provider, and the connector
 * registry supplies the instance. Returns null when the row's connector is
 * not registered on this deployment or reports the user as not connected.
 *
 * A user who has ANY `accounting_connections` row is row-backed: without an
 * active `connected` row there is no destination, full stop — a row demoted
 * to `scope_missing`/`needs_reauthorization` must not keep feeding through a
 * connector whose `isConnected` only checks for secrets (review on #2894:
 * that fallback bypassed the feed-from floor while every user-facing surface
 * said "not connected"). Only a user with NO row at all — a connector that
 * keeps its own connection state, which today is only the in-memory test
 * connector — falls back to the first registered connector that reports the
 * user connected, as before #2862, with no feed-from floor.
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
    return {
      kind: 'ready',
      provider: active.provider,
      connector,
      feedFrom: active.feed_from ? new Date(active.feed_from) : null,
      settings: connectionSettings(active),
    }
  }
  // MUTATION TARGET (feed-from.db.test.ts "a degraded active row feeds
  // nothing"): removing this guard re-opens the registry scan for row-backed
  // users.
  const rows = await listConnections(userId)
  if (rows.length > 0) {
    // #2863: an active row whose grant is dead is still THE destination —
    // the sync is recorded as skipped with the state, not silently dropped.
    // (`scope_missing` keeps #2862's shape: no destination, no rows.)
    for (const r of rows) {
      if (r.is_active_destination && isTokenDeadStatus(r.status)) {
        return {
          kind: 'degraded',
          provider: r.provider,
          status: r.status,
          reason: r.status_reason,
          feedFrom: r.feed_from ? new Date(r.feed_from) : null,
          settings: connectionSettings(r),
        }
      }
    }
    return null
  }
  for (const connector of listConnectors()) {
    if (await connector.isConnected(userId)) return { kind: 'ready', provider: connector.provider, connector, feedFrom: null, settings: DEFAULT_SETTINGS }
  }
  return null
}

/**
 * The connection's `status_reason` for a push-time grant finding: the
 * scopes the connector named (if any) in the parseable shape the dashboard
 * reads (`missingScopesReason`), then the connector's note or reason.
 */
function degradedReason(result: { note?: string; reason?: string; missingScopes?: string[] }): string {
  return missingScopesReason(result.missingScopes ?? [], result.note ?? result.reason ?? 'refused by the provider')
}

/** The `skipped` reason for a dead grant: the state first, so an on-call grep finds it. */
export function degradedSkipReason(status: DegradedConnectionStatus, reason: string | null): string {
  return `connection ${status}${reason ? `: ${reason}` : ''}`
}

/**
 * What one `feedSettledPayment` call did — read by the retry sweep (#2866),
 * ignored by the settlement hook and the backfill. `not_fed` means no claim
 * was taken and no attempt consumed (feed unavailable, no destination, FX not
 * ready, before the feed-from floor, or the row is owned elsewhere). `failed`
 * carries the thrown error so the sweep can tell a provider 429 from
 * anything else; the ledger row already holds its message.
 */
export type FeedOutcome =
  | { outcome: 'pushed' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string; error?: unknown }
  | { outcome: 'not_fed' }

/**
 * How a feed call was triggered (#2867). `manual` is the user's own action
 * — "Sync now" (`syncUser`) and the backfill — and is the only trigger that
 * pushes for a connection whose `auto_feed` setting is false. Everything
 * else (the settlement hook, the retry sweep, a caller that says nothing) is
 * automatic and is gated by it.
 */
export interface FeedOptions {
  manual?: boolean
}

/** Feed one settled payment. No-op unless the feed is available + a connector is connected. */
export async function feedSettledPayment(userId: string, paymentId: string, opts: FeedOptions = {}): Promise<FeedOutcome> {
  const notFed: FeedOutcome = { outcome: 'not_fed' }
  if (!(await accountingFeedAvailable(userId))) return notFed
  const destination = await getActiveDestination(userId)
  if (!destination) return notFed
  const { provider, feedFrom } = destination

  // #2867 auto_feed=false: the user asked for manual only. An automatic
  // trigger stops HERE — before the entry is built, before any claim row —
  // so the payment stays unclaimed for the Sync now / backfill that will
  // feed it. MUTATION TARGET (backfill-and-settings.db.test.ts "auto_feed
  // false: the settlement hook is a no-op"): drop this return and the hook
  // pushes for a manual-only user.
  if (!opts.manual && !destination.settings.autoFeed) return notFed

  const entry = await buildAccountingEntryForPayment(userId, paymentId)
  if (!entry) return notFed
  const tx = toFeedTransaction(entry, { connectionSuggestedAccount: destination.settings.suggestedAccount })
  // Not ready: no book-time SEK yet. Don't feed an amount-less transaction —
  // backfill/retry picks it up once the FX is captured.
  if (tx.amountSek == null) return notFed
  // Settled before the destination was activated: history stays where it
  // was booked. No claim row either — the backfill (#2867) must be able to
  // feed it later on the user's explicit choice.
  if (feedFrom && new Date(tx.settledAt).getTime() < feedFrom.getTime()) return notFed

  const claim = await claimSync(userId, provider, paymentId)
  if (!claim.owned) return notFed // already pushed or another caller owns it

  // MUTATION TARGET (fortnox-connection.db.test.ts, "invalid_grant"): a dead
  // grant is never pushed against — that would be the retried refresh.
  if (destination.kind === 'degraded') {
    const reason = degradedSkipReason(destination.status, destination.reason)
    await markSkipped(userId, provider, paymentId, reason)
    return { outcome: 'skipped', reason }
  }
  const { connector } = destination

  try {
    const result = await connector.pushTransaction(userId, tx)
    if (result.status === 'pushed') {
      await markPushed(userId, connector.provider, paymentId, result.externalRef, result.note ?? null)
      // #2862/#2865 POST-push: a finding about the GRANT (the attachment step
      // lacked a scope) flips the CONNECTION's status so the dashboard can ask
      // for a re-consent. The sync row above stays pushed — never `skipped`,
      // never re-pushable: the record exists, and the retry sweep (#2866)
      // re-feeds skipped rows after a reconnect, which would double-post.
      // MUTATION TARGET (scope-missing.db.test.ts "exactly one POST"): marking
      // the row skipped here makes the sweep create a second invoice.
      if (result.connectionStatus) {
        await flagConnectionStatus(userId, connector.provider, result.connectionStatus, degradedReason(result))
      }
      return { outcome: 'pushed' }
    } else if (result.status === 'skipped') {
      // #1365: a connector skip used to be recorded via markPushed — ledger
      // status 'pushed' with NULL external_ref and the reason DROPPED. The
      // dashboard then showed "Synced" for a payment never delivered, and the
      // backfill (which excludes pushed rows) never revisited it, so a
      // transient skip (e.g. a disconnect race between connector selection
      // and push) was permanently lost. Now the row is a real 'skipped' with
      // its reason preserved, and skipped rows are re-claimable exactly like
      // failed ones.
      const reason = result.reason ?? 'skipped'
      await markSkipped(userId, connector.provider, paymentId, reason)
      // #2865 PRE-push: the create call itself was refused for scope —
      // nothing exists at the provider, so the row is a real `skipped`
      // (re-claimable once the user re-consents) AND the connection flips,
      // so no further payment is attempted until then.
      // MUTATION TARGET (scope-missing.db.test.ts "pre-push"): without this
      // flip the connection stays connected and the sweep retries the refusal.
      if (result.connectionStatus) {
        await flagConnectionStatus(userId, connector.provider, result.connectionStatus, degradedReason(result))
      }
      return { outcome: 'skipped', reason }
    } else {
      const reason = result.reason ?? 'push_failed'
      await markFailed(userId, connector.provider, paymentId, reason)
      return { outcome: 'failed', reason }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await markFailed(userId, connector.provider, paymentId, reason)
    return { outcome: 'failed', reason, error: err }
  }
}

/**
 * Settlement hook — fire-and-forget so the feed never blocks or delays
 * settlement. Idempotent, so a cut-off mid-push is recovered by the next sync.
 * An automatic trigger: a connection with `auto_feed = false` (#2867) makes
 * it a no-op for that user (the gate is in `feedSettledPayment`).
 */
export function feedSettledPaymentBestEffort(userId: string, paymentId: string): void {
  void feedSettledPayment(userId, paymentId, { manual: false }).catch(() => {})
}

/**
 * Backfill / retry — feed every settled, FX-ready payment that hasn't been
 * pushed yet (covers connect-time backfill and retry of failed/never-attempted).
 * Idempotent and resumable via the dedup ledger. This is the user's own
 * action ("Sync now", the #2867 backfill), so it feeds with `manual: true`
 * — an `auto_feed = false` connection still pushes here.
 */
export async function syncUser(userId: string, opts: { limit?: number } = {}): Promise<{ fed: number }> {
  if (!(await accountingFeedAvailable(userId))) return { fed: 0 }
  const destination = await getActiveDestination(userId)
  if (!destination) return { fed: 0 }

  // Selection SQL lives in infra/repositories/accounting-feed-syncs.ts (#999);
  // the feed-from floor (#2862) is applied there so history is never even
  // enumerated for a freshly activated destination.
  const ids = await listUnpushedPaymentIds(userId, destination.provider, opts.limit ?? 200, destination.feedFrom)
  for (const id of ids) await feedSettledPayment(userId, id, { manual: true })
  return { fed: ids.length }
}

/** Per-user sync status for the Reporting UI (#500). */
export async function getAccountingFeedStatus(userId: string): Promise<FeedSyncRow[]> {
  return listSyncs(userId)
}

/** The pending / failed / exhausted numbers next to that list (#2866). */
export async function getAccountingFeedCounts(userId: string): Promise<FeedSyncCounts> {
  return countSyncsForUser(userId)
}
