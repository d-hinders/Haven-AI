'use client'

import { useEffect, useRef, useState } from 'react'
import { hasEntered, markEntered } from '@/lib/entry-latch'

interface UseCountUpOptions {
  /** Animation duration in milliseconds. Default 600ms (Phase B motion guideline). */
  duration?: number
  /**
   * When false the hook returns the target value immediately (no animation),
   * and makes no decision yet. Used while data is still loading, so the
   * entrance is decided on the first REAL balance, not on a placeholder 0.
   */
  enabled?: boolean
  /**
   * The signed-in user the entry latch is keyed on. With no user there is no
   * entrance to have, and the value snaps.
   */
  userId?: string | null
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

// Ease-out cubic — calm landing, no bounce. Matches the "subtle, not flashy"
// motion guideline.
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * - `pending` — not enabled yet; nothing decided, the target is returned.
 * - `animate` — this tab's entrance, with a positive balance: count up once.
 * - `consume` — this tab's entrance, but nothing to count (zero, not finite,
 *   or reduced motion): the entrance is used up and the value snaps.
 * - `snap` — the entrance already happened (or cannot happen): snap.
 */
type Decision = 'pending' | 'animate' | 'consume' | 'snap'

function decide(target: number, userId: string | null | undefined): Decision {
  if (!userId || typeof window === 'undefined') return 'snap'
  if (hasEntered('count-up', userId)) return 'snap'
  if (prefersReducedMotion() || !Number.isFinite(target) || target <= 0) return 'consume'
  return 'animate'
}

/**
 * The balance count-up, entrance only (#4704; owner decision 3 on #4701).
 *
 * It counts up the first time the balance appears after Haven opens in a tab
 * or is launched on a phone, and after signing out and back in. A reload, a
 * return from another page and a balance that changes while the page is open
 * all show the number straight away. The "has this tab had its entrance?"
 * question is the entry latch (`lib/entry-latch.ts`, key `count-up`), per tab
 * and per user in `sessionStorage`.
 *
 * Until #4704 the hook ALSO counted on every first paint and on a 0 → positive
 * flip ("the milestone case"). That trigger is gone: a balance that first
 * resolves to zero consumes the entrance, so funding later snaps, and the
 * first-money moment belongs to #4705's Receive Peak.
 *
 * **The final number is returned at render time, never through state.** The
 * decision is made during the first enabled render, so a snapping balance is
 * the target on that very render: no frame of 0 before an effect runs, and
 * reduced motion is correct from the first enabled render. Only a counting
 * balance returns its in-flight frame, starting at 0.
 *
 * A balance that changes while it is counting stops the count and shows the
 * new number: a poll never restarts the entrance.
 */
export function useCountUp(target: number, options: UseCountUpOptions = {}): number {
  const { duration = 600, enabled = true, userId = null } = options
  const decisionRef = useRef<Decision>('pending')
  // Decided during render so the first enabled render already knows whether
  // it counts (see "The final number is returned at render time" above). The
  // read is idempotent, so a StrictMode double render decides the same way.
  if (decisionRef.current === 'pending' && enabled) {
    decisionRef.current = decide(target, userId)
  }
  const decision = decisionRef.current

  const [frame, setFrame] = useState(0)
  const [done, setDone] = useState(false)
  const countTargetRef = useRef<number | null>(null)
  if (decision === 'animate' && countTargetRef.current === null) {
    countTargetRef.current = target
  }

  // Mark the entrance once it has been used (counted or consumed).
  useEffect(() => {
    if ((decision === 'animate' || decision === 'consume') && userId) {
      markEntered('count-up', userId)
    }
  }, [decision, userId])

  // Sticky: once the balance moved mid-count, the count is over for good, even
  // if a later poll returns the original figure.
  const interruptedRef = useRef(false)
  if (decision === 'animate' && target !== countTargetRef.current) interruptedRef.current = true
  const counting = decision === 'animate' && !done && !interruptedRef.current

  useEffect(() => {
    if (!counting) return
    const to = countTargetRef.current ?? target
    const start = performance.now()
    let raf = window.requestAnimationFrame(function tick(now: number) {
      const t = Math.min((now - start) / duration, 1)
      setFrame(to * easeOutCubic(t))
      if (t < 1) raf = window.requestAnimationFrame(tick)
      else setDone(true)
    })
    return () => window.cancelAnimationFrame(raf)
    // `target` is read through the ref: a change interrupts (above) rather
    // than restarting the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counting, duration])

  return counting ? frame : target
}

export default useCountUp
