/**
 * The stacked-bar chart primitive (#2948, analytics slice D).
 *
 * Daily bars stacked by agent for a range, with refusals as a marker series:
 * a small cap drawn ABOVE the bar, not a second axis. A second axis is the
 * shape this refuses on purpose — a refusal count has no scale comparable to
 * a money total, and two y-scales in one view invite reading a tall bar as
 * "many refusals" or the other way round. A cap over a bar says exactly one
 * thing: that day refused something.
 *
 * ## The house pattern this is, and what it means for the lint gates
 *
 * `design:lint` bans a raw `<svg>` outside the primitive that owns the idiom
 * (the `raw-svg` rule), so the drawing lives in THIS file — the primitive's
 * home — which is what the rule's home-file exemption exists for and is why
 * the two chart homes are listed alongside `Table.tsx` and `Card.tsx` in
 * `scripts/design-lint.mjs`. The charts are hand-drawn rather than
 * chart-library-backed: no chart library exists in the frontend, adding one
 * is a dependency decision the epic does not make, and a token-driven SVG
 * built here is the shape that decision leaves open.
 *
 * ## Colour comes from the series tokens, never from meaning
 *
 * `--v2-series-*` (#2948) is an ordered categorical set: colour identifies
 * the SERIES, never the meaning of a value. A refusal is therefore a neutral
 * ink cap and not a red one — red is `--v2-danger`'s job when a row states a
 * failure, and this is a count of events. Callers assign a series index per
 * agent and hold it stable so the bar, the legend, and the agents table's
 * share column all read one colour per agent.
 *
 * ## Why the labels are HTML over the drawing rather than SVG <text>
 *
 * The svg stretches its geometry with `preserveAspectRatio="none"` so the
 * plot fills its card at every width without a resize observer. That is
 * right for bars, rules, and areas, and wrong for type: stretched glyphs at
 * a 390px viewport would render the axis numbers squeezed by a third. So the
 * drawing stretches and the labels do not — the labels are HTML positioned by
 * percentage of the same viewBox coordinates (`pct` below), which the linear
 * stretch makes exact. The plot box is the element that carries the
 * percentages: it wraps the svg and nothing else in flow, so its box is the
 * svg's box, which is what the percentages have to resolve against.
 *
 * ## Accessibility: a chart with no accessible form is decoration
 *
 * The svg carries `role="img"` and an `aria-label` summary sentence — the
 * canonical accessible-graphic pattern. The hidden table of the plotted
 * values sits OUTSIDE that element rather than inside it: a subtree of
 * `role="img"` is presentational and is not exposed, so a table written
 * inside the figure would be exactly as unreadable as no table at all. The
 * drawing is `aria-hidden`, because every fact in it is already in the
 * table; leaving it exposed would double-announce a chart a sighted user
 * reads and a non-sighted user does not.
 *
 * ## Interaction is keyboard-operable, not hover-only
 *
 * Hover reveals the day's breakdown; the arrow keys move a caret that does
 * the same. A chart whose only reveal is pointer hover is a chart that hides
 * its data from a keyboard.
 *
 * ## The mobile half
 *
 * "Mobile" is decided by the caller's `narrow` flag and not by a media query
 * inside the primitive — the same partition `ThemeToggle` takes with
 * `variant`: the caller owns breakpoints, the primitive owns the treatment,
 * and it is what makes the density behaviour unit-testable instead of
 * e2e-only. What the primitive DOES own is that it never scrolls its
 * ancestor: the svg is `block w-full`, sized by its viewBox rather than by a
 * pixel width, so a chart cannot be wider than the page body holding it.
 *
 * ## Sparse data
 *
 * A range shorter than `MIN_CHARTABLE_DAYS` renders NOTHING. Below three
 * points a "shape" is not a shape, it is noise wearing a chart's clothes,
 * and the analytics page shows tiles instead (slice C). The primitive holds
 * that line itself so no caller can render the misleading case by forgetting
 * to.
 *
 * ## Draw-in motion
 *
 * The grow-from-baseline animation is one CSS class (`v2-chart-draw`) whose
 * keyframes are gated on `prefers-reduced-motion` in `globals.css`, the idiom
 * `.v2-mesh-drift` uses: the media query lives with the animation, so the
 * motion cannot render un-gated and the primitive does not subscribe to the
 * media list to honour it.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { chartScale, MIN_CHARTABLE_DAYS, xLabelIndices } from '@/components/charts/chart-scale'

/**
 * The viewBox coordinate space. The svg stretches its whole drawing through
 * `viewBox` + `preserveAspectRatio="none"`, so these are the plot's own units
 * and the HTML labels convert them to percentages with `pct`.
 */
