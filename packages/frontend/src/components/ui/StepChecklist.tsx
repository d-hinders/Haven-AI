'use client'

import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Icon } from './Icon'
import { Milestone } from './Milestone'
import { Spinner } from '@haven_ai/ui/Spinner'
import { ACTIVE_STEP_RING_CLASS, DONE_STEP_DISC_CLASS, PENDING_STEP_DISC_CLASS } from './StepProgress'

/**
 * The Step status checklist (#3832, promoted to `components/ui/` by #4744): a
 * vertical list in which each row is both an instruction and its status. One
 * marker column, joined by a connector, beside one text column.
 *
 * Two consumers, one stepper family:
 * - `ConnectSteps`, the connect dialog's copy → paste → approve list. No
 *   numerals: the dialog's `StepProgress` band above it is the flow's one
 *   counter, and a numbered column under a numbered band read as a second
 *   stepper (owner review, 2026-10-16).
 * - the dashboard's first-run guide (`DashboardOnboardingGuide`). Numbered:
 *   there the list IS the counter, beside the card's "N of 3 done".
 *
 * Marker states — one disc size and StepProgress's marker classes:
 * - `done`    — success-soft disc with a check; plays `Milestone` Step when
 *               the row opts in with `play` (#4706);
 * - `active`  — the shared ink-2 ring: the user's move;
 * - `working` — the shared spinner in ink-2 inside a border disc, for a row
 *               whose outcome is in flight and needs nothing from the user;
 * - `pending` — the quiet 1px ring.
 *
 * The connector (#4744) is 2px and STATIC: no transition, and not
 * `.v2-progress-line`, whose `scaleX` fill is a horizontal band's motion. A
 * segment describes the step ABOVE it: below a `done` marker it takes the
 * band's filled tint, `--v2-success` at 45% over `--v2-border`; every other
 * segment is `--v2-border-strong`. Steps completed out of order therefore
 * colour only the segments under the done ones.
 */
export type StepChecklistState = 'done' | 'active' | 'working' | 'pending'

export interface StepChecklistRow {
  id: string
  state: StepChecklistState
  title: ReactNode
  /** One line under the heading, toned by the row's state (the guide's step copy). */
  description?: ReactNode
  /** Right-aligned control on the heading line (e.g. "Copy again"). Centres on the heading only. */
  aside?: ReactNode
  /**
   * The row's action (#4744). From `sm` up it sits at the row's right,
   * centred against heading plus description; below `sm` it sits under the
   * text at the text column's full width. Never stacks beside the heading
   * the way `aside` does.
   */
  action?: ReactNode
  /** Free content under the heading block (a sub-flow, a code block). */
  children?: ReactNode
  /**
   * A `pending` row the user can act on now — the guide's `available` and
   * `unknown` steps (#3818). Its heading takes `--v2-ink` instead of the
   * quieter `--v2-ink-2` of a step that is not open yet.
   */
  actionable?: boolean
  /**
   * The numeral inside the marker, when the list is `numbered`. Ignored on a
   * `done` row (its check says it) and a `working` row (its spinner does).
   */
  number?: number
  /**
   * Override the screen-reader state prefix ("Done: ", "Not started: "):
   * `null` drops it, for a row whose state is not knowable (the guide's
   * unreadable balance).
   */
  stateLabel?: string | null
  /**
   * #4706: play `Milestone` Step on this row's done mark. Only a row that goes
   * done while the user is watching opts in — a row already done when the
   * session first saw it renders the static check. Default `false`, so the
   * `/design-system` showcase never animates on first paint.
   */
  play?: boolean
  /**
   * Below the `sm` breakpoint, render `children` at the list's full width
   * instead of indented under the heading. For a row whose body is a whole
   * sub-flow with paired buttons (the approval card): indented by the marker
   * column, a 390px screen left each button ~125px and wrapped "Approve
   * budget" onto two lines (#3832 design review). Last row only — a wide body
   * covers the marker column, where a connector line would run.
   */
  wideBodyOnMobile?: boolean
  /** Extra attributes for the row's `<li>`, e.g. the guide's `data-status`. */
  rowAttributes?: Record<`data-${string}`, string>
}

