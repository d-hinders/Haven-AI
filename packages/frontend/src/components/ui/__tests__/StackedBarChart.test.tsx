import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StackedBarChart } from '../StackedBarChart'
import type { StackedBarDay } from '../StackedBarChart'

/**
 * `ui/StackedBarChart` (#2948, analytics slice D).
 *
 * Five of the issue's six acceptance items for this primitive are
 * behavioural and asserted here on the rendered output; the sixth, the
 * scale arithmetic the bars are drawn against, is asserted at its source in
 * `charts/__tests__/chart-scale.test.ts`. What this file adds is the claim a
 * caller has to be able to rely on: that the chart draws what the data says,
 * tells a reader who cannot see it what it says, and reveals a day's detail
 * to a keyboard as readily as to a mouse.
 *
 * The fixtures are three days and two agents: the smallest set that has a
 * stack (two segments), a stable order (the same two agents on all three
 * days), and a refusal cap over exactly one bar.
 *
 * The reveal is driven through `mouseDown` (the tap-to-pin path) and the
 * arrow keys, not through `mouseEnter`: React synthesises `onMouseEnter`
 * from delegated `mouseover`/`mouseout` pairs, so a hand-dispatched enter is
 * a thing to be flaky about, while a `mouseDown` and a `keyDown` are each one
 * direct event with one direct handler. Pin and hover write the same state
 * through the same setter, so pinning proves the tooltip the hover paints.
 */

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const THREE_DAYS: StackedBarDay[] = [
  {
    label: 'Mon 8',
    refusals: 0,
    series: [
      { id: 'alpha', name: 'Research agent', amount: 100, seriesIndex: 0, tokens: [['USDC', 100]] },
      { id: 'beta', name: 'Ops agent', amount: 50, seriesIndex: 1 },
    ],
  },
  {
    label: 'Tue 9',
    refusals: 4,
    series: [
      {
        id: 'alpha',
        name: 'Research agent',
        amount: 200,
        seriesIndex: 0,
        // The per-token breakdown is the detail behind the amount, so the
        // denominations add up to it: 160.40 + 39.60 = 200.
        tokens: [
          ['USDC', 160.4],
          ['PYUSD', 39.6],
        ],
      },
      { id: 'beta', name: 'Ops agent', amount: 50, seriesIndex: 1 },
    ],
  },
  {
    label: 'Wed 10',
    series: [
      { id: 'alpha', name: 'Research agent', amount: 60, seriesIndex: 0 },
      { id: 'beta', name: 'Ops agent', amount: 390, seriesIndex: 1 },
    ],
  },
]

const SUMMARY = 'Spend over 3 days: 850.00 USD across 2 agents, 4 refusals'

function renderChart(
  overrides: Partial<Parameters<typeof StackedBarChart>[0]> = {},
  days: StackedBarDay[] = THREE_DAYS,
) {
  return render(
    <StackedBarChart
      days={days}
      currency="USD"
      ariaLabel={SUMMARY}
      formatValue={fmt}
      {...overrides}
    />,
  )
}

/** Every bar group, in the order the days were given. */
function dayGroups(): Element[] {
  return [...screen.getAllByTestId('chart-day')]
}

interface Rect {
  id: string
  y: number
  height: number
  fill: string
}

function segmentsOf(group: Element): Rect[] {
  return [...group.querySelectorAll('[data-testid="chart-segment"]')].map((rect) => ({
    id: rect.getAttribute('data-series') ?? '',
    y: Number(rect.getAttribute('y')),
    height: Number(rect.getAttribute('height')),
    fill: rect.getAttribute('fill') ?? '',
  }))
}

