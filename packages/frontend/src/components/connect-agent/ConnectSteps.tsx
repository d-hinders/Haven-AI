'use client'

import type { ReactNode } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Icon } from '../ui/Icon'

/**
 * #3832: the connect step's numbered list — copy → paste → approve. It is the
 * ONE progress signal on step 3 (#1418): it replaced the shell's
 * Waiting → Connected → Approved ticker, which started at "Waiting" without
 * naming the thing the user had to do. Each row is both the instruction and
 * its status, so the screen says the action once instead of three times.
 *
 * Local to `connect-agent/` on purpose: it has one call site, and the
 * design system treats a one-call-site pattern as too thin to promote
 * (`docs/product/design-system.md` § Numbered step list).
 *
 * Marker states — done, active and pending are StepProgress's disc
 * treatments; working adds the brand spinner (no new colour, radius or size):
 * - `done`    — success-soft disc with a check;
 * - `active`  — brand-soft disc, brand ring, brand numeral;
 * - `working` — the brand spinner (lucide `Loader2`), for a row whose outcome
 *               is in flight and needs nothing from the user;
 * - `pending` — a `--v2-border` ring with the numeral in ink-3.
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
   * Below the `sm` breakpoint, render `children` at the list's full width
   * instead of indented under the heading. For a row whose body is a whole
   * sub-flow with paired buttons (the approval card): indented by the marker
   * column, a 390px screen left each button ~125px and wrapped "Approve
   * budget" onto two lines (#3832 design review). Last row only — a wide body
   * covers the marker column, where a connector line would run.
   */
  wideBodyOnMobile?: boolean
}

// Screen-reader state prefix for the row heading. None for `active`: that row
// carries `aria-current="step"`, which already announces it — a prefix would
// say it twice.
const STATE_LABEL: Record<ConnectStepRowState, string | null> = {
  done: 'Done',
  active: null,
  working: 'In progress',
  pending: 'Not started',
}

function Marker({ state, number }: { state: ConnectStepRowState; number: number }) {
  // The disc treatments are StepProgress's (ui/StepProgress.tsx), on purpose:
  // the wizard's header band on steps 1-2 and this list on step 3 are the same
  // progress language, so a user moving from one to the other reads one
  // system continuing, not a second one starting (#3832 design review ask).
  const base =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium v2-tabular sm:h-8 sm:w-8'
  if (state === 'done') {
    return (
      <span className={`${base} border-success/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]`}>
        <Icon icon={Check} className="h-3.5 w-3.5" strokeWidth={2} />
      </span>
    )
  }
  if (state === 'working') {
    return (
      <span className={`${base} border-transparent text-[var(--v2-brand)]`}>
        <Icon icon={Loader2} className="h-4 w-4 motion-safe:animate-spin" strokeWidth={2} />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className={`${base} border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]`}>
        {number}
      </span>
    )
  }
  return <span className={`${base} border-[var(--v2-border)] text-[var(--v2-ink-3)]`}>{number}</span>
}

const TITLE_TONE: Record<ConnectStepRowState, string> = {
  done: 'text-[var(--v2-ink-3)]',
  active: 'text-[var(--v2-ink)]',
  working: 'text-[var(--v2-ink)]',
  pending: 'text-[var(--v2-ink-2)]',
}

export function ConnectSteps({ rows }: { rows: ConnectStepRow[] }) {
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
              <div className="flex flex-col items-center gap-1.5">
                <Marker state={row.state} number={index + 1} />
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
