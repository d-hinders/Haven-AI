/**
 * The shared scale maths for the chart primitives (#2948, analytics slice D).
 *
 * `ui/StackedBarChart` and `ui/AreaChart` both draw one y-scale whose ticks
 * "hit values the data reaches, never beyond the max" (issue #2948). That rule
 * is arithmetic, so it lives here as a pure module the unit tests can drive
 * directly, rather than being inferred through a rendered SVG — the same split
 * `lib/allowance-format.ts` applies between the money formatting and the
 * components that print it.
 *
 * The x-axis label density is here for the same reason: the issue fixes the
 * bands (7d → every day, 30d → weekly, 90d → fortnightly; fewer on mobile),
 * which is a property of the data and the viewport, not of either chart.
 *
 * Nothing here renders; nothing here imports React or DOM types.
 */

/** How many x labels fit per width class, mobile first (#2948: mobile = fewer). */
export const MAX_X_LABELS_DESKTOP = 12
export const MAX_X_LABELS_MOBILE = 5

/** What "too little to chart" means: the issue's sparse-data floor. */
export const MIN_CHARTABLE_DAYS = 3

/**
 * The y-scale: `max` is the ceiling (never below the data), `ticks` are the
 * values the grid lines draw at. `0` is never listed as a tick — the axis floor
 * already draws it, and a scale whose "ticks" are `[0, 400, 800]` reads as a
 * bug the moment the top grid line is missing.
 *
 * `roundNiceStep` snaps the raw span into thirds to 1/2/2.5/5 × 10ⁿ. The
 * snapping is what makes "ticks hit values the data reaches" observable:
 * with a 780-max range the naive four-way split prints 195 / 390 / 585 —
 * numbers no day ever spent — while the snapped scale prints 200 / 400 / 600,
 * values the axis can honestly claim to reach.
 */
export interface ChartScale {
  max: number
  ticks: number[]
}

export function roundNiceStep(span: number): number {
  if (span <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(span))
  const unit = span / pow
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10
  return nice * pow
}

/**
 * A scale covering `[0, dataMax]` with at most `target` grid intervals.
 *
 * The ceiling is a multiple of the tick step so every tick is a reachable
 * value; `+1` on the ceiling guard keeps a data max that already *is* a
 * multiple of the step from sitting exactly on the top grid line (a bar flush
 * with the last line reads as "the axis clipped me"). The only case that
 * cannot be honoured is `dataMax === 0` — a range with nothing plotted gets a
 * degenerate scale and no ticks, because inventing headroom for a chart with
 * no data would be the same lie in a different font.
 */
export function chartScale(dataMax: number, target = 4): ChartScale {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return { max: 0, ticks: [] }
  const step = roundNiceStep(dataMax / target)
  const max = step * Math.floor(dataMax / step + 1)
  const ticks: number[] = []
  for (let v = step; v < max - step / 2; v += step) {
    // Round away float dust from the 2.5× steps (`2.5 + 2.5 + 2.5` lands on
    // 7.4999…); the ticks are labels, and labels must read like numbers.
    ticks.push(Number(v.toPrecision(12)))
  }
  return { max, ticks }
}

/**
 * Which x indices carry a label.
 *
 * The issue's bands first (7d → all, 30d → every 7, 90d → every 14), then a
 * density guard: a 45-day range at a phone width would print seven labels
 * over five slots and collide, so anything the bands leave above
 * `maxLabels` thins to a stride that fits. The last day ALWAYS gets a label
 * — the right edge is where the range ends and a chart that stops its labels
 * short of it hides the window it is about.
 *
 * Indices are returned, not strings: the callers own the calendar formatting
 * (the bar chart wants "Mon 8", the area chart the same day in the same
 * voice) and a scale that formats in two places drifts.
 */
export function xLabelIndices(count: number, { narrow = false }: { narrow?: boolean } = {}): number[] {
  if (count <= 0) return []
  let stride: number
  if (count <= 7) stride = 1
  else if (count <= 30) stride = 7
  else stride = 14
  const maxLabels = narrow ? MAX_X_LABELS_MOBILE : MAX_X_LABELS_DESKTOP
  if (Math.ceil(count / stride) > maxLabels) {
    stride = Math.ceil(count / maxLabels)
  }
  const indices: number[] = []
  for (let i = 0; i < count; i += stride) indices.push(i)
  // The last day always carries a label. Where the stride left a slot near
  // the end it is the slot that moves to the endpoint rather than an extra
  // label being printed past it: a chart may print at most `maxLabels`
  // labels, and a label that collides with its neighbour is worse than a
  // ragged last gap, while an unlabelled right edge hides the window the
  // chart is about.
  if (indices[indices.length - 1] !== count - 1) {
    if (indices.length < maxLabels) indices.push(count - 1)
    else indices[indices.length - 1] = count - 1
  }
  return indices
}
