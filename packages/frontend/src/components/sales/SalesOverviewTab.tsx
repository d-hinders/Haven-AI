'use client'

import { useEffect, useMemo, useRef } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { Skeleton } from '@/components/ui/Skeleton'
import { StackedBarChart } from '@/components/ui/StackedBarChart'
import { StatTile } from '@/components/ui/StatTile'
import { Tooltip } from '@/components/ui/Tooltip'
import { NoticeRow } from '@/components/haven/NoticeRow'
import { currencyLocale } from '@/lib/format'
import { useSalesFacets } from '@/hooks/useSalesFacets'
import { useSalesPayments, useSalesPeriodTotal } from '@/hooks/useSalesPayments'
import { useSalesSummary } from '@/hooks/useSalesSummary'
import type { ListFacet } from '@/components/ui/FacetMenu'
import {
  SALES_FACET_KEYS,
  SALES_KINDS,
  SALES_KIND_LABELS,
  hasSalesFilters,
  isEmptyPeriod,
  lastPaidText,
  payerSubline,
  salesFiltersFromList,
  payerCount,
  revenueCount,
  payerKey,
  payerKindLine,
  payerName,
  previousSalesRange,
  revenueChangePercent,
  salesAmountText,
  salesChartDays,
  salesChartFormat,
  salesRangeDays,
  salesTotalText,
  stripeSalesCount,
  stripeSalesRaw,
  type SalesCurrency,
  type SalesDayRange,
  type SalesFacets,
  type SalesMoney,
  type SalesSummary,
  type SalesUsdcRates,
} from '@/lib/sales'
import { SalesBreakdownCard, type BreakdownLine } from './SalesBreakdownCard'
import { SalesPaymentsList, type SalesListControls } from './SalesPaymentsList'

/** "N payment(s) of $X": the words the own-moves notice and the tiles share. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** The By product lines: every product, the products folded into "Other", then payments with no product. */
export function productLines(summary: SalesSummary, money: SalesMoney): BreakdownLine[] {
  const lines: BreakdownLine[] = summary.by_product.map((product) => ({
    key: `product:${product.product_id}`,
    name: product.label,
    detail: product.product_id !== product.label ? product.product_id : undefined,
    revenue: salesAmountText(product.amount_raw, money),
    count: product.sales,
  }))
  const other = summary.by_product_other
  if (other.products > 0 || other.sales > 0) {
    lines.push({
      key: 'product:other',
      name: 'Other',
      detail: plural(other.products, 'product'),
      revenue: salesAmountText(other.amount_raw, money),
      count: other.sales,
    })
  }
  if (summary.without_product.count > 0) {
    lines.push({
      key: 'product:none',
      name: 'No product',
      detail: 'Paid, but your kit sent no sale record',
      revenue: salesAmountText(summary.without_product.amount_raw, money),
      count: summary.without_product.count,
      muted: true,
      countNoun: 'payment',
    })
  }
  return lines
}

/**
 * The By payer lines: contacts and your own accounts by name, every other
 * payer as "Wallet" with a short address, then the folded "Other payers" and
 * the payments from several payers at once. The page never says a payer uses
 * Haven.
 */
export function payerLines(summary: SalesSummary, money: SalesMoney, now: Date = new Date()): BreakdownLine[] {
  const lines: BreakdownLine[] = summary.by_payer.map((entry) => ({
    key: payerKey(entry.payer),
    name: payerName(entry.payer),
    detail: payerKindLine(entry.payer),
    revenue: salesAmountText(entry.amount_raw, money),
    count: entry.payments,
    // An older backend sends no `last_paid_at`: the cell stays empty, never "Invalid Date".
    lastPaid: entry.last_paid_at ? lastPaidText(entry.last_paid_at, now) : undefined,
  }))
  const other = summary.by_payer_other
  if (other.payers > 0 || other.payments > 0) {
    lines.push({
      key: 'payer:other',
      name: 'Other payers',
      detail: plural(other.payers, 'payer'),
      revenue: salesAmountText(other.amount_raw, money),
      count: other.payments,
    })
  }
  if (summary.unattributed.payments > 0) {
    lines.push({
      key: 'payer:several',
      name: 'Several payers',
      detail: 'Paid by more than one wallet at once',
      revenue: salesAmountText(summary.unattributed.amount_raw, money),
      count: summary.unattributed.payments,
    })
  }
  return lines
}

