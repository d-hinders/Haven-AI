import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AreaChart, deltaLabel } from '../AreaChart'
import type { AreaPoint } from '../AreaChart'

/**
 * `ui/AreaChart` (#2948, analytics slice D).
 *
 * The balance-over-time half of the acceptance list, asserted on the
 * rendered output: the line and its area, the scale's headroom, the endpoint
 * delta as the range's spend, the accessible summary, the hidden value
 * table, and the sparse-data no-render. The arithmetic the line is drawn
 * against is pinned in `charts/__tests__/chart-scale.test.ts`.
 *
 * The fixture's balance FALLS over the range (1 240 → 1 120), which is the
 * direction the page actually shows when agents have been spending: the
 * annotation reads `spent 120.00` (the formatter already carries the currency), the claim the issue asks for ("the
 * range's spend annotated as the endpoint delta"), and not a signed number
 * the reader has to interpret.
 *
 * Reveal is driven through `mouseDown` and the arrow keys, for the reason
 * the sibling suite gives: `onMouseEnter` is synthesised from delegated
 * pointer pairs, the other two are direct.
 */

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const FOUR_POINTS: AreaPoint[] = [
  { label: 'Mon 8', value: 1240 },
  { label: 'Tue 9', value: 1100 },
  { label: 'Wed 10', value: 1180 },
  { label: 'Thu 11', value: 1120 },
]

const SUMMARY = 'Balance over 4 days: ends at 1,120.00 USD, 120.00 USD spent across the range'

function renderChart(
  overrides: Partial<Parameters<typeof AreaChart>[0]> = {},
  points: AreaPoint[] = FOUR_POINTS,
) {
  return render(
    <AreaChart
      points={points}
      currency="USD"
      ariaLabel={SUMMARY}
      formatValue={fmt}
      {...overrides}
    />,
  )
}

/** Every plotted point group, in the order the points were given. */
function areaPoints(): Element[] {
  return [...document.querySelectorAll('[data-testid="area-point"]')]
}

