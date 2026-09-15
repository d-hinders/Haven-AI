import type { ApiPaths } from '@haven_ai/core'

/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
/**
 * The ONE front-end-side extension on the generated overview shape, and it is
 * additive and optional, so the generated type stays the single source for
 * every field the endpoint actually emits (#984's rule; the precedent for the
 * form is `types/transactions.ts`, which extends `ApiSchema<'TransactionBase'>`
 * the same way for #2097).
 *
 * `refusals_recorded_from` is the day from which the refusal ledger has rows,
 * the floor slice C renders as "Refusals are recorded from <date>" when a
 * window reaches back behind it (#2947 scope item 5). It is NOT in the
 * OpenAPI response today: slice B (#2946) ships `basis` without it, and the
 * page therefore never renders this line until the endpoint says it. A date
 * invented in the front end would put a confident day on a claim about the
 * ledger's coverage that the product does not hold, which is the one thing
 * this line must not do. `EmptyStates.ReusalsRecordedFromFootnote` is the
 * renderer; `AnalyticsClient` feeds it nothing while the field is absent.
 * The follow-up asking the API for it is recorded in the handoff.
 */
// ui-local: additive field awaiting its OpenAPI counterpart, named here so the name exists exactly once B's follow-up lands the row in the spec
type AnalyticsBasisExtensions = { refusals_recorded_from?: string | null }

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
 * for every field the endpoint emits, before the one additive optional field
 * declared above.
 */
type GeneratedAnalyticsOverviewResponse =
  ApiPaths['/analytics/overview']['get']['responses']['200']['content']['application/json']

/**
 * The basis the page reads: the generated field plus the optional ledger
 * floor. Derived from the GENERATED shape (not from `AnalyticsOverviewResponse`)
 * so the pair stays non-circular, and the extension lands on the field's
 * shape rather than on whether a basis may be absent at all — `basis` stays
 * required on the response below.
 */
export type AnalyticsBasis = GeneratedAnalyticsOverviewResponse['basis'] & AnalyticsBasisExtensions

/**
 * The 200 body of `GET /analytics/overview`, whole. The generated shape with
 * `basis` swapped for its extended self: an `Omit`-and-overwrite rather than a
 * restatement, so the only thing authored in this file beyond aliases remains
 * the one field the spec is about to gain, and every field the endpoint
 * actually reports still comes from the generated spec verbatim.
 */
export type AnalyticsOverviewResponse = Omit<GeneratedAnalyticsOverviewResponse, 'basis'> & {
  basis: AnalyticsBasis
}

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
