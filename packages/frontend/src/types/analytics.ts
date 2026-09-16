import type { ApiPaths } from '@haven_ai/core'

/**
 * Wire shapes for `GET /analytics/overview` (#2947, epic #2944 slice C).
 *
 * Every type here is a projection of `@haven_ai/core`'s generated API types —
 * the OpenAPI spec is the single source and nothing in this file restates a
 * response field (#984, #1447). The route's `200` content is inline in the
 * generated `operations['getAnalyticsOverview']` rather than a named
 * `components['schemas']` entry, so `ApiPaths` is the correct lookup form here
 * (the same one `hooks/useAccounting.ts` uses); `ApiSchema<'…'>` is only for
 * schemas that ARE named.
 *
 * The money fields are STRINGS on this response (`totals.spent`,
 * `totals.refused_amount`, `fees.amount`, `agents[].spent`, `budgets[].*_atomic`,
 * …) because slice B books fiat via `::text` in SQL and passes the strings
 * through with no `Number()` coercion (`routes/analytics-overview.ts`). `share`
 * is the one number-typed money-adjacent field. Formatters therefore take
 * strings and parse at the edge — see `lib/analytics-format.ts`.
 */

/**
 * The 200 body exactly as the generated spec declares it — the single source
 * for every field the endpoint emits. Slice B's ledger floor
 * (`basis.refusals_recorded_from`, #3013) is IN the generated shape now, so
 * this file carries no extension on it: the renderer
 * (`EmptyStates.RefusalsRecordedFromFootnote`) reads the generated field
 * directly, and the date comes from the response, never from the client.
 */
type GeneratedAnalyticsOverviewResponse =
  ApiPaths['/analytics/overview']['get']['responses']['200']['content']['application/json']

/**
 * The basis the page reads. `basis` stays required on the response below.
 */
export type AnalyticsBasis = GeneratedAnalyticsOverviewResponse['basis']

/**
 * The 200 body of `GET /analytics/overview`, whole — the generated shape
 * verbatim (#984, #1447).
 */
export type AnalyticsOverviewResponse = GeneratedAnalyticsOverviewResponse

/** The validated window the server resolved the request to. */
export type AnalyticsRange = GeneratedAnalyticsOverviewResponse['range']

/** The four StatTile figures' source, plus the budget bands behind tile 3. */
export type AnalyticsTotals = AnalyticsOverviewResponse['totals']

/** The `budget_bands` triple behind the "Budget used" tile. */
export type AnalyticsBudgetBands = AnalyticsTotals['budget_bands']

/** Haven's own fee figure, flag and previous-window value. */
export type AnalyticsFees = AnalyticsTotals['fees']

/** One agent row of the agents table. */
export type AnalyticsAgentRow = AnalyticsOverviewResponse['agents'][number]

/** One delegation's budget, in the token's own atomic units. */
export type AnalyticsDelegationBudget = AnalyticsAgentRow['budgets'][number]

/** One day bucket, tz-aligned to the caller's `tz` (#2946). */
export type AnalyticsDayBucket = AnalyticsOverviewResponse['by_day'][number]

/** One merchant row. Rendered by slice E (#2949); declared here for one shape. */
export type AnalyticsMerchantRow = AnalyticsOverviewResponse['merchants'][number]

/** One daily balance snapshot row. */
export type AnalyticsBalanceDay = AnalyticsOverviewResponse['balance_by_day'][number]

/** The request's `range` enum, so the control and the query key off one type. */
export type AnalyticsRangeValue = '7d' | '30d' | '90d'
