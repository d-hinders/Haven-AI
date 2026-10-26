/**
 * The stacked-bar chart primitive (#2948, analytics slice D).
 *
 * Daily bars stacked by agent for a range, with refusals as a marker series:
 * a small grey mark drawn UNDER the day's slot, not a second axis and not a
 * cap on the bar (#4334). A second axis is the shape this refuses on
 * purpose — a refusal count has no scale comparable to a money total, and
 * two y-scales in one view invite reading a tall bar as "many refusals" or
 * the other way round. A cap over a bar could only sit on a day that SPENT;
 * a mark under the slot says exactly one thing about any day, spent or not:
 * that day refused something.
 *
 * ## The axis is whatever the caller hands it — slots, not activity
 *
 * The primitive draws one slot per `days` entry, in order; a day with an
 * empty `series` is an EMPTY slot (no bar, its refusal mark still drawn) so
 * a caller that hands it every calendar day in a window (#4334) gets a
 * continuous time axis, not a scatter of the days that happened to carry a
 * figure. Nothing here invents or drops days.
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
 * ink mark and not a red one — red is `--v2-danger`'s job when a row states a
 * failure, and this is a count of events. An AGENT-keyed series does not
 * read this palette at all (#4331): it carries `color` — the agent's avatar
 * tint from `seriesColorForAgent`, name-hashed, so one agent wears one
 * colour on every chart, in every period, matching its monogram. Two agents
 * can share a tint (six tints, unbounded agents); the legend and tooltip
 * tell them apart by name. Callers assign `seriesIndex` only for series that
 * are not an agent, and hold it stable so the bar, the legend, and any
 * companion table read one colour per series.
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
 * inside the primitive — the same partition the shell's call sites draw
 * (`Sidebar` owns breakpoints, the primitive owns the treatment), and it is
 * what makes the density behaviour unit-testable instead of e2e-only. What the
 * primitive DOES own is that it never scrolls its ancestor: the svg is
 * `block w-full`, sized by its viewBox rather than by a pixel width, so a
 * chart cannot be wider than the page body holding it.
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

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  chartScale,
  MIN_CHARTABLE_DAYS,
  xLabelEdge,
  xLabelIndices,
  type XLabelAnchoring,
} from '@/components/charts/chart-scale'

/**
 * The viewBox coordinate space. The svg stretches its whole drawing through
 * `viewBox` + `preserveAspectRatio="none"`, so these are the plot's own units
 * and the HTML labels convert them to percentages with `pct`.
 */
const VIEW_W = 640
const VIEW_H = 220
const PAD = { top: 14, right: 10, bottom: 30, left: 48 }
/** The narrow treatment widens the tick gutter: at 390 the desktop 48/640
 *  is ~21 CSS px, and a currency tick painted over the first bar (#3051
 *  design review). Since #4334 a sub-cent scale's ticks carry 4 decimals —
 *  a SEK "0,0040 kr" needs ~55 CSS px of `text-xs` — so the narrow gutter
 *  grew again: 100/640 at the 350px plot a 390 phone leaves (~54px) fits
 *  the longest served tick with margin, where the old 78 (~43px) clipped it. */
const PAD_NARROW = { ...PAD, left: 100 }
/** The x axis pins only its END label, to the last bar's right edge, growing
 *  left inside the plot (#4426). The start label stays centred on its bar:
 *  the y gutter gives it room, and anchoring it costs the phone chart a label
 *  that never collided (#3204 round 4). One declaration, read by both the
 *  label spacing (`xLabelIndices`) and the label rendering (`xLabelEdge`). */
const X_LABEL_ANCHORING: XLabelAnchoring = { endAnchoredRight: true }
/** The refusal mark under a day's slot, in viewBox units: a 3px dash
 *  `REFUSAL_MARKER_GAP` below the axis baseline — under the slot, so a day
 *  with refusals and NO spend still shows (#4334). The x labels start 8
 *  units under the baseline, clear of the dash. */
const REFUSAL_MARKER_H = 3
const REFUSAL_MARKER_GAP = 3
/** The desktop callout's resting offset under the wrapper's top edge — the
 *  CSS px behind its `top-3`; the clearance it keeps from the bar's highest
 *  mark (resting) or the axis baseline (dropped, #3063); and the least of a
 *  bar's top a dropped callout must leave in view — one `top-3` unit, enough
 *  to read as "a bar continues here" rather than a line (design review). */