describe('StackedBarChart — the drawing says what the data says', () => {
  it('draws one group per day, in the caller order', () => {
    renderChart()
    const groups = dayGroups()
    expect(groups).toHaveLength(3)
    expect(groups.map((g) => g.getAttribute('data-day-index'))).toEqual(['0', '1', '2'])
  })

  it('stacks the agents in the caller order, and the SAME order on every day', () => {
    // "Stacking order stable across days", asserted rather than trusted:
    // the first series is the one that sits on the baseline (the largest y,
    // because the plot grows upward while the coordinate runs down), and
    // every later one above it. If the order drifted between days, a reader
    // comparing two bars would be reading two different things.
    renderChart()
    const orders = dayGroups().map((g) => {
      const segs = segmentsOf(g)
      const byBottom = [...segs].sort((a, b) => b.y - a.y).map((s) => s.id)
      expect(byBottom, 'the first series is the one nearest the baseline').toEqual([
        'alpha',
        'beta',
      ])
      return segs.map((s) => s.id)
    })
    for (const order of orders) expect(order).toEqual(orders[0])
  })

  it('sizes each segment by its amount under a scale that reaches past the tallest bar', () => {
    // The tallest day is 60 + 390 = 450; the nice ceiling is 600 with
    // gridlines at 200 and 400 — values the data reaches, none beyond the
    // max. The heights below are the ratios the reader's eye is being asked
    // to trust, so they are checked as ratios of the plotted range.
    renderChart()
    const labels = screen.getAllByTestId('chart-tick-label').map((el) => el.textContent)
    expect(labels).toEqual(['200.00', '400.00'])
    expect(screen.getAllByTestId('chart-gridline')).toHaveLength(2)

    // The plot box is 220 - 14 - 30 = 176 units tall between its pads.
    const dayThree = segmentsOf(dayGroups()[2])
    expect(dayThree[0].height).toBeCloseTo((60 / 600) * 176, 6)
    expect(dayThree[1].height).toBeCloseTo((390 / 600) * 176, 6)
    // Stacked segments do not overlap: the one drawn second starts where
    // the first ended, in the down-running coordinate.
    expect(dayThree[1].y + dayThree[1].height).toBeCloseTo(dayThree[0].y, 6)
  })

  it('marks refusals as a cap above the bar, and only where there were refusals', () => {
    // The marker series is a second SERIES and not a second axis: a count
    // of refused payments has no scale comparable to a sum of spend, and
    // two y-axes in one frame invite a reader to compare the two wrongly.
    renderChart()
    const caps = screen.getAllByTestId('chart-refusal-marker')
    expect(caps).toHaveLength(1)
    const cappedGroup = dayGroups()[1]
    expect(cappedGroup.contains(caps[0])).toBe(true)
    // The cap sits above the bar: its top edge is above the bar's top.
    const topOfBar = Math.min(...segmentsOf(cappedGroup).map((s) => s.y))
    expect(Number(caps[0].getAttribute('y'))).toBeLessThan(topOfBar)
  })

  it('paints the series from the ordered tokens by index, and wraps past the sixth', () => {
    // Colour by series and not by meaning: the first agent is
    // --v2-series-1 wherever it appears — the bar here, the legend, and
    // the share column in the agents table — and a seventh agent wraps to
    // the first token rather than inventing a hue the contrast table never
    // measured.
    renderChart({}, [
      {
        label: 'Mon 8',
        series: [
          { id: 'a', name: 'A', amount: 10, seriesIndex: 0 },
          { id: 'b', name: 'B', amount: 10, seriesIndex: 1 },
          { id: 'c', name: 'C', amount: 10, seriesIndex: 6 },
        ],
      },
      { label: 'Tue 9', series: [{ id: 'a', name: 'A', amount: 10, seriesIndex: 0 }] },
      { label: 'Wed 10', series: [{ id: 'a', name: 'A', amount: 10, seriesIndex: 0 }] },
    ])
    expect(segmentsOf(dayGroups()[0]).map((s) => s.fill)).toEqual([
      'var(--v2-series-1)',
      'var(--v2-series-2)',
      'var(--v2-series-1)',
    ])
  })

  it('leaves the picture to the figure and the words to the reader', () => {
    renderChart()
    // The drawing's every fact is stated again in the data table below,
    // so the drawing itself is marked aria-hidden: a reader with a reader
    // should not be told the same thing twice.
    for (const g of dayGroups()) expect(g.getAttribute('aria-hidden')).toBe('true')
    const svg = document.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('role')).toBe('img')
    expect(svg!.getAttribute('aria-label')).toBe(SUMMARY)
    expect(svg!.getAttribute('tabindex')).toBe('0')
  })
})

