'use client'

/**
 * The Analytics Revenue side (#4901, epic #4885).
 *
 * The page's Spending / Revenue switch swaps the whole data source; this is
 * the Revenue half. It reads ONE endpoint — the Sales reads from #4897
 * (`GET /merchant-sales/summary`, through `useSalesSummary`) — so the side has
 * one request and one loading state, the rule the page already keeps for the
 * spend side. The choice is recorded in `lib/analytics-revenue.ts`: reading
 * the Sales endpoint is what makes "the revenue total equals the Sales page
 * total for the same period" true by construction, and it adds no SQL under
 * `infra/repositories/`, so the slice stays off the money path.
 *
 * ── What each tile says ────────────────────────────────────────────────────
 *
 *   Revenue        The period's total, in the display currency: sales plus
 *                  payments that carry no sale record, wherever the money was
 *                  received (a Stripe-held sale counts, #4981). Own moves are
 *                  NOT in it (the read excludes them), which is why the "Not
 *                  counted" tile exists.
 *   Sales          Every revenue payment: sales plus payments with no
 *                  product, as the Sales page counts them.
 *   Average sale   The total over every payment counted — the read's own
 *                  `average_sale_raw`, never a second division here.
 *   Not counted    What moved between the owner's own accounts and agents.
 *                  It is in no total, and the tile says so rather than
 *                  leaving the reader to wonder where it went.
 *
 * ── The chart ──────────────────────────────────────────────────────────────
 *
 * The shared `StackedBarChart`, one series per product: the five products with
 * the most revenue take the five categorical stops, the rest fold into one
 * "Other" series in neutral ink, and payments with no sale record take the
 * second neutral ink — so the stack adds up to the Revenue tile instead of
 * quietly leaving a class of money out. `hideRefusals` drops the chart's
 * screen-reader Refusals column: a refused payment is not a sale (#4900).
 *
 * ── The states ─────────────────────────────────────────────────────────────
 *
 * loading → one skeleton in the settled layout's shape; failed → the page's
 * one error state with one retry; answered with nothing in the period → one
 * empty state naming the period, never four tiles asserting zeros. A period
 * with only own moves is NOT empty: it renders the tiles, with Revenue at
 * zero and the Not counted tile carrying the figure — that is the honest
 * reading of a period whose only money moved between the owner's accounts.
 */

import { CircleAlert, Info } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Skeleton'
import { StackedBarChart } from '@/components/ui/StackedBarChart'
import { StatTile } from '@/components/ui/StatTile'
import { Tooltip } from '@/components/ui/Tooltip'
import { SalesBreakdownCard } from '@/components/sales/SalesBreakdownCard'
import { useSalesSummary } from '@/hooks/useSalesSummary'
import {
  OWN_MOVES_HINT,
  ownMovesCaption,
  revenueChartDays,
  revenueChartLabel,
  revenueMoney,
} from '@/lib/analytics-revenue'
import {
  isEmptyPeriod,
  payerCount,
  plural,
  productLines,
  revenueCount,
  salesChartFormat,
  salesRangeDays,
  salesRevenueTile,
  salesTotalText,
  type SalesCurrency,
  type SalesDayRange,
} from '@/lib/sales'
import { AnalyticsErrorState } from './EmptyStates'

/** The one loading layout, in the shape the settled side takes: four tiles,
 *  then the chart. A skeleton that matched nothing would make the page jump
 *  as it filled. */
function RevenueSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading revenue"
      data-testid="analytics-revenue-skeleton"
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
        <Skeleton variant="rect" className="h-56 w-full rounded-none" />
      </div>
    </div>
  )
}