describe('AreaChart — the line, the area, and the scale under them', () => {
  it('draws one polyline through every point, in order, left to right', () => {
    const { container } = renderChart()
    const paths = [...container.querySelectorAll('path')]
    const line = paths.find((p) => (p.getAttribute('class') ?? '').includes('v2-chart-draw-stroke'))
    expect(line, 'no stroked line path was drawn').toBeDefined()
    const d = line!.getAttribute('d') ?? ''
    // One M, then an L per point past the first.
    expect(d.startsWith('M')).toBe(true)
    const commands = d.split(/[ML]/).filter((s) => s.trim() !== '')
    expect(commands).toHaveLength(FOUR_POINTS.length)
    // Strictly increasing x: a chart whose later points ran backwards
    // would be telling a reader the range doubled back on itself.
    const xs = commands.map((c) => Number.parseFloat(c.trim().split(/\s+/)[0]))
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1])
  })

  it('raises the line where the balance is higher and drops it where it is lower', () => {
    // The coordinate runs down as the value runs up, so the highest value
    // (1 240, the first point) is the SMALLEST y and the lowest (1 100, the
    // second) the largest. A flat line or an inverted one is a chart lying
    // in the only way a balance chart can.
    const { container } = renderChart()
    const line = [...container.querySelectorAll('path')].find((p) =>
      (p.getAttribute('class') ?? '').includes('v2-chart-draw-stroke'),
    )!
    const ys = (line.getAttribute('d') ?? '')
      .split(/[ML]/)
      .filter((s) => s.trim() !== '')
      .map((c) => Number.parseFloat(c.trim().split(/\s+/)[1]))
    expect(Math.min(...ys)).toBe(ys[0]) // 1240, the first, is the topmost
    expect(Math.max(...ys)).toBe(ys[1]) // 1100, the second, is the bottommost
    expect(ys[2]).toBeLessThan(ys[3]) // 1180 is above 1120
  })

  it('keeps the data inside the frame: headroom at both ends, never a zero baseline', () => {
    // The two failures this is here for: a scale pinned to zero flattens a
    // 140-wide balance into a hairline (a chart whose whole claim is that
    // nothing moved), and a scale with no bottom margin puts the lowest
    // point on the abscissa where it reads as "the balance hit the floor".
    const { container } = renderChart()
    const line = [...container.querySelectorAll('path')].find((p) =>
      (p.getAttribute('class') ?? '').includes('v2-chart-draw-stroke'),
    )!
    const ys = (line.getAttribute('d') ?? '')
      .split(/[ML]/)
      .filter((s) => s.trim() !== '')
      .map((c) => Number.parseFloat(c.trim().split(/\s+/)[1]))
    // The plot box runs from 14 to 190 (PAD.top, PAD.top + plotH); the line
    // stays inside both edges rather than landing on either.
    for (const y of ys) {
      expect(y).toBeGreaterThan(14)
      expect(y).toBeLessThan(190)
    }
    // And the ticks live INSIDE the plot, between the padded floor and the
    // ceiling: for a 1,100–1,240 balance (pad 6% of the 140 range) the nice
    // step over the range is 50, so the reader sees 1,050 / 1,100 / 1,150 /
    // 1,200 — labels that bracket the data. Until #3204 the ticks came from
    // the zero-based scale (500 / 1,000 here), both below the padded floor, so
    // no gridline reached the plot and the labels were positioned under the
    // card; a level-relative pad term then still gave a 100-step. The labels
    // print through `formatTick` (here the same formatter), so they carry its
    // grouping.
    const tickLabels = screen.getAllByTestId('chart-tick-label').map((el) => el.textContent)
    expect(tickLabels).toEqual(['1,050.00', '1,100.00', '1,150.00', '1,200.00'])
    // The line uses the plot: its vertical extent is at least half the plot
    // height (14 → 190 is 176). Mutation: put the `|max| * 3%` pad term back
    // → the data's 140 becomes ~15% of a 500-wide span → red.
    const extent = Math.max(...ys) - Math.min(...ys)
    expect(extent).toBeGreaterThan(176 * 0.5)
    // Every tick's label sits within the svg's height (0–100%), never below it.
    for (const el of screen.getAllByTestId('chart-tick-label')) {
      const top = Number.parseFloat((el as HTMLElement).style.top)
      expect(top).toBeGreaterThanOrEqual(0)
      expect(top).toBeLessThanOrEqual(100)
    }
  })

  it('prints ticks through formatTick when given one, and widens the gutter on the narrow treatment (#3204)', () => {
    // The gutter is a fraction of the svg width; at 390 the desktop 48/640 is
    // ~21 CSS px and a currency tick drawn into it ran under the line. The
    // narrow treatment uses the bar chart's 78, and callers pass a compact
    // formatter so the label fits. Mutation: drop PAD_NARROW → red.
    renderChart({ narrow: true, formatTick: (v: number) => `${Math.round(v)}` })
    const labels = screen.getAllByTestId('chart-tick-label')
    expect(labels.map((el) => el.textContent)).toEqual(['1050', '1100', '1150', '1200'])
    const widthPct = Number.parseFloat((labels[0] as HTMLElement).style.width)
    expect(widthPct).toBeCloseTo(((78 - 6) / 640) * 100, 3)
  })

  it('fills under the line without drawing over it, closing on the baseline', () => {
    const { container } = renderChart()
    const area = [...container.querySelectorAll('path')].find((p) =>
      (p.getAttribute('fill') ?? '').includes('--v2-series-1'),
    )
    expect(area, 'no filled area path was drawn').toBeDefined()
    expect(area!.getAttribute('fill-opacity')).toBe('0.12')
    expect(area!.getAttribute('stroke')).toBe('none')
    const d = area!.getAttribute('d') ?? ''
    // The area is the line plus two closing legs down to the axis: it
    // starts on the baseline, runs the line, and returns along it. So it
    // both begins and ends on the baseline coordinate, and it is a closed
    // path.
    expect(d.endsWith('Z')).toBe(true)
    const firstY = Number.parseFloat(d.slice(1).split(/[ML]/)[0].trim().split(/\s+/)[1])
    const lastY = Number.parseFloat(d.replace(/\s*Z$/, '').split(/[ML]/).pop()!.trim().split(/\s+/)[1])
    expect(firstY).toBeCloseTo(190, 2)
    expect(lastY).toBeCloseTo(190, 2)
  })

  it('annotates the range as what it is: the spend between the endpoints', () => {
    renderChart()
    // The delta is endpoint-to-endpoint, not the sum of movements, and it
    // reads as a spent figure rather than a signed number: the balance fell
    // by 120, and a range of payments spent 120.
    // Exact, not a substring: the formatter already carries the currency, and
    // "spent 120.00 USD" (or "298,43 kr SEK") is the #3204 double-currency
    // defect. Mutation: append `{currency}` again → red.
    expect(screen.getByTestId('area-delta').textContent?.trim()).toBe('spent 120.00')
  })

  it('names the direction of the delta, including the two edges', () => {
    expect(deltaLabel(-120)).toBe('spent')
    expect(deltaLabel(0)).toBe('unchanged')
    expect(deltaLabel(120)).toBe('gained')
    // A range that rises is not called a spend, and an empty one is not a
    // delta at all.
    const { container } = renderChart({}, [
      { label: 'Mon 8', value: 100 },
      { label: 'Tue 9', value: 160 },
      { label: 'Wed 10', value: 210 },
    ])
    expect(container.querySelector('[data-testid="area-delta"]')).toHaveTextContent(
      'gained 110.00',
    )
  })

  it('prints the 30-day right edge as one label: the two right-most label boxes do not intersect (#3037)', () => {
    // The shipped defect, asserted on the geometry it is: the balance
    // chart's 30-bucket fixture put the stride's last slot ("10 Jul") one
    // index behind the endpoint ("11 Jul") and the two `text-xs` labels
    // printed as one garbled cluster at the right edge. The fix lives in
    // the scale helper, but the harm was two boxes overlapping, so the pin
    // reads the rendered spans: each label's `left` is the same plot
    // fraction the drawing is positioned by, and the box is rebuilt from
    // the transform the primitive applies — the first label grows right
    // from the left edge, the endpoint grows left, the rest centre. The
    // box is 12% of the plot wide — a ~40px `text-xs` calendar label at
    // the narrow treatment's ~330px plot, and still generous at desktop
    // widths — generous on purpose, so this pin fails before a real label
    // could touch. Both treatments must pass because both receive the same
    // indices from the fixed helper (the 30-day narrow treatment thins
    // nothing).
    const LABEL_W = 12
    const points = Array.from({ length: 30 }, (_, i) => ({ label: `d${i}`, value: 1000 + i }))
    for (const narrow of [false, true]) {
      // One mount per treatment with an explicit unmount: renders
      // accumulate in the document between renders (cleanup runs between
      // tests, not renders), and a second query would count both charts.
      const { unmount } = renderChart({ narrow }, points)
      const labels = screen.getAllByTestId('chart-x-label')
      expect(labels.map((el) => el.textContent)).toEqual(['d0', 'd7', 'd14', 'd21', 'd29'])
      const boxes = labels.map((el) => {
        const x = Number.parseFloat(el.style.left)
        const label = el.textContent ?? ''
        if (label === 'd0') return [x, x + LABEL_W]
        if (label === 'd29') return [x - LABEL_W, x]
        return [x - LABEL_W / 2, x + LABEL_W / 2]
      })
      const pen = boxes[boxes.length - 2]!
      const end = boxes[boxes.length - 1]!
      expect(
        pen[1],
        `the 30-day ${narrow ? 'narrow' : 'desktop'} penultimate label overlaps the endpoint`,
      ).toBeLessThanOrEqual(end[0])
      // The endpoint delta (`area-delta`, the range's spend) hangs from the
      // plot's top-right corner; the endpoint label sits under the axis.
      // The non-collision claim (#3037's last criterion) is the row
      // separation: the delta's top is in the top band of the plot while
      // every x label starts below the axis line (~90% down), so one
      // `text-xs` line of type cannot bridge the two rows — and a wider
      // figure or a thinner endpoint neighbourhood cannot change that,
      // because the delta is text-right against the right pad while the
      // endpoint label grows leftward from its own anchor.
      const delta = screen.getByTestId('area-delta')
      const deltaTop = Number.parseFloat(delta.style.top)
      const labelTop = Number.parseFloat(labels[0]!.style.top)
      // The style values are percentages of the viewBox (0-100): the delta
      // hangs at ~5.5% of the height, the labels start at ~90%.
      expect(deltaTop).toBeLessThan(10)
      expect(labelTop).toBeGreaterThan(80)
      unmount()
    }
  })
})

