'use client'

import { useEffect, useRef, useState } from 'react'

interface UseCountUpOptions {
  /** Animation duration in milliseconds. Default 600ms (Phase B motion guideline). */
  duration?: number
  /**
   * When false the hook returns the target value immediately (no animation).
   * Useful while data is still loading so we don't animate from 0 → 0.
   */
  enabled?: boolean
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
 * Returns a smoothly-animated value that counts up from 0 to `target` on the
 * first time the hook becomes enabled. Subsequent changes to `target` snap
 * instantly (no re-animation on every render or currency switch).
 *
 * Usage:
 *   const animated = useCountUp(totalFiat, { enabled: !loading })
 *   <p className="v2-tabular">{formatCurrency(animated, currency)}</p>
 *
 * Respects prefers-reduced-motion: when set, returns the target immediately.
 */
export function useCountUp(target: number, options: UseCountUpOptions = {}): number {
  const { duration = 600, enabled = true } = options
  const [value, setValue] = useState(() => (enabled && !prefersReducedMotion() ? 0 : target))
  const hasAnimatedRef = useRef(false)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    // Subsequent updates after the first animation: snap to the new target
    // without re-animating. Currency switches, refreshes, polled updates etc.
    if (hasAnimatedRef.current) {
      setValue(target)
      return
    }

    // Reduced-motion users: skip the animation entirely.
    if (prefersReducedMotion()) {
      hasAnimatedRef.current = true
      setValue(target)
      return
    }

    // Not enabled yet (e.g. still loading) — leave at 0, wait.
    if (!enabled) return

    // Skip the animation if the target is effectively 0 — animating 0 → 0
    // doesn't add anything.
    if (!Number.isFinite(target) || target === 0) {
      hasAnimatedRef.current = true
      setValue(target)
      return
    }

    hasAnimatedRef.current = true
    const start = performance.now()
    const from = 0
    const to = target

    const tick = (now: number) => {
      const elapsed = now - start
      const t = Math.min(elapsed / duration, 1)
      const next = from + (to - from) * easeOutCubic(t)
      setValue(next)
      if (t < 1) {
        frameRef.current = window.requestAnimationFrame(tick)
      }
    }
    frameRef.current = window.requestAnimationFrame(tick)

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [target, duration, enabled])

  return value
}

export default useCountUp
