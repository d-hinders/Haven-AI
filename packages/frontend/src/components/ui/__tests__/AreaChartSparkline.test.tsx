import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AreaChart, SPARKLINE_INSET, SPARKLINE_VIEW_W, type SparklinePoint } from '../AreaChart'

/**
 * The sparkline variant across missing days (#3897).
 *
 * A missing day (`value: null`) is skipped, never zero, and the line connects
 * across it. #3805 broke the line at every gap, so sparse snapshots drew as
 * short dashes and a lone measured day drew nothing at all — the scattered
 * fragments on a real dev account.
 */

const HEIGHT = 40

/** A dense 30-day window measured on `measured` day indexes only. */
function window(measured: Record<number, number>): SparklinePoint[] {
  return Array.from({ length: 30 }, (_, i) => ({
    label: `day-${i}`,
    value: i in measured ? measured[i] : null,
  }))
}

/** Even spacing across the plot, which starts and ends `SPARKLINE_INSET` inside the viewBox. */
function xOf(index: number): number {
  return SPARKLINE_INSET + ((SPARKLINE_VIEW_W - 2 * SPARKLINE_INSET) * index) / 29
}

/** The x coordinates of a path's `M`/`L` commands, in order. */
function pathXs(d: string): number[] {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]))
}

function pathYs(d: string): number[] {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]))
}

function renderSparkline(points: SparklinePoint[]) {
  return render(
    <AreaChart variant="sparkline" points={points} height={HEIGHT} ariaLabel="Balance over the last 30 days" />,
  )
}

describe('AreaChart sparkline across missing days (#3897)', () => {
  // Five measured days, none adjacent: #3805's renderer drew NO path at all
  // here (every run was a single point).
  const sparse = window({ 2: 100, 9: 120, 15: 90, 22: 140, 28: 130 })

  it('draws exactly one line through every measured day, at its true x', () => {
    const { container } = renderSparkline(sparse)
    const lines = container.querySelectorAll('path[data-sparkline-line]')
    expect(lines).toHaveLength(1)
    const xs = pathXs(lines[0].getAttribute('d') ?? '')
    expect(xs).toEqual([2, 9, 15, 22, 28].map((i) => Number(xOf(i).toFixed(2))))
  })

  it('never plots a missing day at zero, in the line or the area top edge', () => {
    const { container } = renderSparkline(sparse)
    const line = container.querySelector('path[data-sparkline-line]')?.getAttribute('d') ?? ''
    const area = container.querySelector('path[data-sparkline-area]')?.getAttribute('d') ?? ''
    // Five commands for five measured days — no point for any of the 25
    // missing ones — and none of them at the baseline a zero would sit on.
    expect(pathXs(line)).toHaveLength(5)
    for (const y of pathYs(line)) expect(y).toBeLessThan(HEIGHT)
    // The area is the line's commands between two baseline corners: its top
    // edge is exactly the line, with no vertex of its own at a missing day.
    const areaXs = pathXs(area)
    const areaYs = pathYs(area)
    expect(areaXs).toHaveLength(7)
    expect(areaXs.slice(1, -1)).toEqual(pathXs(line))
    expect(areaYs.slice(1, -1)).toEqual(pathYs(line))
    for (const y of areaYs.slice(1, -1)) expect(y).toBeLessThan(HEIGHT)
    expect(areaYs[0]).toBe(HEIGHT)
    expect(areaYs[areaYs.length - 1]).toBe(HEIGHT)
  })

  it('fills under the line once there are three or more points', () => {
    const { container } = renderSparkline(sparse)
    const area = container.querySelector('path[data-sparkline-area]')
    expect(area).not.toBeNull()
    expect(area?.getAttribute('fill')).not.toBe('none')
    expect(Number(area?.getAttribute('fill-opacity'))).toBeGreaterThan(0)
    expect(area?.getAttribute('stroke')).toBe('none')
    expect(container.querySelector('path[data-sparkline-line]')?.getAttribute('fill')).toBe('none')
  })

  it('ends with the dot on the last measured day', () => {
    const { container } = renderSparkline(sparse)
    const dot = container.querySelector('circle')
    expect(Number(dot?.getAttribute('cx'))).toBeCloseTo(xOf(28), 2)
  })

  it('keeps the flat placeholder below three points', () => {
    const { container } = renderSparkline([
      { label: 'a', value: 100 },
      { label: 'b', value: 120 },
    ])
    expect(container.querySelectorAll('path')).toHaveLength(0)
    expect(container.querySelector('[data-sparkline-area]')).toBeNull()
    expect(container.querySelectorAll('circle')).toHaveLength(0)
    const line = container.querySelector('line')
    expect(line?.getAttribute('y1')).toBe(String(HEIGHT / 2))
    expect(line?.getAttribute('y2')).toBe(String(HEIGHT / 2))
    expect(line?.getAttribute('x1')).toBe('0')
    expect(line?.getAttribute('x2')).toBe(String(SPARKLINE_VIEW_W))
  })
})

describe('AreaChart sparkline end dot stays inside the viewBox (#3902)', () => {
  // The circle's 1-unit stroke adds 0.5 at every edge.
  const cases: Array<[string, Record<number, number>]> = [
    ['a last value of 0', { 2: 100, 15: 90, 29: 0 }],
    ['the maximum as the last value', { 2: 100, 15: 90, 29: 200 }],
    ['a mid-range last value', { 2: 100, 15: 50, 29: 80 }],
  ]
  it.each(cases)('fully contains the dot for %s', (_name, measured) => {
    const { container } = renderSparkline(window(measured))
    const dot = container.querySelector('circle')
    const cx = Number(dot?.getAttribute('cx'))
    const cy = Number(dot?.getAttribute('cy'))
    const r = Number(dot?.getAttribute('r'))
    expect(r).toBeGreaterThan(0)
    expect(cx + r + 0.5).toBeLessThanOrEqual(SPARKLINE_VIEW_W)
    expect(cx - r - 0.5).toBeGreaterThanOrEqual(0)
    expect(cy - r - 0.5).toBeGreaterThanOrEqual(0)
    expect(cy + r + 0.5).toBeLessThanOrEqual(HEIGHT)
  })
})