const TIP_REST_TOP = 12
const TIP_GAP = 6
const TIP_MIN_VISIBLE = 12
/** The legend's `mt-3` under the svg: the whitespace a dropped callout may
 *  run into (its bottom `TIP_GAP` above the legend's top edge, so it floats
 *  over the label rather than standing on the first row) without covering
 *  a row. */
const LEGEND_GAP = 12

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
  /** Refusals recorded that day; `0` or absent draws no mark. */
  refusals?: number
  /**
   * The bucket covers less than a full local day (#3051): the endpoint's
   * `range.from`/`to` are UTC instants while `by_day` is bucketed in the
   * caller's zone, so the first and last bucket of a window are usually
   * partial — a bar that is short because the day was cut, not because the
   * agents spent little. Drawn HATCHED (diagonal stripes of the ground over
   * the series token at full strength — an opacity blend reads lighter on
   * the light ground and darker on the dark one, and drops the token under
   * the 3:1 the palette guarantees; #3051 design review), named in the
   * tooltip and the data table; never dropped (a partial day with a payment
   * is a day with data).
   */
  partial?: boolean
}

export interface StackedBarSeries {
  /** Legend and tooltip label. */
  name: string
  /** The display-currency amount this agent spent that day — the stack's
   *  height contributor. */
  amount: number
  /** Index into the six `--v2-series-*` tokens; wraps past six. For series
   *  that are NOT an agent. Assign per series and HOLD IT STABLE across
   *  renders, or a series silently changes colour between the chart and the
   *  table beside it. An AGENT-keyed series carries `color` instead
   *  (#4331) — its avatar tint — and omits this. */
  seriesIndex?: number
  /** Explicit fill for an agent-keyed series (#4331): `seriesColorForAgent(name)`
   *  — the agent's avatar tint, the same token its `Monogram` wears, stable
   *  under re-ranking. Wins over `seriesIndex` when both are set. */
  color?: string
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
  /** The y-axis tick formatter; defaults to `formatValue`. Receives the
   *  scale's own tick STEP as its second argument (#4334) so the caller can
   *  choose the tick label's fraction digits from it — 4 decimals under a
   *  cent, none for whole steps. Callers pass a compact form so a tick fits
   *  the gutter at 390 (#3051). */
  formatTick?: (amount: number, step: number) => string
  /** Fewer x ticks, a dot legend, a tap-to-pin panel: the 390px treatment,
   *  decided by the caller's breakpoint (see the file's header). */
  narrow?: boolean
  className?: string
}

/** Which agent's stack segment is drawn at a given y, for the tooltip. */
interface StackedBarSegment {
  seriesId: string
  name: string
  seriesIndex?: number
  color?: string
  /** The amount this segment represents, in the display currency. */
  amount: number
  tokens?: Array<[symbol: string, amount: number]>
}

/**
 * The fill for one segment (#4331): an agent-keyed series paints its own
 * avatar tint; every other series paints the ordered `--v2-series-*` token
 * its `seriesIndex` names. One home so the bar, the legend dot, the tooltip
 * swatch and the exported `SeriesSwatch` cannot disagree.
 */
function seriesFill(s: Pick<StackedBarSegment, 'color' | 'seriesIndex'>): string {
  return s.color ?? seriesColor(s.seriesIndex ?? 0)
}

/** The whole of one day, as the plot and the tooltip read it. */
interface StackedBarEntry {
  label: string
  /** Total height of the stacked bar, display currency. */
  total: number
  segments: StackedBarSegment[]
  /** Number of refused payments recorded that day; draws the mark. */
  refusals: number
  partial: boolean
}

