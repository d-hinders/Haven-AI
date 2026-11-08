'use client'

import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Icon } from '../ui/Icon'
import { Milestone } from '@/components/ui/Milestone'
import { Spinner } from '@haven_ai/ui/Spinner'
import { ACTIVE_STEP_RING_CLASS, DONE_STEP_DISC_CLASS, PENDING_STEP_DISC_CLASS } from '@/components/ui/StepProgress'

/**
 * #3832: the connect step's status checklist — copy → paste → approve. Each
 * row is both the instruction and its status, so the screen says the action
 * once instead of three times; it replaced the shell's
 * Waiting → Connected → Approved ticker, which started at "Waiting" without
 * naming the thing the user had to do.
 *
 * It reports progress WITHIN step 3 and never counts: the header StepProgress
 * (Name → Budget → Connect) is the flow's one counter and stays visible on
 * step 3 with Connect active. So the markers carry no numerals — a numbered
 * column under a numbered band read as a second stepper (owner review,
 * 2026-10-16, superseding #1418's hide-the-band rule).
 *
 * Local to `connect-agent/` on purpose: it expresses this flow's copy → paste
 * → approve checklist rather than a general-purpose progress primitive.
 *
 * Marker states — one disc size and StepProgress's tokens, no numerals:
 * - `done`    — success-soft disc with a check; plays `Milestone` Step when
 *               the row opts in with `play` (#4706);
 * - `active`  — the shared ink-2 ring with no fill or dot: the user's move;
 * - `working` — the shared spinner in ink-2 inside a border disc,
 *               for a row whose outcome is in flight and needs nothing from
 *               the user;
 * - `pending` — an empty `--v2-border` ring.
 */
export type ConnectStepRowState = 'done' | 'active' | 'working' | 'pending'

export interface ConnectStepRow {
  id: string
  state: ConnectStepRowState
  title: ReactNode
  /** Right-aligned control on the heading line (e.g. "Copy again"). */
  aside?: ReactNode
  children?: ReactNode
  /**
   * #4706: play `Milestone` Step on this row's done mark. Only a row that goes
   * done while the user is watching opts in — a row already done when the
   * session first saw the flow renders the static check. Default `false`, so
   * the `/design-system` showcase never animates on first paint.
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

// Screen-reader state prefix for the row heading. None for `active`: that row
// carries `aria-current="step"`, which already announces it — a prefix would
// say it twice.
const STATE_LABEL: Record<ConnectStepRowState, string | null> = {
  done: 'Done',
  active: null,
  working: 'In progress',
  pending: 'Not started',
}

function Marker({ state, halo, play }: { state: ConnectStepRowState; halo: boolean; play: boolean }) {
  // One disc for every state, so the marker column stays a straight edge (the
  // working spinner used to sit bare and ragged it). The tokens are
  // StepProgress's on purpose: the header band and this list are one
  // progress language, a counter above and a status column below.
  // Decorative: the row heading carries the state in words.
  const base = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full sm:h-8 sm:w-8'
  if (state === 'done') {
    // #4706: the done mark is the one place this list plays `Milestone` Step.
    // `play` is decided above `ConnectStepShell`'s key (the shell remounts its
    // body on every sub-state change, so a mount cannot mean "just happened").
    return (
      <Milestone strength="step" play={play}>
        <span aria-hidden="true" className={`${base} ${DONE_STEP_DISC_CLASS}`}>
          <Icon icon={Check} className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
      </Milestone>
    )
  }
  if (state === 'working') {
    return (
      <span aria-hidden="true" className={`${base} border border-[var(--v2-border)] text-[var(--v2-ink-2)]`}>
        <Spinner size="sm" />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span
        aria-hidden="true"
        className={`${base} ${ACTIVE_STEP_RING_CLASS} ${halo ? 'v2-step-halo' : ''}`}
      />
    )
  }
  return <span aria-hidden="true" className={`${base} ${PENDING_STEP_DISC_CLASS}`} />
}

const TITLE_TONE: Record<ConnectStepRowState, string> = {
  done: 'text-[var(--v2-ink-3)]',
  active: 'text-[var(--v2-ink)]',
  working: 'text-[var(--v2-ink)]',
  pending: 'text-[var(--v2-ink-2)]',
}

export function ConnectSteps({ rows, halo = false }: { rows: ConnectStepRow[]; halo?: boolean }) {
  return (
    <ol aria-label="Connection steps" className="flex flex-col">
      {rows.map((row, index) => {
        const last = index === rows.length - 1
        return (
          <li
            key={row.id}
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
                  the connector line and the text column exactly where they
                  were. */}
              <div className="flex flex-col items-center gap-1.5 overflow-clip p-2 -m-2">
                <Marker state={row.state} halo={halo && row.state === 'active'} play={row.play ?? false} />
                {!last && <span aria-hidden="true" className="w-px flex-1 bg-[var(--v2-border)]" />}
              </div>
              {/* The row spacing sits on THIS column, not the <li>: padding on
                  the <li> would sit outside the marker column's stretch, and a
                  heading-only row would draw no connector line at all. */}
              <div className={`flex min-w-0 flex-1 flex-col gap-3 pt-0.5 sm:pt-1 ${last ? '' : 'pb-5'}`}>
                <div className="flex min-h-5 items-center justify-between gap-3">
                  {/* #1393: section tier — the modal keeps its one title. */}
                  <h3 className={`text-sm font-semibold ${TITLE_TONE[row.state]}`}>
                    {STATE_LABEL[row.state] && (
                      <span className="sr-only">{`${STATE_LABEL[row.state]}: `}</span>
                    )}
                    {row.title}
                  </h3>
                  {row.aside}
                </div>
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
