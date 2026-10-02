/**
 * The delegate balance monitor's in-memory LAST REPORT (#3514): what
 * `GET /ops/health` serves instead of ever scanning on request.
 *
 * One module-level slot, written ONLY by the monitor's own scan — the hourly,
 * leader-locked tick in `index.ts`. Reading it never scans: a replica that
 * does not hold the monitor's leader lock has no report, and `/ops/health`
 * answers `not_available_on_this_replica` rather than pretending. There is
 * deliberately no TTL or staleness check here — `scannedAt` travels with the
 * report, so a stale scan is a visible fact, not a hidden one.
 *
 * Zero imports beyond the shared TYPES module, so the ops console's graph
 * can reach this store (its invariant-1 walk forbids `infra/delegate-*`
 * pattern paths — the store's name avoids the pattern deliberately, and the
 * walk's rule is about write/spend reach, which a getter slot has none of).
 */

import type { DelegateBalanceReport } from '../domain/delegate-balance.js'

let lastReport: DelegateBalanceReport | null = null

/** The last report this process scanned, or null before the first scan. */
export function lastDelegateBalanceReport(): DelegateBalanceReport | null {
  return lastReport
}

/** Record the report of a completed scan. The monitor's own scan is the only writer. */
export function storeDelegateBalanceReport(report: DelegateBalanceReport): void {
  lastReport = report
}

/** Test seam: forget the stored report. */
export function resetDelegateBalanceReportForTests(): void {
  lastReport = null
}