describe('AreaChart — what a reader who cannot see the chart is told', () => {
  it('carries the summary as the accessible name of the figure', () => {
    renderChart()
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe(SUMMARY)
    expect(svg.getAttribute('tabindex')).toBe('0')
  })

  it('puts the values in a table outside the figure, where a reader can reach them', () => {
    renderChart()
    const table = screen.getByTestId('chart-data-table')
    expect(table.tagName).toBe('TABLE')
    // The defect this guards: the table rendered INSIDE the role="img"
    // element, whose subtree assistive technology is not shown, would read
    // as a chart with no data table at all — silently.
    expect(table.closest('[role="img"]')).toBeNull()
    // Visually hidden through a WRAPPER, never the table itself: `sr-only`'s
    // `height: 1px` is a minimum for a <table>, so the table rendered full
    // height under the card's `overflow-hidden` and every screenshot capture
    // reported ~800px of clipped content (#3204). Mutation: put `sr-only`
    // back on the table → red.
    expect(table.className).not.toContain('sr-only')
    expect(table.parentElement?.className).toContain('sr-only')
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Day',
      'Balance (USD)',
    ])
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th,td')].map((c) => c.textContent),
    )
    expect(rows).toEqual([
      ['Mon 8', '1,240.00'],
      ['Tue 9', '1,100.00'],
      ['Wed 10', '1,180.00'],
      ['Thu 11', '1,120.00'],
    ])
    expect(table.querySelector('caption')!.textContent).toBe(SUMMARY)
  })
})

