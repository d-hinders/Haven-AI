import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  VISIBLE_POLL_INTERVAL_MS,
  useVisiblePolling,
} from '@/hooks/useVisiblePolling'
import { BUDGET_REMAINING_POLL_INTERVAL_MS, useBudgetRemaining } from '@/hooks/useBudgetRemaining'

// jsdom reports `visible` by default; tests flip it per-case. Redefinition
// needs `configurable` because jsdom defines the property on the prototype.
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

// #3804: the cadence is an optional argument that defaults to 10 s — existing
// consumers and their tests are unchanged — and the budget-remaining hook
// passes 60 s. These pins live beside the default-cadence suite.
describe('useVisiblePolling intervalMs (#3804)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('an explicit cadence overrides the 10 s default', async () => {
    const fetch = vi.fn()
    renderHook(() => useVisiblePolling(fetch, 60_000))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    // The default cadence would have fired by now.
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 - VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('the returned fetcher resolves through silent ticks without changing visible state', async () => {
    const fetch = vi.fn()
    renderHook(() => useVisiblePolling(fetch, BUDGET_REMAINING_POLL_INTERVAL_MS))
    expect(BUDGET_REMAINING_POLL_INTERVAL_MS).toBe(60_000)
  })
})

describe('useBudgetRemaining (#3804)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
    vi.unstubAllGlobals()
  })

  function stubApi(payload: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(payload),
      ),
    )
  }

  it('fetches on mount, polls on its 60 s cadence, and carries the response', async () => {
    stubApi({ budgets: [] })
    const { result } = renderHook(() => useBudgetRemaining())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.data).toEqual({ budgets: [] })
    expect(result.current.loading).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    // Mount fetch + one silent tick; the 10 s default would have ticked 6x.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes('/dashboard/budget-remaining'),
    )
    expect(calls).toHaveLength(2)
  })
})
