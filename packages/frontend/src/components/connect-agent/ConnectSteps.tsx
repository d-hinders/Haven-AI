'use client'

import { StepChecklist, type StepChecklistRow, type StepChecklistState } from '@/components/ui/StepChecklist'

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
 * The list itself is the shared Step status checklist (`components/ui/
 * StepChecklist`, #4744), which the dashboard's first-run guide renders too:
 * markers, connector, spacing and motion room are defined there once. This
 * file keeps what is the connect flow's own — its list label and its
 * section-tier `h3` headings.
 */
export type ConnectStepRowState = StepChecklistState

export type ConnectStepRow = Pick<
  StepChecklistRow,
  'id' | 'state' | 'title' | 'aside' | 'children' | 'play' | 'wideBodyOnMobile'
>

export function ConnectSteps({ rows, halo = false }: { rows: ConnectStepRow[]; halo?: boolean }) {
  return <StepChecklist aria-label="Connection steps" headingAs="h3" rows={rows} halo={halo} />
}
