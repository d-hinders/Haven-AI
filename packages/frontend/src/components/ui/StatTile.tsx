'use client'

import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/ui/StatusBadge'

/**
 * StatTile — the one number and the sentence under it (#2947, epic #2944
 * slice C).
 *
 * Four of these answer the Analytics page's four questions (Spent, Refused,
 * Budget used, Fees paid to Haven), and the primitive exists so the fourth
 * cannot drift from the first in size, rhythm, or — the reason this needs a
 * primitive at all — what its colour MEANS.
 *
 * ── The polarity rule ───────────────────────────────────────────────────────
 *
 * A delta chip's colour carries a judgement, and a bigger number only justifies
 * a red chip when a bigger number is bad news. So the tile does not choose its
 * own tone and the caller cannot hand it one: the caller declares what a
 * rising value of this particular figure means via `polarity`, and the tone
 * follows from that.
 *
 *   `higher-is-bad`      Refused.     More refusals is worse, so an increase
 *                                     goes red and a decrease green.
 *   `neutral`            Spent, Fees. Spend is activity, not loss; fees are the
 *                                     price the product charges. Neither direction
 *                                     is good or bad, so the chip stays neutral
 *                                     and the number carries itself.
 *   `higher-is-warning`  Budget used. Past the point where a budget is nearly
 *                                     spent is genuinely the condition the chip
 *                                     warns about, so up reads warning rather
 *                                     than success.
 *
 * The rule that makes the whole thing checkable: **colour is never on the
 * value.** The figure renders at `--v2-ink` in every state, so a tile whose
 * number went red or green — which is what "urgency" tempts a page into — is a
 * defect regardless of what the screen looks like afterwards. The number is a
 * reading, not a verdict, and a reading that changes colour with volume stops
 * being scannable the moment one tile is loud. The judgement is the chip's job
 * alone.
 *
 * A flat delta (`delta === 0`) always reads neutral whatever the polarity,
 * because "no change" is neither better nor worse under any reading of the
 * figure.
 */

export type StatTilePolarity = 'higher-is-bad' | 'neutral' | 'higher-is-warning'

interface StatTileProps {
  /** What the figure is. A noun or a short noun phrase, never a verb. */
  label: string
  /**
   * The figure, ALREADY formatted for display. A string keeps the money path's
   * numeric-string types intact (the overview response books fiat as strings)
   * and keeps one formatter in front of every tile.
   */
  value: string
  /** Unit beside the figure (`USDC`, `%`). Rendered in secondary ink, never in the value's weight. */
  unit?: string
  /**
   * What a RISING value of this figure means. Required when a delta is shown —
   * there is no safe default for a judgement, and a caller that omitted one
   * would get green-for-more on a figure where that is the wrong reading.
   */
  polarity?: StatTilePolarity
  /** The change versus the previous window, as a percentage of the figure (2.4 = +2.4%). */
  delta?: number | null
  /** Caption for the chip (e.g. "vs previous 30 days"). */
  deltaCaption?: string
  /**
   * BCP-47 locale the delta percentage is written in. The value beside it is
   * already formatted by the caller (sv-SE "324,75 kr"), and a chip that said
   * "+15.9%" next to it mixed two decimal dialects on one tile (#3204). Default
   * `en-US` keeps every existing caller's output.
   */
  deltaLocale?: string
  /** What the figure was computed over — the basis line ("based on 4 payments"). */
  footnote?: ReactNode
  className?: string
}

const POLARITY_ERROR =
  'StatTile shows a delta without a polarity: colouring a change is a judgement about whether more of this figure is bad, so the caller must declare what a rising value means.'

export function StatTile({
  label,
  value,
  unit,
  polarity,
  delta = null,
  deltaLocale = 'en-US',
  deltaCaption,
  footnote,
  className = '',
}: StatTileProps) {
  const showDelta = delta != null
  if (showDelta && polarity == null) {
    throw new Error(POLARITY_ERROR)
  }

  // The single place a chip's tone is decided. `up` is the raw direction; the
  // reading of it is `polarity`'s, which is why both are needed to pick a tone.
  const up = showDelta && delta > 0
  const down = showDelta && delta < 0
  let tone: 'success' | 'danger' | 'warning' | 'neutral' = 'neutral'
  if (up || down) {
    if (polarity === 'higher-is-bad') tone = up ? 'danger' : 'success'
    else if (polarity === 'higher-is-warning') tone = up ? 'warning' : 'neutral'
    // `neutral` polarity keeps the chip neutral in both directions: by
    // declaration, neither direction of this figure is news.
  }
  const sign = up ? '+' : down ? '-' : ''
  // One decimal, locale-formatted (sv-SE writes "15,9 %" with a space before
  // the sign; `style: 'percent'` supplies both the separator and the spacing).
  const deltaText = showDelta
    ? `${sign}${new Intl.NumberFormat(deltaLocale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(delta as number) / 100)}`
    : ''

  return (
    <div
      className={`rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card p-5 ${className}`}
      data-testid={`stat-tile-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
    >
      <p className="text-sm font-medium text-[var(--v2-ink-2)]">{label}</p>
      <p className="mt-2 v2-tabular text-2xl font-semibold leading-tight text-[var(--v2-ink)]">
        {value}
        {unit && <span className="ml-1 text-sm font-medium text-[var(--v2-ink-3)]">{unit}</span>}
      </p>
      {showDelta && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <StatusBadge tone={tone} className="v2-tabular">
            {deltaText}
          </StatusBadge>
          {deltaCaption && <span className="text-xs text-[var(--v2-ink-3)]">{deltaCaption}</span>}
        </div>
      )}
      {footnote && (
        <p className="mt-2.5 text-xs leading-relaxed text-[var(--v2-ink-3)]">{footnote}</p>
      )}
    </div>
  )
}

export default StatTile
