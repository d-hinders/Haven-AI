import type { ReactNode } from 'react'

export type BudgetMeterProps = {
  /**
   * How much of the budget is used, in percent. Values outside 0–100 are
   * clamped, not trusted: an overdrawn or malformed read must never push the
   * fill past its track or the ARIA value outside its own declared range.
   */
  usedPercent: number
  /**
   * The accessible name of the measurement, e.g. `USDC budget used`. The bar
   * carries no visible label of its own — the caller renders the label row —
   * so this is what a screen reader announces for the progressbar role.
   */
  label: string
  /** Optional caption line under the bar (the "1.20 of 3.00 USDC used · refills …" line). */
  caption?: ReactNode
}

/**
 * The budget meter (#3692, epic #3691) — the ONE progress bar for "how much of
 * a delegation's own period is spent". Extracted from the analytics agents
 * table's hand-rolled bar so every surface that measures a budget against its
 * own period renders the same track height, the same fill and the same ARIA
 * contract, instead of restating the markup per screen.
 *
 * It takes `usedPercent` (clamped 0–100), an `aria-label`, and an optional
 * `caption` slot for the line under the bar. The label row that sits above it
 * (token value, percentage) belongs to the caller — it is tabular, caller-
 * specific typography, not part of the measurement.
 */
export function BudgetMeter({ usedPercent, label, caption }: BudgetMeterProps) {
  const used = Math.min(100, Math.max(0, usedPercent))
  return (
    <div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-label={label}
        className="mt-1 h-1.5 rounded-full bg-[var(--v2-surface-2)] overflow-hidden"
      >
        <div
          // The fill is a token surface colour, never a series colour: a
          // budget bar is a measurement of one delegation against its own
          // period, not a category to be keyed against a legend.
          className="h-full rounded-full bg-[var(--v2-brand)]"
          style={{ width: `${used}%` }}
        />
      </div>
      {caption && <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{caption}</p>}
    </div>
  )
}

export default BudgetMeter
