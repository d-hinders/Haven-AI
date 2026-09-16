'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { usePreferences } from '@/hooks/usePreferences'
import { analyticsDaysWithData, useAnalyticsOverview } from '@/hooks/useAnalyticsOverview'
import {
  budgetBandsCaption,
  formatAnalyticsAmount,
  percentChange,
  rangeCaption,
  refusalsCaption,
} from '@/lib/analytics-format'
import type { AnalyticsOverviewResponse, AnalyticsRangeValue } from '@/types/analytics'
import {
  isAnalyticsRangeValue,
  readStoredAnalyticsRange,
  writeStoredAnalyticsRange,
} from '@/lib/analytics-range'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { AgentsTable } from '@/components/analytics/AgentsTable'
import { BalanceSection } from '@/components/analytics/BalanceSection'
import { MerchantsTable } from '@/components/analytics/MerchantsTable'
import { RangeControl } from '@/components/analytics/RangeControl'
// The floor slice D fixed for "too little data to chart", read here so the
// wrapper below carries no empty margin when BalanceSection decides not to
// draw. Importing the constant rather than comparing to `3` is what keeps the
// page and the primitive on one rule with one home.
import { MIN_CHARTABLE_DAYS } from '@/components/charts/chart-scale'
import {
  AnalyticsErrorState,
  NoActivityEmptyState,
  RefusalsRecordedFromFootnote,
  SparseDataLine,
  UnsettledEvidenceFootnote,
} from '@/components/analytics/EmptyStates'

/**
 * The Analytics page (#2947, epic #2944 slice C).
 *
 * One request, four figures, one table. The request is the whole page's only
 * source: `GET /analytics/overview` (#2946) returns the aggregate, so the
 * page has one loading state and one "based on N payments" basis rather than
 * a per-widget fetch each answering its own question. Nothing here computes a
 * figure the endpoint did not report — `lib/analytics-format.ts` owns the
 * rule and this file obeys it.
 *
 * ── The four tiles and what each one says ──────────────────────────────────
 *
 *   Spent        The booked total, CONFIRMED only, with its basis under it:
 *                the payment count, and — when submissions are still awaiting
 *                their settlement evidence — how many are not counted.
 *   Refused      The count of refusal rows, the attempts behind them when
 *                they differ, and the amount that was attempted. Never
 *                "saved": a refused payment is money that was not spent, not
 *                money that was kept.
 *   Budget used  How many agents are above 75% of a period budget, from the
 *                bands the endpoint counts.
 *   Fees         What Haven charged. While the fee flag is off this says so
 *                in words — a $0.00 there would report "nothing charged this
 *                period", which is not the same fact.
 *
 * The numbers themselves never carry colour; each tile's delta chip carries
 * its polarity (`StatTile`'s docblock owns the rule).
 *
 * ── The five states ─────────────────────────────────────────────────────────
 *
 * loading → one skeleton in the final layout's shape; failed (or never
 * answered) → one error state with one retry; answered with no activity at
 * all → one empty state, not four tiles asserting zeros; answered with fewer
 * than `MIN_DAYS_FOR_CHARTS` days of history → tiles only, with the reason on
 * screen; else the populated page. The states are mutually exclusive because
 * what they report about the request is: the empty state says the endpoint
 * answered and found nothing, the error state says it did not answer, and a
 * page of honest zeros is exactly what a failure is mistaken for.
 */

/**
 * Below this many days carrying data the charts band stays empty (#2948's
 * rule, taken from slice D): a line through one point agrees with every
 * trend, so it proves none. The tiles still render — a total over one day is
 * still the total over that day — and `SparseDataLine` says out what the
 * reader is not being shown and why.
 */
const MIN_DAYS_FOR_CHARTS = 3

/** The window's length for the caption, keyed off the control's own values. */
const RANGE_DAYS: Record<AnalyticsRangeValue, 7 | 30 | 90> = { '7d': 7, '30d': 30, '90d': 90 }

