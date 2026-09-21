/**
 * The balance-over-time area chart (#2948, analytics slice D).
 *
 * One line, a faint area beneath it, and the range's spend annotated as the
 * delta between the two endpoints. Built on the same scale maths and the
 * same house pattern as `ui/StackedBarChart`: a hand-drawn SVG inside the
 * primitive's home file (the design-lint `raw-svg` exemption the two chart
 * homes carry there), colour from the `--v2-series-*` tokens (#2948), and
 * no chart library — none exists in the frontend and adding one is a
 * dependency decision the epic does not make. Read that file's header for
 * the reasoning that applies to both charts; this header records only what
 * is specific to this one.
 *
 * ## Why the line takes the first series stop, not a free one
 *
 * The `--v2-series-*` set is ordered and its first stop is the brand colour
 * in both palettes. The one line a balance chart has is exactly as load-
 * bearing as the first agent's stack in the bar chart, and it reading as the
 * same colour across the analytics page is the point of an ordered set.
 *
 * ## Why the spend is an annotation and not a second line
 *
 * The issue fixes it: "the range's spend annotated as the endpoint delta".
 * A second series for cumulative spend would ask the reader to subtract two
 * lines by eye; the delta is computed from the same two points the line
 * already passes through, so the chart states the fact once, in words. It
 * prints in neutral ink — colour here is for series, never for meaning, and
 * a balance that fell is not an error state.
 *
 * ## The scale
 *
 * From the data with headroom at both ends, and NOT from a zero baseline: a
 * balance that moved between 1,100 and 1,240 flattens into one hairline
 * across the plot on a zero-based scale, which is a chart whose whole claim
 * is that nothing happened. The nice-step rule runs on the padded RANGE —
 * floor to ceiling, `chartScaleRange` (#3204) — so the gridlines bracket the
 * data and stay values the data can be said to reach; run on the padded
 * maximum, as it was, every tick sat below the floor.
 *
 * ## Mobile, and the labels
 *
 * `narrow` is a prop and not a media query, for the reasons the bar chart's
 * header gives (the caller owns breakpoints; the primitive owns the
 * treatment; and it is what makes the density unit-testable). On a narrow
 * screen the x labels thin out, the tooltip becomes a tap-to-pin panel below
 * the plot, and the svg stays `block w-full` sized by its viewBox so the
 * page body never scrolls sideways on account of this element. The labels
 * are HTML positioned by percentage of the viewBox rather than SVG `<text>`,
 * because the drawing stretches with `preserveAspectRatio="none"` and
 * stretched type at a 390px viewport is exactly the defect that rule
 * prevents; see the bar chart's header, which spells it out.
 *
 * ## Accessibility
 *
 * The svg carries `role="img"` with an `aria-label` summary sentence, and
 * the plotted values are exposed as a visually-hidden table OUTSIDE that
 * element — a subtree of a `role="img"` is presentational and would swallow
 * the table — so a reader gets the headline and the figures.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { chartScaleRange, MIN_CHARTABLE_DAYS, xLabelIndices } from '@/components/charts/chart-scale'

/** The viewBox coordinate space; see `pct` for how the HTML labels read it. */
const VIEW_W = 640
const VIEW_H = 220
const PAD = { top: 14, right: 10, bottom: 30, left: 48 }
/** The narrow treatment widens the tick gutter, exactly as the bar chart's
 *  does: at 390 the desktop 48/640 is ~21 CSS px, and a currency tick drawn
 *  into it ran under the line's first week (#3204 review; the labels were
 *  never visible before that PR, so the gutter had never been measured). */
const PAD_NARROW = { ...PAD, left: 78 }
/** The fraction of the data's own span held free at each end, so the line
 *  clears the frame and no point sits on a gridline. The pad is RANGE-relative
 *  only: an earlier level-relative term (`|max| × 3%`) meant a 300 kr movement
 *  on a 12 000 kr balance got a 379 kr pad, a 500 kr step and a line using
 *  15% of the plot — the flat read this chart exists to avoid (#3204). A flat
 *  series (max === min) still needs SOME span to draw at all; that is the
 *  `max(…, 1)` floor. */