describe('StackedBarChart — a partial day is drawn as one (#3051)', () => {
  it('hatches the bar with its own series token, marks the group, and names it in the data table and the tooltip', () => {
    const days: StackedBarDay[] = THREE_DAYS.map((d) => ({ ...d }))
    days[0] = { ...days[0]!, partial: true }
    const { container, getByTestId } = render(
      <StackedBarChart days={days} currency="USD" ariaLabel="s" formatValue={fmt} />,
    )
    const groups = container.querySelectorAll('[data-testid="chart-day"]')
    expect(groups[0]!.getAttribute('data-partial')).toBe('true')
    expect(groups[1]!.getAttribute('data-partial')).toBeNull()
    const cutSegment = groups[0]!.querySelector('[data-testid="chart-segment"]')!
    const fullSegment = groups[1]!.querySelector('[data-testid="chart-segment"]')!
    // Striped, not faded: the partial segment fills from a <pattern> whose
    // base rect is the SAME series token the full segment is filled with, so
    // the mark is identical on both themes and the token's contrast holds.
    expect(cutSegment.getAttribute('data-hatched')).toBe('true')
    expect(fullSegment.getAttribute('data-hatched')).toBeNull()
    const fill = cutSegment.getAttribute('fill')!
    expect(fill).toMatch(/^url\(#.*-hatch-\d+\)$/)
    const patternId = fill.slice(5, -1)
    const pattern = container.querySelector(`[data-testid="chart-hatch-pattern"][id="${patternId}"]`)!
    expect(pattern.querySelector('rect')!.getAttribute('fill')).toBe(fullSegment.getAttribute('fill'))
    expect(pattern.querySelector('line')!.getAttribute('stroke')).toBe('var(--v2-bg)')
    // Opacity is no longer the encoding: both segments carry the resting value.
    expect(cutSegment.getAttribute('fill-opacity')).toBe(fullSegment.getAttribute('fill-opacity'))
    const table = getByTestId('chart-data-table')
    expect(table.textContent).toContain(`${days[0]!.label} (partial day)`)
    expect(table.textContent).not.toContain(`${days[1]!.label} (partial day)`)
    const svg = container.querySelector('svg')!
    fireEvent.keyDown(svg, { key: 'Home' })
    expect(getByTestId('chart-tooltip-partial').textContent).toContain('partial day')
  })
})

describe('StackedBarChart — the desktop callout is clamped by its own measured width (#3051 design re-review)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('anchors the callout over its day and clamps by the measured half-width, not a fixed 30/70', () => {
    // jsdom lays nothing out: every box is 0 wide, so the effect bails and
    // the max-width bound (30%) stands. Give the wrapper 600px and the
    // callout 300px — a 25% half-width — and the clamp must follow.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
    const { container, getByTestId } = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />,
    )
    const svg = container.querySelector('svg')!
    fireEvent.keyDown(svg, { key: 'Home' })
    // Day 0's centre (22.7% of a three-bar plot) sits inside 25%, so the
    // clamp binds: the callout's left edge lands on the wrapper's (plus
    // the half-percent cushion) — neither the fixed 30% nor the raw centre.
    expect(getByTestId('chart-tooltip').style.left).toBe('25.5%')
    fireEvent.keyDown(svg, { key: 'End' })
    expect(getByTestId('chart-tooltip').style.left).toBe('74.5%')
    // The callout is the wrapper's child — the box the measurement and the
    // `left: %` both resolve against — not the plot's.
    expect(getByTestId('chart-tooltip').parentElement).toBe(getByTestId('stacked-bar-chart'))
  })

  it('falls back to the max-width bound where nothing has a width (jsdom, first paint)', () => {
    const { container, getByTestId } = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />,
    )
    const svg = container.querySelector('svg')!
    fireEvent.keyDown(svg, { key: 'Home' })
    expect(getByTestId('chart-tooltip').style.left).toBe('30%')
    fireEvent.keyDown(svg, { key: 'End' })
    expect(getByTestId('chart-tooltip').style.left).toBe('70%')
  })
})