describe('AreaChart — the reveal, the mobile half, the sparse half', () => {
  it('reveals a day to a keyboard caret and to a tap', () => {
    renderChart()
    const svg = document.querySelector('svg')!
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
    fireEvent.keyDown(svg, { key: 'ArrowRight' }) // → Tue 9
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Tue 9/)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/1,100\.00/)
    fireEvent.keyDown(svg, { key: 'End' })
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Thu 11/)
    fireEvent.keyDown(svg, { key: 'Escape' })
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()

    // A tap pins it, and the pin holds when the pointer leaves: a phone
    // has no hover to hold a callout open with.
    fireEvent.mouseDown(document.querySelectorAll('[data-testid="area-point"]')[0]!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Mon 8/)
    fireEvent.mouseLeave(svg)
    expect(screen.queryByTestId('chart-tooltip')).not.toBeNull()
  })

  it('never pins itself: the callout takes no pointer, and a pin is released by a second tap or Escape (#3070)', () => {
    renderChart()
    const groups = areaPoints()
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
    // The pointer falls through to the hit strips beneath: hovering the next
    // point while the previous point's callout would lie over it moves the
    // hover — the scrub the issue measured, which used to skip a day.
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

  it('lets a pin and a caret go when the points change, so a shorter range does not strand the reveal on a day that is gone', () => {
    const fivePoints: AreaPoint[] = [
      ...FOUR_POINTS,
      { label: 'Fri 12', value: 1210 },
    ]
    const { rerender } = renderChart({}, fivePoints)
    fireEvent.mouseDown(areaPoints()[4]!)
    fireEvent.mouseLeave(document.querySelector('svg')!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Fri 12/)
    rerender(
      <AreaChart points={FOUR_POINTS} currency="USD" ariaLabel={SUMMARY} formatValue={fmt} />,
    )
    expect(screen.queryByTestId('chart-tooltip')).toBeNull()
    // Hover works again at once — the stale pin is not outranking it.
    fireEvent.mouseEnter(areaPoints()[0]!)
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/Mon 8/)
  })

  it('thins the labels on a narrow screen and puts the panel below the plot', () => {
    // 90 points on a phone: five labels at the very most, the LAST one on
    // the closing day — where the stride's own last slot (d72) is the one
    // that moves to the endpoint rather than a sixth label printing past
    // the cap — and the tooltip in the flow rather than floating over the
    // thing it describes.
    const many = Array.from({ length: 90 }, (_, i) => ({ label: `d${i}`, value: 1000 + i }))
    renderChart({ narrow: true }, many)
    const labels = screen.getAllByTestId('chart-x-label')
    expect(labels.length).toBeLessThanOrEqual(5)
    expect(labels.map((el) => el.textContent?.trim())).toEqual([
      'd0',
      'd18',
      'd36',
      'd54',
      'd89',
    ])
    fireEvent.keyDown(document.querySelector('svg')!, { key: 'End' })
    const tip = screen.getByTestId('chart-tooltip')
    expect(tip.className).not.toMatch(/absolute/)
    expect(tip.className).toMatch(/mt-3/)
  })

  it('renders nothing at all below the chartable floor, and draws once filled', () => {
    const { container, rerender } = renderChart({}, [{ label: 'Mon 8', value: 1240 }])
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('chart-data-table')).toBeNull()
    rerender(
      <AreaChart
        points={FOUR_POINTS}
        currency="USD"
        ariaLabel={SUMMARY}
        formatValue={fmt}
      />,
    )
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getAllByTestId('area-point')).toHaveLength(FOUR_POINTS.length)
  })

  it('declares its draw-in motion only inside the reduced-motion gate', () => {
    // Same argument as the bar chart's, with the other half of the rule:
    // the stroke-draw class exists in the gated block, and nowhere outside
    // it does a chart class carry an animation.
    const css = readFileSync(resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const gate = /@media\s+\(prefers-reduced-motion:\s*no-preference\)\s*\{/.exec(css)
    expect(gate).not.toBeNull()
    let depth = 1
    let close = gate!.index + gate![0].length
    while (depth > 0 && close < css.length) {
      if (css[close] === '{') depth++
      else if (css[close] === '}') depth--
      close++
    }
    const gated = css.slice(gate!.index + gate![0].length, close - 1)
    expect(gated).toMatch(/\.v2-chart-draw-stroke\s*\{[\s\S]*?\banimation:/)
    expect(gated).toMatch(/stroke-dasharray:\s*1/)
    const ungated = css.slice(0, gate!.index) + css.slice(close)
    expect(ungated).not.toMatch(/\.v2-chart-draw[^{]*\{[^}]*\banimation:/)
    // And the path is given the length the dash trick measures against — a
    // dasharray of 1 without a pathLength of 1 hides the line in plain ink.
    renderChart()
    const line = [...document.querySelectorAll('path')].find((p) =>
      (p.getAttribute('class') ?? '').includes('v2-chart-draw-stroke'),
    )!
    // jsdom matches SVG attribute names case-sensitively and React renders
    // the SVG spelling (`pathLength`), but attribute-name case handling has
    // drifted across jsdom versions — accept either spelling rather than pin
    // the test to one of them.
    const pathLen = line.getAttribute('pathLength') ?? line.getAttribute('pathlength')
    expect(pathLen).toBe('1')
  })
})
