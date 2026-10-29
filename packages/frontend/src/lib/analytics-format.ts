import { timeAgo, truncate, currencyLocale } from '@/lib/format'
// #3844: the instant voice is the budget caption helper's (#3806) — the same
// three-distance phrasing a budget meter's "refills …" line uses, so a period
// end can no longer be rendered in a private date dialect.
import { formatNextEvent } from '@/lib/budget-caption'

/**
 * Presentation-only formatters for the Analytics surface (#2947, epic #2944
 * slice C).
 *
 * NOTHING here re-derives a figure. Every value the page displays is computed
 * by `GET /analytics/overview` — the endpoint is the single source — and each
 * function below only renders what that response already contains. That is a
 * standing rule, not a style preference: the display currency is a *booking*
 * currency, the fiat on a payment row was booked at confirmation, and
 * converting it again here would put arithmetic between the reader and the
 * number the money path actually wrote. If a figure is missing from the
 * response, the fix is to add it to the endpoint, never to derive it client-
 * side. (The budget percentage this file used to compute is gone with the
 * phone row's own budget line, #4432: a budget renders through the shared
 * caption helper, `lib/budget-caption.ts`.)
 */

/** The display currency the Settings surface owns (`usePreferences().currency`). */
export type AnalyticsCurrency = 'USD' | 'EUR' | 'SEK'

/**
 * The wire voice for each display currency. SEK renders in sv-SE — the
 * currency's own locale, the same rule that puts EUR in de-DE — so a krona
 * figure reads "1 234,56 kr", not a USD figure wearing a SEK symbol (#3127).
 *
 * #3195: this is the ONE shared rule (`lib/format.ts`'s `currencyLocale`)
 * re-exported under the analytics name — the copy here was byte-identical to
 * `formatFiat`'s inline ternary and could drift independently of it.
 */
export function analyticsCurrencyLocale(currency: AnalyticsCurrency): string {
  return currencyLocale(currency)
}

/**
 * Booked fiat for display, in the display currency.
 *
 * Takes a STRING and parses at the edge: every fiat field on the overview
 * response is a numeric string because slice B books fiat via `::text` in SQL
 * and never coerces (`routes/analytics-overview.ts`). Formatting with the
 * platform's `Intl.NumberFormat` means an EUR figure gets its decimal comma
 * from the locale rather than from a hand-rolled string; the value itself
 * stays exactly what the endpoint sent.
 */
export function formatAnalyticsAmount(amount: string, currency: AnalyticsCurrency): string {
  return new Intl.NumberFormat(analyticsCurrencyLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.parseFloat(amount))
}