describe('StackedBarChart — the desktop callout drops above the baseline when the described bar is tall (#3063)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The fixture's totals are 150 / 250 / 450 on a 600 scale, a 200px svg:
  // bar tops at CSS y 132.7 / 106.1 / 52.7 (Tue 9 also carries a refusal
  // cap 10 viewBox units higher: 97.0); baseline 172.7, svg bottom 200,
  // legend top 212 (a dropped callout stops 6px above it: 206). A 90px callout at rest spans 12..102 and needs 6px of
  // clearance (bottom 108), so it hides Tue 9 and Wed 10 but not Mon 8. A
  // dropped callout must leave 12px of the day's marks above it and clear
  // the bar's own top by 6.
  function layOut() {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200)
  }

  it('rests at top-3 over a short bar and drops to the baseline over a tall one, keeping the bar top and its cap visible', () => {
    layOut()
    const { container, getByTestId } = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />,
    )
    const svg = container.querySelector('svg')!
    fireEvent.keyDown(svg, { key: 'Home' })
    let tip = getByTestId('chart-tooltip')
    expect(tip.className).toContain('top-3')
    expect(tip.style.top).toBe('')
    expect(tip.getAttribute('data-flipped')).toBeNull()
    fireEvent.keyDown(svg, { key: 'End' })
    tip = getByTestId('chart-tooltip')
    expect(tip.className).not.toContain('top-3')
    expect(tip.getAttribute('data-flipped')).toBe('true')
    // Baseline at viewBox 190 of 220 → CSS 172.7; minus the 90px callout
    // and the 6px gap: the callout's top sits at 76.7px, its bottom 6px
    // above the axis — and 24px under the bar's top (52.7px), more than
    // the 12px it must leave.
    expect(tip.style.top).toBe('76.7px')
    // The horizontal clamp is untouched by the flip (200px callout in a
    // 600px wrapper → half 17.2%, so End clamps to 100 − 17.2).
    expect(tip.style.left).toMatch(/^82\.8/)
  })

  it('drops to just above the legend — over the label whole, not a legend row — when the bar cannot hold the callout above the baseline', () => {
    layOut()
    // A 120px callout over Wed 10 (bar top 52.7): above the baseline it
    // would start at 46.7 and cover the top; with its bottom 6px above the
    // legend (206) it starts at 86, leaving 33px of the bar.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120)
    const { container, getByTestId } = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />,
    )
    fireEvent.keyDown(container.querySelector('svg')!, { key: 'End' })
    const tip = getByTestId('chart-tooltip')
    expect(tip.getAttribute('data-flipped')).toBe('true')
    expect(tip.style.top).toBe('86px')
  })

  it('rests over a bar it would otherwise swallow: a drop that cannot leave 12px of the bar in view is not made', () => {
    layOut()
    // A 130px callout over Mon 8 (bar top 132.7): at rest it hides 22px of
    // the top; dropped, even to the legend (top 76) it would cover the
    // whole bar and the label — so it rests.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(130)
    const swallowed = render(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />)
    fireEvent.keyDown(swallowed.container.querySelector('svg')!, { key: 'Home' })
    let tip = swallowed.getByTestId('chart-tooltip')
    expect(tip.getAttribute('data-flipped')).toBeNull()
    expect(tip.className).toContain('top-3')
    swallowed.unmount()
    // A 145px callout over Wed 10 (bar top 52.7) lands at 61 above the
    // legend: 8.3px of the bar — clear of its top edge, but under the 12px
    // that reads as a bar — so it rests too.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(145)
    const sliver = render(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />)
    fireEvent.keyDown(sliver.container.querySelector('svg')!, { key: 'End' })
    tip = sliver.getByTestId('chart-tooltip')
    expect(tip.getAttribute('data-flipped')).toBeNull()
  })

  it('counts the refusal cap as part of the bar: a day whose CAP alone would hide flips too', () => {
    layOut()
    // Tue 9's bar top is at 106.1, the 90px callout's resting bottom at
    // 108 → drops on the bar alone. Shrink the callout to 80px (bottom at
    // 98): the bar clears it, the cap (97.0) does not — so it still drops
    // with the cap (to just above the legend: 126, leaving the cap and 20px
    // of the bar) and rests without it.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
    const withCap = render(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />)
    fireEvent.keyDown(withCap.container.querySelector('svg')!, { key: 'ArrowRight' })
    expect(withCap.getByTestId('chart-tooltip').getAttribute('data-flipped')).toBe('true')
    expect(withCap.getByTestId('chart-tooltip').style.top).toBe('126px')
    withCap.unmount()
    // The cap counts towards the 12px of marks but never stands in for the
    // bar's own top edge: a 95px callout lands at 111 — 14px under the
    // cap, but only 4.9px under the bar's top — so it rests.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(95)
    const tooTall = render(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />)
    fireEvent.keyDown(tooTall.container.querySelector('svg')!, { key: 'ArrowRight' })
    expect(tooTall.getByTestId('chart-tooltip').getAttribute('data-flipped')).toBeNull()
    tooTall.unmount()
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
    const noCap = THREE_DAYS.map((d, i) => (i === 1 ? { ...d, refusals: 0 } : d))
    const without = render(<StackedBarChart days={noCap} currency="USD" ariaLabel="s" formatValue={fmt} />)
    fireEvent.keyDown(without.container.querySelector('svg')!, { key: 'ArrowRight' })
    expect(without.getByTestId('chart-tooltip').getAttribute('data-flipped')).toBeNull()
  })

  it('never flips the narrow panel, and rests where nothing has a height (jsdom, first paint)', () => {
    layOut()
    const narrow = render(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} narrow />)
    fireEvent.keyDown(narrow.container.querySelector('svg')!, { key: 'End' })
    const panel = narrow.getByTestId('chart-tooltip')
    expect(panel.getAttribute('data-flipped')).toBeNull()
    expect(panel.style.top).toBe('')
    narrow.unmount()
    vi.restoreAllMocks()
    const bare = render(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />)
    fireEvent.keyDown(bare.container.querySelector('svg')!, { key: 'End' })
    const tip = bare.getByTestId('chart-tooltip')
    expect(tip.className).toContain('top-3')
    expect(tip.getAttribute('data-flipped')).toBeNull()
  })
})

