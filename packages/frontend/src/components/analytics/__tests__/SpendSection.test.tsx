import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SpendSection, partialEdgeDates, partialEdges, partialNote, spendSummary, toStackedBarDays } from '../SpendSection'
import { orderAgentsForDisplay, seriesIndexByAgent } from '@/lib/analytics-series'
import { seriesColor } from '@/components/ui/StackedBarChart'
import { formatAnalyticsValue } from '@/lib/analytics-format'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../../scripts/screenshot.mjs'
import type { AnalyticsAgentRow, AnalyticsDayBucket, AnalyticsOverviewResponse } from '@/types/analytics'

/**
 * The seam between `GET /analytics/overview`'s `by_day` and slice D's
 * `StackedBarChart` (#3051). The fixture is the harness's own populated
 * overview: two agents, four days, refusals on the last two — the dataset
 * the visual baselines are captured from, so what is pinned here is what a
 * reader of the capture sees.
 */
const POPULATED = FIXTURE_ANALYTICS_OVERVIEW as AnalyticsOverviewResponse
const AGENTS = orderAgentsForDisplay(POPULATED.agents as AnalyticsAgentRow[])
const BY_DAY = POPULATED.by_day as AnalyticsDayBucket[]
const SERIES = seriesIndexByAgent(AGENTS, BY_DAY)
const render6 = (byDay: AnalyticsDayBucket[], range: { from: string; to: string }, tz: string) =>
  render(
    <SpendSection byDay={byDay} agents={AGENTS} seriesIndexById={seriesIndexByAgent(AGENTS, byDay)} range={range} tz={tz} currency="USD" rangeDays={30} />,
  )

/** A window whose edges are NOT midnight in Stockholm: 07 Jul 09:30 → 10 Jul 09:30 UTC. */
const CUT_RANGE = { from: '2026-07-07T09:30:00.000Z', to: '2026-07-10T09:30:00.000Z' }
/** The same dates, but the window starts and ends exactly at Stockholm midnight (UTC+2). */
const ALIGNED_RANGE = { from: '2026-07-06T22:00:00.000Z', to: '2026-07-10T22:00:00.000Z' }

describe('toStackedBarDays — the wire becomes the primitive input', () => {
  it('keys every segment to the agent name and its index in agents[], the order the endpoint sent', () => {
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, ALIGNED_RANGE, 'Europe/Stockholm')
    expect(days).toHaveLength(BY_DAY.length)
    const first = days[0]!
    expect(first.series.map((s) => s.name)).toEqual(['Research agent', 'Data-feed agent'])
    expect(first.series.map((s) => s.seriesIndex)).toEqual([0, 1])
    // The one string→number parse, at the row: "85.75" → 85.75, not a
    // re-typed wire.
    expect(first.series[0]!.amount).toBe(85.75)
    expect(first.label).toBe('7 Jul')
  })

  it('carries the day refusals onto the bar, and only where the endpoint counted some', () => {
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, ALIGNED_RANGE, 'Europe/Stockholm')
    expect(days.map((d) => d.refusals)).toEqual([0, 0, 1, 1])
  })

  it('stacks every bar in display order even when the wire lists the agents the other way round', () => {
    // The endpoint's `spent_by_agent` key order is the SQL's row order; the
    // page's display order is spend-desc. A bucket keyed retired-first must
    // still stack research (index 0) first.
    const reversed: AnalyticsDayBucket[] = [
      { date: '2026-07-07', spent_by_agent: { 'agent-retired': '12.50', 'agent-research': '85.75' }, refusals: 0 },
    ]
    const [day] = toStackedBarDays(reversed, AGENTS, seriesIndexByAgent(AGENTS, reversed), ALIGNED_RANGE, 'UTC')
    expect(day!.series.map((s) => [s.id, s.seriesIndex])).toEqual([
      ['agent-research', 0],
      ['agent-retired', 1],
    ])
  })

  it('gives two stray ids two different colours', () => {
    const stray: AnalyticsDayBucket[] = [{ date: '2026-07-07', spent_by_agent: { x: '1', y: '2' }, refusals: 0 }]
    const [day] = toStackedBarDays(stray, AGENTS, new Map([['c', 0]]), ALIGNED_RANGE, 'UTC')
    expect(day!.series.map((s) => s.seriesIndex)).toEqual([1, 2])
  })

  it('names an agent id the roster does not carry rather than dropping its money, on a colour past the roster', () => {
    const stray: AnalyticsDayBucket[] = [
      { date: '2026-07-07', spent_by_agent: { 'agent-ghost': '3.00' }, refusals: 0 },
    ]
    const [day] = toStackedBarDays(stray, AGENTS, seriesIndexByAgent(AGENTS, stray), ALIGNED_RANGE, 'UTC')
    expect(day!.series[0]).toMatchObject({ name: 'agent-ghost', seriesIndex: 0, amount: 3 })
  })
})

