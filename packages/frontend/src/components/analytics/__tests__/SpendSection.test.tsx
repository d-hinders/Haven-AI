import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SpendSection, partialEdgeDates, partialEdges, partialNote, spendSummary, toStackedBarDays, windowDates } from '../SpendSection'
import { orderAgentsForDisplay, seriesColorByAgent } from '@/lib/analytics-series'
import { seriesColorForAgent } from '@/lib/avatar-tint'
import { formatAnalyticsValue } from '@/lib/analytics-format'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../../scripts/screenshot.mjs'
import type { AnalyticsAgentRow, AnalyticsDayBucket, AnalyticsOverviewResponse } from '@/types/analytics'

/**
 * The seam between `GET /analytics/overview`'s `by_day` and slice D's
 * `StackedBarChart` (#3051). The fixture is the harness's own populated
 * overview: two agents, four days, refusals on the last two — the dataset
 * the visual baselines are captured from, so what is pinned here is what a
 * reader of the capture sees. Since #4334 the section turns those four
 * activity days into a CONTINUOUS axis: every local date the window
 * touches gets a slot, empty days included.
 */
const POPULATED = FIXTURE_ANALYTICS_OVERVIEW as AnalyticsOverviewResponse
const AGENTS = orderAgentsForDisplay(POPULATED.agents as AnalyticsAgentRow[])
const BY_DAY = POPULATED.by_day as AnalyticsDayBucket[]
const SERIES = seriesColorByAgent(AGENTS, BY_DAY)
const render6 = (byDay: AnalyticsDayBucket[], range: { from: string; to: string }, tz: string) =>
  render(
    <SpendSection byDay={byDay} agents={AGENTS} agentColors={seriesColorByAgent(AGENTS, byDay)} range={range} tz={tz} currency="USD" rangeDays={30} />,
  )

/** A window whose edges are NOT midnight in Stockholm: 07 Jul 09:30 → 10 Jul 09:30 UTC. */
const CUT_RANGE = { from: '2026-07-07T09:30:00.000Z', to: '2026-07-10T09:30:00.000Z' }
/** The same dates, but the window starts and ends exactly at Stockholm midnight (UTC+2). */
const ALIGNED_RANGE = { from: '2026-07-06T22:00:00.000Z', to: '2026-07-10T22:00:00.000Z' }
/** The fixture's own 30-day window (14:30Z edges): 31 local dates, UTC. */
const THIRTY_DAY_CUT = { from: '2026-06-10T14:30:00.000Z', to: '2026-07-10T14:30:00.000Z' }

describe('toStackedBarDays — the wire becomes the primitive input', () => {
  it('keys every segment to the agent name and its own avatar tint, the colour its monogram wears', () => {
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, ALIGNED_RANGE, 'Europe/Stockholm')
    expect(days).toHaveLength(BY_DAY.length)
    const first = days[0]!
    expect(first.series.map((s) => s.name)).toEqual(['Research agent', 'Data-feed agent'])
    // One colour per agent (#4331): the fill is the agent's avatar tint,
    // hashed from the NAME — not a rank index — so it is stable across
    // periods, pages and re-rankings.
    expect(first.series.map((s) => s.color)).toEqual([
      seriesColorForAgent('Research agent'),
      seriesColorForAgent('Data-feed agent'),
    ])
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
    const [day] = toStackedBarDays(reversed, AGENTS, seriesColorByAgent(AGENTS, reversed), CUT_RANGE, 'UTC')
    expect(day!.series.map((s) => s.id)).toEqual(['agent-research', 'agent-retired'])
    // Rank-independence (#4331): the reverse-order wire changes the STACK
    // order to the display order but not either agent's colour.
    expect(day!.series.map((s) => s.color)).toEqual([
      seriesColorForAgent('Research agent'),
      seriesColorForAgent('Data-feed agent'),
    ])
  })

  it('gives ids the roster does not carry the neutral ink, named rather than dropped', () => {
    const stray: AnalyticsDayBucket[] = [{ date: '2026-07-07', spent_by_agent: { x: '1', y: '2' }, refusals: 0 }]
    const [day] = toStackedBarDays(stray, AGENTS, new Map(), CUT_RANGE, 'UTC')
    // No name to hash → no invented hue; the neutral ink MoneyPanel gives
    // unattributed money (#3897). The legend and tooltip still NAME them.
    expect(day!.series.map((s) => s.color)).toEqual(['var(--v2-ink-3)', 'var(--v2-ink-3)'])
    expect(day!.series.map((s) => s.name)).toEqual(['x', 'y'])
  })

  it('names an agent id the roster does not carry rather than dropping its money, on the neutral ink', () => {
    const stray: AnalyticsDayBucket[] = [
      { date: '2026-07-07', spent_by_agent: { 'agent-ghost': '3.00' }, refusals: 0 },
    ]
    const [day] = toStackedBarDays(stray, AGENTS, seriesColorByAgent(AGENTS, stray), CUT_RANGE, 'UTC')
    expect(day!.series[0]).toMatchObject({ name: 'agent-ghost', color: 'var(--v2-ink-3)', amount: 3 })
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
    // The note describes stripes that are DRAWN (#4334): a partial edge day
    // with no spend is an empty slot — flagged partial in the tooltip and
    // the table, but with no bar to stripe it does not claim to be striped.
    const firstEmptyPartial = partialEdges(lastOnly)
    expect(firstEmptyPartial.first).toBe(false)
    expect(lastOnly[0]!.partial).toBe(true)
    expect(lastOnly[0]!.series).toEqual([])
  })
})