const VIEW_W = 640
const VIEW_H = 220
const PAD = { top: 14, right: 10, bottom: 30, left: 48 }
/** The cap above a bar that refused something, in viewBox units. */
const REFUSAL_MARKER_H = 7

const AXIS_COLOR = 'var(--v2-border)'
const INK = 'var(--v2-ink)'

/** A viewBox coordinate as a percentage of the axis it lies on. */
function pct(value: number, span: number): string {
  return `${((value / span) * 100).toFixed(3)}%`
}

/** One day's worth of what the caller has already grouped by agent. */
export interface StackedBarDay {
  /** Stable day key; `label` is what the axis, legend, and tooltip print. */
  label: string
  /** The per-agent amounts making up this bar. `tokens` is per-denomination
   *  detail for the tooltip only — the bar itself is one display currency. */
  series: StackedBarSeries[]
  /** Refusals recorded that day; `0` or absent draws no cap. */
  refusals?: number
}

export interface StackedBarSeries {
  /** Legend and tooltip label. */
  name: string
  /** The display-currency amount this agent spent that day — the stack's
   *  height contributor. */
  amount: number
  /** Index into the six `--v2-series-*` tokens; wraps past six. Assign per
   *  agent and HOLD IT STABLE across renders, or an agent silently changes
   *  colour between the chart and the table beside it. */
  seriesIndex: number
  /** Stable key; the tooltip's per-row identity and the React key. */
  id: string
  /** Per-denomination breakdown, e.g. `[['USDC', 900.4], ['PYUSD', 340]]`.
   *  Displayed in the tooltip; never used for geometry. */
  tokens?: Array<[symbol: string, amount: number]>
}

export interface StackedBarChartProps {
  days: StackedBarDay[]
  /** Display currency code the `amount` figures are in; printed in the
   *  tooltip's total, never derived. */
  currency: string
  /** Printed verbatim as the accessible name of the graphic: the issue's
   *  example is `Spend over 30 days: 1,240 USD across 3 agents, 4
   *  refusals`. The caller owns it because only the caller knows the
   *  range's prose. */
  ariaLabel: string
  /** The caller formats every money figure (thousands separators, locale,
   *  fraction digits) — the same callback the tiles and the agents table
   *  print with, so one voice reads the page. */
  formatValue: (amount: number) => string
  /** Fewer x ticks, a dot legend, a tap-to-pin panel: the 390px treatment,
   *  decided by the caller's breakpoint (see the file's header). */
  narrow?: boolean
  className?: string
}

/** Which agent's stack segment is drawn at a given y, for the tooltip. */
interface StackedBarSegment {
  seriesId: string
  name: string
  seriesIndex: number
  /** The amount this segment represents, in the display currency. */
  amount: number
  tokens?: Array<[symbol: string, amount: number]>
}

/** The whole of one day, as the plot and the tooltip read it. */
interface StackedBarEntry {
  label: string
  /** Total height of the stacked bar, display currency. */
  total: number
  segments: StackedBarSegment[]
  /** Number of refused payments recorded that day; draws the cap. */
  refusals: number
}

function seriesColor(seriesIndex: number): string {
  // The six tokens are declared 1..6; a seventh series wraps to 1. The set
  // is deliberately short and the wrap is deliberate: past six agents the
  // legend distinguishes by name rather than by an invented hue.
  return `var(--v2-series-${(Math.trunc(seriesIndex) % 6) + 1})`
}

/**
 * The legend rows and the data table's columns, in one place: the first time
 * a series id is seen, in the order the days were plotted. Derived from the
 * entries rather than from a second source, so a series that spent nothing on
 * any day still gets a row and a colour (it reads `0`, which is a fact).
 */
function legendRows(entries: StackedBarEntry[]): StackedBarSegment[] {
  const seen = new Map<string, StackedBarSegment>()
  for (const e of entries) {
    for (const s of e.segments) {
      if (!seen.has(s.seriesId)) seen.set(s.seriesId, s)
    }
  }
  return [...seen.values()]
}