/**
 * The Product, Payer and Recorded facets (#4960). The options come from the
 * period's UNFILTERED facets read, so they never shrink to the value just
 * chosen; a payer is named as everywhere on the page ("Wallet" with a short
 * address unless it is a contact or the owner's own), and Recorded's values
 * render as words, never as the raw kind.
 */
export function salesFacets(facets: SalesFacets | null): ListFacet[] {
  return [
    {
      id: SALES_FACET_KEYS.product,
      label: 'Product',
      options: (facets?.products ?? []).map((p) => ({ value: p.product_id, label: p.label })),
    },
    {
      id: SALES_FACET_KEYS.payer,
      label: 'Payer',
      options: (facets?.payers ?? []).map((payer) => ({ value: payer.address.toLowerCase(), label: payerSubline(payer, false) })),
    },
    {
      id: SALES_FACET_KEYS.kind,
      label: 'Recorded',
      values: SALES_KINDS,
      options: SALES_KINDS.map((kind) => ({ value: kind, label: SALES_KIND_LABELS[kind] })),
    },
  ]
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading sales" data-testid="sales-skeleton">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-5 shadow-card">
            <Skeleton variant="text" className="h-3 w-24" />
            <Skeleton variant="text" className="mt-2 h-6 w-20" />
            <Skeleton variant="text" className="mt-3 h-3 w-32" />
          </div>
        ))}
      </div>
      <Skeleton variant="rect" className="mt-4 h-56 w-full" />
    </div>
  )
}

const STRIPE_HINT =
  'Sales paid to a Stripe deposit address you registered. They are not in Revenue or in any Haven balance, and this is not your Stripe balance.'

const WITHOUT_PRODUCT_HINT =
  'A payment your kit sent no sale record for. It still counts as revenue; the product is what is missing.'

/**
 * The Sales Overview tab (#4900): totals, the by-day chart, the two
 * breakdowns and the payments list for one period.
 *
 * Every figure is a read of the period, never a sum of loaded rows: the tiles,
 * the chart and both breakdowns come from ONE summary response, and the list's
 * count and revenue line read the same response, so they agree by construction
 * while the rows themselves are paged. Moves from the owner's own accounts or
 * agents are left out of every figure and named once, in the notice.
 *
 * Sales received in Stripe (#4954) are in none of those figures: they have one
 * tile of their own, "Received in Stripe", shown only when the period has one,
 * and the list's summary line names their amount beside Revenue. So each kind
 * agrees with its own rows: the account's rows with the account's tiles, the
 * Stripe rows with the Stripe figure.
 */
