import { describe, expect, it, vi } from 'vitest'
import {
  ANALYTICS_RANGE_STORAGE_KEY,
  DEFAULT_ANALYTICS_RANGE,
  browserTimeZone,
  isAnalyticsRangeValue,
  readStoredAnalyticsRange,
  writeStoredAnalyticsRange,
} from '../analytics-range'

/**
 * The Analytics range control's storage half (#2947, slice C).
 *
 * The behaviour that matters here is not the reading, it is WHAT the reading
 * is FOR: the value is read inside the `useState` initialiser so that the
 * FIRST `GET /analytics/overview` carries the reader's chosen window. An
 * effect-based read would fire a second request on every mount of a device
 * that chose 7d or 90d, and flash the wrong window in between — the same
 * reasoning that put `haven.theme` in a <head> script (#2927). These tests
 * therefore pin the read as a synchronous function of a seeded store, which is
 * exactly how the client calls it.
 */

function seed(value: string | null) {
  if (value === null) window.localStorage.removeItem(ANALYTICS_RANGE_STORAGE_KEY)
  else window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, value)
}

describe('isAnalyticsRangeValue', () => {
  it('accepts exactly the three windows the endpoint documents', () => {
    for (const value of ['7d', '30d', '90d']) {
      expect(isAnalyticsRangeValue(value)).toBe(true)
    }
  })

  it('rejects every other string, including near-misses of the enum', () => {
    // The server answers 400 to anything outside the enum, so a value that
    // reaches it through trust would put the WHOLE page into its error state
    // because of one bad string in localStorage. The reject side is the
    // expensive one, which is why it gets the long list.
    for (const value of ['', '7', '7D', '30D', '90 days', '180d', 'null', 'undefined']) {
      expect(isAnalyticsRangeValue(value)).toBe(false)
    }
    for (const value of [null, undefined, 0, 30, true, {}, [], ['7d']]) {
      expect(isAnalyticsRangeValue(value)).toBe(false)
    }
  })
})

describe('readStoredAnalyticsRange', () => {
  it('returns the stored window when it is still a value the endpoint accepts', () => {
    for (const value of ['7d', '30d', '90d']) {
      seed(value)
      expect(readStoredAnalyticsRange()).toBe(value)
    }
  })

  it('returns the default when the device has never chosen', () => {
    seed(null)
    expect(readStoredAnalyticsRange()).toBe(DEFAULT_ANALYTICS_RANGE)
    expect(DEFAULT_ANALYTICS_RANGE).toBe('30d')
  })

  it('returns the default rather than a corrupt stored value', () => {
    // Includes the shape a stale key from a future build leaves behind: an
    // enum member this build does not know. Trusting it would be a guaranteed
    // 400 and a page of error copy.
    for (const value of ['7', '7D', '180d', '', ' 30d ']) {
      seed(value)
      expect(readStoredAnalyticsRange()).toBe(DEFAULT_ANALYTICS_RANGE)
    }
  })

  it('returns the default when storage itself throws', () => {
    // Private mode and a blocked store throw on the GETTER call inside the
    // try, and this runs during the render. A throw here would take the page
    // down, so the fallback is the only acceptable outcome.
    const original = window.localStorage.getItem
    window.localStorage.getItem = vi.fn(() => {
      throw new Error('blocked')
    }) as typeof window.localStorage.getItem
    try {
      expect(readStoredAnalyticsRange()).toBe(DEFAULT_ANALYTICS_RANGE)
    } finally {
      window.localStorage.getItem = original
    }
  })
})

describe('writeStoredAnalyticsRange', () => {
  it('remembers a valid choice for this device', () => {
    writeStoredAnalyticsRange('7d')
    expect(window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY)).toBe('7d')
    // And the round trip is exact, which is what makes the next mount's first
    // request carry the same window.
    expect(readStoredAnalyticsRange()).toBe('7d')
  })

  it('refuses to write a value the endpoint would answer 400 to', () => {
    seed('30d')
    // A cast is deliberate: the type forbids it, and the guard is what is
    // under test. A second caller that lost the types must not be able to
    // poison the key the next mount trusts.
    writeStoredAnalyticsRange('180d' as never)
    expect(window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY)).toBe('30d')
  })

  it('survives a store that throws on write, which is the visit that must not break', () => {
    // The selection is already in React state and already on screen; losing
    // persistence is a degraded preference, not a broken screen. Without the
    // try/catch the click that changes the range would throw mid-render.
    const original = window.localStorage.setItem
    window.localStorage.setItem = vi.fn(() => {
      throw new Error('quota exceeded')
    }) as typeof window.localStorage.setItem
    try {
      expect(() => writeStoredAnalyticsRange('90d')).not.toThrow()
    } finally {
      window.localStorage.setItem = original
    }
  })
})

describe('browserTimeZone', () => {
  it('names a zone the server can bucket by, or none at all', () => {
    // The spec rejects offsets and abbreviations, so the only legal wire
    // value is an IANA name. `UTC` is deliberately NOT returned as 'UTC' by
    // this function's own rule when it is all Intl can offer: the server's
    // documented default takes over instead, which is honest, whereas a
    // 'UTC' here would claim a zone the reader may not live in.
    const zone = browserTimeZone()
    expect(zone === undefined || /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/.test(zone)).toBe(true)
    expect(zone).not.toBe('UTC')
  })

  it('is the value the hook puts on the wire, so the two cannot disagree', () => {
    // `useAnalyticsOverview` imports this same function; pinning the pair
    // here means a change to the rule above lands on both surfaces at once.
    const zone = browserTimeZone()
    const params = new URLSearchParams({ range: '30d', currency: 'usd' })
    if (zone !== undefined) params.set('tz', zone)
    expect(params.get('tz')).toBe(zone ?? null)
  })

  it('gives up cleanly to the server default when Intl cannot name a zone', () => {
    // A headless or exotic runtime whose Intl hands back a throw or an empty
    // zone must produce `undefined`, so the endpoint's documented default
    // takes over, rather than a guess reaching the wire.
    const Original = globalThis.Intl.DateTimeFormat
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Intl.DateTimeFormat = function Broken() {
      throw new Error('no icu')
    }
    try {
      expect(browserTimeZone()).toBeUndefined()
    } finally {
      // Restore it at the end, and every time: the whole suite shares Intl.
      // The restore is proven BY IDENTITY against the constructor captured
      // above, never by calling `browserTimeZone()` again: that call would
      // assert what the HOST resolves, and CI runners resolve `UTC`, which
      // analytics-range.ts deliberately maps to `undefined`. What the old line
      // was meant to show — that the function still reads through the
      // collaborator we swapped — is asserted against a pinned zone instead
      // of the environment, so no assertion in this file depends on where the
      // suite runs (#2947, CI-UTC red at 68d11b06).
      ;(globalThis as any).Intl.DateTimeFormat = Original
      expect((globalThis as any).Intl.DateTimeFormat).toBe(Original)
      ;(globalThis as any).Intl.DateTimeFormat = class Stub {
        resolvedOptions() {
          return { timeZone: 'Europe/Stockholm' }
        }
      }
      expect(browserTimeZone()).toBe('Europe/Stockholm')
      ;(globalThis as any).Intl.DateTimeFormat = Original
    }
  })
})