export function RevenueSection({
  range,
  currency,
  chainId,
}: {
  /** The period as the Sales reads take it: UTC calendar days, both inclusive. */
  range: SalesDayRange
  currency: SalesCurrency
  /** The Sales account's chain: it decides whether USDC is the display currency itself. */
  chainId: number | null | undefined
}) {
  const summary = useSalesSummary(range)

  if (summary.loading) return <RevenueSkeleton />

  if (summary.failed || summary.data === null) {
    return <AnalyticsErrorState onRetry={summary.refetch} />
  }

  const data = summary.data
  const money = revenueMoney(data, currency, chainId)

  if (isEmptyPeriod(data)) {
    return (
      <div data-testid="analytics-revenue-empty">
        <EmptyState
          icon={<Icon icon={CircleAlert} className="w-full h-full" />}
          tone="neutral"
          title="No sales in this period"
          body="Nothing reached your Sales account in these days. A longer period may reach further back."
        />
      </div>
    )
  }

  const days = salesRangeDays(range)
  const chart = salesChartFormat(money)
  const chartDays = revenueChartDays(data, range, chart.rate)
  const lines = productLines(data, money)
  const payers = payerCount(data)
  // The payer count is exact only when every payment has a payer on the
  // breakdown; a payment from several wallets at once has none to count.
  const payersExact = data.unattributed.payments === 0
  const own = data.own_moves
  const revenuePayments = revenueCount(data)

  return (
    <div data-testid="analytics-revenue">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="analytics-revenue-tiles">
        <StatTile
          label="Revenue"
          {...salesRevenueTile(data.revenue_raw, money)}
          footnote={`from ${plural(revenuePayments, 'payment')}`}
        />
        <StatTile
          label="Sales"
          value={String(revenuePayments)}
          {...(payersExact ? { footnote: `from ${plural(payers, 'payer')}` } : {})}
        />
        <StatTile
          label="Average sale"
          value={salesTotalText(data.average_sale_raw, money)}
          footnote="per payment"
        />
        {/* The mockup's "Not counted" tile (#4894): what moved between the
            owner's own accounts and agents. It is in no total above, and the
            tile says so — the alternative is a reader who cannot find the
            money. It renders at zero too: "$0.00 / No transfers between your
            accounts" is a fact about the period, and a tile that came and went
            would move the grid under the reader. */}
        <StatTile
          label="Not counted"
          value={salesTotalText(own.amount_raw, money)}
          footnote={ownMovesCaption(own.count)}
          hint={
            <Tooltip label={OWN_MOVES_HINT} side="bottom">
              <span
                tabIndex={0}
                role="button"
                aria-label={`What this counts: ${OWN_MOVES_HINT}`}
                data-testid="analytics-revenue-own-moves-hint"
                className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                <Icon icon={Info} className="h-3.5 w-3.5" />
              </span>
            </Tooltip>
          }
        />
      </div>

      <div className="mt-4" data-testid="analytics-revenue-by-day">
        <Card hover={false} className="overflow-hidden">
          <Card.Header as="h2" title="Revenue over time" description="Revenue per day, by product." />
          <div className="px-5 pb-5 pt-2">
            <div className="hidden lg:block">
              <StackedBarChart
                days={chartDays}
                currency={currency}
                ariaLabel={revenueChartLabel(data, money, days)}
                formatValue={chart.formatValue}
                formatTick={chart.formatTick}
                hideRefusals
              />
            </div>
            <div className="lg:hidden">
              <StackedBarChart
                days={chartDays}
                currency={currency}
                ariaLabel={revenueChartLabel(data, money, days)}
                formatValue={chart.formatValue}
                formatTick={chart.formatTick}
                narrow
                hideRefusals
              />
            </div>
          </div>
        </Card>
      </div>

      {lines.length > 0 && (
        <div className="mt-4">
          <SalesBreakdownCard
            testId="analytics-revenue-by-product"
            title="By product"
            description="What sold, ranked by revenue."
            nameHeader="Product"
            countHeader="Sales"
            countNoun="sale"
            lines={lines}
          />
        </div>
      )}
    </div>
  )
}

export default RevenueSection