describe('partial edge buckets — the window cuts its first and last day', () => {
  it('flags the local dates of from and to when the instants are not local midnight', () => {
    // 09:30Z is 11:30 in Stockholm on both days: both edges cut their day.
    expect([...partialEdgeDates(CUT_RANGE, 'Europe/Stockholm')].sort()).toEqual(['2026-07-07', '2026-07-10'])
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, CUT_RANGE, 'Europe/Stockholm')
    expect(days.map((d) => d.partial)).toEqual([true, false, false, true])
  })

  it('flags nothing when the window is aligned to local midnight', () => {
    expect(partialEdgeDates(ALIGNED_RANGE, 'Europe/Stockholm').size).toBe(0)
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, ALIGNED_RANGE, 'Europe/Stockholm')
    expect(days.every((d) => d.partial === false)).toBe(true)
  })

  it('reads the boundary in the zone the response was bucketed in, not in UTC', () => {
    // 22:00Z is midnight in Stockholm but 22:00 in UTC: the same instants are
    // aligned in one zone and cut in the other.
    expect(partialEdgeDates(ALIGNED_RANGE, 'UTC').size).toBe(2)
  })

  it('flags nothing for a zone this runtime cannot resolve, rather than throwing or guessing UTC', () => {
    expect(partialEdgeDates(CUT_RANGE, 'Mars/Olympus_Mons').size).toBe(0)
  })

  it('says which end is cut, not always both', () => {
    expect(partialNote({ first: true, last: true })).toMatch(/^The first and last bars are striped/)
    expect(partialNote({ first: false, last: true })).toMatch(/^The last bar is striped/)
    expect(partialNote({ first: true, last: false })).toMatch(/^The first bar is striped/)
    expect(partialNote({ first: false, last: false })).toBeNull()
    // Only the LAST bucket flagged when the window's first day had no activity.
    const lastOnly = toStackedBarDays(BY_DAY, AGENTS, SERIES, { from: '2026-06-10T14:30:00.000Z', to: '2026-07-10T14:30:00.000Z' }, 'UTC')
    expect(partialEdges(lastOnly)).toEqual({ first: false, last: true })
  })
})

describe('spendSummary — the accessible sentence in the primitive shape', () => {
  it('states the total, the agent count and the refusals over the window', () => {
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, ALIGNED_RANGE, 'UTC')
    expect(spendSummary(days, 'USD', 30)).toBe('Spend over 30 days: $324.75 across 2 agents, 2 refusals.')
  })

  it('singularises', () => {
    const oneDay = [{ date: '2026-07-07', spent_by_agent: { 'agent-research': '10.00' }, refusals: 1 }]
    const one = toStackedBarDays(oneDay, AGENTS, seriesIndexByAgent(AGENTS, oneDay), ALIGNED_RANGE, 'UTC')
    // `formatAnalyticsValue` owns the de-DE spacing (a non-breaking space before €); the sentence around it is what this pins.
    expect(spendSummary(one, 'EUR', 7)).toBe(`Spend over 7 days: ${formatAnalyticsValue(10, 'EUR')} across 1 agent, 1 refusal.`)
  })
})

describe('SpendSection — on the page', () => {
  it('renders the chart pair (desktop + narrow) under its own heading, off the response', () => {
    const { container } = render6(BY_DAY, ALIGNED_RANGE, 'UTC')
    expect(screen.getByRole('heading', { name: 'Spend over time' })).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="stacked-bar-chart"]')).toHaveLength(2)
    expect(screen.getAllByRole('img', { name: /Spend over 30 days: \$324\.75 across 2 agents, 2 refusals\./ })).toHaveLength(2)
  })

  it('paints agent i in the same series token the agents table swatch reads for row i', () => {
    const { container } = render6(BY_DAY, ALIGNED_RANGE, 'UTC')
    const chart = container.querySelector('[data-testid="stacked-bar-chart"]')!
    const firstDay = within(chart as HTMLElement).getAllByTestId('chart-day')[0]!
    const segments = firstDay.querySelectorAll('[data-testid="chart-segment"]')
    expect(segments[0]!.getAttribute('fill')).toBe(seriesColor(0))
    expect(segments[1]!.getAttribute('fill')).toBe(seriesColor(1))
  })

  it('says on the face of the card when the edge bars are partial, and stays quiet when they are not', () => {
    const cut = render6(BY_DAY, CUT_RANGE, 'Europe/Stockholm')
    expect(cut.container.querySelector('[data-testid="analytics-spend-partial-note"]')).not.toBeNull()
    expect(cut.container.querySelectorAll('[data-testid="chart-day"][data-partial="true"]')).toHaveLength(4) // 2 per chart
    cut.unmount()
    const aligned = render6(BY_DAY, ALIGNED_RANGE, 'Europe/Stockholm')
    expect(aligned.container.querySelector('[data-testid="analytics-spend-partial-note"]')).toBeNull()
  })

  it('keeps the desktop chart in the lg-only wrapper and the narrow chart in the below-lg wrapper (the pair is one chart)', () => {
    const { container } = render6(BY_DAY, ALIGNED_RANGE, 'UTC')
    const desktop = container.querySelector('[data-testid="analytics-spend-desktop"]')!
    const narrow = container.querySelector('[data-testid="analytics-spend-narrow"]')!
    expect(desktop.className).toContain('hidden')
    expect(desktop.className).toContain('lg:block')
    expect(narrow.className).toContain('lg:hidden')
    // The narrow rendering is the one with the dot legend (a wrapping row);
    // the desktop one lists the legend as a column — the primitive's own tell.
    expect(within(narrow as HTMLElement).getByTestId('chart-legend').className).toContain('flex-wrap')
    expect(within(desktop as HTMLElement).getByTestId('chart-legend').className).toContain('flex-col')
  })

  it('renders nothing below the chartable floor, so no card wraps an empty plot', () => {
    const { container } = render6(BY_DAY.slice(0, 2), ALIGNED_RANGE, 'UTC')
    expect(container.innerHTML).toBe('')
  })
})
