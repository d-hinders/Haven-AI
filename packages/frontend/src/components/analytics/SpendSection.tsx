'use client'

import { useMemo } from 'react'
import { CircleDollarSign } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { StackedBarChart, type StackedBarDay } from '@/components/ui/StackedBarChart'
import { formatAnalyticsDay, formatAnalyticsTick, formatAnalyticsValue } from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import type { AnalyticsAgentRow, AnalyticsDayBucket, AnalyticsRange } from '@/types/analytics'

/**
 * The spend-over-time section (#3051; epic #2944's page item 2, slice D;
 * the continuous axis #4334). Daily bars stacked by agent — one slot for
 * EVERY local calendar date the window touches, empty days included — read
 * off the SAME overview response the tiles and the tables already render
 * from; one request still owns the page.
 *
 * What this file owns is the seam between the wire and the primitive:
 *
 * - `by_day[].spent_by_agent` is keyed by agent id with numeric STRINGS
 *   (slice B books fiat via `::text`); the one string→number parse per figure
 *   happens here, at the row that becomes a segment — the same edge parse
 *   `BalanceSection` performs for its points.
 * - Agent NAMES come from `agents[]`; the series colour comes from the ONE
 *   map the page builds in `lib/analytics-series.ts`
 *   (`seriesColorByAgent` — the agent's own avatar tint, #4331) and hands
 *   to this section. The fill is the agent's STORED tint (#4428), so it holds
 *   across periods and rank moves and two agents whose names hash alike are
 *   drawn in different colours; two agents that share a tint are told apart
 *   by name in the legend and tooltip.
 * - **A continuous day axis (#4334).** The window is
 *   `[now − N×24h, now)` bucketed by local day, so it touches N local dates
 *   when `now` is local midnight and N+1 otherwise; the section enumerates
 *   every one of them (`windowDates`) and hands the primitive a slot per
 *   date — a day with no spend is an EMPTY slot, not a skipped column, so
 *   the chart reads as time. (Before #4334 the axis was one bar per day
 *   with activity, which drew spend as a scatter with the calendar
 *   missing.) A bucket whose date is the local date of `range.from` or
 *   `range.to` — and that instant is not local midnight — is flagged
 *   `partial`: the primitive hatches it and names it in the tooltip and the
 *   data table, and the note under the chart says WHICH end is cut. Never
 *   dropped: a cut day with a payment is a day with data, and
 *   `analyticsDaysWithData` keeps counting it. `by_day` carries only days
 *   WITH activity; the enumeration is what turns that into a calendar.
 * - **The sparse rule is now only the no-activity one.** A window with ANY
 *   activity draws the chart however few days carry it (the chart's own
 *   `MIN_CHARTABLE_DAYS` floor still holds below three SLOTS — unreachable
 *   from a real 7/30/90 window, which yields ≥ 8). A period with no
 *   activity at all (`by_day` empty — an agent-scoped response's way of
 *   saying "this agent spent and refused nothing here") renders the
 *   section's empty state instead of a card around an empty plot.
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

/** The day before a `YYYY-MM-DD` key, by UTC arithmetic — safe across month
 *  and year edges (`2026-07-01` → `2026-06-30`), because the key IS a UTC
 *  date and `Date.UTC` normalises the underflow. */
function previousDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Every local calendar date the window `[from, to)` touches, ascending, in
 * the zone (#4334) — the continuous axis's input. The window is
 * `[now − N×24h, now)`, so it touches N dates when `now` is exactly local
 * midnight (`to` inclusive of nothing on its own date) and N+1 otherwise;
 * both edge dates are always drawn, and `partialEdgeDates` flags the cut
 * ones. Stepping the instant by exactly 24h crosses exactly one local
 * midnight per step (a calendar day is 23–25h, never more or less than one
 * midnight wide), so the local date advances by exactly one per step —
 * DST transitions cannot skip or repeat a date. Exported for the tests that
 * pin the N/N+1 rule against 7-, 30- and 90-day windows.
 */
export function windowDates(
  range: Pick<AnalyticsRange, 'from' | 'to'>,
  tz: string,
  byDay: AnalyticsDayBucket[] = [],
): string[] {
  try {
    // The half-open window: when `to` is exactly local midnight, its own
    // date is touched only at the excluded endpoint — the last date is the
    // one before it. When it cuts its day, its date is in the window.
    const lastKey = cutsItsDay(range.to, tz)
      ? dayKeyInZone(range.to, tz)
      : previousDayKey(dayKeyInZone(range.to, tz))
    const start = new Date(range.from).getTime()
    const end = new Date(range.to).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    const keys: string[] = []
    for (let t = start; keys.length <= 400; t += 24 * 60 * 60 * 1000) {
      const key = dayKeyInZone(new Date(t).toISOString(), tz)
      if (key > lastKey) break
      keys.push(key)
    }
    return keys
  } catch {
    // The response echoed a zone this runtime cannot resolve (the endpoint
    // validated it against tzdata, so this is the runtime's list being
    // older — the same case `partialEdgeDates` meets). Fall back to the
    // dates the response itself carries rather than drawing nothing: a
    // gappy axis is the lesser lie next to a blank one.
    return [...new Set(byDay.map((d) => d.date))].sort()
  }
}

/**
 * The wire becomes the primitive's input: one slot per local calendar date
 * the window touches (#4334), the day's `by_day` row — agents in display
 * order, amounts parsed, refusals and partial flags carried — or an EMPTY
 * slot where the window has a date the response has no activity for.
 */
export function toStackedBarDays(
  byDay: AnalyticsDayBucket[],
  agents: AnalyticsAgentRow[],
  agentColors: Map<string, string>,
  range: Pick<AnalyticsRange, 'from' | 'to'>,
  tz: string,
): StackedBarDay[] {
  const nameById = new Map(agents.map((a) => [a.id, a.name]))
  const partial = partialEdgeDates(range, tz)
  // Segments in display order — the wire's `spent_by_agent` key order is the
  // SQL's row order, not the page's — so every bar stacks the agents the same
  // way the table lists them. An id the roster does not carry stacks last,
  // in the order it was met (the sort is stable).
  const position = new Map(agents.map((agent, index) => [agent.id, index]))
  const orderOf = (agentId: string): number => position.get(agentId) ?? agents.length
  // The fill is the agent's avatar tint (`seriesColorByAgent`, #4331) — its
  // stored tint (#4428), so it survives re-ranking and two agents whose names
  // hash alike are drawn in different colours. An id the map does not carry
  // (not producible by this endpoint) gets the neutral ink rather than a
  // silent fall-through to the first series token.
  const buckets = new Map(byDay.map((day) => [day.date, day]))
  return windowDates(range, tz, byDay).map((date) => {
    const day = buckets.get(date)
    return {
      label: formatAnalyticsDay(date),
      series: day
        ? Object.entries(day.spent_by_agent)
            .map(([agentId, amount]) => ({
              id: agentId,
              name: nameById.get(agentId) ?? agentId,
              color: agentColors.get(agentId) ?? 'var(--v2-ink-3)',
              amount: Number(amount),
            }))
            .sort((a, b) => orderOf(a.id) - orderOf(b.id))
        : [],
      refusals: day?.refusals ?? 0,
      partial: partial.has(date),
    }
  })
}

/** Which ends of the plotted range are cut, for the note under the chart. A
 *  partial day with no spend is an EMPTY slot (#4334) — the tooltip and the
 *  data table still name it partial, but there is no bar to stripe, so the
 *  note only claims stripes that are actually drawn. */
export function partialEdges(days: StackedBarDay[]): { first: boolean; last: boolean } {
  const striped = (day?: StackedBarDay) => day?.partial === true && day.series.length > 0
  return { first: striped(days[0]), last: days.length > 1 && striped(days[days.length - 1]) }
}

export function partialNote(edges: { first: boolean; last: boolean }): string | null {
  if (edges.first && edges.last) {
    return 'The first and last bars are striped: the range starts and ends at this moment, not at midnight, so each covers part of a day.'
  }
  if (edges.last) {
    return 'The last bar is striped: the range ends at this moment, not at midnight, so it covers part of today.'
  }
  if (edges.first) {
    return 'The first bar is striped: the range starts at this moment of that day, not at midnight, so it covers part of a day.'
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

/** The card's subtitle (#4334), verbatim from the issue. */
const SPEND_SUBTITLE = 'Spend per day, by agent. Grey marks under a day are refused attempts.'

export function SpendSection({
  byDay,
  agents,
  agentColors,
  range,
  tz,
  currency,
  rangeDays,
}: {
  byDay: AnalyticsDayBucket[]
  /** In display order — the page sorts once (`orderAgentsForDisplay`). */
  agents: AnalyticsAgentRow[]
  /** `seriesColorByAgent(agents, byDay)` — the agent → avatar-tint map (#4331). */
  agentColors: Map<string, string>
  range: Pick<AnalyticsRange, 'from' | 'to'>
  tz: string
  currency: AnalyticsCurrency
  rangeDays: 7 | 30 | 90
}) {
  const days = useMemo(
    () => toStackedBarDays(byDay, agents, agentColors, range, tz),
    [byDay, agents, agentColors, range, tz],
  )

  // The section's own sparse rule is now only the no-activity one (#4334):
  // a window with any activity draws the calendar however few days carry
  // it; a period with NOTHING — the agent-scoped response's empty `by_day`
  // — renders the empty state instead of a card around an empty plot.
  if (byDay.length === 0) {
    return (
      <div data-testid="analytics-spend-section">
        <Card hover={false} className="overflow-hidden">
          <Card.Header as="h2" title="Spend over time" description={SPEND_SUBTITLE} />
          <div className="px-5 pb-5 pt-2">
            <EmptyState
              icon={<Icon icon={CircleDollarSign} className="w-full h-full" />}
              tone="neutral"
              title="No spend in this window"
              body="Nothing was booked or refused on any day of this range. A longer range may reach further back."
            />
          </div>
        </Card>
      </div>
    )
  }

  const ariaLabel = spendSummary(days, currency, rangeDays)
  const formatValue = (value: number) => formatAnalyticsValue(value, currency)
  // Tick decimals come from the scale's own step (#4334): a sub-cent peak
  // reads "$0.0010 … $0.0040" instead of "$0, $0"; a whole-unit step keeps
  // the old compact voice (`$1,240`) that fits the gutter (#3051).
  const formatTick = (value: number, step: number) => formatAnalyticsTick(value, step, currency)
  const note = partialNote(partialEdges(days))

  return (
    <div data-testid="analytics-spend-section">
      <Card hover={false} className="overflow-hidden">
        <Card.Header
          as="h2"
          title="Spend over time"
          description={SPEND_SUBTITLE}
        />
        <div className="px-5 pb-5 pt-2">
          <div className="hidden lg:block" data-testid="analytics-spend-desktop">
            <StackedBarChart days={days} currency={currency} ariaLabel={ariaLabel} formatValue={formatValue} formatTick={formatTick} />
          </div>
          <div className="lg:hidden" data-testid="analytics-spend-narrow">
            <StackedBarChart days={days} currency={currency} ariaLabel={ariaLabel} formatValue={formatValue} formatTick={formatTick} narrow />
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