describe('windowDates — the continuous day axis (#4334)', () => {
  /** A 7-day window whose edges cut their UTC days. */
  const DAYS_7_CUT = { from: '2026-07-04T09:30:00.000Z', to: '2026-07-11T09:30:00.000Z' }
  /** The same length, aligned to UTC midnight: the excluded endpoint owns no part of its date. */
  const DAYS_7_ALIGNED = { from: '2026-07-04T00:00:00.000Z', to: '2026-07-11T00:00:00.000Z' }

  it('yields N+1 dates for a window whose end cuts its day — 7, 30 and 90 days', () => {
    expect(windowDates(DAYS_7_CUT, 'UTC')).toHaveLength(8)
    expect(windowDates(DAYS_7_CUT, 'UTC')[0]).toBe('2026-07-04')
    expect(windowDates(DAYS_7_CUT, 'UTC')[7]).toBe('2026-07-11')
    // The fixture's own 30-day window: Jun 10 .. Jul 10 inclusive.
    expect(windowDates(THIRTY_DAY_CUT, 'UTC')).toHaveLength(31)
    expect(windowDates(THIRTY_DAY_CUT, 'UTC')[0]).toBe('2026-06-10')
    expect(windowDates(THIRTY_DAY_CUT, 'UTC')[30]).toBe('2026-07-10')
    // 90 days: Apr 11 .. Jul 10.
    const days90 = { from: '2026-04-11T09:30:00.000Z', to: '2026-07-10T09:30:00.000Z' }
    expect(windowDates(days90, 'UTC')).toHaveLength(91)
  })

  it('yields N dates when now is exactly local midnight — in THAT zone alone', () => {
    expect(windowDates(DAYS_7_ALIGNED, 'UTC')).toHaveLength(7)
    expect(windowDates(DAYS_7_ALIGNED, 'UTC')[6]).toBe('2026-07-10')
    // 00:00Z is 02:00 in Stockholm: the same window cuts both its edge days
    // there, so the zone, not the instant alone, decides the count.
    expect(windowDates(DAYS_7_ALIGNED, 'Europe/Stockholm')).toHaveLength(8)
  })

  it('crosses month edges and a DST spring-forward without skipping or repeating a date', () => {
    // The steps are absolute 24h; a local calendar day is 23–25h wide, so
    // each step crosses exactly one midnight — the Europe/Stockholm switch
    // to CEST on 2026-03-29 02:00 local cannot double a date or drop one.
    expect(windowDates({ from: '2026-06-29T09:30:00.000Z', to: '2026-07-02T09:30:00.000Z' }, 'UTC')).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
    ])
    expect(
      windowDates({ from: '2026-03-28T09:30:00.000Z', to: '2026-03-31T09:30:00.000Z' }, 'Europe/Stockholm'),
    ).toEqual(['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'])
  })

  it('falls back to the response dates for a zone this runtime cannot resolve', () => {
    expect(windowDates(DAYS_7_CUT, 'Mars/Olympus_Mons', BY_DAY)).toEqual(BY_DAY.map((d) => d.date).sort())
  })
})

describe('toStackedBarDays — the continuous axis fills the calendar (#4334)', () => {
  it('hands the primitive a slot for EVERY local date the window touches, empty days included', () => {
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, THIRTY_DAY_CUT, 'UTC')
    expect(days).toHaveLength(31)
    // An empty slot: the day exists, nothing was booked or refused on it.
    expect(days[0]).toMatchObject({ label: '10 Jun', series: [], refusals: 0 })
    // The four activity days carry their rows unchanged, in calendar order.
    const populated = days.filter((d) => d.series.length > 0)
    expect(populated.map((d) => d.label)).toEqual(['7 Jul', '8 Jul', '9 Jul', '10 Jul'])
    expect(populated[0]!.series.map((s) => s.id)).toEqual(['agent-research', 'agent-retired'])
    // Both edge dates are drawn, and both are partial — the window's 14:30Z
    // edges cut their UTC days; the 29 interior dates are full days.
    const partials = days.map((d) => d.partial)
    expect(partials[0]).toBe(true)
    expect(partials[30]).toBe(true)
    expect(partials.filter(Boolean)).toHaveLength(2)
  })
})