/** The four figures, in the order the reader scans them. */
function TileGrid({ data, currency }: { data: AnalyticsOverviewResponse; currency: 'USD' | 'EUR' }) {
  if (data === null) return null
  const { totals, basis, range } = data
  const windowCaption = `vs previous ${range.days} days`

  const gasSponsored =
    totals.gas_sponsored_ops === 1
      ? "Haven sponsored 1 operation's gas."
      : totals.gas_sponsored_ops > 1
        ? `Haven sponsored ${totals.gas_sponsored_ops} operations' gas.`
        : null

  const fees = totals.fees
  const feesFootnote = fees.flag_on
    ? gasSponsored
    : gasSponsored === null
      ? 'Haven is not charging fees.'
      : `Haven is not charging fees. ${gasSponsored}`

  // The basis is the page's most load-bearing line: it says what the number
  // counted, including which submissions were left out of it.
  const spentFootnote = (
    <>
      {`based on ${basis.payments_counted} payment${basis.payments_counted === 1 ? '' : 's'}`}
      {basis.unsettled_submitted > 0 && (
        <>
          {' · '}
          <UnsettledEvidenceFootnote count={basis.unsettled_submitted} />
        </>
      )}
    </>
  )

  // The ledger's own floor, when the ledger has rows (#3013: the endpoint now
  // reports it, so this line renders whenever it is non-null). A date invented
  // here would report a coverage the product does not hold, which is the one
  // thing this line must not do — the value is the response's, never the
  // client's.
  const refusalLedgerFloor =
    basis.refusals_recorded_from != null ? (
      <>
        {' · '}
        <RefusalsRecordedFromFootnote fromDate={formatFloorDate(basis.refusals_recorded_from)} />
      </>
    ) : null

  const refusedFootnote =
    totals.refused_count > 0 || totals.refused_attempts > 0 ? (
      <>
        {refusalsCaption(totals.refused_count, totals.refused_attempts)}
        {` · ${formatAnalyticsAmount(totals.refused_amount, currency)} attempted`}
        {refusalLedgerFloor}
        {' · '}
        {"Price-cap refusals in your agent's runtime are not recorded."}
      </>
    ) : (
      "Price-cap refusals in your agent's runtime are not recorded."
    )

  const bands = totals.budget_bands
  const hasBudgets = bands.agents_with_budget > 0

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="analytics-tiles">
      <StatTile
        label="Spent"
        value={formatAnalyticsAmount(totals.spent, currency)}
        polarity="neutral"
        delta={percentChange(totals.spent, totals.spent_previous)}
        deltaCaption={windowCaption}
        footnote={spentFootnote}
      />
      <StatTile
        label="Refused"
        value={String(totals.refused_count)}
        polarity="higher-is-bad"
        delta={percentChange(totals.refused_count, totals.refused_previous_count)}
        deltaCaption={windowCaption}
        footnote={refusedFootnote}
      />
      <StatTile
        label="Budget used"
        value={hasBudgets ? `${bands.above_75}/${bands.agents_with_budget}` : '—'}
        polarity="higher-is-warning"
        footnote={
          hasBudgets
            ? budgetBandsCaption(bands.above_75, bands.agents_with_budget)
            : 'No agent has a budget set in this window.'
        }
      />
      <StatTile
        label="Fees paid to Haven"
        value={fees.flag_on ? formatAnalyticsAmount(fees.amount, currency) : 'No fees yet'}
        polarity="neutral"
        // While the flag is off there is nothing charged, so there is no change
        // of anything to show either: a chip on a standing zero is a figure
        // about a number the fee schedule does not keep.
        delta={fees.flag_on ? percentChange(fees.amount, fees.previous) : null}
        deltaCaption={fees.flag_on ? windowCaption : undefined}
        footnote={feesFootnote}
      />
    </div>
  )
}

/** "2026-07-11" to the same "11 Jul" the budget cells use; an unparseable
 *  date is passed through rather than rendered as an invented one. */
function formatFloorDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date)
}

/** The one loading layout, in the shape the settled page takes: four tiles
 *  then the table. A skeleton that matched nothing would make the page jump
 *  as it filled, which is the flash the loading states exist to avoid. */
function AnalyticsSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading analytics"
      data-testid="analytics-skeleton"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div
            key={item}
            className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card p-5"
          >
            <Skeleton variant="text" className="h-3 w-24" />
            <Skeleton variant="text" className="mt-2 h-6 w-20" />
            <Skeleton variant="text" className="mt-3 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card">
        <Skeleton variant="rect" className="h-12 w-full rounded-none" />
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} variant="rect" className="mx-5 my-3 h-10" />
        ))}
      </div>
    </div>
  )
}

type AnalyticsData = NonNullable<ReturnType<typeof useAnalyticsOverview>>['data']