/**
 * Pulls a row's footer (its action pair) out over the marker column from `sm`
 * up — 2rem disc + 0.875rem gap — so it lines up with the dialog body's edges
 * like every other footer in the flow, instead of with the indented text
 * column. Below `sm` a `wideBodyOnMobile` row is already at those edges. Last
 * row only, for the same reason as `wideBodyOnMobile`: no connector line runs
 * under the last marker.
 */
export const ROW_FOOTER_OUTDENT_CLASS = 'sm:-ml-[2.875rem]'

/** The connector segment under a marker; `done` is the step above it. */
export const STEP_CONNECTOR_CLASS = 'w-0.5 flex-1 rounded-full'
const CONNECTOR_TONE = {
  done: 'bg-[color-mix(in_srgb,var(--v2-success)_45%,var(--v2-border))]',
  other: 'bg-[var(--v2-border-strong)]',
} as const

// Screen-reader state prefix for the row heading. None for `active`: that row
// carries `aria-current="step"`, which already announces it — a prefix would
// say it twice.
const STATE_LABEL: Record<StepChecklistState, string | null> = {
  done: 'Done',
  active: null,
  working: 'In progress',
  pending: 'Not started',
}

const MARKER_BASE = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full sm:h-8 sm:w-8'
const NUMERAL_CLASS = 'text-xs font-medium v2-tabular'

function Marker({
  state,
  halo,
  play,
  numeral,
}: {
  state: StepChecklistState
  halo: boolean
  play: boolean
  numeral: number | undefined
}) {
  // One disc for every state, so the marker column stays a straight edge.
  // The tokens are StepProgress's on purpose: the header band and this list
  // are one progress language. Decorative: the heading carries the state in
  // words.
  if (state === 'done') {
    // #4706: the done mark is the one place this list plays `Milestone` Step.
    return (
      <Milestone strength="step" play={play} className="shrink-0">
        <span aria-hidden="true" className={`${MARKER_BASE} ${DONE_STEP_DISC_CLASS}`}>
          <Icon icon={Check} className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
      </Milestone>
    )
  }
  if (state === 'working') {
    return (
      <span aria-hidden="true" className={`${MARKER_BASE} border border-[var(--v2-border)] text-[var(--v2-ink-2)]`}>
        <Spinner size="sm" />
      </span>
    )
  }
  const numeralClass = numeral === undefined ? '' : NUMERAL_CLASS
  if (state === 'active') {
    return (
      <span
        aria-hidden="true"
        className={`${MARKER_BASE} ${ACTIVE_STEP_RING_CLASS} text-[var(--v2-ink-2)] ${numeralClass} ${halo ? 'v2-step-halo' : ''}`}
      >
        {numeral}
      </span>
    )
  }
  return (
    <span aria-hidden="true" className={`${MARKER_BASE} ${PENDING_STEP_DISC_CLASS} ${numeralClass}`}>
      {numeral}
    </span>
  )
}

function titleTone(row: StepChecklistRow): string {
  if (row.state === 'done') return 'text-[var(--v2-ink-3)]'
  if (row.state === 'pending' && !row.actionable) return 'text-[var(--v2-ink-2)]'
  return 'text-[var(--v2-ink)]'
}

function descriptionTone(row: StepChecklistRow): string {
  if (row.state === 'done') return 'text-[var(--v2-ink-3)]'
  if (row.state === 'pending' && !row.actionable) return 'text-[var(--v2-ink-3)]'
  return 'text-[var(--v2-ink-2)]'
}

type ListLabel = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never }