describe('spendSummary — the accessible sentence in the primitive shape', () => {
  it('states the total, the agent count and the refusals over the window', () => {
    const days = toStackedBarDays(BY_DAY, AGENTS, SERIES, ALIGNED_RANGE, 'UTC')
    expect(spendSummary(days, 'USD', 30)).toBe('Spend over 30 days: $324.75 across 2 agents, 2 refusals.')
  })

  it('singularises', () => {
    const oneDay = [{ date: '2026-07-07', spent_by_agent: { 'agent-research': '10.00' }, refusals: 1 }]
    const one = toStackedBarDays(oneDay, AGENTS, seriesColorByAgent(AGENTS, oneDay), ALIGNED_RANGE, 'UTC')
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

  it('paints each agent in its own avatar tint — the same fill its monogram wears (#4331)', () => {
    // Aligned to Stockholm midnight so no day is partial: a partial day is
    // hatched (a url(#…) pattern), and this test reads the raw token.
    const { container } = render6(BY_DAY, ALIGNED_RANGE, 'Europe/Stockholm')
    const chart = container.querySelector('[data-testid="stacked-bar-chart"]')!
    const firstDay = within(chart as HTMLElement).getAllByTestId('chart-day')[0]!
    const segments = firstDay.querySelectorAll('[data-testid="chart-segment"]')
    expect(segments[0]!.getAttribute('fill')).toBe(seriesColorForAgent('Research agent'))
    expect(segments[1]!.getAttribute('fill')).toBe(seriesColorForAgent('Data-feed agent'))
    // Both fixture agents hash to tint 6 — the documented collision, live in
    // the capture fixture: two agents, one chart, one tint, told apart by
    // NAME in the legend and tooltip. The pin is deliberate: rank-based
    // assignment would have silently "fixed" this by re-painting an agent.
    expect(segments[0]!.getAttribute('fill')).toBe('var(--v2-avatar-6)')
    expect(segments[1]!.getAttribute('fill')).toBe('var(--v2-avatar-6)')
  })

  it('says on the face of the card when the edge bars are partial, and stays quiet when they are not', () => {
    const cut = render6(BY_DAY, CUT_RANGE, 'Europe/Stockholm')
    expect(cut.container.querySelector('[data-testid="analytics-spend-partial-note"]')).not.toBeNull()
    expect(cut.container.querySelectorAll('[data-testid="chart-day"][data-partial="true"]')).toHaveLength(4) // 2 per chart
    cut.unmount()
    const aligned = render6(BY_DAY, ALIGNED_RANGE, 'Europe/Stockholm')
    expect(aligned.container.querySelector('[data-testid="analytics-spend-partial-note"]')).toBeNull()
  })

  it('draws a slot for every calendar day of the window, empty days included (#4334)', () => {
    const { container } = render6(BY_DAY, THIRTY_DAY_CUT, 'UTC')
    for (const chart of container.querySelectorAll('[data-testid="stacked-bar-chart"]')) {
      expect(chart.querySelectorAll('[data-testid="chart-day"]')).toHaveLength(31)
    }
    // The first chart-day is the EMPTY Jun 10 slot: no segments to draw.
    const charts = container.querySelectorAll('[data-testid="stacked-bar-chart"]')
    const firstSlot = charts[0]!.querySelector('[data-testid="chart-day"]')!
    expect(firstSlot.querySelectorAll('[data-testid="chart-segment"]')).toHaveLength(0)
  })

  it('lists every day in the screen-reader table, empty days reading $0.00 (#4334)', () => {
    const { container } = render6(BY_DAY, THIRTY_DAY_CUT, 'UTC')
    const table = container.querySelector('[data-testid="chart-data-table"]')!
    expect(table.querySelectorAll('tbody tr')).toHaveLength(31)
    expect(table.textContent).toContain('10 Jun')
    expect(table.textContent).toContain('7 Jul')
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

  it('renders the section empty state when the window has NO activity at all (#4334)', () => {
    // The sparse rule is now only the no-activity one: the old
    // `MIN_CHARTABLE_DAYS` null-return drew nothing below a couple of
    // activity days; the calendar now draws them. A period with nothing —
    // an agent-scoped response's empty `by_day` — renders the empty state
    // instead of a card around an empty plot.
    const { container } = render6([], CUT_RANGE, 'UTC')
    expect(screen.getByText('No spend in this window')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="stacked-bar-chart"]')).toHaveLength(0)
    // A window with only a COUPLE of activity days still draws the calendar.
    const sparse = render6(BY_DAY.slice(0, 2), THIRTY_DAY_CUT, 'UTC')
    for (const chart of sparse.container.querySelectorAll('[data-testid="stacked-bar-chart"]')) {
      expect(chart.querySelectorAll('[data-testid="chart-day"]')).toHaveLength(31)
    }
  })
})