describe('StackedBarChart — ticks fit the gutter at 390 (#3051 design review)', () => {
  it('formats ticks with formatTick when given, and widens the gutter on the narrow treatment', () => {
    const compact = (n: number) => `$${Math.round(n)}`
    const wide = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} formatTick={compact} />,
    )
    const wideTicks = wide.getAllByTestId('chart-tick-label')
    expect(wideTicks.every((t) => /^\$\d+$/.test(t.textContent ?? ''))).toBe(true)
    const wideGutter = (wideTicks[0] as HTMLElement).style.width
    wide.unmount()
    const narrow = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} formatTick={compact} narrow />,
    )
    const narrowGutter = (narrow.getAllByTestId('chart-tick-label')[0] as HTMLElement).style.width
    expect(parseFloat(narrowGutter)).toBeGreaterThan(parseFloat(wideGutter))
    // The bars still start to the right of the wider gutter.
    const firstBar = narrow.container.querySelector('[data-testid="chart-segment"]')!
    expect(Number(firstBar.getAttribute('x'))).toBeGreaterThan(70)
  })

  it('falls back to formatValue for ticks when no tick formatter is given', () => {
    const { getAllByTestId } = render(
      <StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel="s" formatValue={fmt} />,
    )
    // Every tick goes through `fmt` (which prints cents) when no compact
    // formatter is given.
    expect(getAllByTestId('chart-tick-label').every((t) => /\.\d\d$/.test(t.textContent ?? ''))).toBe(true)
  })
})