/** Same figure, compacted for narrow columns (`$1.2K`); thresholds are Intl's. */
export function formatAnalyticsAmountCompact(amount: string, currency: AnalyticsCurrency): string {
  return new Intl.NumberFormat(analyticsCurrencyLocale(currency), {
    style: 'currency',
    currency,
    notation: 'compact',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.parseFloat(amount))
}

/** A percentage of an integer count ("72%") — used by the share column. */
export function formatSharePercent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/**
 * An agent's refused count, with its attempts when they differ ("1 · 2
 * attempts"). Rows and attempts can differ — a dedupe upstream folds retries
 * of one refusal into one row — so the attempts ride the count only when they
 * say something the count does not. One home for the string (#4426): the
 * desktop Refused cell and the phone row's disclosure both print it.
 */
export function formatRefusedCount(refusals: number, attempts: number): string {
  return attempts === refusals ? String(refusals) : `${refusals} · ${attempts} attempts`
}

/**
 * When a budget's period ends, phrased by the caption helper's one instant
 * voice (#3806, routed here in #3844): "in 45m" under 24 h away, "Thu 14:02"
 * under 7 days, otherwise day and short month ("11 Jul") — the voice this
 * formatter used to roll itself, now the helper's ≥ 7-day band. The year is
 * off the far band on purpose: a delegation period is short by nature (hours
 * to weeks), so a year would read as a period years away.
 *
 * `nowMs` is a required parameter — nothing here reads `Date.now()` (#1995)
 * — and `timeZone` is the caption helper's: an explicit zone where a test or
 * a frozen-clock capture needs one, the runtime's zone when omitted (a live
 * render). The period end itself is the read's `period_end` — a boundary of
 * `start_date + k × period` via `currentPeriodBounds` in `@haven_ai/core`,
 * which the backend already computed; this formatter re-derives nothing.
 *
 * The element carrying this also sets `title` to the full local timestamp,
 * so a reader who needs the date precisely can have it without the table
 * carrying it.
 */
export function formatBudgetResetDate(iso: string, nowMs: number, timeZone?: string): string {
  return formatNextEvent(new Date(iso).getTime(), nowMs, timeZone)
}

/**
 * "2 of 3 agents above 75% of their period budget" — the Budget-used tile's
 * sub-line, from `totals.budget_bands`. The denominator is
 * `agents_with_budget`, not the agent count: an agent with no delegation
 * budget is not at 0% of anything, and counting it would report a coverage
 * the response does not claim.
 */
export function budgetBandsCaption(above75: number, agentsWithBudget: number): string {
  return `${above75} of ${agentsWithBudget} agents above 75% of their period budget`
}

/**
 * "by 2 of 3 agents" — the Payments tile's caption (#4333): the agents the
 * window's payments came from, out of the agents the table lists. Both counts
 * are read off the response's own `agents[]` rows (each carries its
 * `payments`), so the caption counts what the endpoint reported and invents
 * nothing; when the page is filtered to one agent the caller renders that
 * agent's name instead and this caption is not used.
 */
export function paymentsAgentsCaption(agentsWithPayments: number, agentsListed: number): string {
  return `by ${agentsWithPayments} of ${agentsListed} agents`
}

/**
 * The Spent tile's comparison (#4333): the previous window's spent, as an
 * AMOUNT rather than a percentage — "$280.10 the 30 days before". A ratio of
 * two booked totals is a derivation the response did not make (`percentChange`
 * is gone with the delta pills); the endpoint reports both windows' figures
 * and the tile puts them side by side, which is the one comparison it can
 * make without inventing a number.
 */
export function spentComparisonCaption(
  previousSpent: string,
  days: number,
  currency: AnalyticsCurrency,
): string {
  return `vs ${formatAnalyticsAmount(previousSpent, currency)} the ${days} days before`
}

/**
 * The "last payment" cell, from the one piece the response offers:
 * `last_payment_at` (null → never). Relative form keeps the column comparable
 * across rows at a glance — "2h ago" answers the question the column is for,
 * how recently has this agent spent — and reuses the app's own `timeAgo` so
 * the same duration words appear here and on the transaction rows rather than
 * a second dialect of them. The full local timestamp rides on the element's
 * `title` at the call site.
 */
export function lastPaymentCaption(iso: string | null): string {
  return iso === null ? 'No payments in this range' : timeAgo(iso)
}

/**
 * The short address an UNKNOWN recipient shows under its "Unknown recipient"
 * label (#4333): the one truncation rule in the app (#853) — "0x71C2…7128".
 * Since #4332 the overview's `label` is either a resolved NAME or null — it
 * is never an address — so the address appears only where the issue puts it:
 * the kind line and the tooltip of an unknown recipient, never AS the label.
 */
export function unknownRecipientShortAddress(address: string): string {
  return truncate(address)
}

/**
 * The day label the balance chart and the merchants table print: "11 Jul",
 * the caption helper's ≥ 7-day band voice (`formatNextEvent`, `en-GB` day +
 * short month) with a fixed UTC zone, so one page does not hold two dialects
 * of a date. Takes the endpoint's
 * `YYYY-MM-DD` bucket string; `isValidDateString`-style validation is not
 * performed because the endpoint owns the format and the parity fixtures
 * prove it, and an unparseable date renders as its own raw string rather than
 * as an invented one.
 */
export function formatAnalyticsDay(dayIso: string): string {
  const date = new Date(`${dayIso}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return dayIso
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)
}

/**
 * The compacted balance figure for the chart's callout and its table (the
 * axis ticks have their own, digit-free voice in `formatAnalyticsTick`): a number
 * through `Intl`, in the same voice `formatAnalyticsAmount` gives the tiles —
 * but it takes a NUMBER because that is what `AreaChart`'s `formatValue`
 * contract fixes (the caller formats every money figure; the primitive prints
 * none). The string→number parse for a wire row happens ONCE, at the row
 * mapping in `BalanceSection` — the same edge parse `formatAnalyticsAmount`
 * performs for the tiles — so the wire's numeric strings are never re-typed
 * into numbers anywhere else.
 */
export function formatAnalyticsValue(value: number, currency: AnalyticsCurrency): string {
  return new Intl.NumberFormat(analyticsCurrencyLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * The y-axis tick: the same currency voice as `formatAnalyticsValue`, with
 * the fraction digits the TICK STEP chooses (#4334) — 0 for a whole-unit
 * step, 2 otherwise, and 4 when the step is under a cent, so a sub-cent
 * scale's ticks stay distinct instead of printing "$0, $0". The decimals
 * come from the STEP and not from each value (S5 on #4334): per-value
 * formatting would print "$0.0020, $0.0040, $0.01, $0.01" up one axis —
 * the two coarse ticks rounding away the very distinction the fine ones
 * carry. Values are the scale's own round ticks, never a figure.
 */
export function formatAnalyticsTick(value: number, step: number, currency: AnalyticsCurrency): string {
  const decimals = step >= 1 ? 0 : step > 0 && step < 0.01 ? 4 : 2
  return new Intl.NumberFormat(analyticsCurrencyLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}
