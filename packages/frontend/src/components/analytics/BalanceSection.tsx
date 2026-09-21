'use client'

import { useMemo } from 'react'
import { AreaChart, deltaLabel } from '@/components/ui/AreaChart'
import type { AreaPoint } from '@/components/ui/AreaChart'
import { formatAnalyticsDay, formatAnalyticsTick, formatAnalyticsValue } from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import { MIN_CHARTABLE_DAYS } from '@/components/charts/chart-scale'
import { Card } from '@/components/ui/Card'
import type { AnalyticsBalanceDay } from '@/types/analytics'

/**
 * The balance-over-time section (#2949, epic #2944 slice E), wired to
 * `balance_by_day` on the shared overview response.
 *
 * What this file owns is the seam between the wire and slice D's
 * `AreaChart` primitive, and the seam is exactly one line wide: the wire's
 * `balance_by_day[].value` is a numeric STRING (slice B books fiat through
 * `::text` and the route passes it through uncoerced, #2946), while the
 * primitive's `AreaPoint.value` is a number it can scale, subtract and put on
 * an axis. So the parse happens HERE, once, where the row becomes a point —
 * the same edge `lib/analytics-format` parses at for the tiles. Everywhere
 * downstream of that mapping the value is a number because a chart has to
 * arithmetic on it, and everywhere upstream of it the value is the string the
 * endpoint sent. Neither the fixture nor the generated type is re-typed to
 * make this convenient; the conversion sits at the boundary, where it can be
 * read and audited.
 *
 * ── The label the section gives the reader ───────────────────────────────────
 *
 * The heading and its sentence come from `docs/product/analytics.md` §
 * "Balance over time": this is what the account HELD, as Haven's daily
 * snapshots recorded it, not what it is worth right now. Saying so on the
 * face of the card is what distinguishes it from the balances/portfolio
 * surfaces, which value tokens at whatever the current price is. A number
 * that is a record and a number that is a valuation, side by side and
 * unlabeled, is the pair readers mix up; the sentence is the label.
 *
 * ── When the section renders nothing at all ──────────────────────────────────
 *
 * `AreaChart` refuses to draw below `MIN_CHARTABLE_DAYS` points (slice D's
 * rule: a line through two points agrees with every trend whatsoever and so
 * proves none). This section applies the same floor BEFORE rendering the card,
 * not after, because a card frame around an empty plot is a blank region the
 * reader has to diagnose — the defect the page's other empty states exist to
 * avoid. There are three cases and they are distinct: no rows at all (the
 * whole-window empty state upstream answers that), too few rows (this guard),
 * and enough rows (the chart). Only the middle one is this file's to decide.
 *
 * ── The two renderings ───────────────────────────────────────────────────────
 *
 * `narrow` is the primitive's prop and this caller's decision (the split the
 * primitive's header documents: the caller owns breakpoints, the primitive
 * owns the treatment). The same complementary `hidden lg:block` /
 * `lg:hidden` pair the two tables on this page use, so exactly one figure is
 * displayed at any width, and the one that is displayed is the one whose
 * label density and tooltip behaviour were chosen for that width.
 */

/** The day the range ends, in the same voice the chart's own axis uses. */
function balancePoints(rows: AnalyticsBalanceDay[]): AreaPoint[] {
  // The one string→number parse in this slice. `Number()` on the wire's
  // numeric string, at the row that becomes the point: see the header.
  return rows.map((row) => ({
    label: formatAnalyticsDay(row.date),
    value: Number(row.value),
  }))
}

/**
 * The accessible name of the figure, computed from the very array the chart
 * draws — the design-system precedent (#2948): a summary sentence typed next
 * to the data can drift from it, a summary computed from it cannot. The word
 * before the endpoint delta is the primitive's own `deltaLabel`, so the
 * sentence and the annotation on the plot can never call the same movement
 * two different things.
 */
function balanceSummary(points: AreaPoint[], currency: AnalyticsCurrency, days: number): string {
  const first = points[0]?.value ?? 0
  const last = points.at(-1)?.value ?? 0
  const delta = last - first
  const opening = `Balance over ${days} days: started at ${formatAnalyticsValue(first, currency)}`
  const ending = ` and ended at ${formatAnalyticsValue(last, currency)}`
  if (delta === 0) return `${opening}${ending}, unchanged across the range.`
  // The verb is the primitive's own: the sentence and the annotation printed
  // on the plot can then never call the same movement two different things.
  return `${opening}${ending}, ${formatAnalyticsValue(Math.abs(delta), currency)} ${deltaLabel(delta)} across the range.`
}

export function BalanceSection({
  balanceByDay,
  currency,
  rangeDays,
}: {
  /** `overview.balance_by_day`, uncoerced: each `value` is a numeric string. */
  balanceByDay: AnalyticsBalanceDay[]
  currency: AnalyticsCurrency
  /** The window the figures cover, from the response's own `range.days`. */
  rangeDays: 7 | 30 | 90
}) {
  const points = useMemo(() => balancePoints(balanceByDay), [balanceByDay])

  // The sparse floor, before any drawing and before any hook could see a
  // half-drawn card: see the header.
  if (points.length < MIN_CHARTABLE_DAYS) return null

  const ariaLabel = balanceSummary(points, currency, rangeDays)
  const formatValue = (value: number) => formatAnalyticsValue(value, currency)
  // Ticks without cents, the same rule the spend chart keeps: the gutter is
  // narrow on a phone and a tick is a round scale value, never a figure.
  const formatTick = (value: number) => formatAnalyticsTick(value, currency)

  return (
    <div data-testid="analytics-balance-section">
      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          title="Balance over time"
          description="What your Haven account held, as Haven’s daily snapshots recorded it at each day’s end. This is a record of what was held, not a live valuation."
        />
        <div className="px-5 pb-5 pt-2">
          <div className="hidden lg:block">
            <AreaChart
              points={points}
              currency={currency}
              ariaLabel={ariaLabel}
              formatValue={formatValue}
              formatTick={formatTick}
            />
          </div>
          <div className="lg:hidden">
            <AreaChart
              points={points}
              currency={currency}
              ariaLabel={ariaLabel}
              formatValue={formatValue}
              formatTick={formatTick}
              narrow
            />
          </div>
        </div>
      </Card>
    </div>
  )
}

export default BalanceSection