export type StepChecklistProps = ListLabel & {
  rows: StepChecklistRow[]
  /** The active row's 8px halo — a live dialog only, never a static showcase. */
  halo?: boolean
  /** Draw each row's `number` inside its marker. */
  numbered?: boolean
  /**
   * The heading element. `h3` (semibold, section tier, #1393) inside the
   * connect dialog, which keeps its one title; `p` (medium) where the card's
   * own `h2` is the only heading (the guide).
   */
  headingAs?: 'h3' | 'p'
}

export function StepChecklist({ rows, halo = false, numbered = false, headingAs = 'h3', ...label }: StepChecklistProps) {
  const Heading = headingAs
  const headingWeight = headingAs === 'h3' ? 'font-semibold' : 'font-medium'
  return (
    <ol {...label} className="flex flex-col">
      {rows.map((row, index) => {
        const last = index === rows.length - 1
        const prefix = row.stateLabel === undefined ? STATE_LABEL[row.state] : row.stateLabel
        const headingLine = (
          <div className="flex min-h-5 items-center justify-between gap-3">
            <Heading className={`text-sm ${headingWeight} ${titleTone(row)}`}>
              {prefix ? <span className="sr-only">{`${prefix}: `}</span> : null}
              <span>{row.title}</span>
            </Heading>
            {row.aside}
          </div>
        )
        const headingBlock = row.description ? (
          <div className="min-w-0" data-step-text="">
            {headingLine}
            <p className={`mt-0.5 text-xs leading-relaxed ${descriptionTone(row)}`}>{row.description}</p>
          </div>
        ) : (
          <div className="min-w-0" data-step-text="">
            {headingLine}
          </div>
        )
        return (
          <li
            key={row.id}
            {...row.rowAttributes}
            data-step-state={row.state}
            // One current step per list: the row the user acts on. A `working`
            // row is Haven's to finish, so it is not "current".
            aria-current={row.state === 'active' ? 'step' : undefined}
          >
            <div className="flex gap-3.5">
              {/* #4706: the marker column carries 8px of padding and an equal
                  negative margin, and clips at the padding box. The padding
                  box is therefore 16px larger than the disc on each axis, which
                  is exactly the room `Milestone` Step's 1.25× check-pop and the
                  active row's 8px halo need — so neither is clipped, and
                  neither grows the column's scroll box (the e2e dialog-overflow
                  gate measures every box). The negative margin keeps the disc,
                  the connector and the text column exactly where they were.
                  #4744: no gap around the connector — it runs disc to disc, so
                  a heading-only row (12px between discs) still draws a line,
                  not a dot. */}
              <div className="flex flex-col items-center overflow-clip p-2 -m-2">
                <Marker
                  state={row.state}
                  halo={halo && row.state === 'active'}
                  play={row.play ?? false}
                  numeral={numbered && row.state !== 'done' && row.state !== 'working' ? row.number : undefined}
                />
                {!last && (
                  <span
                    aria-hidden="true"
                    data-step-connector={row.state === 'done' ? 'done' : 'open'}
                    className={`${STEP_CONNECTOR_CLASS} ${row.state === 'done' ? CONNECTOR_TONE.done : CONNECTOR_TONE.other}`}
                  />
                )}
              </div>
              {/* The row spacing sits on THIS column, not the <li>: padding on
                  the <li> would sit outside the marker column's stretch, and a
                  heading-only row would draw no connector at all. */}
              <div className={`flex min-w-0 flex-1 flex-col gap-3 pt-0.5 sm:pt-1 ${last ? '' : 'pb-5'}`}>
                {row.action ? (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    {headingBlock}
                    <div className="flex flex-col sm:shrink-0" data-step-action="">
                      {row.action}
                    </div>
                  </div>
                ) : (
                  headingBlock
                )}
                {row.wideBodyOnMobile ? (
                  // Rendered ONCE (the body can hold a signing flow, so it must
                  // never mount twice); below `sm` it pulls left over the
                  // marker column — 1.75rem disc + 0.875rem gap.
                  <div className="-ml-[2.625rem] flex flex-col gap-3 sm:ml-0">{row.children}</div>
                ) : (
                  row.children
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export default StepChecklist
