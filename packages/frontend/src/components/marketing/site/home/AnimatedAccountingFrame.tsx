'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ACCOUNTING_CYCLE_MS,
  useCycle,
  useDocumentVisible,
  useInView,
  usePrefersReducedMotion,
  type CycleStep,
} from './motion'
import { AccountingFrame, type AccountingFrameState } from './AccountingFrame'

/**
 * The accounting section's frame with the mockup's 11 s loop
 * (`docs/product/site-mockup/index.html:289-296`) — (#3575).
 *
 * The controller owns only the loop's state; `AccountingFrame` owns the feed
 * markup. One row — `pay_01…E0G2`, the mockup's `anim-e0g2` (:205) — goes
 * Failed → Retrying → Synced on the script's offsets, 1600 ms and 3300 ms
 * (`loop(…, 11000, …)` at :293, the steps at :294-295): Retrying renames the
 * detail to "Retrying the push to Fortnox", Synced moves it to "Fortnox
 * invoice 1043 · payment evidence attached", flashes the row (site.css:335)
 * and flips the connector line to "Last push just now". At the boundary the
 * row returns to Failed and the line to its settled text (:296's reset).
 *
 * With no state passed — reduced motion, before the loop starts, out of
 * view, hidden tab — the feed renders the settled fixture state exactly: the
 * failed push, as slice 2 shipped it. Decorative: the section wraps the
 * frame in `aria-hidden`.
 */
export function AnimatedAccountingFrame() {
  const reduced = usePrefersReducedMotion()
  const visible = useDocumentVisible()
  const { ref, inView } = useInView<HTMLDivElement>()
  const looping = !reduced && visible && inView

  const [status, setStatus] = useState<'Failed' | 'Retrying' | 'Synced'>('Failed')

  const steps: CycleStep[] = [
    { at: 1600, act: () => setStatus('Retrying') },
    { at: 3300, act: () => setStatus('Synced') },
  ]
  useCycle(steps, ACCOUNTING_CYCLE_MS, looping, () => setStatus('Failed'))

  const rowDetail =
    status === 'Retrying'
      ? 'Retrying the push to Fortnox'
      : status === 'Synced'
        ? 'Fortnox invoice 1043 · payment evidence attached'
        : 'Fortnox answered 503 · will retry'

  const state: AccountingFrameState | undefined = looping
    ? {
        rowStatus: status,
        rowDetail,
        lastPush: status === 'Synced' ? 'Last push just now' : 'Last push 2 minutes ago',
        flashing: status === 'Synced',
      }
    : undefined

  return (
    <div ref={ref} data-testid="accounting-animated">
      <AccountingFrame state={state} />
    </div>
  )
}
