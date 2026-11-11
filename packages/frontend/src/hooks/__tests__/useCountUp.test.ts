import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCountUp } from '@/hooks/useCountUp'
import { clearEntryLatches, hasEntered, markEntered } from '@/lib/entry-latch'

/**
 * #4704: the balance count-up is entrance only — owner decision 3 on #4701.
 * One case per row of the decision's table, plus the two rules the slice
 * adds: a zero first balance consumes the entrance, and a snapping balance
 * never renders 0 on any render.
 *
 * The global stub in `__tests__/setup.ts` answers `prefers-reduced-motion:
 * reduce`; every case here sets the answer it needs.
 */

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

// A hand-driven animation clock: frames run only when the test says so.
let now = 0
let queued: Array<(t: number) => void> = []
function runFrames(ms: number) {
  const steps = Math.ceil(ms / 16)
  for (let i = 0; i < steps; i++) {
    now += 16
    const callbacks = queued
    queued = []
    act(() => {
      for (const cb of callbacks) cb(now)
    })
  }
}

const USER = 'user-1'

beforeEach(() => {
  setReducedMotion(false)
  window.sessionStorage.clear()
  now = 0
  queued = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    queued.push(cb)
    return queued.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  setReducedMotion(true)
  window.sessionStorage.clear()
})

type Props = { target: number; enabled: boolean; userId: string | null }
function mount(initial: Props) {
  const seen: number[] = []
  const hook = renderHook(
    ({ target, enabled, userId }: Props) => {
      const value = useCountUp(target, { enabled, userId })
      seen.push(value)
      return value
    },
    { initialProps: initial },
  )
  return { ...hook, seen }
}

describe('useCountUp — entrance only (#4704, decision 3 on #4701)', () => {
  it('opening Haven in a new tab counts up from 0 to the balance, once', () => {
    const { result, seen } = mount({ target: 25, enabled: true, userId: USER })
    expect(result.current).toBe(0)
    runFrames(320)
    expect(result.current).toBeGreaterThan(0)
    expect(result.current).toBeLessThan(25)
    runFrames(400)
    expect(result.current).toBe(25)
    expect(hasEntered('count-up', USER)).toBe(true)
    // Counted up: values rose through the middle, never past the target.
    expect(seen.some((v) => v > 0 && v < 25)).toBe(true)
    expect(Math.max(...seen)).toBe(25)
  })

  it('signing out and back in counts up again (sign-out clears the latch)', () => {
    markEntered('count-up', USER)
    clearEntryLatches()
    const { result } = mount({ target: 25, enabled: true, userId: USER })
    expect(result.current).toBe(0)
    runFrames(700)
    expect(result.current).toBe(25)
  })

  it('returning to the dashboard from another page shows the balance straight away', () => {
    // The first visit in this tab played the entrance.
    const first = mount({ target: 25, enabled: true, userId: USER })
    runFrames(700)
    first.unmount()
    // Back on the dashboard: a fresh mount, same tab.
    const { seen } = mount({ target: 25, enabled: true, userId: USER })
    expect(seen).not.toContain(0)
    expect(seen.every((v) => v === 25)).toBe(true)
  })

  it('reloading the page shows the balance straight away (the latch survives in sessionStorage)', () => {
    markEntered('count-up', USER)
    const { seen } = mount({ target: 25, enabled: true, userId: USER })
    runFrames(700)
    expect(seen.every((v) => v === 25)).toBe(true)
  })

  it('a balance update while the page is open shows straight away', () => {
    const { result, rerender, seen } = mount({ target: 25, enabled: true, userId: USER })
    runFrames(700)
    expect(result.current).toBe(25)
    const before = seen.length
    rerender({ target: 40, enabled: true, userId: USER })
    runFrames(700)
    expect(seen.slice(before).every((v) => v === 40)).toBe(true)
  })

  it('a balance that changes mid-count stops the count and shows the new figure', () => {
    const { result, rerender } = mount({ target: 25, enabled: true, userId: USER })
    runFrames(160)
    rerender({ target: 40, enabled: true, userId: USER })
    expect(result.current).toBe(40)
    runFrames(700)
    expect(result.current).toBe(40)
    // Sticky: the original figure coming back does not restart the count.
    rerender({ target: 25, enabled: true, userId: USER })
    expect(result.current).toBe(25)
  })

  it('a balance that first resolves to zero consumes the entrance, so funding later snaps', () => {
    const { rerender, seen } = mount({ target: 0, enabled: true, userId: USER })
    expect(hasEntered('count-up', USER)).toBe(true)
    const before = seen.length
    rerender({ target: 25, enabled: true, userId: USER })
    runFrames(700)
    expect(seen.slice(before).every((v) => v === 25)).toBe(true)
  })

  it('no render of a snapping balance shows 0 — the target is returned at render time', () => {
    markEntered('count-up', USER)
    // MoneyPanel mounts loading (enabled=false, target 0) and then receives
    // the balance and enables in one render.
    const { rerender, seen } = mount({ target: 0, enabled: false, userId: USER })
    const before = seen.length
    rerender({ target: 25, enabled: true, userId: USER })
    expect(seen.slice(before)).not.toContain(0)
    expect(seen.slice(before)[0]).toBe(25)
  })

  it('nothing is decided while loading: the entrance waits for the first real balance', () => {
    const { result, rerender } = mount({ target: 0, enabled: false, userId: USER })
    expect(hasEntered('count-up', USER)).toBe(false)
    rerender({ target: 25, enabled: true, userId: USER })
    expect(result.current).toBe(0)
    runFrames(700)
    expect(result.current).toBe(25)
  })

  it('reduced motion shows the final number from the first enabled render, and uses up the entrance', () => {
    setReducedMotion(true)
    const { seen } = mount({ target: 25, enabled: true, userId: USER })
    runFrames(700)
    expect(seen.every((v) => v === 25)).toBe(true)
    expect(hasEntered('count-up', USER)).toBe(true)
  })

  it('with no signed-in user there is no entrance: the number shows straight away', () => {
    const { seen } = mount({ target: 25, enabled: true, userId: null })
    runFrames(700)
    expect(seen.every((v) => v === 25)).toBe(true)
  })
})