const HEADROOM = 0.06
/** The line and the area are the first series stop: see the header. */
const LINE_SERIES = 1
/** The area is the line's own colour at a fraction of its strength, so the
 *  fill reads as the line's shadow and not as a second claim. */
const AREA_OPACITY = 0.12
const DOT_R = 2.5

const AXIS_COLOR = 'var(--v2-border)'
const LINE_COLOR = `var(--v2-series-${LINE_SERIES})`

/** A viewBox coordinate as a percentage of the axis it lies on. */
function pct(value: number, span: number): string {
  return `${((value / span) * 100).toFixed(3)}%`
}

export interface AreaPoint {
  /** Stable day key; the axis, the hidden table, and the tooltip print it. */
  label: string
  /** The balance at this point, in the display currency. */
  value: number
}

export interface AreaChartProps {
  points: AreaPoint[]
  /**
   * Display currency code the figures are in — named only in the accessible
   * table's header. The annotation and the tooltip print `formatValue`'s
   * output alone: callers pass a currency-style formatter, and appending the
   * code again read "298,43 kr SEK" (#3204).
   */
  currency: string
  /** Printed verbatim as the accessible name of the graphic, e.g.
   *  `Balance over 30 days: ends at 1,240 USD, 180 USD spent across the
   *  range`. The caller owns the sentence; only the caller knows the range. */
  ariaLabel: string
  /** The caller formats every money figure — one voice across the page. */
  formatValue: (amount: number) => string
  /** Tick labels; callers keep it compact (no cents) so the gutter fits. Defaults to `formatValue`. */
  formatTick?: (amount: number) => string
  /** Fewer ticks and the pinned panel: the 390px treatment, owned by the
   *  caller's breakpoint. */
  narrow?: boolean
  className?: string
}

