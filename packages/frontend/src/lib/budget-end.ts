/**
 * The main-budget end date (#4350, epic #4349): the owner chooses how long a
 * budget lives — 30, 90 (default), 180 or 365 days, owner decision 1 on
 * #4349 — and the choice rides the existing `expires_at` on
 * `POST /agents/:id/delegations/build` (and on an edit, through the hook's
 * `opts.expiresAt`).
 *
 * The conversion REUSES the sub-budget end-date machinery
 * (`lib/sub-budget.ts`) rather than a second picker: the chosen day count
 * becomes a calendar date (that preset's last day), and
 * `expiryDateToUnixSeconds` does the same end-of-UTC-day → unix-seconds
 * conversion, with the same future validation. No cap is enforced here — the
 * build route owns the ceiling (#4351); 365 is the largest preset this form
 * offers, not a guard.
 */
import { expiryDateToUnixSeconds, formatSubBudgetDate, unixSecondsToDateInput } from './sub-budget'

/** The presets the owner picks from, in days (owner decision 1 on #4349). */
export const BUDGET_END_DAYS = [30, 90, 180, 365] as const

/** The default preset: 90 days — the server's own default, made visible. */
export const BUDGET_END_DEFAULT_DAYS: number = 90

/** The chosen preset as a calendar date: `nowSec + days`, dated. */
function endDateInput(days: number, nowSec: number): string {
  return unixSecondsToDateInput(nowSec + days * 86_400)
}

/**
 * The chosen preset as unix seconds — the END of that UTC day, via the
 * sub-budget conversion (so the semantics are the one definition's: a date
 * picked today is still valid at 23:59:59 of its day). Returns null only when
 * the conversion would not be in the future, which the presets (≥ 30 days)
 * cannot produce on a sane clock.
 */
export function budgetEndsAt(days: number, nowSec: number): number | null {
  return expiryDateToUnixSeconds(endDateInput(days, nowSec), nowSec)
}

/** The preset's option label: "30 days" and so on. */
export function budgetEndDaysLabel(days: number): string {
  return `${days} days`
}

/**
 * A unix-seconds instant as the human end date — "9 Oct 2026" — the SAME
 * formatter the sub-budget rows use, so no surface drifts.
 */
export function formatBudgetEndDate(sec: number): string {
  return formatSubBudgetDate(sec)
}
