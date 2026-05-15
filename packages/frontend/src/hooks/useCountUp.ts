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
 * Returns a smoothly-animated value that counts up to `target`.
 *
 * Two scenarios trigger the count-up:
 *  1. First paint after the hook becomes enabled with a positive target
 *     (the usual case — dashboard mounts, balance arrives).
 *  2. A 0 → positive transition after first paint (the milestone case —
 *     a brand-new user funds their account and the balance flips from 0).
 *
 * Other updates (currency switches, polled refreshes of an already-positive
 * balance) snap to the new value without animating.
 *
 * Respects prefers-reduced-motion: when set, returns the target immediately.
 */
export function useCountUp(target: number, options: UseCountUpOptions = {}): number {
  const { duration = 600, enabled = true } = options
  const [value, setValue] = useState(() => (enabled && !prefersReducedMotion() ? 0 : target))
  const hasAnimatedRef = useRef(false)
  const previousTargetRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const previousTarget = previousTargetRef.current
    previousTargetRef.current = target

    // Reduced-motion users: skip the animation entirely.
    if (prefersReducedMotion()) {
      hasAnimatedRef.current = true
      setValue(target)
      return
    }

    // Not enabled yet (e.g. still loading) — leave at 0, wait.
    if (!enabled) return

    // First-paint case: target is 0 (or not finite). Skip animation; nothing
    // to animate to. Stay open for the milestone case below if the target
    // later goes positive.
    if (!Number.isFinite(target) || target === 0) {
      setValue(target)
      // Do NOT flip hasAnimatedRef here — we still want to animate the first
      // positive value if it arrives later (the milestone).
      return
    }

    // Snap for boring updates: already animated once AND the previous target
    // was already positive (currency switch, poll refresh).
    if (
      hasAnimatedRef.current &&
      previousTarget !== null &&
      previousTarget > 0
    ) {
      setValue(target)
      return
    }

    // Otherwise: animate from 0 → target. Covers first-paint with a positive
    // target AND the 0 → first-funded milestone.
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