export function AreaChart({
  points,
  currency,
  ariaLabel,
  formatValue,
  formatTick = formatValue,
  narrow = false,
  className = '',
}: AreaChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Everything the drawing needs, derived once from the points. The scale is
  // computed on the PADDED extremes — floor AND ceiling — so the nice steps
  // stay nice across the whole plot while the line keeps clear of the frame
  // at both ends. Range-aware (`chartScaleRange`, #3204): the ticks live
  // between the padded floor and the ceiling, never below the floor.
  const plot = useMemo(() => {
    const values = points.map((p) => p.value)
    const min = values.length > 0 ? Math.min(...values) : 0
    const max = values.length > 0 ? Math.max(...values) : 0
    const pad = Math.max((max - min) * HEADROOM, 1)
    const scale = chartScaleRange(Math.max(0, min - pad), max + pad)
    const floor = scale.min
    const span = scale.max - floor
    const P = narrow ? PAD_NARROW : PAD
    const plotW = VIEW_W - P.left - P.right
    const plotH = VIEW_H - P.top - P.bottom
    const baseY = P.top + plotH
    const xOf = (index: number) =>
      P.left + (points.length <= 1 ? plotW / 2 : (plotW * index) / (points.length - 1))
    const yOf = (value: number) => (span <= 0 ? baseY : baseY - ((value - floor) / span) * plotH)
    return {
      scale,
      floor,
      span,
      plotW,
      plotH,
      baseY,
      pad: P,
      xOf,
      yOf,
      labelIdx: xLabelIndices(points.length, { narrow }),
      delta: values.length >= 2 ? values[values.length - 1] - values[0] : 0,
      // Two points make a line, which is the minimum the drawing can be;
      // below that there is nothing to connect.
      linePath:
        points.length < 2
          ? ''
          : points
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)} ${yOf(p.value).toFixed(2)}`)
              .join(' '),
    }
  }, [points, narrow])

  const areaPath =
    plot.linePath === ''
      ? ''
      : `M${plot.xOf(0).toFixed(2)} ${plot.baseY.toFixed(2)} L ${plot.linePath.slice(1)} L ${plot
          .xOf(points.length - 1)
          .toFixed(2)} ${plot.baseY.toFixed(2)} Z`

  // The sparse-data decision, taken before any early exit and acted on below
  // the last hook: the hooks have to run unconditionally, and data arriving
  // late makes a return between them a hook-count change — a React crash
  // rather than an empty chart. A range with too few points to be a trend
  // contributes nothing at all (see the bar chart's header; a unit test
  // proves the branch, which is the acceptance criterion for it).
  const chartable = points.length >= MIN_CHARTABLE_DAYS

  const active = caret ?? pinned ?? hovered
  const point = active === null ? null : points[active] ?? null

  const moveCaret = useCallback(
    (event: KeyboardEvent<SVGSVGElement>) => {
      if (points.length === 0) return
      const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 }
      if (event.key in step) {
        event.preventDefault()
        setCaret((prev) => {
          // The caret rests on the first day before any arrow is pressed — a
          // roving caret: focus arrives at the chart with day 0 already
          // current, so the first ArrowRight advances to the SECOND day and
          // ArrowLeft clamps where it is. Escape clears and the convention
          // restarts.
          const next = (prev ?? 0) + step[event.key]
          return Math.min(points.length - 1, Math.max(0, next))
        })
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        setCaret(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setCaret(points.length - 1)
      } else if (event.key === 'Escape') {
        setCaret(null)
        setPinned(null)
      }
    },
    [points.length],
  )

  // A pin or caret outlives the data it pointed at otherwise: a shorter
  // range would leave `active` on an index with no point — no callout, and
  // no hover either, until a tap or Escape. Reset both when the points
  // change. (The bar chart's note; #3070 ports its treatment whole.)
  useEffect(() => {
    setPinned(null)
    setCaret(null)
  }, [points.length])

  if (!chartable) return null

  return (
    <div data-testid="area-chart" className={`relative w-full ${className}`.trim()}>
      <div data-testid="chart-plot" className="relative w-full">
        <svg
          ref={svgRef}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block h-[140px] w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:h-[200px]"
          onKeyDown={moveCaret}
          onMouseLeave={() => setHovered(null)}
        >
          {plot.scale.ticks.map((tick) => (
            <line
              key={`grid-${tick}`}
              data-testid="chart-gridline"
              x1={plot.pad.left}
              x2={VIEW_W - plot.pad.right}
              y1={plot.yOf(tick)}
              y2={plot.yOf(tick)}
              stroke={AXIS_COLOR}
              strokeWidth={1}
            />
          ))}
          <line
            x1={plot.pad.left}
            x2={VIEW_W - plot.pad.right}
            y1={plot.baseY}
            y2={plot.baseY}
            stroke={AXIS_COLOR}
            strokeWidth={1}
          />
          {/* The area behind, the claim in front, each its own element. */}
          <path d={areaPath} fill={LINE_COLOR} fillOpacity={AREA_OPACITY} stroke="none" />
          <path
            d={plot.linePath}
            pathLength={1}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="v2-chart-draw v2-chart-draw-stroke"
          />
          {points.map((p, i) => (
            <g
              key={`pt-${i}-${p.label}`}
              data-testid="area-point"
              aria-hidden="true"
              onMouseEnter={() => setHovered(i)}
              // A tap pins the day; a second tap on the pinned day lets
              // it go (the callout takes no pointer, so nothing else can
              // — #3070, the #3066 treatment). The release also drops the
              // hover: a touch tap synthesises mouseenter before mousedown
              // and never a mouseleave, so without this the panel would
              // stay up through the second tap.
              onMouseDown={() => {
                if (pinned === i) {
                  setPinned(null)
                  setHovered(null)
                } else {
                  setPinned(i)
                }
              }}
            >
              {/* The hit strip is the day's whole slice of the plot, not the
                  dot: a day has to be selectable where the day is drawn. */}
              <rect
                x={plot.xOf(i) - plot.plotW / Math.max(1, points.length - 1) / 2}
                y={plot.pad.top}
                width={plot.plotW / Math.max(1, points.length - 1)}
                height={plot.plotH}
                fill="transparent"
                stroke="none"
              />
              <circle
                cx={plot.xOf(i)}
                cy={plot.yOf(p.value)}
                r={active === i ? DOT_R * 1.6 : DOT_R}
                fill={LINE_COLOR}
                stroke={LINE_COLOR}
              />
            </g>
          ))}
        </svg>

        {/* The labels, in HTML: the drawing stretches and the type does not
            (see the header). */}
        {plot.scale.ticks.map((tick) => (
          <span
            key={`tick-${tick}`}
            data-testid="chart-tick-label"
            aria-hidden="true"
            className="absolute block text-right text-xs leading-none text-[var(--v2-ink-3)]"
            style={{
              left: 0,
              width: pct(plot.pad.left - 6, VIEW_W),
              top: pct(plot.yOf(tick), VIEW_H),
              transform: 'translateY(-50%)',
            }}
          >
            {formatTick(tick)}
          </span>
        ))}
        {plot.labelIdx.map((i) => (
          <span
            key={`x-${i}`}
            data-testid="chart-x-label"
            aria-hidden="true"
            className="absolute block whitespace-nowrap text-xs leading-none text-[var(--v2-ink-3)]"
            style={{
              left: pct(plot.xOf(i), VIEW_W),
              top: pct(plot.baseY + 8, VIEW_H),
              transform: `translateX(${i === 0 ? '0' : i === points.length - 1 ? '-100%' : '-50%'})`,
            }}
          >
            {points[i]?.label}
          </span>
        ))}
        {/* The endpoint delta: the range's spend, annotated (see header).
            Neutral ink — a fall is not a failure, and the series colours are
            for series. */}
        <span
          data-testid="area-delta"
          aria-hidden="true"
          className="absolute block text-right text-xs leading-none text-[var(--v2-ink-3)]"
          style={{ right: pct(plot.pad.right, VIEW_W), top: pct(plot.pad.top - 2, VIEW_H) }}
        >
          {deltaLabel(plot.delta)} {formatValue(Math.abs(plot.delta))}
        </span>
      </div>

      {/* The callout takes no pointer events: it used to pin itself on
          mouseenter, and since it overlaps the neighbouring points the
          pointer could not reach a day the previous day's callout lay over
          (#3070 — a scrub across the /design-system sample skipped Thu 4).
          Now the pointer falls through to the hit strips beneath; a pin is
          a tap on the day, released by a second tap or Escape. On a narrow
          screen the panel is in flow below the plot. */}
      {point !== null && (
        <div
          data-testid="chart-tooltip"
          role="status"
          className={
            narrow
              ? 'mt-3 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3'
              : 'pointer-events-none absolute left-1/2 top-3 w-max max-w-full -translate-x-1/2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3 shadow-popover'
          }
        >
          <p className="text-xs text-[var(--v2-ink-2)]">{point.label}</p>
          <p className="mt-1 text-sm font-semibold text-[var(--v2-ink)]">
            {formatValue(point.value)}
          </p>
        </div>
      )}

      {/* The values in full — outside the `role="img"` svg, whose subtree
          assistive technology is not shown (see the header). A chart's
          visually-hidden data table is not a product table: `ui/Table` is
          visible rows with column staging and hover chrome, which is not
          what a screen reader is handed here. */}
      {/* `sr-only` on a wrapper, not on the table element: Tailwind's
          `sr-only` sets `height: 1px`, which a table treats as a minimum, so
          the table rendered at full size, clipped by the card's
          `overflow-hidden`, and the screenshot harness counted ~800px of
          "hidden content" on every capture (#3204 design review). A block
          wrapper honours the 1px. */}
      <div className="sr-only">
        {/* design-lint-disable-line: raw-table */}
        <table data-testid="chart-data-table">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Balance ({currency})</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={`row-${i}-${p.label}`}>
              <th scope="row">{p.label}</th>
              <td>{formatValue(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

/**
 * The word before the endpoint delta. A fall in the balance over a spend
 * range is the range's spend, and saying "spent 180" is truer than saying
 * "net -180" next to a chart of payments; a rise is called a rise.
 */
export function deltaLabel(delta: number): string {
  if (delta < 0) return 'spent'
  if (delta > 0) return 'gained'
  return 'unchanged'
}
