import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  it('lightens the bar, marks the group, and names it in the data table and the tooltip', () => {
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
    expect(Number(cutSegment.getAttribute('fill-opacity'))).toBeLessThan(Number(fullSegment.getAttribute('fill-opacity')))
    const table = getByTestId('chart-data-table')
    expect(table.textContent).toContain(`${days[0]!.label} (partial day)`)
    expect(table.textContent).not.toContain(`${days[1]!.label} (partial day)`)
    const svg = container.querySelector('svg')!
    fireEvent.keyDown(svg, { key: 'Home' })
    expect(getByTestId('chart-tooltip-partial').textContent).toContain('partial day')
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