export function seriesColor(seriesIndex: number): string {
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

/**
 * The legend dot as a component, exported so a showcase beside the chart can
 * key a row to the same fill the chart paints (#3051; #4331 added `color` for
 * agent-keyed series — an agent's monogram beside its chart swatch). One home
 * for "what colour is this series": the chart's segments, its legend and its
 * tooltip all read `seriesFill`; a caller passes the same `color` the series
 * carries (or the same `seriesIndex` for a non-agent series).
 */
/** Every box `SeriesSwatch` can draw, written out whole so each is greppable. */
const SWATCH_BOX = {
  sm: {
    circle: 'h-2 w-2 flex-shrink-0 rounded-full',
    square: 'h-2 w-2 flex-shrink-0 rounded-sm',
  },
  md: {
    circle: 'h-2.5 w-2.5 flex-shrink-0 rounded-full',
    square: 'h-2.5 w-2.5 flex-shrink-0 rounded-sm',
  },
} as const

export function SeriesSwatch({
  seriesIndex,
  color,
  size = 'md',
  shape = 'circle',
  className = '',
}: {
  seriesIndex?: number
  color?: string
  /** `md` (10px) beside a legend name; `sm` (8px) inside a tooltip row. */
  size?: 'sm' | 'md'
  /**
   * `circle` is the chart's own key (legend, tooltip, `/design-system`);
   * `square` is the dashboard money card's list key beside its split bar
   * (#3901, the agreed #3897 mockup).
   */
  shape?: 'circle' | 'square'
  className?: string
}) {
  // Size and shape are props, not className overrides: two height or radius
  // utilities on one element resolve by stylesheet order, not by the order
  // they are written, so `className="h-2 w-2"` would not reliably shrink it.
  const box = SWATCH_BOX[size][shape]
  return (
    <span
      aria-hidden="true"
      data-testid="series-swatch"
      data-series-index={seriesIndex}
      className={`inline-block ${box} ${className}`.trim()}
      style={{ backgroundColor: color ?? seriesColor(seriesIndex ?? 0) }}
    />
  )
}

export function StackedBarChart({
  days,
  currency,
  ariaLabel,
  formatValue,
  formatTick = formatValue,
  narrow = false,
  className = '',
}: StackedBarChartProps) {
  // Pattern ids must be unique per mounted chart — the page mounts the
  // desktop and narrow pair, and /design-system a third — or one chart's
  // <defs> would serve another's fills.
  const patternId = useId()
  const [hovered, setHovered] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  // The callout's half-width as a fraction of its containing block — the
  // chart wrapper, which is the box its `left: %` and `max-w-[60%]` resolve
  // against and, with no padding on either, the plot's width too — measured
  // after it paints, so the edge clamp is exactly as wide as the callout
  // needs and no wider: a fixed 30/70 clamp (the first cut) parked the
  // callout on its own bar at day 0 and over the wrong bar at day N (#3051
  // design re-review). The callout is `w-max`, so its width does not depend
  // on `left` and the measurement is a fixed point (the second render reads
  // the same number and the setter bails out). Before the first measurement
  // — and in jsdom, where every box is 0 wide — the max-width bound applies.
  const [tipHalfPct, setTipHalfPct] = useState(30)
  // The callout's top, in CSS px from the wrapper's top, when the bar it
  // describes is tall enough to reach under the resting `top-3` position:
  // then the callout drops to sit just above the axis baseline instead, so
  // the bar's top — its height against the neighbours; the refusal mark now
  // lives under the slot (#4334), out of any callout's reach but the legend
  // slot's, and is scored below.
  // (#3063). `null` is the resting position. Measured after paint like the
  // half-width; in jsdom nothing has a height and the resting position stands.
  const [tipTop, setTipTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const tip = tooltipRef.current
    const wrapper = tip?.parentElement
    if (!tip || !wrapper || wrapper.clientWidth === 0) return
    const half = ((tip.offsetWidth / 2) / wrapper.clientWidth) * 100
    // Keep it strictly inside the wrapper and never wider than the max-width
    // bound allows.
    setTipHalfPct(Math.min(30, Math.max(1, half + 0.5)))
  })

  // The entries the plot draws: geometry and tooltip read the same array, so
  // what is on the screen is what the panel reports.
  const entries = useMemo<StackedBarEntry[]>(
    () =>
      days.map((day) => {
        const segments = day.series.map((s) => ({
          seriesId: s.id,
          name: s.name,
          seriesIndex: s.seriesIndex,
          color: s.color,
          amount: s.amount,
          tokens: s.tokens,
        }))
        return {
          label: day.label,
          total: segments.reduce((sum, s) => sum + s.amount, 0),
          segments,
          refusals: day.refusals ?? 0,
          partial: day.partial === true,
        }
      }),
    [days],
  )

  const { scale, labelIdx } = useMemo(() => {
    const dataMax = Math.max(0, ...entries.map((e) => e.total))
    return { scale: chartScale(dataMax), labelIdx: xLabelIndices(entries.length, { narrow, ...X_LABEL_ANCHORING }) }
  }, [entries, narrow])

  // The sparse-data decision, held as a value and ACTED ON after the last
  // hook (see the render guard below): a return between hooks would make the
  // hook count depend on the data, and data arriving late turns "renders
  // nothing" into a React crash.
  const chartable = entries.length >= MIN_CHARTABLE_DAYS

  const pad = narrow ? PAD_NARROW : PAD
  const plotW = VIEW_W - pad.left - pad.right
  const plotH = VIEW_H - pad.top - pad.bottom
  const baseY = pad.top + plotH
  const band = entries.length === 0 ? plotW : plotW / entries.length
  const barW = Math.max(2, band * 0.64)

  const yOf = (value: number) => baseY - (scale.max === 0 ? 0 : value / scale.max) * plotH
  const xOf = (index: number) => pad.left + band * index + (band - barW) / 2
  // The fills that need a hatch pattern: only partial days use one. Keyed by
  // the fill itself (an avatar tint can be shared by two agents — one
  // pattern per colour is then exactly right), so the id has to be derived
  // from position in the de-duped list.
  const hatched = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) if (e.partial) for (const s of e.segments) set.add(seriesFill(s))
    return [...set]
  }, [entries])
  const hatchId = useMemo(() => new Map(hatched.map((fill, i) => [fill, `${patternId}-hatch-${i}`])), [hatched, patternId])

  // A pin or caret outlives the data it pointed at otherwise: a shorter
  // range would leave `active` on an index with no entry — no callout, and
  // no hover either, until a tap or Escape. Reset both when the days change.
  useEffect(() => {
    setPinned(null)
    setCaret(null)
  }, [entries.length])

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
        setPinned(null)
      }
    },
    [entries.length],
  )

  // The vertical drop (#3063). The resting callout hangs 12px (`top-3`) under
  // the wrapper's top edge; if the described bar's top would sit under the
  // callout's box, the callout drops below the bar's top, but only where that
  // leaves at least `TIP_MIN_VISIBLE` of the bar in view: its bottom `TIP_GAP` above the axis baseline when the
  // bar is tall enough to hold it, else its bottom just above the legend
  // — over the axis labels beneath it (whole, never half of one; the day's
  // own it repeats) and never over a legend row. A bar too short for either (the
  // callout would swallow its body, the label and the legend to save a
  // sliver — design review) keeps the resting callout and loses its top
  // instead. Between the two slots, the one that hides the fewest
  // NEIGHBOURS' tops wins (#3076): a 62px band above the baseline covers
  // the top of every bar shorter than ~68px within the callout's span,
  // leaving a refusal mark floating over a hidden bar, while the same
  // callout above the legend clears them at the cost of the date labels it
  // partly repeats. Ties go to the baseline slot. The svg scales the
  // viewBox to its CSS box without preserving the ratio, so a viewBox y
  // maps to CSS by `y / VIEW_H * clientHeight` (and x by `VIEW_W`). This
  // effect reads `tipHalfPct`, which the half-width effect above sets: on
  // the pass where that value changes this one uses the previous value and
  // corrects itself on the next — a two-stage fixed point, one way (the
  // half-width never depends on `tipTop`), converging before paint.
  // Every input is a layout read or a value the render already fixed, so the
  // second pass reads the same number and the setter bails out — the same
  // fixed point as the half-width above.
  useLayoutEffect(() => {
    const tip = tooltipRef.current
    const svg = svgRef.current
    if (narrow || !tip || !svg || entry === null || svg.clientHeight === 0) {
      setTipTop(null)
      return
    }
    const cssY = (y: number) => (y / VIEW_H) * svg.clientHeight
    const barTop = cssY(yOf(entry.total))
    // The highest mark the day draws above the baseline is its bar top: the
    // refusal mark lives UNDER the slot (#4334), below the axis, where no
    // resting-or-dropped callout can sit.
    const markTop = barTop
    const restingBottom = TIP_REST_TOP + tip.offsetHeight + TIP_GAP
    if (restingBottom <= markTop) {
      setTipTop(null)
      return
    }
    // Both candidates leave `TIP_MIN_VISIBLE` of the day's marks in view and
    // clear the BAR's top edge by `TIP_GAP`.
    const least = Math.max(barTop + TIP_GAP, markTop + TIP_MIN_VISIBLE)
    const aboveBaseline = cssY(baseY) - tip.offsetHeight - TIP_GAP
    const onLegendTop = svg.clientHeight + LEGEND_GAP - TIP_GAP - tip.offsetHeight
    // The callout's horizontal span, in the wrapper's CSS px (the box its
    // `left: %` resolves against — the same one the half-width effect
    // measures): the same centre-and-clamp the `left` style uses, half its
    // measured width each side. A neighbour whose bar top — or whose refusal
    // mark under the slot — lies inside a slot's box has its mark hidden by
    // that slot (the legend slot is the only one that reaches below the
    // baseline, where the marks now live, #4334).
    const width = tip.parentElement?.clientWidth ?? 0
    const cssX = (x: number) => (x / VIEW_W) * width
    const centre =
      (Math.min(100 - tipHalfPct, Math.max(tipHalfPct, ((xOf(active as number) + barW / 2) / VIEW_W) * 100)) / 100) *
      width
    const spanLeft = centre - tip.offsetWidth / 2
    const spanRight = centre + tip.offsetWidth / 2
    const hiddenTops = (slotTop: number): number => {
      if (width === 0) return 0
      let n = 0
      entries.forEach((e, j) => {
        if (j === active) return
        const left = cssX(xOf(j))
        if (left + cssX(barW) <= spanLeft || left >= spanRight) return
        // A day with nothing spent draws no bar: its "top" is the baseline
        // and must not score (it only ever falls in the legend slot's box,
        // which would bias the choice toward the baseline slot — review).
        // Its refusal mark, if it has one, still counts: the dash sits under
        // the slot (#4334), and the legend slot — the only one that reaches
        // below the baseline — can cover it.
        const inside = (y: number) => y > slotTop && y < slotTop + tip.offsetHeight
        const barHidden = e.total > 0 && inside(cssY(yOf(e.total)))
        const markHidden = e.refusals > 0 && inside(cssY(baseY + REFUSAL_MARKER_GAP))
        if (barHidden || markHidden) n += 1
      })
      return n
    }
    const slots = [aboveBaseline, onLegendTop].filter((t) => t >= least)
    let top: number | null = null
    if (slots.length > 0) {
      top = slots[0] as number
      let best = hiddenTops(top)
      for (const t of slots.slice(1)) {
        const n = hiddenTops(t)
        if (n < best) {
          best = n
          top = t
        }
      }
    }
    setTipTop(top === null ? null : Number(top.toFixed(1)))
  })

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
              x1={pad.left}
              x2={VIEW_W - pad.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
              stroke={AXIS_COLOR}
              strokeWidth={1}
            />
          ))}
          {/* Hatch patterns for partial days: the series fill at full
              strength with diagonal ground-coloured stripes, so the mark is
              the same on both themes and the fill's contrast survives. */}
          {hatched.length > 0 && (
            <defs>
              {hatched.map((fill, i) => (
                <pattern
                  key={`hatch-${i}`}
                  id={`${patternId}-hatch-${i}`}
                  data-testid="chart-hatch-pattern"
                  patternUnits="userSpaceOnUse"
                  width="6"
                  height="6"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" fill={fill} />
                  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--v2-bg)" strokeWidth="2" />
                </pattern>
              ))}
            </defs>
          )}
          {/* The abscissa. */}
          <line
            x1={pad.left}
            x2={VIEW_W - pad.right}
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
                data-partial={e.partial ? 'true' : undefined}
                aria-hidden="true"
                className="v2-chart-draw"
                style={{ transformOrigin: `${xOf(dayIdx) + barW / 2}px ${baseY}px` }}
                onMouseEnter={() => setHovered(dayIdx)}
                // A tap pins the day; a second tap on the pinned day lets
                // it go (the callout takes no pointer, so nothing else can
                // — #3066). The release also drops the hover: a touch tap
                // synthesises mouseenter before mousedown and never a
                // mouseleave, so without this the panel would stay up
                // through the second tap.
                onMouseDown={() => {
                  if (pinned === dayIdx) {
                    setPinned(null)
                    setHovered(null)
                  } else {
                    setPinned(dayIdx)
                  }
                }}
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
                      // A partial day is hatched so a cut day does not read
                      // as a quiet one (see `StackedBarDay.partial`).
                      fill={e.partial ? `url(#${hatchId.get(seriesFill(s))})` : seriesFill(s)}
                      data-hatched={e.partial ? 'true' : undefined}
                      fillOpacity={isHl ? 1 : 0.88}
                    />
                  )
                })}
                {/* Refusals: the marker series. A grey dash UNDER the day's
                    slot, never a second axis (see the header for why) and
                    never a cap on the bar — a day with refusals and no spend
                    has no bar to cap, and its refusals are still a fact. */}
                {e.refusals > 0 && (
                  <rect
                    data-testid="chart-refusal-marker"
                    x={xOf(dayIdx)}
                    y={baseY + REFUSAL_MARKER_GAP}
                    width={barW}
                    height={REFUSAL_MARKER_H}
                    rx={1.5}
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
              width: pct(pad.left - 6, VIEW_W),
              top: pct(yOf(tick), VIEW_H),
              transform: 'translateY(-50%)',
            }}
          >
            {formatTick(tick, scale.step)}
          </span>
        ))}
        {labelIdx.map((i) => {
          // One line always (#4426): an absolutely positioned label with no
          // width shrinks to the room left of the card's edge, so the last
          // day wrapped ("10 Jul" on two lines). The end label is pinned to
          // its bar's right edge and grows left, inside the plot.
          const at = xLabelEdge(i, entries.length, X_LABEL_ANCHORING)
          return (
            <span
              key={`x-${i}`}
              data-testid="chart-x-label"
              aria-hidden="true"
              className="absolute block whitespace-nowrap text-xs leading-none text-[var(--v2-ink-3)]"
              style={{
                left: pct(xOf(i) + barW * at.bandOffset, VIEW_W),
                top: pct(baseY + 8, VIEW_H),
                transform: at.transform,
              }}
            >
              {entries[i]?.label}
            </span>
          )
        })}
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
            <SeriesSwatch color={seriesFill(row)} seriesIndex={row.seriesIndex} />
            <span className="truncate">{row.name}</span>
          </li>
        ))}
        {entries.some((d) => d.refusals > 0) && (
          // The one mark the series rows do not explain: the grey dash under
          // a day that refused something. Named here, in the legend that names
          // everything else, rather than only in the card's prose (#3204).
          <li data-testid="chart-legend-refusal" className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-[3px] w-2.5 flex-shrink-0 rounded-sm"
              style={{ backgroundColor: INK, opacity: 0.55 }}
            />
            <span className="truncate">Refused</span>
          </li>
        )}
      </ul>

      {/* The tooltip: on a wide screen a callout over the day it describes;
          on a narrow one, a panel below the plot that a tap pins. One
          tooltip, two treatments, never a horizontal scroll. The callout
          takes no pointer events: it used to pin itself on mouseenter, and
          since it overlaps the neighbours' bars the pointer could not reach
          a day the previous day's callout lay over (#3066 — a scrub across
          the /design-system sample skipped two of seven days). Now the
          pointer falls through to the bars beneath; a pin is a tap on the
          day, released by a second tap or Escape. */}
      {entry !== null && (
        <div
          ref={tooltipRef}
          data-testid="chart-tooltip"
          role="status"
          className={
            narrow
              ? 'mt-3 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3'
              : `pointer-events-none absolute w-max max-w-[min(60%,24rem)] -translate-x-1/2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3 shadow-popover${tipTop === null ? ' top-3' : ''}`
          }
          data-flipped={!narrow && tipTop !== null ? 'true' : undefined}
          // Anchored over the day it describes rather than the plot's
          // centre (which covered its neighbours' bars and refusal caps —
          // #3051 design review), clamped by the callout's own measured
          // half-width so it stays inside the plot at either edge without
          // sliding onto a neighbour; dropped above the baseline when the
          // described bar is tall enough to hide under it (#3063).
          style={
            narrow || active === null
              ? undefined
              : {
                  left: `${Math.min(100 - tipHalfPct, Math.max(tipHalfPct, ((xOf(active) + barW / 2) / VIEW_W) * 100))}%`,
                  ...(tipTop === null ? {} : { top: `${tipTop}px` }),
                }
          }
        >
          {/* Two lines, not a table (#3067): the day, its refusal count and
              its total on the first, the agents as swatch·name·amount chips
              that wrap on the second. The old one-row-per-agent
              form stood 113–135px tall on a 200px plot, so on every bar of
              middling height the callout either hid the bar's top or (had
              it dropped) the whole bar — a ~60px callout fits above or
              below almost any bar and the drop rule (#3063) has room to
              work. The values in full are in the data table below. */}
          {/* The header row wraps: the label's units ("10 Jul", "· partial
              day", "· 1 payment refused") each hold together and break only
              between each other — a space between them is the break, the
              <p> may shrink (min-w-0) — and the total is pushed to the
              right edge, or onto the next line when the units fill this
              one; it never leaves the box (design re-check: with no break
              between nowrap units the row's min-content pushed the total
              6.7px past the 390 panel's border and split "10 Jul"). */}
          <div data-testid="chart-tooltip-header" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <p className="min-w-0 text-xs font-semibold text-[var(--v2-ink)]">
              <span className="whitespace-nowrap">{entry.label}</span>
              {entry.partial && (
                <>
                  {' '}
                  <span data-testid="chart-tooltip-partial" className="whitespace-nowrap font-normal text-[var(--v2-ink-3)]">
                    · partial day
                  </span>
                </>
              )}
              {/* The day's refusal count belongs to the day, so it sits
                  beside the day — as a trailing chip it read as the last
                  agent's (design review). */}
              {entry.refusals > 0 && (
                <>
                  {' '}
                  <span data-testid="chart-tooltip-refusals" className="whitespace-nowrap font-normal text-[var(--v2-ink-2)]">
                    · {entry.refusals} payment{entry.refusals === 1 ? '' : 's'} refused
                  </span>
                </>
              )}
            </p>
            <p data-testid="chart-tooltip-total" className="v2-tabular ml-auto whitespace-nowrap text-xs font-semibold text-[var(--v2-ink)]">
              {currency} {formatValue(entry.total)}
            </p>
          </div>
          {/* A chip may not run off the panel: the name truncates, the
              money figure never does (a 36-char id fallback or a long agent
              name pushed the amount out of the 390 panel — the
              whitespace-nowrap trap of #2038, caught in review), and the
              token breakdown wraps onto the chip's next line rather than
              stretching the callout to its width bound (a 560px banner
              over four date labels on the showcase — design review; the
              bound is 24rem, so chips wrap at a readable width). */}
          <ul data-testid="chart-tooltip-chips" className="mt-1 flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
              {entry.segments.map((s) => (
                <li
                  key={s.seriesId}
                  data-testid="chart-tooltip-row"
                  className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
                >
                  {/* swatch·name·amount never wrap against each other: in a
                      wrapping chip the name's flex-basis is its full width,
                      so a long name took a line of its own, orphaned the
                      swatch and pushed the amount to a third line (design
                      re-check). Inside this non-wrapping span the name
                      truncates against the amount; only the token breakdown
                      folds to the chip's next line. */}
                  <span data-testid="chart-tooltip-figure" className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
                    <SeriesSwatch color={seriesFill(s)} seriesIndex={s.seriesIndex} size="sm" className="self-center" />
                    <span data-testid="chart-tooltip-name" className="min-w-0 truncate text-[var(--v2-ink-2)]">{s.name}</span>
                    <span data-testid="chart-tooltip-amount" className="v2-tabular flex-shrink-0 whitespace-nowrap text-[var(--v2-ink)]">
                      {formatValue(s.amount)}
                    </span>
                  </span>
                  {s.tokens !== undefined && s.tokens.length > 0 && (
                    <span
                      data-testid="chart-tooltip-tokens"
                      className="v2-tabular min-w-0 text-[var(--v2-ink-3)]"
                    >
                      {'('}
                      {s.tokens.map(([token, amount]) => `${formatValue(amount)} ${token}`).join(' + ')}
                      {')'}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* The values in full, for anyone who reads the chart rather than
          looks at it — OUTSIDE the `role="img"` element above, whose subtree
          assistive technology is not shown. A chart's visually-hidden data
          table is not a product table: `ui/Table` is visible rows with
          sticky headers, column staging, and hover chrome, and none of that
          is what a screen reader is handed here. */}
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
              <th scope="row">{e.partial ? `${e.label} (partial day)` : e.label}</th>
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
    </div>
  )
}
