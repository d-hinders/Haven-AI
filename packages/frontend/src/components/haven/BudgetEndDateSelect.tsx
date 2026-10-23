'use client'

/**
 * The budget end-date choice (#4350) — ONE control for every surface that
 * grants or edits a MAIN budget (the agent page's grant form, the connect
 * flow's approval step, EditBudgetModal). The owner picks how long the budget
 * lasts — 30, 90 (default), 180 or 365 days, owner decision 1 on #4349 — and
 * the choice converts through `lib/budget-end.ts`, which reuses the
 * sub-budget conversion (`expiryDateToUnixSeconds`) rather than a second
 * picker. Sub-budgets keep their own date input; this is the preset choice
 * the epic prescribes.
 *
 * The date under the select is always stated — chosen preset or "keep
 * current", the owner reads the resulting day before anything is signed.
 * The clock enters as `nowSec` (the caption module's #1995 rule): a
 * frozen-clock capture renders the date that clock says.
 */

import { BUDGET_END_DAYS, budgetEndDaysLabel, budgetEndsAt, formatBudgetEndDate } from '@/lib/budget-end'
import { Select } from '../ui/Select'

/** The "keep the current end" option's value in the Select. */
const KEEP = 'keep'

export default function BudgetEndDateSelect({
  days,
  onDaysChange,
  nowSec,
  keepUntilSec = null,
  id,
  disabled = false,
  label = 'Ends',
}: {
  /** The chosen preset in days. `null` is "keep the current end" (edits). */
  days: number | null
  onDaysChange: (days: number | null) => void
  /** The clock, as unix seconds — never read here (#1995). */
  nowSec: number
  /**
   * When set, a "keep current end" option is offered FIRST, dated to this —
   * an edit whose owner touches nothing here must not silently move the end
   * (the build route would otherwise restart its default, #4350's problem
   * statement). The edit always sends the budget's own `expires_at` then.
   */
  keepUntilSec?: number | null
  id?: string
  disabled?: boolean
  label?: string
}) {
  const endsAt = days === null ? keepUntilSec : budgetEndsAt(days, nowSec)
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-[var(--v2-ink)]">
        {label}
      </label>
      <Select
        id={id}
        value={days === null ? KEEP : String(days)}
        onChange={(e) => onDaysChange(e.target.value === KEEP ? null : Number(e.target.value))}
        disabled={disabled}
        aria-label={`${label} — how long the budget lasts`}
      >
        {keepUntilSec != null ? (
          <option value={KEEP}>
            Keep current end · {formatBudgetEndDate(keepUntilSec)}
          </option>
        ) : null}
        {BUDGET_END_DAYS.map((d) => (
          <option key={d} value={String(d)}>
            {budgetEndDaysLabel(d)}
          </option>
        ))}
      </Select>
      {endsAt != null ? (
        <p className="text-xs text-[var(--v2-ink-3)]" data-testid="budget-end-date">
          Ends {formatBudgetEndDate(endsAt)}.
        </p>
      ) : null}
    </div>
  )
}
