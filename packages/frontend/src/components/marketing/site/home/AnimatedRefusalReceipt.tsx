'use client'

import { useEffect, useRef, useState } from 'react'
import { useDocumentVisible, useInView, usePrefersReducedMotion } from './motion'
import { RefusalReceipt, type ReceiptAssemblyState } from './RefusalReceipt'

/**
 * The spending-limits band's receipt, with the mockup's assembly animation
 * (`docs/product/site-mockup/index.html:298-305`) — (#3575).
 *
 * The mockup replays the assembly EVERY time the receipt scrolls into view
 * (:302-304 — remove `play`, force reflow, re-add it). The controller owns
 * exactly that: an entry counter that bumps on every out-of-view → in-view
 * transition; `RefusalReceipt` remounts its rows on the new key, restarting
 * their staggered CSS entrance (110 ms per pair, `index.html:301`) and the
 * refusal's late landing (site.css:338) from zero.
 *
 * Under reduced motion no state is passed and the settled receipt renders —
 * fully assembled, no animation. Decorative: the band wraps it in
 * `aria-hidden`, so none of the assembly is announced; nothing is inserted
 * or removed, and there is no live region.
 */
export function AnimatedRefusalReceipt() {
  const reduced = usePrefersReducedMotion()
  const visible = useDocumentVisible()
  const { ref, inView } = useInView<HTMLDivElement>(0.45)

  const [entry, setEntry] = useState(0)
  const wasInView = useRef(false)
  useEffect(() => {
    if (inView && !wasInView.current && !reduced) setEntry((n) => n + 1)
    wasInView.current = inView
  }, [inView, reduced])

  const state: ReceiptAssemblyState | undefined = reduced ? undefined : { entry }

  return (
    <div ref={ref} data-testid="refusal-receipt">
      <RefusalReceipt state={state} />
    </div>
  )
}
