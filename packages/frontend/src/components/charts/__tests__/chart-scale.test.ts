import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chartScale,
  MAX_X_LABELS_DESKTOP,
  MAX_X_LABELS_MOBILE,
  MIN_CHARTABLE_DAYS,
  roundNiceStep,
  xLabelIndices,
} from '../chart-scale'

/**
 * The scale maths behind the chart primitives (#2948, analytics slice D).
 *
 * The acceptance list names these behaviours, and they are asserted HERE
 * rather than inferred from a rendered SVG, because they are arithmetic: the
 * issue's words are "ticks hit data values, never beyond the max" and the
 * 7/30/90 label densities. Driving the functions directly means a violation
 * names the rule it broke instead of naming a DOM shape that happened to be
 * in the way. The rendered half — aria summary, tooltip content, the sparse
 * no-render, the reduced-motion branch — lives in the two primitives' own
 * test files.
 *
 * The expected values below are the nice-step table's own outputs, computed
 * from its definition (the family 1, 2, 2.5, 5, 10 × 10ⁿ with the ceiling
 * `step × floor(dataMax / step + 1)`), not eyeballed off a printout. The
 * `never beyond the max` test carries the same reading for a spread of
 * maxima so a single lucky number cannot be what makes the suite green.
 */

/** The module under test is pure; this is how its doc comment reads above. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // JSDoc is prose about the code, not code
    .replace(/^\s*\*.*$/gm, '') // a block-comment gutter, likewise
    .replace(/(?<!:)\/\/.*$/gm, '') // line comments; keep `://` intact
}

describe('chartScale — ticks hit values the data reaches, never beyond the max', () => {
  it('never places a tick above the data it describes', () => {
    // The load-bearing invariant of the whole file, run over a spread of
    // maxima rather than over one lucky number: a tick at 780 in a chart
    // whose tallest bar is 743 invites reading a day that never spent 780.
    for (const dataMax of [1, 7, 42, 99, 240, 743, 1240, 87654.32, 1e9]) {
      const { max, ticks } = chartScale(dataMax)
      expect(max, `ceiling for ${dataMax}`).toBeGreaterThanOrEqual(dataMax)
      expect(max, `the tallest bar is never flush with the frame (${dataMax})`).toBeGreaterThan(
        dataMax,
      )
      for (const tick of ticks) {
        expect(tick, `tick ${tick} of ${dataMax}`).toBeLessThan(max)
        expect(tick, `tick ${tick} of ${dataMax} is not a quantity`).toBeGreaterThanOrEqual(0)
      }
      expect(ticks.length, `a range of ${dataMax} is drawn with no gridline at all`).toBeGreaterThan(0)
    }
  })

  it('prints round values, not the raw thirds of an arbitrary max', () => {
    // The failure the nice steps prevent: a 743-tall range split four ways
    // is 185.75 / 371.5 / 557.25, and no day ever spent those amounts. The
    // snapped scale is the one whose ticks the data can be said to reach.
    expect(chartScale(743)).toEqual({ max: 800, ticks: [200, 400, 600] })
    // 1240 → step roundNiceStep(310): the 3.1 unit snaps up to the 5, so the
    // step is 500 and the scale reads 500 / 1000 under a 1500 ceiling.
    expect(chartScale(1240)).toEqual({ max: 1500, ticks: [500, 1000] })
    // 2.5 is on the family, so 99 reaches it: 25 / 50 / 75 under 100.
    expect(chartScale(99)).toEqual({ max: 100, ticks: [25, 50, 75] })
  })

  it('lifts the ceiling past a data max that is already a round step', () => {
    // The +1 guard, and the reason a chart's frame is never a data line: a
    // 1000-tall range whose step is also a round 250 must not have its
    // tallest bar sitting on the top of the plot.
    const { max, ticks } = chartScale(1000)
    expect(max).toBe(1250)
    expect(ticks).toEqual([250, 500, 750, 1000])
    expect(ticks).not.toContain(max)
  })

  it('does not list zero as a tick', () => {
    // The axis line already draws the floor; a "tick" at 0 is the floor
    // counted twice, and it crowds the label column with a `0` nobody asked
    // to plot.
    for (const dataMax of [1, 240, 743, 1240]) {
      expect(chartScale(dataMax).ticks, `zero in the ticks of ${dataMax}`).not.toContain(0)
    }
  })

  it('keeps float dust out of the printed labels', () => {
    // The steps accumulate by addition, and a fraction in the binary float
    // set prints as 7.4999999999996 — which is a defect the moment it is
    // typeset on an axis. Every tick must be a number a human can read off
    // the screen without a calculator next to it.
    for (const dataMax of [9, 24, 99, 240, 87654.32, 0.7]) {
      for (const tick of chartScale(dataMax).ticks) {
        expect(String(tick), `tick ${tick} of ${dataMax} carries float dust`).toMatch(
          /^(0|[1-9]\d*)(\.[1-9]\d{0,8})?$/,
        )
      }
    }
  })

  it('degenerates honestly on an empty range instead of inventing headroom', () => {
    // A chart with nothing plotted has nothing to tick. The alternative — a
    // scale of 0..10 — is a lie in a serif face: it shows a y-axis with
    // values on it, for a chart about nothing.
    expect(chartScale(0)).toEqual({ max: 0, ticks: [] })
    expect(chartScale(-5)).toEqual({ max: 0, ticks: [] })
    expect(chartScale(Number.NaN)).toEqual({ max: 0, ticks: [] })
    expect(chartScale(Number.POSITIVE_INFINITY)).toEqual({ max: 0, ticks: [] })
  })

  it('honours a coarser interval when asked for fewer gridlines', () => {
    // The narrow-screen half asks for less ink on the y-axis too, and the
    // scale answers with a coarser family member rather than a crowded one.
    const two = chartScale(1240, 2)
    const four = chartScale(1240, 4)
    expect(two.ticks.length).toBeLessThanOrEqual(four.ticks.length)
    expect(two).toEqual({ max: 2000, ticks: [1000] })
    expect(four).toEqual({ max: 1500, ticks: [500, 1000] })
  })
})

describe('roundNiceStep', () => {
  it('snaps a span to the near 1, 2, 2.5, 5, 10 family', () => {
    expect(roundNiceStep(185)).toBe(200)
    expect(roundNiceStep(40)).toBe(50)
    expect(roundNiceStep(3.1)).toBe(5)
    expect(roundNiceStep(2.2)).toBe(2.5)
    expect(roundNiceStep(1)).toBe(1)
    expect(roundNiceStep(310)).toBe(500)
  })

  it('stays positive for a span that is not', () => {
    // Not a chart's business, but a caller with an empty array reaches this
    // function through `Math.max(0, …)` and must not receive a step that
    // makes the tick loop run forever.
    expect(roundNiceStep(0)).toBe(1)
    expect(roundNiceStep(-7)).toBe(1)
  })
})

describe('xLabelIndices — the density the issue fixes for 7d, 30d, 90d', () => {
  it('labels every day for a week', () => {
    // 7d → every day labelled. Nothing to thin, nothing to invent.
    expect(xLabelIndices(7)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(xLabelIndices(1)).toEqual([0])
  })

  it('labels weekly for a month', () => {
    // 30d → weekly ticks: days 0, 7, 14, 21, 28 — and the last day on the
    // end, because the right edge is where the range finishes and a chart
    // that stops its labels short of it hides the window it is about.
    expect(xLabelIndices(30)).toEqual([0, 7, 14, 21, 28, 29])
  })

  it('labels fortnightly for a quarter', () => {
    // 90d → fortnightly, on the same last-day rule: day 84 and day 89 are
    // five apart, which is the price of never leaving the range unlabelled
    // at its close.
    expect(xLabelIndices(90)).toEqual([0, 14, 28, 42, 56, 70, 84, 89])
  })

  it('thins to the width it has rather than overprinting labels', () => {
    // The ranges the fixed bands leave too crowded for the narrow screen: on
    // mobile five labels at the most, and they must not collide.
    const mobile = xLabelIndices(90, { narrow: true })
    expect(mobile.length).toBeLessThanOrEqual(MAX_X_LABELS_MOBILE)
    expect(mobile[mobile.length - 1]).toBe(89)

    const desktop = xLabelIndices(45)
    expect(desktop.length).toBeLessThanOrEqual(MAX_X_LABELS_DESKTOP)
    expect(desktop[desktop.length - 1]).toBe(44)
  })

  it('never exceeds the cap it is given, and always ends on the last day', () => {
    // The two rules are in tension — the endpoint label can push the list
    // one past the cap — and the resolution is that a slot MOVES rather than
    // an extra label being printed, so neither rule is broken silently.
    for (const count of [7, 30, 45, 60, 74, 90, 120, 365]) {
      for (const narrow of [false, true]) {
        const idx = xLabelIndices(count, { narrow })
        const cap = narrow ? MAX_X_LABELS_MOBILE : MAX_X_LABELS_DESKTOP
        expect(idx.length, `${count}${narrow ? ' narrow' : ' wide'} prints ${idx.length} labels`).toBeLessThanOrEqual(
          cap,
        )
        expect(idx[idx.length - 1], `${count}${narrow ? ' narrow' : ' wide'} has no last-day label`).toBe(
          count - 1,
        )
        expect(idx[0], `${count}${narrow ? ' narrow' : ' wide'} has no first-day label`).toBe(0)
      }
    }
  })

  it('keeps the strides apart so labels cannot overlap', () => {
    // Consecutive labels at least one band apart; a stride of one on a
    // 365-day narrow range would print three hundred and sixty five day
    // labels over a plot too narrow to read one of them.
    for (const count of [7, 30, 45, 90, 365]) {
      for (const narrow of [false, true]) {
        const idx = xLabelIndices(count, { narrow })
        for (let i = 1; i < idx.length; i++) {
          expect(
            idx[i] - idx[i - 1],
            `overlapping labels in ${count}${narrow ? ' narrow' : ' wide'}`,
          ).toBeGreaterThan(0)
        }
        expect(idx.every((i) => Number.isInteger(i) && i >= 0 && i < count)).toBe(true)
      }
    }
  })

  it('returns nothing when there is nothing to label', () => {
    expect(xLabelIndices(0)).toEqual([])
    expect(xLabelIndices(-3)).toEqual([])
  })

  it('is the shared floor the primitives read for the sparse-data decision', () => {
    // The number is the contract between the scale, both charts, and slice
    // C, so it is exported rather than written twice.
    expect(MIN_CHARTABLE_DAYS).toBe(3)
  })
})

describe('the scale module is the shared arithmetic it claims to be', () => {
  it('imports neither React nor the DOM', () => {
    // Both charts read this file, and the tests above read it directly, so
    // it cannot reach for a component or a window: a scale that needs a DOM
    // to compute its ticks is a scale that cannot be measured with a ruler.
    // Comments are stripped first — the module's own prose talks about a
    // "window", meaning the one a chart is drawn into.
    const source = codeOf(readFileSync(resolve(__dirname, '../chart-scale.ts'), 'utf8'))
    expect(source).not.toMatch(/\bfrom\s+['"]react['"]/)
    expect(source).not.toMatch(/\bwindow\.|\bdocument\.|HTMLElement|matchMedia/)
  })
})