export function SalesOverviewTab({
  range,
  currency,
  chainId,
  merchantName,
  onOpenPayment,
  refreshKey = 0,
  controls,
}: {
  range: SalesDayRange
  currency: SalesCurrency
  /** The Sales account's chain: it decides whether USDC is the display currency itself. */
  chainId: number | null
  merchantName: string
  onOpenPayment: (txHash: string) => void
  /** Changes when something the figures describe changed (a sale record cleared): read both again. */
  refreshKey?: number
  /** The payments list's controls, owned by the page's URL state (#4960). */
  controls: SalesListControls
}) {
  // #4960: ONE filter set for every read on the tab — the summary (tiles,
  // chart, both breakdowns), the previous period it is compared with, and the
  // list — so for any filter the figures and the rows describe the same
  // payments. The facet options are the one unfiltered read.
  const filterState = controls.state
  const filters = useMemo(() => salesFiltersFromList(filterState), [filterState])
  const filtered = hasSalesFilters(filters)
  const summary = useSalesSummary(range, filters)
  const previousRange = previousSalesRange(range)
  const previous = useSalesSummary(previousRange, filters)
  const list = useSalesPayments(range, { filters })
  const facetData = useSalesFacets(range)
  const periodTotal = useSalesPeriodTotal(range, filtered)
  const facets = useMemo(() => salesFacets(facetData), [facetData])

  const refetchAll = useRef(() => {})
  refetchAll.current = () => {
    summary.refetch()
    list.refetch()
  }
  const lastKey = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey === lastKey.current) return
    lastKey.current = refreshKey
    refetchAll.current()
  }, [refreshKey])

  // The display rate is today's, the same for every filter: the last summary's
  // is kept so the rows keep their currency while a new filter's summary loads.
  const lastRates = useRef<SalesUsdcRates | null>(null)
  if (summary.data?.usdc_rates) lastRates.current = summary.data.usdc_rates
  const money: SalesMoney = { currency, chainId, rates: lastRates.current ?? undefined }

  const clearFilters = () => {
    controls.bumpSearchEpoch()
    controls.onChange({
      ...controls.state,
      q: '',
      facets: { [SALES_FACET_KEYS.product]: [], [SALES_FACET_KEYS.payer]: [], [SALES_FACET_KEYS.kind]: [] },
    })
  }

  const data = summary.loading || summary.failed ? null : summary.data
  const emptyUnfiltered = data !== null && !filtered && isEmptyPeriod(data)
  // The list (and its toolbar) stays mounted while a filter's figures reload,
  // so the search field keeps its focus and its draft. Without a filter it
  // waits for the first summary, as before, and an empty period has none.
  const showList = filtered || (data !== null && !emptyUnfiltered)
  const revenueText = data !== null ? salesTotalText(data.revenue_raw, money) : null
  const stripeCount = data !== null ? stripeSalesCount(data) : 0
  const stripeText = data !== null && stripeCount > 0 ? salesTotalText(stripeSalesRaw(data), money) : null

  return (
    <div className="mt-6 space-y-4" data-testid="sales-overview">
      <div className="space-y-4">
        <OverviewFigures
          summary={summary}
          previous={previous.data}
          range={range}
          currency={currency}
          money={money}
          filtered={filtered}
        />
      </div>
      {showList ? (
        <div className="pt-2">
          <SalesPaymentsList
            list={list}
            periodTotal={periodTotal}
            revenueText={revenueText}
            stripeText={stripeText}
            money={money}
            merchantName={merchantName}
            onOpenPayment={onOpenPayment}
            controls={controls}
            facets={facets}
            filtered={filtered}
            onClearFilters={clearFilters}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Everything above the list: the tiles, the Stripe tile, the own-moves notice,
 * the by-day chart and both breakdowns, all from the ONE (filtered) summary.
 * While it loads, a skeleton; on a failed read, the retry; a period with no
 * payments says so — unless a filter emptied it, when the list's no-match
 * state under its toolbar says it instead, where the filter can be cleared.
 */
function OverviewFigures({
  summary,
  previous,
  range,
  currency,
  money,
  filtered,
}: {
  summary: ReturnType<typeof useSalesSummary>
  previous: SalesSummary | null
  range: SalesDayRange
  currency: SalesCurrency
  money: SalesMoney
  filtered: boolean
}) {
  const days = salesRangeDays(range)

  if (summary.loading) return <OverviewSkeleton />

  if (summary.failed || summary.data === null) {
    return (
      <div data-testid="sales-error">
        <EmptyState
          title="Sales could not load"
          body="Your payments are unchanged."
          action={
            <Button variant="ghost" size="sm" onClick={summary.refetch}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const data = summary.data

  if (isEmptyPeriod(data)) {
    if (filtered) return null
    return (
      <div data-testid="sales-empty-period">
        <EmptyState
          title="No payments in this period"
          body="Nothing reached your Sales account in these days. A longer period may reach further back."
        />
      </div>
    )
  }
  const change = revenueChangePercent(data, previous)
  const previousRevenueIsZero = previous !== null && previous.revenue_raw === '0'
  const revenueCaption = `vs the ${days} days before`
  const payers = payerCount(data)
  // The payer count is exact only when every payment has a payer on the
  // breakdown; a payment from several wallets at once has none to count.
  const payersExact = data.unattributed.payments === 0
  const revenuePayments = revenueCount(data)
  const averageRaw = revenuePayments > 0 ? String(BigInt(data.revenue_raw || '0') / BigInt(revenuePayments)) : '0'
  const chart = salesChartFormat(money)
  const chartDays = salesChartDays(data, range, chart.rate)
  const productRows = productLines(data, money)
  const payerRows = payerLines(data, money)
  const own = data.own_moves
  const stripeCount = stripeSalesCount(data)
  const stripeText = stripeCount > 0 ? salesTotalText(stripeSalesRaw(data), money) : null

  // #4963: the bars are struck in the display currency, so the values and the
  // axis ticks format them as they are (USDC in token mode).
  const { formatValue, formatTick } = chart
  const chartLabel = `Revenue over ${days} days: ${salesTotalText(data.revenue_raw, money)} from ${plural(revenuePayments, 'payment')}.`

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="sales-tiles">
        <StatTile
          label="Revenue"
          value={salesTotalText(data.revenue_raw, money)}
          {...(change !== null
            ? {
                delta: change,
                polarity: 'neutral' as const,
                deltaCaption: revenueCaption,
                // #4963: the chip's decimal mark follows the figure's (no "+15.9%" beside "23,03 kr").
                ...(chart.rate !== null ? { deltaLocale: currencyLocale(currency) } : {}),
              }
            : previousRevenueIsZero
              ? { footnote: `No sales in the ${days} days before` }
              : {})}
        />
        <StatTile
          label="Sales"
          value={String(revenueCount(data))}
          {...(payersExact ? { footnote: `from ${plural(payers, 'payer')}` } : {})}
        />
        <StatTile label="Average sale" value={salesTotalText(averageRaw, money)} footnote="per payment" />
        <StatTile
          label="Without a product"
          value={String(data.without_product.count)}
          footnote="Paid, but your kit sent no sale record"
          hint={
            <Tooltip label={WITHOUT_PRODUCT_HINT} side="bottom">
              <span
                tabIndex={0}
                role="button"
                aria-label={`What this counts: ${WITHOUT_PRODUCT_HINT}`}
                className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                <Icon icon={Info} className="h-3.5 w-3.5" />
              </span>
            </Tooltip>
          }
        />
      </div>

      {/* #4954: the Stripe figure is its own row, on the same column grid, so
          the account tiles above stay one row of four and the figure reads as
          apart from them, as it is: not in Revenue. */}
      {stripeText !== null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div data-testid="sales-stripe-tile">
            <StatTile
              className="h-full"
              label="Received in Stripe"
              value={stripeText}
              footnote={`${plural(stripeCount, 'sale')}, not in Revenue`}
              hint={
                <Tooltip label={STRIPE_HINT} side="bottom">
                  <span
                    tabIndex={0}
                    role="button"
                    aria-label={`What this counts: ${STRIPE_HINT}`}
                    className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
                  >
                    <Icon icon={Info} className="h-3.5 w-3.5" />
                  </span>
                </Tooltip>
              }
            />
          </div>
        </div>
      ) : null}

      {own.count > 0 ? (
        <NoticeRow>
          <strong className="font-semibold text-[var(--v2-ink)]">Not counted:</strong>{' '}
          {plural(own.count, 'payment')} of {salesAmountText(own.amount_raw, money)} from your own accounts or
          agents. Moves between your accounts are never revenue.
        </NoticeRow>
      ) : null}

      <div data-testid="sales-by-day">
        <Card hover={false} className="overflow-hidden">
          <Card.Header as="h2" title="By day" description="Revenue per day." />
          <div className="px-5 pb-5 pt-2">
            <div className="hidden lg:block">
              <StackedBarChart
                days={chartDays}
                currency={currency}
                ariaLabel={chartLabel}
                formatValue={formatValue}
                formatTick={formatTick}
                hideRefusals
              />
            </div>
            <div className="lg:hidden">
              <StackedBarChart
                days={chartDays}
                currency={currency}
                ariaLabel={chartLabel}
                formatValue={formatValue}
                formatTick={formatTick}
                narrow
                hideRefusals
              />
            </div>
          </div>
        </Card>
      </div>

      {productRows.length > 0 ? (
        <SalesBreakdownCard
          testId="sales-by-product"
          title="By product"
          description="What sold, ranked by revenue."
          nameHeader="Product"
          countHeader="Sales"
          countNoun="sale"
          lines={productRows}
        />
      ) : null}
      {payerRows.length > 0 ? (
        <SalesBreakdownCard
          testId="sales-by-payer"
          title="By payer"
          description="Who paid. Only your contacts and your own agents and accounts are named."
          nameHeader="Payer"
          countHeader="Payments"
          countNoun="payment"
          lines={payerRows}
          lastPaidHeader="Last paid"
        />
      ) : null}
    </>
  )
}

export default SalesOverviewTab