export function StackedBarChart({
  days,
  currency,
  ariaLabel,
  formatValue,
  narrow = false,
  className = '',
}: StackedBarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // The entries the plot draws: geometry and tooltip read the same array, so
  // what is on the screen is what the panel reports.
  const entries = useMemo<StackedBarEntry[]>(
    () =>
      days.map((day) => {
        const segments = day.series.map((s) => ({
          seriesId: s.id,
          name: s.name,
          seriesIndex: s.seriesIndex,
          amount: s.amount,
          tokens: s.tokens,
        }))
        return {
          label: day.label,
          total: segments.reduce((sum, s) => sum + s.amount, 0),
          segments,
          refusals: day.refusals ?? 0,
        }
      }),
    [days],
  )

  const { scale, labelIdx } = useMemo(() => {
    const dataMax = Math.max(0, ...entries.map((e) => e.total))
    return { scale: chartScale(dataMax), labelIdx: xLabelIndices(entries.length, { narrow }) }
  }, [entries, narrow])

  // The sparse-data decision, held as a value and ACTED ON after the last
  // hook (see the render guard below): a return between hooks would make the
  // hook count depend on the data, and data arriving late turns "renders
  // nothing" into a React crash.
  const chartable = entries.length >= MIN_CHARTABLE_DAYS

  const plotW = VIEW_W - PAD.left - PAD.right
  const plotH = VIEW_H - PAD.top - PAD.bottom
  const baseY = PAD.top + plotH
  const band = entries.length === 0 ? plotW : plotW / entries.length
  const barW = Math.max(2, band * 0.64)

  const yOf = (value: number) => baseY - (scale.max === 0 ? 0 : value / scale.max) * plotH
  const xOf = (index: number) => PAD.left + band * index + (band - barW) / 2

  const active = caret ?? pinned ?? hovered
  const entry = active === null ? null : entries[active] ?? null
  const legend = useMemo(() => legendRows(entries), [entries])

  const moveCaret = useCallback(
    (event: KeyboardEvent<SVGSVGElement>) => {
      if (entries.length === 0) return
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
          return Math.min(entries.length - 1, Math.max(0, next))
        })
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        setCaret(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setCaret(entries.length - 1)
      } else if (event.key === 'Escape') {
        setCaret(null)
      }
    },
    [entries.length],
  )

  // The sparse-data render guard: a range with too few days to carry a shape
  // contributes nothing to the page at all (the acceptance criterion for this
  // branch, proven by a unit test).
  if (!chartable) return null

  return (
    <div data-testid="stacked-bar-chart" className={`relative w-full ${className}`.trim()}>
      {/* The positioning context for the HTML labels: it wraps the svg and
          holds nothing else in flow, so its box IS the svg's box and the
          labels' percentages resolve against the plot, not the card. */}
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
          {/* The grid: rules at the values the scale can claim to reach. */}
          {scale.ticks.map((tick) => (
            <line
              key={`grid-${tick}`}
              data-testid="chart-gridline"
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
              stroke={AXIS_COLOR}
              strokeWidth={1}
            />
          ))}
          {/* The abscissa. */}
          <line
            x1={PAD.left}
            x2={VIEW_W - PAD.right}
            y1={baseY}
            y2={baseY}
            stroke={AXIS_COLOR}
            strokeWidth={1}
          />
          {/* The series. One group per day; per agent one rect, stacked from
              the baseline up in the caller's own order. */}
          {entries.map((e, dayIdx) => {
            let bottom = baseY
            const isHl = active === dayIdx
            return (
              <g
                key={`bar-${dayIdx}-${e.label}`}
                data-testid="chart-day"
                data-day-index={dayIdx}
                aria-hidden="true"
                className="v2-chart-draw"
                style={{ transformOrigin: `${xOf(dayIdx) + barW / 2}px ${baseY}px` }}
                onMouseEnter={() => setHovered(dayIdx)}
                onMouseDown={() => setPinned(dayIdx)}
              >
                {e.segments.map((s) => {
                  const height = scale.max === 0 ? 0 : (s.amount / scale.max) * plotH
                  bottom -= height
                  return (
                    <rect
                      key={`${e.label}-${s.seriesId}`}
                      data-testid="chart-segment"
                      data-series={s.seriesId}
                      x={xOf(dayIdx)}
                      y={bottom}
                      width={barW}
                      height={Math.max(0, height)}
                      fill={seriesColor(s.seriesIndex)}
                      fillOpacity={isHl ? 1 : 0.88}
                    />
                  )
                })}
                {/* Refusals: the marker series. A cap above the bar, never a
                    second axis (see the header for why). */}
                {e.refusals > 0 && (
                  <rect
                    data-testid="chart-refusal-marker"
                    x={xOf(dayIdx)}
                    y={yOf(e.total) - REFUSAL_MARKER_H - 3}
                    width={barW}
                    height={REFUSAL_MARKER_H}
                    rx={2}
                    fill={INK}
                    fillOpacity={isHl ? 0.85 : 0.55}
                  />
                )}
              </g>
            )
          })}
        </svg>

        {/* The labels, in HTML (see the header): positioned by percentage of
            the very coordinates the drawing above is drawn in. */}
        {scale.ticks.map((tick) => (
          <span
            key={`tick-${tick}`}
            data-testid="chart-tick-label"
            aria-hidden="true"
            className="absolute block text-right text-xs leading-none text-[var(--v2-ink-3)]"
            style={{
              left: 0,
              width: pct(PAD.left - 6, VIEW_W),
              top: pct(yOf(tick), VIEW_H),
              transform: 'translateY(-50%)',
            }}
          >
            {formatValue(tick)}
          </span>
        ))}
        {labelIdx.map((i) => (
          <span
            key={`x-${i}`}
            data-testid="chart-x-label"
            aria-hidden="true"
            className="absolute block text-center text-xs leading-none text-[var(--v2-ink-3)]"
            style={{
              left: pct(xOf(i) + barW / 2, VIEW_W),
              top: pct(baseY + 8, VIEW_H),
              transform: 'translateX(-50%)',
            }}
          >
            {entries[i]?.label}
          </span>
        ))}
      </div>

      {/* The legend: the same colours, read by name. A column on a wide
          screen, a wrapping row of dots and names on a narrow one. */}
      <ul
        data-testid="chart-legend"
        aria-hidden="true"
        className={`mt-3 gap-x-4 gap-y-1.5 text-xs text-[var(--v2-ink-2)] ${
          narrow ? 'flex flex-wrap' : 'flex flex-col'
        }`}
      >
        {legend.map((row) => (
          <li
            key={row.seriesId}
            data-testid="chart-legend-item"
            className="inline-flex items-center gap-1.5"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: seriesColor(row.seriesIndex) }}
            />
            <span className="truncate">{row.name}</span>
          </li>
        ))}
      </ul>

      {/* The tooltip: on a wide screen a callout over the day it describes;
          on a narrow one, a panel below the plot that a tap pins. One
          tooltip, two treatments, never a horizontal scroll. */}
      {entry !== null && (
        <div
          data-testid="chart-tooltip"
          role="status"
          className={
            narrow
              ? 'mt-3 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3'
              : 'absolute left-1/2 top-3 w-max max-w-full -translate-x-1/2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3 shadow-popover'
          }
          onMouseEnter={() => setPinned(active)}
          onMouseLeave={() => {
            setPinned(null)
            setHovered(null)
          }}
        >
          <p className="text-xs font-semibold text-[var(--v2-ink)]">{entry.label}</p>
          <ul className="mt-1.5 space-y-1">
            {entry.segments.map((s) => (
              <li
                key={s.seriesId}
                data-testid="chart-tooltip-row"
                className="flex items-baseline gap-2 text-xs"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: seriesColor(s.seriesIndex) }}
                />
                <span className="min-w-0 flex-1 truncate text-[var(--v2-ink-2)]">{s.name}</span>
                <span className="v2-tabular whitespace-nowrap text-[var(--v2-ink)]">
                  {formatValue(s.amount)}
                </span>
                {s.tokens !== undefined && s.tokens.length > 0 && (
                  <span
                    data-testid="chart-tooltip-tokens"
                    className="v2-tabular whitespace-nowrap text-[var(--v2-ink-3)]"
                  >
                    {' ('}
                    {s.tokens.map(([token, amount]) => `${formatValue(amount)} ${token}`).join(' + ')}
                    {')'}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {entry.refusals > 0 && (
            <p
              data-testid="chart-tooltip-refusals"
              className="mt-1.5 text-xs text-[var(--v2-ink-2)]"
            >
              {entry.refusals} payment{entry.refusals === 1 ? '' : 's'} refused
            </p>
          )}
          <p className="mt-1.5 border-t border-[var(--v2-border)] pt-1.5 text-xs font-semibold text-[var(--v2-ink)]">
            {currency} {formatValue(entry.total)}
          </p>
        </div>
      )}

      {/* The values in full, for anyone who reads the chart rather than
          looks at it — OUTSIDE the `role="img"` element above, whose subtree
          assistive technology is not shown. A chart's visually-hidden data
          table is not a product table: `ui/Table` is visible rows with
          sticky headers, column staging, and hover chrome, and none of that
          is what a screen reader is handed here. */}
      {/* design-lint-disable-line: raw-table */}
      <table data-testid="chart-data-table" className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {legend.map((row) => (
              <th key={`h-${row.seriesId}`} scope="col">
                {row.name}
              </th>
            ))}
            <th scope="col">Total</th>
            <th scope="col">Refusals</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`row-${i}-${e.label}`}>
              <th scope="row">{e.label}</th>
              {legend.map((row) => (
                <td key={`c-${i}-${row.seriesId}`}>
                  {formatValue(e.segments.find((s) => s.seriesId === row.seriesId)?.amount ?? 0)}
                </td>
              ))}
              <td>{formatValue(e.total)}</td>
              <td>{e.refusals}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
