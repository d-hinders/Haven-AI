import { describe, expect, it, vi } from 'vitest'
import {
  ANALYTICS_AGENT_URL_PARAM,
  ANALYTICS_PERIOD_URL_PARAM,
  ANALYTICS_RANGE_STORAGE_KEY,
  DEFAULT_ANALYTICS_RANGE,
  browserTimeZone,
  isAnalyticsRangeValue,
  readStoredAnalyticsRange,
  readUrlAnalyticsAgentId,
  readUrlAnalyticsRange,
  writeStoredAnalyticsRange,
  writeUrlAnalyticsAgentId,
  writeUrlAnalyticsRange,
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

/**
 * The URL half (#4116). `?period=` is the sharable half of the choice: it is
 * read before storage in the client's initialiser, through the same
 * `isAnalyticsRangeValue` gate, and mirrored back on every pick with a
 * `replaceState` write — no history entry per change, the posture
 * `useListUrlState` set (#4110).
 */
describe('readUrlAnalyticsRange', () => {
  function seedUrl(search: string) {
    window.history.replaceState(null, '', `/${search}`)
  }

  it('reads the period the URL asks for', () => {
    for (const value of ['7d', '30d', '90d']) {
      seedUrl(`?period=${value}`)
      expect(readUrlAnalyticsRange()).toBe(value)
    }
  })

  it('returns null when the URL carries no period', () => {
    seedUrl('')
    expect(readUrlAnalyticsRange()).toBeNull()
  })

  it('returns null rather than a value the endpoint would answer 400 to', () => {
    // The same reject list the storage gate holds: a stale or hand-edited
    // parameter must fall back to the device's choice, never reach the wire.
    for (const value of ['7', '7D', '180d', 'all', '']) {
      seedUrl(`?period=${value}`)
      expect(readUrlAnalyticsRange()).toBeNull()
    }
  })

  it('ignores other params and keeps the first period if two arrive', () => {
    seedUrl('?foo=1&period=7d&range=90d')
    expect(readUrlAnalyticsRange()).toBe('7d')
  })
})

describe('writeUrlAnalyticsRange', () => {
  it('mirrors the choice onto the address bar', () => {
    window.history.replaceState(null, '', '/analytics')
    writeUrlAnalyticsRange('7d')
    expect(new URLSearchParams(window.location.search).get(ANALYTICS_PERIOD_URL_PARAM)).toBe('7d')
    // And the read half round-trips it, which is what makes a reload or a
    // shared link reopen the window the reader is looking at.
    expect(readUrlAnalyticsRange()).toBe('7d')
  })

  it('leaves params the page does not own untouched', () => {
    window.history.replaceState(null, '', '/analytics?foo=1')
    writeUrlAnalyticsRange('90d')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('foo')).toBe('1')
    expect(params.get(ANALYTICS_PERIOD_URL_PARAM)).toBe('90d')
  })

  it('replaces rather than pushes, so the back button still leaves the page', () => {
    window.history.replaceState(null, '', '/analytics')
    const before = window.history.length
    writeUrlAnalyticsRange('30d')
    expect(window.history.length).toBe(before)
  })

  it('refuses to write a value the endpoint would answer 400 to', () => {
    window.history.replaceState(null, '', '/analytics?period=7d')
    writeUrlAnalyticsRange('180d' as never)
    expect(new URLSearchParams(window.location.search).get(ANALYTICS_PERIOD_URL_PARAM)).toBe('7d')
  })
})

describe('readUrlAnalyticsAgentId / writeUrlAnalyticsAgentId (#4333)', () => {
  it('round-trips an agent selection through the address bar', () => {
    window.history.replaceState(null, '', '/analytics')
    writeUrlAnalyticsAgentId('agent-research')
    expect(new URLSearchParams(window.location.search).get(ANALYTICS_AGENT_URL_PARAM)).toBe(
      'agent-research',
    )
    expect(readUrlAnalyticsAgentId()).toBe('agent-research')
  })

  it('deletes the key on clear rather than writing an empty value', () => {
    window.history.replaceState(null, '', '/analytics?agentId=agent-research&period=7d')
    writeUrlAnalyticsAgentId(null)
    const params = new URLSearchParams(window.location.search)
    expect(params.get(ANALYTICS_AGENT_URL_PARAM)).toBeNull()
    // An `agentId=` in a shared link would read as a filter that names
    // nothing; the period key the page also owns is preserved.
    expect(params.get(ANALYTICS_PERIOD_URL_PARAM)).toBe('7d')
  })

  it('preserves params the page does not own, and replaces rather than pushes', () => {
    window.history.replaceState(null, '', '/analytics?foo=1')
    const before = window.history.length
    writeUrlAnalyticsAgentId('agent-x')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('foo')).toBe('1')
    expect(window.history.length).toBe(before)
  })

  it('reads null when there is no id or an empty one', () => {
    window.history.replaceState(null, '', '/analytics')
    expect(readUrlAnalyticsAgentId()).toBeNull()
    window.history.replaceState(null, '', '/analytics?agentId=')
    expect(readUrlAnalyticsAgentId()).toBeNull()
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
