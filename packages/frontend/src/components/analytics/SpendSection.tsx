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
 * - Agent NAMES and the series colour come from `agents[]`, in the order the
 *   endpoint sent them (ranked by spend). `seriesIndex` is the agent's index
 *   in that array and is HELD there for every day, which is what lets the
 *   agents table beside this chart show the same colour for the same agent
 *   (`AgentsTable`'s name-cell swatch reads the same index). An agent id in
 *   `by_day` that is not in `agents[]` cannot happen on this response — the
 *   endpoint's agent list is every delegation-rail agent the tenant owns —
 *   but the fallback names the id rather than dropping the money.
 * - **Partial edge buckets.** `range.from`/`to` are UTC instants; `by_day` is
 *   bucketed in `basis.tz`. So the first and last bucket usually cover less
 *   than a local day (the OpenAPI description says so and says the page
 *   should treat them as partial). A bucket whose date is the local date of
 *   `range.from` or `range.to` — and that instant is not local midnight — is
 *   flagged `partial`: the primitive draws it lighter and names it in the
 *   tooltip and the data table. It is never dropped: a cut day with a payment
 *   is a day with data, and `analyticsDaysWithData` keeps counting it.
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
  let zone = tz
  try {
    dayKeyInZone(range.from, zone)
  } catch {
    // An unrecognised zone here means the response echoed one the runtime
    // cannot resolve; the endpoint validated it against tzdata, so this is
    // the runtime's list being older, not bad data. UTC is the documented
    // default the endpoint itself falls back to.
    zone = 'UTC'
  }
  if (cutsItsDay(range.from, zone)) partial.add(dayKeyInZone(range.from, zone))
  if (cutsItsDay(range.to, zone)) partial.add(dayKeyInZone(range.to, zone))
  return partial
}

export function toStackedBarDays(
  byDay: AnalyticsDayBucket[],
  agents: AnalyticsAgentRow[],
  range: Pick<AnalyticsRange, 'from' | 'to'>,
  tz: string,
): StackedBarDay[] {
  const indexById = new Map(agents.map((a, i) => [a.id, i]))
  const nameById = new Map(agents.map((a) => [a.id, a.name]))
  const partial = partialEdgeDates(range, tz)
  return byDay.map((day) => ({
    label: formatAnalyticsDay(day.date),
    series: Object.entries(day.spent_by_agent).map(([agentId, amount]) => ({
      id: agentId,
      name: nameById.get(agentId) ?? agentId,
      // An id outside `agents[]` gets the index past the last agent, so it
      // still has a stable colour rather than colliding with agent 0.
      seriesIndex: indexById.get(agentId) ?? agents.length,
      amount: Number(amount),
    })),
    refusals: day.refusals,
    partial: partial.has(day.date),
  }))
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
  range,
  tz,
  currency,
  rangeDays,
}: {
  byDay: AnalyticsDayBucket[]
  agents: AnalyticsAgentRow[]
  range: Pick<AnalyticsRange, 'from' | 'to'>
  tz: string
  currency: AnalyticsCurrency
  rangeDays: 7 | 30 | 90
}) {
  const days = useMemo(() => toStackedBarDays(byDay, agents, range, tz), [byDay, agents, range, tz])

  if (days.length < MIN_CHARTABLE_DAYS) return null

  const ariaLabel = spendSummary(days, currency, rangeDays)
  const formatValue = (value: number) => formatAnalyticsValue(value, currency)
  const hasPartial = days.some((d) => d.partial)

  return (
    <div data-testid="analytics-spend-section">
      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          title="Spend over time"
          description="What your agents spent each day, stacked by agent, with the days the guardrails refused a payment marked above the bar. Booked values only, in your display currency."
        />
        <div className="px-5 pb-5 pt-2">
          <div className="hidden lg:block">
            <StackedBarChart days={days} currency={currency} ariaLabel={ariaLabel} formatValue={formatValue} />
          </div>
          <div className="lg:hidden">
            <StackedBarChart days={days} currency={currency} ariaLabel={ariaLabel} formatValue={formatValue} narrow />
          </div>
          {hasPartial && (
            <p data-testid="analytics-spend-partial-note" className="mt-3 text-xs text-[var(--v2-ink-3)]">
              The first and last day are drawn lighter: the range starts and ends at this moment, not at
              midnight, so those two bars cover part of a day.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

export default SpendSection