describe('StackedBarChart — the tooltip, opened two ways', () => {
  it('reveals a day to a keyboard caret, with amounts, tokens, and refusals', () => {
    renderChart()
    const svg = document.querySelector('svg')!
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()

    // Arrow right lands on day 1 (Tue 9), the day with refusals and the
    // per-token breakdown.
    fireEvent.keyDown(svg, { key: 'ArrowRight' })
    const tip = screen.getByTestId('chart-tooltip')
    expect(tip).toHaveTextContent(/Tue 9/)
    expect(tip).toHaveTextContent(/Research agent/)
    expect(tip).toHaveTextContent(/Ops agent/)
    // The per-token breakdown is the day's detail, printed through the
    // caller's formatter — the chart owns no money-formatting of its own.
    expect(screen.getByTestId('chart-tooltip-tokens')).toHaveTextContent(
      '160.40 USDC + 39.60 PYUSD',
    )
    expect(screen.getByTestId('chart-tooltip-refusals')).toHaveTextContent('4 payments refused')
    expect(tip).toHaveTextContent(/USD 250\.00/)
  })

  it('is two lines, not a table: day and total on the first, agents and refusals as wrapping chips on the second (#3067)', () => {
    renderChart()
    fireEvent.keyDown(document.querySelector('svg')!, { key: 'ArrowRight' })
    const tip = screen.getByTestId('chart-tooltip')
    // The total shares the first line with the day label.
    const total = screen.getByTestId('chart-tooltip-total')
    expect(total).toHaveTextContent('USD 250.00')
    expect(total.parentElement!.textContent).toMatch(/^Tue 9/)
    // Every agent is a chip in one wrapping list, and the refusal count is
    // the last chip of the same list — no row-per-agent block underneath.
    const chips = screen.getByTestId('chart-tooltip-chips')
    expect(chips.className).toMatch(/flex-wrap/)
    const items = Array.from(chips.children)
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual([
      'chart-tooltip-row',
      'chart-tooltip-row',
      'chart-tooltip-refusals',
    ])
    // The chips carry swatch, name and amount — the name stays (the legend
    // is below the plot, the chip is where the eye is).
    expect(items[0]).toHaveTextContent(/Research agent.*200\.00/)
    // Nothing of the old block form remains after the chips.
    expect(chips.nextElementSibling).toBeNull()
    expect(tip.querySelector('.border-t')).toBeNull()
  })

  it('moves the caret and stops at the ends of the range', () => {
    renderChart()
    const svg = document.querySelector('svg')!
    fireEvent.keyDown(svg, { key: 'End' })
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Wed 10/)
    fireEvent.keyDown(svg, { key: 'ArrowRight' }) // past the end, no further
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Wed 10/)
    fireEvent.keyDown(svg, { key: 'Home' })
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Mon 8/)
    fireEvent.keyDown(svg, { key: 'Escape' }) // and away again
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
  })

  it('pins a day to a tap, and the pin holds after the pointer leaves', () => {
    renderChart()
    fireEvent.mouseDown(dayGroups()[0])
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Mon 8/)
    // A pinned day survives the pointer leaving the figure: a tap-to-pin
    // panel is not a hover that has to be held open.
    fireEvent.mouseLeave(document.querySelector('svg')!)
    expect(screen.queryByTestId('chart-tooltip')).not.toBeNull()
  })

  it('never pins itself: the callout takes no pointer, and a pin is released by a second tap or Escape (#3066)', () => {
    renderChart()
    const groups = dayGroups()
    const svg = document.querySelector('svg')!
    // Hover paints the callout; entering the callout must not pin it, so
    // leaving the figure clears it like any hover.
    fireEvent.mouseEnter(groups[0]!)
    const tip = screen.getByTestId('chart-tooltip')
    expect(tip).toHaveTextContent(/Mon 8/)
    expect(tip.className).toMatch(/pointer-events-none/)
    fireEvent.mouseEnter(tip)
    fireEvent.mouseLeave(svg)
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
    // The pointer falls through to the bars beneath: hovering the next day
    // while the previous day's callout would lie over it moves the hover.
    fireEvent.mouseEnter(groups[0]!)
    fireEvent.mouseEnter(groups[1]!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Tue 9/)
    fireEvent.mouseLeave(svg)
    // A tap pins; the same tap again lets go.
    fireEvent.mouseDown(groups[2]!)
    fireEvent.mouseLeave(svg)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Wed 10/)
    fireEvent.mouseDown(groups[2]!)
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
    // A tap on another day moves the pin; Escape releases it.
    fireEvent.mouseDown(groups[0]!)
    fireEvent.mouseDown(groups[1]!)
    fireEvent.mouseLeave(svg)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Tue 9/)
    fireEvent.keyDown(svg, { key: 'Escape' })
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
    // A touch tap synthesises mouseenter → mousedown with no mouseleave
    // between taps: the second tap must still take the callout down, so
    // the release drops the hover too.
    fireEvent.mouseEnter(groups[1]!)
    fireEvent.mouseDown(groups[1]!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Tue 9/)
    fireEvent.mouseDown(groups[1]!)
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
  })

  it('lets a pin and a caret go when the days change, so a shorter range does not strand the reveal on a day that is gone', () => {
    const fourDays: StackedBarDay[] = [
      ...THREE_DAYS,
      { label: 'Thu 11', series: [{ id: 'alpha', name: 'Research agent', amount: 20, seriesIndex: 0 }] },
    ]
    const { rerender } = renderChart({}, fourDays)
    fireEvent.mouseDown(dayGroups()[3]!)
    fireEvent.mouseLeave(document.querySelector('svg')!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Thu 11/)
    rerender(<StackedBarChart days={THREE_DAYS} currency="USD" ariaLabel={SUMMARY} formatValue={fmt} />)
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
    // Hover works again at once — the stale pin is not outranking it.
    fireEvent.mouseEnter(dayGroups()[0]!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Mon 8/)
  })

  it('sits below the plot when the screen is narrow, rather than over it', () => {
    renderChart({ narrow: true })
    fireEvent.mouseDown(dayGroups()[2])
    const tip = screen.getByTestId('chart-tooltip')
    // On a wide screen the callout is positioned over the figure; on a
    // narrow one it is a panel in the flow, below the chart — a callout
    // covering the bar it describes would hide the thing it is telling the
    // reader about.
    expect(tip.className).not.toMatch(/absolute/)
    expect(tip.className).toMatch(/mt-3/)
  })
})

