/**
 * The pure half of the Analytics Revenue side (#4901, epic #4885).
 *
 * The revenue side reads the Sales reads from #4897 (`GET
 * /merchant-sales/summary`) rather than adding a second aggregate to
 * `GET /analytics/overview`, and that choice is the acceptance criterion, not
 * a shortcut:
 *
 *   - "The revenue total for a period equals the Sales page total for the same
 *     period" holds BY CONSTRUCTION — both surfaces read the same endpoint
 *     over the same day range (`salesDayRange`, the Sales page's own period
 *     helper), so there is no second definition of revenue to drift.
 *   - "Revenue figures follow the definition in #4897: no zero-value
 *     transfers, and no transfers from the owner's own accounts or own agents'
 *     delegate addresses" is the read's own rule (`kind <> 'own_move'`, and
 *     zero-value transfers are never indexed), not a rule this page re-applies.
 *   - It adds no SQL under `infra/repositories/`, so the slice stays off the
 *     money path.
 *
 * Everything here is a projection of that one response: the money mode, the
 * per-product chart series, the chart's accessible sentence and the
 * "Not counted" tile's words. The tiles and the chart are the shared
 * primitives (`StatTile`, `StackedBarChart`); nothing in this file draws.
 */

import type { StackedBarDay, StackedBarSeries } from '@/components/ui/StackedBarChart'
import { formatAnalyticsDay } from '@/lib/analytics-format'
import {
  plural,
  revenueCount,
  salesDayKeys,
  salesTotalText,
  usdcOf,
  type SalesCurrency,
  type SalesDayRange,
  type SalesMoney,
  type SalesSummary,
} from '@/lib/sales'

/**
 * How many products the chart names before folding the rest into "Other".
 * `docs/product/design-system.md` § StackedBarChart: five products take the
 * five categorical stops, and the rest fold into ONE "Other" series drawn in
 * neutral ink rather than a sixth stop — so no product is silently given a
 * repeated colour. Which five is the consuming slice's decision; this is it:
 * the five with the most revenue in the period, the order the read already
 * ranks `by_product` in.
 */
export const REVENUE_TOP_PRODUCTS = 5

/** "Other" — the products past the top five, in neutral ink (never a sixth stop). */
export const REVENUE_OTHER_COLOR = 'var(--v2-ink-3)'

/**
 * "No product" — payments that count as revenue but carry no sale record.
 * They are in the Revenue total, so they must be in the chart's stack or the
 * bars would not add up to the tile; they are not a product, so they take the
 * second neutral ink rather than a categorical stop.
 */
export const REVENUE_NO_PRODUCT_COLOR = 'var(--v2-ink-2)'

/** The "Not counted" tile's hint: what the figure is, and what it is not. */
export const OWN_MOVES_HINT =
  'Transfers between your own accounts and agents. They are never revenue and are in no total.'

/** The "Not counted" tile's footnote: how many transfers the figure covers. */
export function ownMovesCaption(count: number): string {
  return count === 0 ? 'No transfers between your accounts' : `${plural(count, 'transfer')} between your accounts`
}

/**
 * How the revenue side strikes its figures: the display currency, the Sales
 * account's chain (it decides whether USDC IS the display currency) and the
 * ONE rate the summary carries (#4963). The same `SalesMoney` the Sales page
 * uses, so a figure on Analytics and the same figure on Sales are formatted by
 * one voice.
 */
export function revenueMoney(
  summary: SalesSummary,
  currency: SalesCurrency,
  chainId: number | null | undefined,
): SalesMoney {
  return { currency, chainId, rates: summary.usdc_rates ?? undefined }
}

function rawOf(value: string | undefined): bigint {
  try {
    return BigInt(value ?? '0')
  } catch {
    return 0n
  }
}

/**
 * One slot per calendar day of the period, stacked by product — the revenue
 * use of `StackedBarChart` (`docs/product/design-system.md` § StackedBarChart).
 *
 * The stack adds up to the day's revenue: the top five products, then "Other"
 * (the products past them, plus the read's own folded `by_product_other`), then
 * "No product" (payments that count as revenue but carry no sale record). A
 * series with no revenue in the whole period is left out; a top-five product
 * keeps its slot on every day, so its colour and its legend row hold across
 * the period. `rate` is the display-currency multiplier (#4963); null keeps
 * USDC.
 */
export function revenueChartDays(
  summary: SalesSummary,
  range: SalesDayRange,
  rate: number | null = null,
): StackedBarDay[] {
  const scale = rate ?? 1
  const top = summary.by_product.slice(0, REVENUE_TOP_PRODUCTS)
  const topIds = new Set(top.map((product) => product.product_id))
  const otherTotal =
    summary.by_product
      .filter((product) => !topIds.has(product.product_id))
      .reduce((sum, product) => sum + rawOf(product.amount_raw), 0n) +
    rawOf(summary.by_product_other.amount_raw)
  const noProductTotal = rawOf(summary.without_product.amount_raw)
  const byDay = new Map(summary.by_day.map((day) => [day.day, day]))

  return salesDayKeys(range).map((day) => {
    const row = byDay.get(day)
    const series: StackedBarSeries[] = top.map((product, index) => ({
      id: `product:${product.product_id}`,
      name: product.label,
      seriesIndex: index,
      amount:
        usdcOf(row?.by_product?.find((entry) => entry.product_id === product.product_id)?.amount_raw ?? '0') *
        scale,
    }))
    if (otherTotal > 0n) {
      const otherRaw =
        (row?.by_product ?? [])
          .filter((entry) => !topIds.has(entry.product_id))
          .reduce((sum, entry) => sum + rawOf(entry.amount_raw), 0n) + rawOf(row?.other_products_raw)
      series.push({
        id: 'other',
        name: 'Other',
        color: REVENUE_OTHER_COLOR,
        amount: usdcOf(otherRaw.toString()) * scale,
      })
    }
    if (noProductTotal > 0n) {
      series.push({
        id: 'no-product',
        name: 'No product',
        color: REVENUE_NO_PRODUCT_COLOR,
        amount: usdcOf(row?.without_product_raw ?? '0') * scale,
      })
    }
    return { label: formatAnalyticsDay(day), series }
  })
}

/**
 * The chart's accessible sentence — the caller owns it because only the caller
 * knows the range's prose. Revenue wording, never the spend wording: a refused
 * payment is not a sale, and this chart draws no refusal mark.
 */
export function revenueChartLabel(summary: SalesSummary, money: SalesMoney, days: number): string {
  return `Revenue over ${days} days: ${salesTotalText(summary.revenue_raw, money)} from ${plural(
    revenueCount(summary),
    'payment',
  )}.`
}
