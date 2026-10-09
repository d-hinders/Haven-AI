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
 * Marker states, all StepProgress's existing treatments (no new colour,
 * radius or size):
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
}

const STATE_LABEL: Record<ConnectStepRowState, string> = {
  done: 'Done',
  active: 'Current step',
  working: 'In progress',
  pending: 'Not started',
}

function Marker({ state, number }: { state: ConnectStepRowState; number: number }) {
  // The disc treatments are StepProgress's (ui/StepProgress.tsx), on purpose:
  // the wizard's header band on steps 1-2 and this list on step 3 are the same
  // progress language, so a user moving from one to the other reads one
  // system continuing, not a second one starting (#3832 design review ask).
  const base =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium v2-tabular'
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
            aria-current={row.state === 'active' || row.state === 'working' ? 'step' : undefined}
            className="flex gap-3.5"
          >
            <div className="flex flex-col items-center gap-1.5">
              <Marker state={row.state} number={index + 1} />
              {!last && <span aria-hidden="true" className="w-px flex-1 bg-[var(--v2-border)]" />}
            </div>
            {/* The row spacing sits on THIS column, not the <li>: padding on the
                <li> would sit outside the marker column's stretch, and a
                heading-only row would draw no connector line at all. */}
            <div className={`flex min-w-0 flex-1 flex-col gap-3 pt-0.5 ${last ? '' : 'pb-5'}`}>
              <div className="flex min-h-5 items-center justify-between gap-3">
                {/* #1393: section tier — the modal keeps its one title. */}
                <h3 className={`text-sm font-semibold ${TITLE_TONE[row.state]}`}>
                  <span className="sr-only">{`${STATE_LABEL[row.state]}: `}</span>
                  {row.title}
                </h3>
                {row.aside}
              </div>
              {row.children}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
