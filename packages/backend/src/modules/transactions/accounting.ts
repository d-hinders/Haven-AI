/**
 * Per-page accounting-feed enrichment for the Transactions list (#2870,
 * epic #2858 slice 12).
 *
 * Joins the sync ledger (`accounting_feed_syncs`, keyed on the payment-intent
 * id the row already carries as `paymentId`) onto a PAGE of transactions in
 * one query, so the dashboard can show "In Fortnox" / "Feeding…" / "Not fed"
 * where the user already looks. Read-only: no provider call, no write.
 *
 * The key is present ONLY when all three hold — the feed is available to the
 * account (`accountingFeedAvailable`: hosted + flag + entitlement), the user
 * has an ACTIVE provider connection (`hasActiveConnection`, #2862), and a sync row exists for that payment id.
 * Otherwise the key is ABSENT, never null: an unentitled or disconnected
 * account must not learn that the ledger exists, and a fed account's rows
 * that predate `feed_from` legitimately carry nothing.
 *
 * `booked` (the issue's optional fourth field) is deliberately not emitted:
 * the ledger stores no verify result — `/accounting/feed/verify/:paymentId`
 * is a live read-back that is never persisted — so there is nothing truthful
 * to join. The issue allows omitting it.
 */
import { accountingFeedAvailable } from '../agents/index.js'
import { hasActiveConnection } from '../accounting/index.js'
import {
  listSyncsForPaymentIds,
  type FeedSyncBadgeRow,
} from '../../infra/repositories/accounting-feed-syncs.js'
import type { FastifyBaseLogger } from 'fastify'
import type { Transaction, TransactionAccounting } from './types.js'

/** Wire shape from a ledger row — the projection, camel-cased. */
function toAccounting(row: FeedSyncBadgeRow): TransactionAccounting {
  return {
    provider: row.provider,
    status: row.status,
    externalRef: row.external_ref,
    error: row.error,
  }
}

/**
 * Attach `accounting` to every row on the page that has a sync row. Runs at
 * most ONE ledger query per call, and none at all when the page carries no
 * payment ids or the account is not entitled/connected.
 */
export async function enrichTransactionsWithAccounting<T extends Transaction>(
  userId: string,
  transactions: T[],
  log?: FastifyBaseLogger,
): Promise<T[]> {
  const paymentIds = Array.from(
    new Set(transactions.map((tx) => tx.paymentId).filter((id): id is string => Boolean(id))),
  )
  if (paymentIds.length === 0) return transactions

  let rows: FeedSyncBadgeRow[]
  try {
    // Gate BEFORE the connection read and the ledger read: an unentitled
    // account never touches either (mutation-tested at the route).
    if (!(await accountingFeedAvailable(userId))) return transactions
    if (!(await hasActiveConnection(userId))) return transactions

    rows = await listSyncsForPaymentIds(userId, paymentIds)
  } catch (err) {
    // Fail-soft, the same trade `enrichTransactionsWithAgents` makes: a
    // ledger or entitlement read failing must not take the money history
    // down with it. The rows come back WITHOUT `accounting`, which the UI
    // renders as no badge — never as a false "In Fortnox" or "Not fed".
    // Logged (review on #2893): a badge outage must be visible somewhere.
    log?.warn({ err, userId, paymentIds: paymentIds.length }, 'accounting badge enrichment failed; rows served without accounting')
    return transactions
  }
  if (rows.length === 0) return transactions

  // One badge per payment. The ledger is unique on (provider, payment_id,
  // user_id), so two rows for one payment means two providers; a `pushed`
  // row wins because it is the one the user can act on in the provider.
  const byPaymentId = new Map<string, FeedSyncBadgeRow>()
  for (const row of rows) {
    const existing = byPaymentId.get(row.payment_id)
    if (!existing || (existing.status !== 'pushed' && row.status === 'pushed')) {
      byPaymentId.set(row.payment_id, row)
    }
  }

  return transactions.map((tx) => {
    const row = tx.paymentId ? byPaymentId.get(tx.paymentId) : undefined
    return row ? { ...tx, accounting: toAccounting(row) } : tx
  })
}