export default function AnalyticsClient() {
  const { currency } = usePreferences()

  // The stored window is read in the initialiser, not in an effect, so the
  // FIRST request carries the reader's chosen range — see the note in
  // `lib/analytics-range.ts` (the `haven.theme` reasoning again).
  const [range, setRange] = useState<AnalyticsRangeValue>(readStoredAnalyticsRange)

  // The Settings currency is the one source for both halves of the page: the
  // value on the wire and the symbol in the tiles. The endpoint echoes it on
  // the response, and the response is not consulted for it — were the two to
  // disagree, the page would have two answers to "which currency am I
  // reading" and the reader would believe the louder one.
  const { data, loading, failed, refetch } = useAnalyticsOverview(
    range,
    currency === 'EUR' ? 'eur' : 'usd',
  )

  const changeRange = (next: AnalyticsRangeValue) => {
    // Storage is a cache of the reader's choice, not the source of it: a
    // value the endpoint would answer 400 to is not a range, and must not
    // leave this page either way (see `isAnalyticsRangeValue`).
    if (!isAnalyticsRangeValue(next)) return
    setRange(next)
    writeStoredAnalyticsRange(next)
  }

  const days = data?.range.days ?? RANGE_DAYS[range]

  let body: ReactNode
  if (loading) {
    body = <AnalyticsSkeleton />
  } else if (failed || data === null) {
    // `data === null` with the request settled and no error is a state the
    // hook does not produce; the branch is here so that a change to the hook
    // fails as an error state with a retry, never as a blank page.
    body = <AnalyticsErrorState onRetry={refetch} />
  } else if (isEmptyWindow(data)) {
    body = <NoActivityEmptyState />
  } else {
    const sparse = analyticsDaysWithData(data) < MIN_DAYS_FOR_CHARTS
    body = (
      <>
        <TileGrid data={data} currency={currency} />
        {sparse ? (
          <div className="mt-4">
            <SparseDataLine />
          </div>
        ) : (
          <>
            {/* ── Charts band (slice D, #2948) ──────────────────────────────
                `StackedBarChart` + `AreaChart` mount here when
                `feat/2948-analytics-charts` (head 00ec5433) lands: the
                day-buckets the endpoint already returns in `by_day`, keyed
                to the agents in the table below. Slice C owns the position;
                D adds its imports and its JSX inside this block only. The
                sparse branch above keeps this band empty for fewer than
                MIN_DAYS_FOR_CHARTS days of data. */}
            {data.agents.length > 0 && (
              <div className="mt-4" data-testid="analytics-agents-section">
                <AgentsTable agents={data.agents} currency={currency} />
              </div>
            )}
            {/* ── Merchants and balance (slice E, #2949) ────────────────────
                The two sections the wire contract parked here, now mounted:
                the top-merchants table over `merchants` and the
                balance-over-time chart over `balance_by_day`, both read off
                THIS same response — one request still owns the whole page.
                Each guards on its own array rather than on the other's: a
                range can have agents without a reported merchant row, or a
                balance series with no merchants, and rendering a section the
                endpoint did not populate would be the page asserting figures
                it was not given. The "Top merchants" heading is E's own, on
                the card, and the sparse branch above keeps the whole band
                empty for fewer than MIN_DAYS_FOR_CHARTS days of data —
                including these. */}
            {data.merchants.length > 0 && (
              <div className="mt-4" data-testid="analytics-merchants-section">
                <MerchantsTable
                  merchants={data.merchants}
                  agents={data.agents}
                  currency={currency}
                />
              </div>
            )}
            {data.balance_by_day.length >= MIN_CHARTABLE_DAYS && (
              <div className="mt-4">
                <BalanceSection
                  balanceByDay={data.balance_by_day}
                  currency={currency}
                  rangeDays={days === 7 || days === 90 ? days : 30}
                />
              </div>
            )}
          </>
        )}
      </>
    )
  }

  return (
    <div className="max-w-6xl" data-testid="analytics-page">
      <PageHeader
        title="Analytics"
        subtitle="What your agents did with your money."
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--v2-ink-3)]">{rangeCaption(days)}</span>
            <RangeControl value={range} onChange={changeRange} />
          </div>
        }
      />
      {body}
    </div>
  )
}

/**
 * The whole-page empty state's trigger: the request answered, and there is
 * nothing in the window to report — no counted payments, no submissions
 * waiting for their evidence, no refusals, no fees. Anything else is rendered
 * as figures, because a payment that has been submitted but not yet settled is
 * activity the tiles name with, and hiding it behind "no activity" would be
 * the page's least honest lie.
 */
function isEmptyWindow(data: NonNullable<AnalyticsData>): boolean {
  return (
    data.basis.payments_counted === 0 &&
    data.basis.unsettled_submitted === 0 &&
    data.totals.refused_count === 0 &&
    data.basis.fee_rows === 0
  )
}
