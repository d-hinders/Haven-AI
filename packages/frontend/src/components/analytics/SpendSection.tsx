'use client'

import { useMemo } from 'react'
import { Card } from '@/components/ui/Card'
import { StackedBarChart, type StackedBarDay } from '@/components/ui/StackedBarChart'
import { MIN_CHARTABLE_DAYS } from '@/components/charts/chart-scale'
import { formatAnalyticsDay, formatAnalyticsValue } from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import type { AnalyticsAgentRow, AnalyticsDayBucket, AnalyticsRange } from '@/types/analytics'

/**
 * The spend-over-time section (#3051; epic #2944's page item 2, slice D's
 * `StackedBarChart` finally on the page). Daily bars stacked by agent, the
 * day's refusals as the marker cap, read off the SAME overview response the
 * tiles and the tables already render from — one request still owns the page.
 *
 * What this file owns is the seam between the wire and the primitive:
 *
 * - `by_day[].spent_by_agent` is keyed by agent id with numeric STRINGS
 *   (slice B books fiat via `::text`); the one string→number parse per figure
 *   happens here, at the row that becomes a segment — the same edge parse
 *   `BalanceSection` performs for its points.
 * - Agent NAMES come from `agents[]`; the series colour comes from the ONE
 *   map the page builds in `lib/analytics-series.ts` (`seriesIndexByAgent`
 *   over the display order) and hands to this section and to `AgentsTable`
 *   alike — the endpoint's `agents[]` is unordered on the wire, so a colour
 *   keyed on wire position would move between requests. An agent id in
 *   `by_day` that is not in `agents[]` cannot happen on this response (both
 *   statements share the tenant + rail scope) but is named rather than
 *   dropped.
 * - **Partial edge buckets.** `range.from`/`to` are UTC instants; `by_day` is
 *   bucketed in `basis.tz`. So a bucket on the window's first or last local
 *   day covers less than a day (the OpenAPI description says so and says the
 *   page should treat them as partial). A bucket whose date is the local date
 *   of `range.from` or `range.to` — and that instant is not local midnight —
 *   is flagged `partial`: the primitive draws it lighter and names it in the
 *   tooltip and the data table, and the note under the chart says WHICH end
 *   is cut (a window whose first day had no activity has no first bucket to
 *   flag, so "first and last" would over-claim). Never dropped: a cut day
 *   with a payment is a day with data, and `analyticsDaysWithData` keeps
 *   counting it. Note `by_day` carries only days WITH activity — the x axis
 *   is one bar per active day, not one per calendar day; the section's
 *   description says so.
 *
 * Below `MIN_CHARTABLE_DAYS` days of data the primitive draws nothing and this
 * section returns null before mounting a card around nothing — the page's
 * sparse branch already withholds the whole charts band, so this is the
 * belt to that brace.
 */

/** `YYYY-MM-DD` of an ISO instant in a zone — the JS twin of the endpoint's
 *  `dayKeyInZone` (`infra/repositories/analytics.ts`). */
