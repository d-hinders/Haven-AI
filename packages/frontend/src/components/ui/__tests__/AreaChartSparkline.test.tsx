import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AreaChart, type SparklinePoint } from '../AreaChart'

/**
 * The sparkline variant across missing days (#3897).
 *
 * A missing day (`value: null`) is skipped, never zero, and the line connects
 * across it. #3805 broke the line at every gap, so sparse snapshots drew as
 * short dashes and a lone measured day drew nothing at all — the scattered
 * fragments on a real dev account.
 */

const VIEW_W = 640
const HEIGHT = 40

/** A dense 30-day window measured on `measured` day indexes only. */
function window(measured: Record<number, number>): SparklinePoint[] {
  return Array.from({ length: 30 }, (_, i) => ({
    label: `day-${i}`,
    value: i in measured ? measured[i] : null,
  }))
}

function xOf(index: number): number {
  return (VIEW_W * index) / 29
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

  it('draws exactly one path through every measured day, at its true x', () => {
    const { container } = renderSparkline(sparse)
    const paths = container.querySelectorAll('path')
    expect(paths).toHaveLength(1)
    const xs = pathXs(paths[0].getAttribute('d') ?? '')
    expect(xs).toEqual([2, 9, 15, 22, 28].map((i) => Number(xOf(i).toFixed(2))))
  })

  it('never plots a missing day at zero', () => {
    const { container } = renderSparkline(sparse)
    const d = container.querySelector('path')?.getAttribute('d') ?? ''
    // Five commands for five measured days — no point for any of the 25
    // missing ones — and none of them at the baseline a zero would sit on.
    expect(pathXs(d)).toHaveLength(5)
    for (const y of pathYs(d)) expect(y).toBeLessThan(HEIGHT)
  })

  it('ends with the dot on the last measured day, as HTML — a `<circle>` would stretch into an oval (#3903)', () => {
    const { container } = renderSparkline(sparse)
    const dot = container.querySelector<HTMLElement>(
      '[data-testid="area-chart-sparkline-dot"]',
    )
    expect(dot).not.toBeNull()
    expect(container.querySelectorAll('circle')).toHaveLength(0)
    // The dot's horizontal position is the endpoint's fraction of the
    // viewBox — the same fraction the old circle's `cx` divided by the
    // viewBox width was. (Read from the data attribute: jsdom's CSSOM
    // re-serialises the calc() and drops the multiplier's precision.)
    expect(dot!.dataset.xFrac).toBe((28 / 29).toFixed(6))
    // And the dot keeps the circle's rendered footprint (2·r plus the
    // stroke), sized as inline style so it stays round at every width.
    expect(dot!.style.width).toBe('6px')
    expect(dot!.style.height).toBe('6px')
  })

  it('keeps the flat placeholder below three points', () => {
    const { container } = renderSparkline([
      { label: 'a', value: 100 },
      { label: 'b', value: 120 },
    ])
    expect(container.querySelectorAll('path')).toHaveLength(0)
    expect(container.querySelector('[data-testid="area-chart-sparkline-dot"]')).toBeNull()
    const line = container.querySelector('line')
    expect(line?.getAttribute('y1')).toBe(String(HEIGHT / 2))
    expect(line?.getAttribute('y2')).toBe(String(HEIGHT / 2))
  })
})