describe('StackedBarChart — what a reader who cannot see the chart is told', () => {
  it('states the summary sentence as the accessible name of the figure', () => {
    renderChart()
    expect(document.querySelector('svg')!.getAttribute('aria-label')).toBe(SUMMARY)
  })

  it('exposes the plotted values as a table that is NOT inside the figure', () => {
    // A subtree of role="img" is presentational: assistive technology is
    // not shown what is in it. A data table written INSIDE the figure would
    // be exactly as unreadable as no table at all, which is why the table
    // is a sibling of the svg and why this assertion is worth its place.
    renderChart()
    const table = screen.getByTestId('chart-data-table')
    expect(table.tagName).toBe('TABLE')
    expect(table.closest('[role="img"]')).toBeNull()
    expect(table.className).toContain('sr-only')

    const headCells = [...table.querySelectorAll('thead th')].map((th) => th.textContent)
    expect(headCells).toEqual(['Day', 'Research agent', 'Ops agent', 'Total', 'Refusals'])
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th,td')].map((c) => c.textContent),
    )
    expect(rows).toEqual([
      ['Mon 8', '100.00', '50.00', '150.00', '0'],
      ['Tue 9', '200.00', '50.00', '250.00', '4'],
      ['Wed 10', '60.00', '390.00', '450.00', '0'],
    ])
  })

  it('labels the days the reader is asked to read, and only the ones that fit', () => {
    // One mount, rerendered for the narrow half: two renders in one test
    // ACCUMULATE in the document (RTL cleanup runs between tests, not
    // between renders), and the second query would count both charts' labels.
    const { rerender } = renderChart()
    expect(screen.getAllByTestId('chart-x-label').map((el) => el.textContent)).toEqual([
      'Mon 8',
      'Tue 9',
      'Wed 10',
    ])
    // A narrow screen thins them: three days is under the week band, so
    // even here all three stay, and the density rule itself is tested in
    // the scale suite where the ranges are long.
    rerender(
      <StackedBarChart
        days={THREE_DAYS}
        currency="USD"
        ariaLabel={SUMMARY}
        formatValue={fmt}
        narrow
      />,
    )
    expect(screen.getAllByTestId('chart-x-label').length).toBeLessThanOrEqual(5)
  })

  it('inherits the helper\'s endpoint-only right edge on the 30-day range (#3037)', () => {
    // The bar chart reads the same `xLabelIndices` the area chart does, so
    // the #3037 min-separation rule is inherited here, not re-implemented:
    // on the 30-day fixture the stride's day-28 slot drops and the endpoint
    // closes the axis alone — the same five labels, in the same order, both
    // treatments, exactly as the scale suite pins them.
    const days = Array.from({ length: 30 }, (_, i) => ({
      label: `d${i}`,
      series: [{ id: 'a', name: 'A', amount: 10 + i, seriesIndex: 0 }],
    }))
    const { rerender, unmount } = renderChart({}, days)
    expect(screen.getAllByTestId('chart-x-label').map((el) => el.textContent)).toEqual([
      'd0',
      'd7',
      'd14',
      'd21',
      'd29',
    ])
    rerender(
      <StackedBarChart
        days={days}
        currency="USD"
        ariaLabel={SUMMARY}
        formatValue={fmt}
        narrow
      />,
    )
    expect(screen.getAllByTestId('chart-x-label').map((el) => el.textContent)).toEqual([
      'd0',
      'd7',
      'd14',
      'd21',
      'd29',
    ])
    unmount()
  })
})

