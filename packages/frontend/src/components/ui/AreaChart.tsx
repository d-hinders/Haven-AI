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
 * ## The dots are HTML, not `<circle>`s (#3903)
 *
 * The drawing stretches with `preserveAspectRatio="none"`, and a `<circle>`
 * stretches with it: wherever the box's aspect differs from the viewBox's,
 * the dot renders as an oval (measured ~3.5 × 5.5 CSS px on the dashboard
 * money card's sparkline). The dots are therefore HTML spans — round at
 * every width — positioned the same way the labels are: a percentage of the
 * viewBox for the full chart, and CSS px for the sparkline, whose vertical
 * scale is exactly 1 in fixed-height mode (in `fill` mode, #3908, the
 * vertical position is the endpoint's fraction of the inset box, like
 * `left`). The sparkline's box carries a horizontal inset in CSS
 * px (`SPARKLINE_DOT_INSET`, at least the dot's radius plus stroke) and the
 * line draws edge to edge inside it, so the end dot's centre stays on the
 * line's endpoint while the whole dot stays inside the box — the #3902
 * containment guarantee, restated in CSS px rather than viewBox units. The
 * inset runs on ALL sides, not just the horizontal one: the scale floors at
 * zero, so a last balance of 0 maps to the box's bottom edge exactly, and a
 * round dot centred there would straddle it.
 * The line's own stroke takes `vector-effect: non-scaling-stroke` for the
 * same reason: without it the 2-unit stroke is 2 px on flat segments and
 * stretched on steep ones.
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
/** The narrow treatment widens the tick gutter: at 390 the desktop 48/640
 *  is ~21 CSS px, and a currency tick drawn into it ran under the line's
 *  first week (#3204 review; the labels were never visible before that PR,
 *  so the gutter had never been measured). The bar chart's 78 was tried and
 *  measured short too: its label box is ~33 px at 390 while `12 600 kr`
 *  (sv-SE, `text-xs` Inter) is 53.4 px and `$12,600` 46 px, so the end of
 *  the label — `text-right`, no break opportunity — spilled into the plot.
 *  128 gives a ~56 px box, wider than the widest supported tick. */
const PAD_NARROW = { ...PAD, left: 128 }
/** The fraction of the data's own span held free at each end, so the line
 *  clears the frame and no point sits on a gridline. The pad is RANGE-relative
 *  only: an earlier level-relative term (`|max| × 3%`) meant a 300 kr movement
 *  on a 12 000 kr balance got a 379 kr pad, a 500 kr step and a line using
 *  15% of the plot — the flat read this chart exists to avoid (#3204). A flat
 *  series (max === min) still needs SOME span to draw at all; that is the
 *  `max(…, 2)` floor. Two, not one: a ±1 span steps by 0.5 and the compact
 *  (no-cents) tick formatter then prints two gridlines with one label; a
 *  ±2 span steps by 1 and every integer tick is distinct. */
const HEADROOM = 0.06
/** The line and the area are the first series stop: see the header. */
const LINE_SERIES = 1
/** The area is the line's own colour at a fraction of its strength, so the
 *  fill reads as the line's shadow and not as a second claim. */
const AREA_OPACITY = 0.12
const DOT_R = 2.5
/** The `<circle>`s drew a default 1-unit stroke around the 2.5-unit fill;
 *  the HTML dots keep the same rendered footprint — the diameter INCLUDING
 *  the stroke — as inline style (#3903). */
const DOT_STROKE = 1
const DOT_DIAMETER = 2 * DOT_R + DOT_STROKE
const ACTIVE_DOT_DIAMETER = 2 * DOT_R * 1.6 + DOT_STROKE
/** The sparkline's inset in CSS px on every side (#3903). The dot's
 *  half-width (radius + half the stroke) must clear the box edge at EVERY
 *  width, and on the horizontal axis viewBox units no longer are CSS px;
 *  vertically the scale floors at zero, so a last balance of 0 maps to the
 *  bottom edge exactly and would straddle it. 4 ≥ 3.5 with a hair to spare;
 *  the line draws edge to edge of the inset box, so the line's endpoint
 *  stays the dot's centre. */
const SPARKLINE_DOT_INSET = 4

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

/**
 * A sparkline point. `value: null` is a day with no snapshot — a missing day
 * is skipped, never zero; the line connects across it (#3805, #3897): a zero
 * would state a balance of nothing on a day nobody measured, and a break at
 * every missing day left sparse data as scattered dashes.
 */
export interface SparklinePoint {
  label: string
  value: number | null
}

export interface FullChartProps {
  /** Omitted for the default full chart: gridlines, ticks, delta, tooltip. */
  variant?: 'full'
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

interface SparklineProps {
  variant: 'sparkline'
  points: SparklinePoint[]
  /**
   * Rendered height in px (default 40). The caller owns it — a sparkline
   * scales to the row it sits in, not to the chart's own 140/200px treatment.
   */
  height?: number
  /**
   * #3908: grow to the container's height, with `height` as the minimum —
   * the dashboard money card's balance half, which shares a grid row with a
   * taller spending half. The viewBox keeps `height` units and stretches;
   * the end dot is placed as a FRACTION of the box on both axes, so it stays
   * on the line's endpoint at any stretch (the px placement below assumes a
   * vertical scale of exactly 1, which a stretched box breaks).
   */
  fill?: boolean
  /** Required summary sentence: the sparkline is `role="img"` with no hidden
   *  data table and is not a tab stop — the sentence IS the data access. */
  ariaLabel: string
  className?: string
}

export type AreaChartProps = FullChartProps | SparklineProps

/** The sparkline's default height, and its viewBox width (see `pct`). */
const SPARKLINE_HEIGHT = 40
const SPARKLINE_VIEW_W = 640

export function AreaChart(props: AreaChartProps) {
  if (props.variant === 'sparkline') {
    const { points, height = SPARKLINE_HEIGHT, fill = false, ariaLabel, className = '' } = props
    return <Sparkline points={points} height={height} fill={fill} ariaLabel={ariaLabel} className={className} />
  }
  return <AreaChartFull {...props} />
}

/**
 * The sparkline variant (#3805): the balance line over a faint area of the same
 * colour (#3902) — no gridlines, ticks,
 * x labels, delta annotation, tooltip or caret; one dot on the last point.
 * `role="img"` with the required `ariaLabel`, NOT a tab stop, and no hidden
 * data table — a glanceable shape, whose data access is the summary sentence.
 * Below `MIN_CHARTABLE_DAYS` it renders a flat placeholder line of the same
 * height instead of `null`, so a layout that reserved the sparkline's box
 * does not jump on the first snapshot arriving. The `chartable` floor counts
 * points, not measured values, so a window of >= `MIN_CHARTABLE_DAYS` days
 * where EVERY value is null reserves the box but draws nothing — an empty
 * SVG of the correct dimensions, no placeholder line and no dot. That is
 * accepted for #3805: a fully-missing window is a transient data gap, and
 * the box stays quiet until a measured value arrives.
 * A missing day is skipped, never
 * zero; the line connects across it at the measured days' true x positions
 * (#3897), and there is no draw animation: a shape that redraws itself on every data
 * refresh is noise, not information.
 */
function Sparkline({
  points,
  height,
  fill = false,
  ariaLabel,
  className = '',
}: {
  points: SparklinePoint[]
  height: number
  fill?: boolean
  ariaLabel: string
  className?: string
}) {
  const chartable = points.length >= MIN_CHARTABLE_DAYS

  // The same scale maths as the full chart (data + headroom, never zero-based),
  // computed over the measured values only — a null is a missing day, not a
  // data point, and must not drag the scale.
  const measured = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null && Number.isFinite(v))
  const min = measured.length > 0 ? Math.min(...measured) : 0
  const max = measured.length > 0 ? Math.max(...measured) : 0
  const pad = Math.max((max - min) * HEADROOM, 2)
  const scale = chartScaleRange(Math.max(0, min - pad), max + pad)
  const floor = scale.min
  const span = scale.max - floor
  const xOf = (index: number) =>
    points.length <= 1 ? SPARKLINE_VIEW_W / 2 : (SPARKLINE_VIEW_W * index) / (points.length - 1)
  const yOf = (value: number) => (span <= 0 ? height / 2 : height - ((value - floor) / span) * height)

  // One line through every measured day (#3897). A missing day is skipped,
  // never zero; the line connects across it, and each point keeps its true
  // x position in the window, so the spacing still says which days were
  // measured. (#3805 broke the line at every gap, which drew sparse data as
  // short dashes and a lone measured day as nothing at all.)
  const commands: string[] = []
  let lastIndex = -1
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) return
    lastIndex = i
    commands.push(`${commands.length === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)} ${yOf(p.value).toFixed(2)}`)
  })
  const linePath = commands.length > 1 ? commands.join(' ') : null
  // #3902: the faint area under the line, as the mockup fills it. Its top
  // edge IS the line — the line's own commands between two baseline corners —
  // so a missing day is skipped exactly as the line skips it and never drops
  // to the baseline; only the two closing corners sit on the floor.
  const firstIndex = points.findIndex((p) => p.value !== null && Number.isFinite(p.value))
  const areaPath =
    linePath === null || firstIndex < 0
      ? null
      : `M${xOf(firstIndex).toFixed(2)} ${height} L${linePath.slice(1)} L${xOf(lastIndex).toFixed(2)} ${height} Z`

  return (
    <div
      data-testid="area-chart-sparkline"
      data-fill={fill ? '' : undefined}
      className={`relative w-full ${fill ? 'flex h-full flex-col' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
      style={{ padding: SPARKLINE_DOT_INSET }}
    >
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${SPARKLINE_VIEW_W} ${height}`}
        preserveAspectRatio="none"
        // Fill: `grow` (basis auto), not `flex-1` (basis 0%) — with a 0% basis
        // the browser sizes the svg from its viewBox ratio and ignores
        // `height`, so a stacked layout below `lg` grew to ~50px at 900. With
        // basis auto the svg starts at `height` and only a container with
        // spare height (the money card's `lg` half) grows it (#3908 review).
        className={fill ? 'block w-full grow' : 'block w-full'}
        style={fill ? { height, minHeight: height } : { height }}
      >
        {!chartable ? (
          <line
            x1={0}
            y1={height / 2}
            x2={SPARKLINE_VIEW_W}
            y2={height / 2}
            stroke={AXIS_COLOR}
            strokeWidth={2}
          />
        ) : (
          <>
            {areaPath !== null && (
              <path
                data-sparkline-area=""
                d={areaPath}
                fill={LINE_COLOR}
                fillOpacity={AREA_OPACITY}
                stroke="none"
              />
            )}
            {linePath !== null && (
              <path
                data-sparkline-line=""
                d={linePath}
                fill="none"
                stroke={LINE_COLOR}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </>
        )}
      </svg>
      {chartable && lastIndex >= 0 && points[lastIndex].value !== null && (
        // The end dot, in HTML like the labels (#3903): a `<circle>` in this
        // stretched svg renders as an oval wherever the box is not 640px
        // wide. Fixed mode: CSS px on both axes — the vertical scale is exactly 1, and
        // the horizontal position is the endpoint's fraction of the viewBox,
        // padded by the CSS-px inset (all sides: a last balance of 0 maps to
        // the bottom edge exactly) so the round dot stays inside the box
        // (#3902's containment guarantee, restated in CSS px).
        <span
          data-testid="area-chart-sparkline-dot"
          aria-hidden="true"
          data-x-frac={(xOf(lastIndex) / SPARKLINE_VIEW_W).toFixed(6)}
          data-y-frac={(yOf(points[lastIndex].value as number) / height).toFixed(6)}
          className="pointer-events-none absolute block rounded-full"
          style={{
            left: `calc(${SPARKLINE_DOT_INSET}px + (100% - ${
              SPARKLINE_DOT_INSET * 2
            }px) * ${(xOf(lastIndex) / SPARKLINE_VIEW_W).toFixed(6)})`,
            // Fill mode (#3908): the box's height is not `height`, so the
            // vertical position is the endpoint's fraction of the inset box,
            // like `left`. Fixed mode keeps the px placement (scale 1).
            top: fill
              ? `calc(${SPARKLINE_DOT_INSET}px + (100% - ${SPARKLINE_DOT_INSET * 2}px) * ${(
                  yOf(points[lastIndex].value as number) / height
                ).toFixed(6)})`
              : SPARKLINE_DOT_INSET + yOf(points[lastIndex].value as number),
            width: DOT_DIAMETER,
            height: DOT_DIAMETER,
            transform: 'translate(-50%, -50%)',
            background: LINE_COLOR,
          }}
        />
      )}
    </div>
  )
}

function AreaChartFull({
  points,
  currency,
  ariaLabel,
  formatValue,
  formatTick = formatValue,
  narrow = false,
  className = '',
}: FullChartProps) {
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
    const pad = Math.max((max - min) * HEADROOM, 2)
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
      // The first x label is anchored at its left edge (see the label's
      // transform below), so the helper gives it two label-widths.
      labelIdx: xLabelIndices(points.length, { narrow, startAnchoredLeft: true }),
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
            vectorEffect="non-scaling-stroke"
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
                  dot: a day has to be selectable where the day is drawn. The
                  dot itself is NOT drawn here (#3903): a `<circle>` in this
                  stretched svg renders as an oval wherever the box's aspect
                  differs from the viewBox's — it is an HTML span in the plot
                  wrapper below, positioned like the labels. */}
              <rect
                x={plot.xOf(i) - plot.plotW / Math.max(1, points.length - 1) / 2}
                y={plot.pad.top}
                width={plot.plotW / Math.max(1, points.length - 1)}
                height={plot.plotH}
                fill="transparent"
                stroke="none"
              />
            </g>
          ))}
        </svg>

        {/* The point dots, in HTML like the labels (#3903): round at every
            width, on the same percentage-of-viewBox positioning the type
            uses. pointer-events off — the hit strips in the svg own
            selection (#3070). */}
        {points.map((p, i) => (
          <span
            key={`dot-${i}-${p.label}`}
            data-testid="area-point-dot"
            aria-hidden="true"
            className="pointer-events-none absolute block rounded-full"
            style={{
              left: pct(plot.xOf(i), VIEW_W),
              top: pct(plot.yOf(p.value), VIEW_H),
              width: active === i ? ACTIVE_DOT_DIAMETER : DOT_DIAMETER,
              height: active === i ? ACTIVE_DOT_DIAMETER : DOT_DIAMETER,
              transform: 'translate(-50%, -50%)',
              background: LINE_COLOR,
            }}
          />
        ))}

        {/* The labels, in HTML: the drawing stretches and the type does not
            (see the header). */}
        {plot.scale.ticks.map((tick) => (
          <span
            key={`tick-${tick}`}
            data-testid="chart-tick-label"
            aria-hidden="true"
            className="absolute block whitespace-nowrap text-right text-xs leading-none text-[var(--v2-ink-3)]"
            style={{
              // Anchored by its RIGHT edge, 6 units inside the gutter, with no
              // width of its own: the type is fixed 12px while the gutter
              // scales with the svg, so a label the gutter cannot hold grows
              // LEFT into the card's padding and never right into the plot
              // (#3204 round 2: a width-boxed, right-aligned label spilled its
              // overflow onto the line).
              right: pct(VIEW_W - (plot.pad.left - 6), VIEW_W),
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
