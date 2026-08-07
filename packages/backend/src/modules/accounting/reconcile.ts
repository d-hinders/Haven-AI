import type { AccountingEntry } from './accounting-entry.js'
import { buildBookingLines } from './booking.js'

/**
 * Reconciliation of accounting entries (epic #462, P3 #466).
 *
 * Surfaces entries that can't yet be booked cleanly so the user (their
 * accountant) can act before filing — rather than silently dropping them.
 * Pure over already-built entries; the endpoint wraps it with the period query.
 */
export type ReconcileStatus = 'ok' | 'missing_fx' | 'missing_tx' | 'unbalanced'

export interface ReconcileItem {
  paymentId: string
  txHash: string
  settledAt: string
  status: ReconcileStatus
}

export interface ReconcileReport {
  total: number
  ok: number
  issues: number
  byStatus: Record<ReconcileStatus, number>
  items: ReconcileItem[]
}

function classify(entry: AccountingEntry): ReconcileStatus {
  if (entry.amountSek == null) return 'missing_fx'
  if (!entry.txHash) return 'missing_tx'
  const lines = buildBookingLines(entry)
  if (!lines) return 'missing_fx'
  const debit = lines.reduce((s, l) => s + l.debit, 0)
  const credit = lines.reduce((s, l) => s + l.credit, 0)
  // Tolerate sub-öre float noise.
  if (Math.abs(debit - credit) > 0.005) return 'unbalanced'
  return 'ok'
}

export function reconcileEntries(entries: AccountingEntry[]): ReconcileReport {
  const byStatus: Record<ReconcileStatus, number> = {
    ok: 0,
    missing_fx: 0,
    missing_tx: 0,
    unbalanced: 0,
  }
  const items: ReconcileItem[] = []

  for (const entry of entries) {
    const status = classify(entry)
    byStatus[status] += 1
    // Only list the entries that need attention.
    if (status !== 'ok') {
      items.push({
        paymentId: entry.paymentId,
        txHash: entry.txHash,
        settledAt: entry.settledAt,
        status,
      })
    }
  }

  const issues = entries.length - byStatus.ok
  return { total: entries.length, ok: byStatus.ok, issues, byStatus, items }
}
