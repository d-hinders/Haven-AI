'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ACCOUNTING_CYCLE_MS,
  HERO_BUDGET_CAP,
  HERO_CYCLE_MS,
  HERO_PAYMENT,
  HERO_TWEEN_MS,
  HOW_CYCLE_MS,
  RECEIPT_ROW_STAGGER_MS,
} from './motion-timings'

/** Re-exported for the client controllers; server code imports the timings
 *  module directly (a server component cannot import from a `'use client'`
 *  module). */
export {
  ACCOUNTING_CYCLE_MS,
  HERO_BUDGET_CAP,
  HERO_CYCLE_MS,
  HERO_PAYMENT,
  HERO_TWEEN_MS,
  HOW_CYCLE_MS,
  RECEIPT_ROW_STAGGER_MS,
}

/**
 * The mockup's cycle engine, as React hooks (#3575, epic #3572).
 *
 * The mockup drives its loops with `loop(el, cycleMs, steps, reset)` —
 * `docs/product/site-mockup/index.html:257-265` — a timer script gated by
 * `prefers-reduced-motion` and an IntersectionObserver. This module is that
 * script re-derived for the page: the same offsets, the same gating, the
 * same cycle shape, expressed as hooks a client component can drive. The
 * cycle lengths and shared offsets live in `motion-timings.ts` (importable
 * from server components too); every one cites the mockup line it mirrors.
 */

/**
 * True when the user asks for reduced motion, tracked live (the mockup reads
 * the media query once at script start, `index.html:256`; we keep the
 * listener so a mid-session flip settles immediately).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduced(mql.matches)
    apply()
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [])

  return reduced
}

/**
 * True while the observed element is inside the viewport — the mockup's
 * IntersectionObserver (`index.html:261-264`), which starts a loop on entry
 * and stops it on exit.
 *
 * Environments without IntersectionObserver (JSDOM, or the same guard the
 * mockup makes at `index.html:256`) report true: a render without a running
 * loop still holds the settled state, which is what reduced motion and the
 * unit tests assert.
 */
export function useInView<T extends Element>(
  threshold = 0.35,
): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting)
      },
      { threshold },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [threshold])

  return { ref, inView }
}

/**
 * True while the page is visible — the second half of the gate. The mockup
 * relies on the browser throttling background tabs; the slice's quality bar
 * asks for the explicit check.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const apply = () => setVisible(document.visibilityState === 'visible')
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => document.removeEventListener('visibilitychange', apply)
  }, [])

  return visible
}

export type CycleStep = { at: number; act: () => void }

/**
 * Run `steps` on a cycle of `cycleMs` — the mockup's `run()`/`reset()` pair
 * (`index.html:258-260`) — while `running` holds. Returns how many steps
 * have fired so far in the current cycle, so a component renders from state
 * and owns no timers of its own.
 *
 * At the cycle boundary the count returns to 0 (the reset) and the next
 * cycle is scheduled in place (the mockup's `at(cycleMs, cycle)`); leaving
 * the element (running → false) cancels everything and resets, exactly like
 * the mockup's `stop()`.
 */
export function useCycle(
  steps: CycleStep[],
  cycleMs: number,
  running: boolean,
  onReset?: () => void,
): { stepIndex: number; cycle: number } {
  const [stepIndex, setStepIndex] = useState(0)
  const [cycle, setCycle] = useState(0)
  const stepsRef = useRef(steps)
  stepsRef.current = steps
  // The reset callback lives in a ref: a boundary and the next cycle's early
  // steps can fire inside ONE advance window (a fake-clock fast-forward, or a
  // real timer backlog), and the reset must land in the same callback batch
  // as the boundary itself — ordered BEFORE any step that follows — never in
  // a later effect flush, which would undo the state that step just set.
  const onResetRef = useRef(onReset)
  onResetRef.current = onReset

  useEffect(() => {
    if (!running) {
      setStepIndex(0)
      setCycle(0)
      // Leaving the region stops the loop and resets it, as the mockup's
      // `stop()` does (`index.html:260`).
      onResetRef.current?.()
      return
    }

    let cancelled = false
    let generation = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const schedule = (ms: number, fn: () => void, thisGeneration: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (cancelled || thisGeneration !== generation) return
        fn()
      }, ms)
      timers.add(timer)
    }

    const runCycle = () => {
      if (cancelled) return
      generation += 1
      const thisGeneration = generation
      setCycle(thisGeneration)
      for (const step of stepsRef.current) {
        schedule(step.at, () => {
          setStepIndex((n) => n + 1)
          step.act()
        }, thisGeneration)
      }
      schedule(cycleMs, () => {
        // The mockup's reset at the cycle boundary (:259's `reset()`), in
        // the boundary's own callback batch.
        setStepIndex(0)
        onResetRef.current?.()
        runCycle()
      }, thisGeneration)
    }

    runCycle()
    return () => {
      cancelled = true
      generation += 1
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      // Unmount stops the loop and resets it, exactly like leaving view.
      onResetRef.current?.()
    }
  }, [running, cycleMs])

  return { stepIndex, cycle }
}

/**
 * The mockup's typing step (`index.html:280`): `text` typed one character
 * per 95 ms while `run` holds; empty string before the first keystroke.
 */
export function useTyping(text: string, run: boolean): { typed: string; done: boolean } {
  const [typed, setTyped] = useState('')
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    if (!run) {
      setTyped('')
      return
    }

    let cancelled = false
    let i = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = () => {
      if (cancelled) return
      if (i < textRef.current.length) {
        i += 1
        setTyped(textRef.current.slice(0, i))
        timer = setTimeout(tick, 95)
      }
    }
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [run])

  return { typed, done: typed.length >= text.length && text.length > 0 }
}

/**
 * The mockup's tween (`index.html:98-102`), as the live value: `from` →
 * `to` over `ms` with the same cubic ease-out.
 *
 * Driven by a `setTimeout` chain counting 16 ms ticks instead of
 * `performance.now()` or `requestAnimationFrame`, deliberately: the value
 * must advance under BOTH fake clocks the quality bars run on — vitest's
 * fake timers and Playwright's `page.clock` — and both virtualize timers
 * while neither guarantees rAF or the monotonic clock moves on demand. The
 * tick count is the elapsed time, so fast-forwarding either clock advances
 * the tween deterministically and the last tick lands exactly on `to`.
 */
const TWEEN_TICK_MS = 16

export function useTween(from: number, to: number, ms: number, run: boolean): number {
  const [value, setValue] = useState(from)

  useEffect(() => {
    if (!run) {
      setValue(from)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let elapsed = 0

    const tick = () => {
      if (cancelled) return
      elapsed += TWEEN_TICK_MS
      const k = Math.min(1, elapsed / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      setValue(from + (to - from) * eased)
      if (k < 1) timer = setTimeout(tick, TWEEN_TICK_MS)
    }
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [run, from, to, ms])

  return value
}