describe('StackedBarChart — the two things that must not happen', () => {
  it('renders nothing at all when the range is too sparse to be a shape', () => {
    // Below three days a "trend" is noise wearing a chart's clothes, and
    // the page shows tiles instead (slice C). The primitive holds that
    // line itself so no caller can render the misleading case by accident.
    const { container, rerender } = renderChart({}, [THREE_DAYS[0], THREE_DAYS[1]])
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('chart-data-table')).toBeNull()
    // And the same component on a range that fills in later DOES draw: the
    // guard is about the data and not about the mount, so the hooks have
    // to have run on the sparse turn as well.
    rerender(
      <StackedBarChart
        days={THREE_DAYS}
        currency="USD"
        ariaLabel={SUMMARY}
        formatValue={fmt}
      />,
    )
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getAllByTestId('chart-day')).toHaveLength(3)
  })

  it('gates the draw-in on the motion preference, where the motion lives', () => {
    // The animation is one class whose keyframes live inside a
    // prefers-reduced-motion gate in globals.css — the idiom .v2-mesh-drift
    // uses. JSDOM implements neither keyframes nor animations, so what is
    // assertable from here is the two halves that together make the branch:
    // the bars are GIVEN the class, and the stylesheet gives the class an
    // animation ONLY inside the gate.
    renderChart()
    for (const g of dayGroups()) expect(g.getAttribute('class') ?? '').toContain('v2-chart-draw')

    const css = readFileSync(resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const gate = /@media\s+\(prefers-reduced-motion:\s*no-preference\)\s*\{/.exec(css)
    expect(gate, 'there is no reduced-motion gate to hide the motion in').not.toBeNull()
    // The block the gate opens (brace-counted, because the file is one
    // string and the block is not the last thing in it).
    const open = gate!.index + gate![0].length
    let depth = 1
    let close = open
    while (depth > 0 && close < css.length) {
      if (css[close] === '{') depth++
      else if (css[close] === '}') depth--
      close++
    }
    const gated = css.slice(open, close - 1)
    expect(gated).toMatch(/\.v2-chart-draw\s*\{[^}]*\banimation:/)

    // The half that catches the bug: OUTSIDE the gate, the class gets no
    // animation. A draw-in declared un-gated is a draw-in a user who asked
    // for calm still gets.
    const ungated = css.slice(0, gate!.index) + css.slice(close)
    expect(ungated).not.toMatch(/\.v2-chart-draw[^{]*\{[^}]*\banimation:/)
  })
})