function dayKeyInZone(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/** True when the instant is not local midnight in the zone — i.e. a window
 *  boundary that cuts its day. */
function cutsItsDay(iso: string, tz: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return !(get('hour') === '00' && get('minute') === '00' && get('second') === '00')
}

/**
 * Which `by_day` dates are partial under this window and zone. Exported for
 * the test that pins the rule against a boundary the endpoint would produce.
 */
export function partialEdgeDates(range: Pick<AnalyticsRange, 'from' | 'to'>, tz: string): Set<string> {
  const partial = new Set<string>()
  try {
    if (cutsItsDay(range.from, tz)) partial.add(dayKeyInZone(range.from, tz))
    if (cutsItsDay(range.to, tz)) partial.add(dayKeyInZone(range.to, tz))
  } catch {
    // The response echoed a zone this runtime cannot resolve (the endpoint
    // validated it against tzdata, so this is the runtime's list being
    // older). Flag nothing: a UTC re-read would name a date no bucket may
    // carry, and an unmarked full-looking bar is the lesser lie.
    return new Set()
  }
  return partial
}

export function toStackedBarDays(
  byDay: AnalyticsDayBucket[],
  agents: AnalyticsAgentRow[],
  seriesIndexById: Map<string, number>,
  range: Pick<AnalyticsRange, 'from' | 'to'>,
  tz: string,
): StackedBarDay[] {
  const nameById = new Map(agents.map((a) => [a.id, a.name]))
  const partial = partialEdgeDates(range, tz)
  // Segments in display order (the map's insertion order IS the display
  // order), so every bar stacks the agents the same way the table lists them.
  return byDay.map((day) => ({
    label: formatAnalyticsDay(day.date),
    series: Object.entries(day.spent_by_agent)
      .map(([agentId, amount]) => ({
        id: agentId,
        name: nameById.get(agentId) ?? agentId,
        seriesIndex: seriesIndexById.get(agentId) ?? seriesIndexById.size,
        amount: Number(amount),
      }))
      .sort((a, b) => a.seriesIndex - b.seriesIndex),
    refusals: day.refusals,
    partial: partial.has(day.date),
  }))
}

/** Which ends of the plotted range are cut, for the note under the chart. */
export function partialEdges(days: StackedBarDay[]): { first: boolean; last: boolean } {
  return { first: days[0]?.partial === true, last: days.length > 1 && days[days.length - 1]?.partial === true }
}

export function partialNote(edges: { first: boolean; last: boolean }): string | null {
  if (edges.first && edges.last) {
    return 'The first and last bars are drawn lighter: the range starts and ends at this moment, not at midnight, so each covers part of a day.'
  }
  if (edges.last) {
    return 'The last bar is drawn lighter: the range ends at this moment, not at midnight, so it covers part of today.'
  }
  if (edges.first) {
    return 'The first bar is drawn lighter: the range starts at this moment of that day, not at midnight, so it covers part of a day.'
  }
  return null
}

/** The primitive's own sentence shape (#2948): "Spend over 30 days: 1,240 USD across 3 agents, 4 refusals". */
export function spendSummary(days: StackedBarDay[], currency: AnalyticsCurrency, rangeDays: number): string {
  const total = days.reduce((sum, d) => sum + d.series.reduce((s, x) => s + x.amount, 0), 0)
  const agentIds = new Set<string>()
  for (const d of days) for (const s of d.series) agentIds.add(s.id)
  const refusals = days.reduce((sum, d) => sum + (d.refusals ?? 0), 0)
  const agentsClause = `${agentIds.size} agent${agentIds.size === 1 ? '' : 's'}`
  const refusalsClause = `${refusals} refusal${refusals === 1 ? '' : 's'}`
  return `Spend over ${rangeDays} days: ${formatAnalyticsValue(total, currency)} across ${agentsClause}, ${refusalsClause}.`
}

export function SpendSection({
  byDay,
  agents,
  seriesIndexById,
  range,
  tz,
  currency,
  rangeDays,
}: {
  byDay: AnalyticsDayBucket[]
  /** In display order — the page sorts once (`orderAgentsForDisplay`). */
  agents: AnalyticsAgentRow[]
  /** `seriesIndexByAgent(agents, byDay)` — the same map `AgentsTable` reads. */
  seriesIndexById: Map<string, number>
  range: Pick<AnalyticsRange, 'from' | 'to'>
  tz: string
  currency: AnalyticsCurrency
  rangeDays: 7 | 30 | 90
}) {
  const days = useMemo(
    () => toStackedBarDays(byDay, agents, seriesIndexById, range, tz),
    [byDay, agents, seriesIndexById, range, tz],
  )

  if (days.length < MIN_CHARTABLE_DAYS) return null

  const ariaLabel = spendSummary(days, currency, rangeDays)
  const formatValue = (value: number) => formatAnalyticsValue(value, currency)
  const note = partialNote(partialEdges(days))

  return (
    <div data-testid="analytics-spend-section">
      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          title="Spend over time"
          description="One bar per day with activity, stacked by agent, with the days the guardrails refused a payment marked above the bar. Booked values only, in your display currency; days with nothing to show are not drawn."
        />
        <div className="px-5 pb-5 pt-2">
          <div className="hidden lg:block" data-testid="analytics-spend-desktop">
            <StackedBarChart days={days} currency={currency} ariaLabel={ariaLabel} formatValue={formatValue} />
          </div>
          <div className="lg:hidden" data-testid="analytics-spend-narrow">
            <StackedBarChart days={days} currency={currency} ariaLabel={ariaLabel} formatValue={formatValue} narrow />
          </div>
          {note !== null && (
            <p data-testid="analytics-spend-partial-note" className="mt-3 text-xs text-[var(--v2-ink-3)]">
              {note}
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

export default SpendSection
