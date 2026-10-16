'use client'

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

/** The body-height transition between sub-states, in ms. */
const HEIGHT_TRANSITION_MS = 200

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * #1377 C: the one persistent frame for everything after the setup prompt
 * exists. Step 3 used to swap between structurally unrelated bodies exactly
 * when the user was looking for reassurance; this shell keeps one frame while
 * the sub-states swap IN PLACE inside it.
 *
 * The frame sizes to its content and top-aligns it. It used to reserve a
 * 340px floor and centre short sub-states in it, which left wide empty bands
 * above and below "Finishing local setup" (owner review, 2026-10-16). #1377's
 * no-jump intent is kept by motion instead of by a floor: when `stateKey`
 * changes, the frame animates from the old content height to the new one, so
 * the dialog eases to its new size rather than snapping. Under
 * `prefers-reduced-motion: reduce` it resizes at once. Growth inside one
 * sub-state (a disclosure opening) is not animated: that is the user's own
 * action, and the content flows as normal.
 *
 * Progress lives in two places with two jobs: the modal's header StepProgress
 * counts the wizard steps (Connect active here), and the connect step's
 * status checklist (`ConnectSteps`: copy → paste → approve) reports progress
 * within this step. The shell adds neither — #3832 removed its old
 * Waiting → Connected → Approved ticker. Terminal states (expired, cancelled,
 * failed, not found) render no checklist: their body explains.
 *
 * The body is keyed by `stateKey`, so it remounts — and plays the entry
 * transition — on every sub-state change, the checklist included. That is
 * deliberate: a sub-state change is the screen moving forward (a row ticks,
 * the next one opens), which happens at most a few times per setup, and the
 * rise reads as that motion.
 */
export function ConnectStepShell({
  stateKey,
  children,
}: {
  /** Changes when the sub-state changes — re-triggers the entry transition. */
  stateKey: string
  children: ReactNode
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // The content height the frame last settled at — the "from" of the next
  // sub-state change. Kept current between changes, so growth within a
  // sub-state (an opened disclosure) is the height the next change starts at.
  const settledHeight = useRef<number | null>(null)

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // Mid-transition the frame carries an inline height; the layout effect
      // below owns the measurement until it is released.
      if (!frameRef.current?.style.height) settledHeight.current = content.offsetHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Layout effect: it runs after the new sub-state is in the DOM and before
  // paint, so the frame can be pinned at the OLD height without a flash of
  // the new one.
  useLayoutEffect(() => {
    const frame = frameRef.current
    const content = contentRef.current
    if (!frame || !content) return
    const from = settledHeight.current
    const to = content.offsetHeight
    settledHeight.current = to
    if (from === null || from === to || prefersReducedMotion()) return

    frame.style.overflow = 'hidden'
    frame.style.height = `${from}px`
    // Commit the start height before setting the target, or no transition runs.
    void frame.offsetHeight
    frame.style.transition = `height ${HEIGHT_TRANSITION_MS}ms ease-out`
    frame.style.height = `${to}px`

    const release = () => {
      frame.style.height = ''
      frame.style.overflow = ''
      frame.style.transition = ''
    }
    // Only the frame's own height transition ends the pin: transitions on
    // controls inside the body (hover colours) bubble here too.
    const onEnd = (event: TransitionEvent) => {
      if (event.target === frame && event.propertyName === 'height') release()
    }
    frame.addEventListener('transitionend', onEnd)
    // Backstop: a transition that never ends (the tab is hidden) must not
    // leave the frame clipped at a fixed height.
    const timer = window.setTimeout(release, HEIGHT_TRANSITION_MS + 100)
    return () => {
      window.clearTimeout(timer)
      frame.removeEventListener('transitionend', onEnd)
      release()
    }
  }, [stateKey])

  return (
    <div ref={frameRef}>
      <div ref={contentRef}>
        {/* #1392: the body is a flex column with ONE 20px rhythm (gap-5) —
            the spacing the pre-#1380 `space-y-5` wrapper gave fragment
            sub-states, restored at the source so no sub-state needs its own
            wrapper. Top-aligned: the content starts under the header. */}
        <div key={stateKey} className="v2-animate-step-rise flex flex-col gap-5">
          {children}
        </div>
      </div>
    </div>
  )
}
