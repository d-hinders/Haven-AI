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
 * annotation reads `spent 120.00 USD`, the claim the issue asks for ("the
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
    // And the scale did not fall to a zero floor: the gridline labels the
    // reader sees are multiples of 500 (the nice step of this range), which
    // only a data-anchored scale prints. A zero-based scale of the same
    // height would print 200 / 400 / 600 / 800 / 1000 / 1200. The labels
    // print through the caller's formatter, so they carry its grouping.
    const tickLabels = screen.getAllByTestId('chart-tick-label').map((el) => el.textContent)
    expect(tickLabels).toEqual(['500.00', '1,000.00'])
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
    expect(screen.getByTestId('area-delta')).toHaveTextContent('spent 120.00 USD')
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
      'gained 110.00 USD',
    )
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
    expect(table.className).toContain('sr-only')
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
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent(/USD 1,100\.00/)
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
