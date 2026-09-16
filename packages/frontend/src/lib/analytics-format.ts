import { timeAgo, truncate, isValidAddress } from '@/lib/format'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import type { AnalyticsDelegationBudget } from '@/types/analytics'

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
 * side. The one computation performed here is budget percentage of two atomic
 * strings on the same token — a ratio, not a currency conversion.
 */

/** `usePreferences().currency` — the display currency the Settings surface owns. */
export type AnalyticsCurrency = 'USD' | 'EUR'

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
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.parseFloat(amount))
}

/** Same figure, compacted for narrow columns (`$1.2K`); thresholds are Intl's. */
export function formatAnalyticsAmountCompact(amount: string, currency: AnalyticsCurrency): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
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
 * A budget position in the delegation's own token units ("180 of 250 USDC").
 *
 * Token units, not fiat: a budget is what the owner-signed delegation permits
 * on that token over its own period, so the only honest denominator is the
 * token the delegation is written in. The atomic strings divide down to
 * decimal places (`1800000` at 6 decimals → `1.8`).
 */
export function formatBudgetTokenValue(
  budget: Pick<AnalyticsDelegationBudget, 'token' | 'used_atomic' | 'budget_atomic'>,
): string {
  // `chainId: null` on purpose: the response carries the token's SYMBOL, not
  // its address or chain, so the symbol-based decimals table is the only one
  // that can be consulted, and `formatAllowanceForToken` already owns that
  // table plus its unknown-token fallback.
  const used = formatAllowanceForToken(budget.used_atomic, null, budget.token)
  const total = formatAllowanceForToken(budget.budget_atomic, null, budget.token)
  return `${used} of ${total} ${budget.token}`
}

/**
 * Used/budget as a 0–100 percentage. A zero or malformed budget reports `0`
 * rather than `Infinity` or `NaN` — a delegation whose budget reads as zero is
 * a state that exists (an approval revoked down to nothing), and the bar must
 * render flat rather than produce a nonsense figure.
 */
export function budgetUsedPercent(usedAtomic: string, budgetAtomic: string): number {
  const budget = Number.parseFloat(budgetAtomic)
  if (!Number.isFinite(budget) || budget <= 0) return 0
  const used = Number.parseFloat(usedAtomic)
  if (!Number.isFinite(used) || used <= 0) return 0
  return Math.min(100, Math.round((used / budget) * 100))
}

/**
 * "14 Sep" for a budget period end. The year is off the caption on purpose:
 * a delegation period is short by nature (hours to weeks), so a year would
 * read as a period years away. The element carrying this also sets `title` to
 * the full local timestamp, so a reader who needs the date precisely can have
 * it without the table carrying it.
 */
export function formatBudgetResetDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso))
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
 * A one- or two-word label for the window the figures cover. A caption that
 * restates the endpoint's own numbers ("30 days of data, 12 payments") adds a
 * second place for a count to be wrong, so the range stays a shape word and
 * the counts stay in their tiles.
 */
export function rangeCaption(rangeDays: 7 | 30 | 90): string {
  return `Last ${rangeDays} days`
}

/**
 * The "last payment" cell, built from the one piece the response offers:
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
 * The change of a figure against the same figure in the previous window, as
 * a percentage of the previous window (2.4 = +2.4%), or `null` when there is
 * no previous figure to compare against.
 *
 * It takes a STRING as well as a number because the two fields it is called
 * with on the overview response (`spent`/`spent_previous`) are numeric
 * strings — B books fiat via `::text` and the route passes them through — and
 * a helper that refused them would push every caller into coercing at the
 * render boundary, the one thing the note above this file forbids. The parse
 * happens here, at the edge, exactly where the formatters parse.
 *
 * `null` rather than `Infinity`/`NaN` for a zero or absent previous figure is
 * deliberate: "up from zero" is not a percentage of zero, and the first window
 * an account has data has no previous window at all. A tile given a `null`
 * delta renders no chip; a tile given a made-up one would be a figure the
 * endpoint never reported.
 */
export function percentChange(current: string | number, previous: string | number): number | null {
  const now = typeof current === 'number' ? current : Number.parseFloat(current)
  const before = typeof previous === 'number' ? previous : Number.parseFloat(previous)
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null
  return ((now - before) / before) * 100
}

/**
 * Refused-count with the attempts only when they differ, as one line:
 * "2 refused payments · across 3 attempts". A dedupe upstream means rows and
 * attempts are usually equal, and spelling out "3 · 3 attempts" every time
 * would train the reader to stop parsing that cell.
 */
export function refusalsCaption(refusedCount: number, refusedAttempts: number): string {
  const payments = refusedCount === 1 ? 'refused payment' : 'refused payments'
  if (refusedAttempts === refusedCount) return `${refusedCount} ${payments}`
  return `${refusedCount} ${payments} · across ${refusedAttempts} attempts`
}

/**
 * How a merchant label that is still an address is DISPLAYED (#2949).
 *
 * This decides nobody's identity — the label is the API's (contact, else
 * receipt name, else address), and neither of the two tables that use it
 * re-resolves, because a second resolution is a second place the same merchant
 * can be named two ways. What it does is the display half only: such a label
 * goes through `lib/format.truncate`, the one truncation rule in the app
 * (#853), because an un-truncated `0x…` at table width clips mid-glyph with no
 * ellipsis and no way to read the whole thing. The full string rides in the
 * returned `title` so the reader can still get it; contacts and receipt names
 * are not addresses, keep their own characters, and get no title.
 *
 * `isValidAddress` is `@haven_ai/core`'s (re-exported through `lib/format`),
 * deliberately not viem's, which validates the EIP-55 checksum and so would
 * reject a lowercase address into the non-address branch.
 *
 * It lives here rather than beside either table because BOTH tables use it —
 * the agents table's top-merchant cell and slice E's merchants table render
 * the same field — and a truncation that exists on one side and not the other
 * is a disagreement between them, exactly the class this module exists to
 * prevent.
 */
export function merchantLabel(label: string): { value: string; title?: string } {
  if (isValidAddress(label)) {
    return { value: truncate(label), title: label }
  }
  return { value: label }
}

/**
 * The day label the balance chart and the merchants table print: "11 Jul",
 * the same `en-GB` day+short-month voice `formatBudgetResetDate` already uses,
 * so one page does not hold two dialects of a date. Takes the endpoint's
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
 * The compacted balance figure for the chart's ticks and its table: a number
 * through `Intl`, in the same voice `formatAnalyticsAmount` gives the tiles —
 * but it takes a NUMBER because that is what `AreaChart`'s `formatValue`
 * contract fixes (the caller formats every money figure; the primitive prints
 * none). The string→number parse for a wire row happens ONCE, at the row
 * mapping in `BalanceSection` — the same edge parse `formatAnalyticsAmount`
 * performs for the tiles — so the wire's numeric strings are never re-typed
 * into numbers anywhere else.
 */
/**
 * The y-axis tick: the same currency voice as `formatAnalyticsValue`, with
 * NO fraction digits — an axis needs no more precision than its grid, and a
 * `$100.00` tick overran the 390 gutter and sat on the first bar (#3051
 * design review). Values are the scale's own round ticks, never a figure.
 */
export function formatAnalyticsTick(value: number, currency: AnalyticsCurrency): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

export function formatAnalyticsValue(value: number, currency: AnalyticsCurrency): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

