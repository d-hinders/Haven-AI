import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  VISIBLE_POLL_INTERVAL_MS,
  useVisiblePolling,
} from '@/hooks/useVisiblePolling'

// jsdom reports `visible` by default; tests flip it per-case. Redefinition
// needs `configurable` because jsdom defines the property on the prototype.
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event('visibilitychange'))
}

function fireFocus() {
  window.dispatchEvent(new Event('focus'))
}

describe('useVisiblePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('does not fetch on mount and polls at the cadence while visible', async () => {
    const fetch = vi.fn()
    renderHook(() => useVisiblePolling(fetch))

    expect(fetch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS - 1)
    })
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('zero fetches while hidden for 60s', async () => {
    setVisibility('hidden')
    const fetch = vi.fn()
    renderHook(() => useVisiblePolling(fetch))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetch).not.toHaveBeenCalled()

    // Going hidden after being visible also stops the cadence mid-cycle.
    setVisibility('visible')
    renderHook(() => useVisiblePolling(fetch))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    setVisibility('hidden')
    fireVisibilityChange()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000)
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fires exactly ONE immediate fetch when visibilitychange and focus both fire on a visible flip, then resumes the cadence', async () => {
    const fetch = vi.fn()
    renderHook(() => useVisiblePolling(fetch))

    setVisibility('hidden')
    fireVisibilityChange()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS * 3)
    })
    expect(fetch).not.toHaveBeenCalled()

    // The demo flip: both events, one fetch.
    setVisibility('visible')
    await act(async () => {
      fireVisibilityChange()
      fireFocus()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    // Cadence resumed from the flip, not from the old hidden schedule.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS - 1)
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('still fetches exactly once when the first event fetch resolves before focus fires', async () => {
    const fetch = vi.fn().mockResolvedValue(undefined)
    renderHook(() => useVisiblePolling(fetch))

    setVisibility('hidden')
    fireVisibilityChange()
    setVisibility('visible')
    await act(async () => {
      fireVisibilityChange()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireFocus()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('skips overlapping ticks without queuing them, and the cadence survives a fetch slower than the interval', async () => {
    let resolveFetch!: () => void
    const fetch = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveFetch = resolve }),
    )
    renderHook(() => useVisiblePolling(fetch))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    // A fetch still in flight at the next tick: skipped, not queued.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch()
      await Promise.resolve()
    })

    // The cadence is alive after the slow fetch — the skip did not kill it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('unmount clears the timer and every listener', async () => {
    const fetch = vi.fn()
    const { unmount } = renderHook(() => useVisiblePolling(fetch))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS * 10)
    })
    fireVisibilityChange()
    fireFocus()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS * 10)
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an immediate fetch on return-to-visible works when the hook mounted hidden', async () => {
    setVisibility('hidden')
    const fetch = vi.fn()
    renderHook(() => useVisiblePolling(fetch))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(fetch).not.toHaveBeenCalled()

    setVisibility('visible')
    await act(async () => {
      fireVisibilityChange()
      fireFocus()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    // Cadence starts from the flip.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISIBLE_POLL_INTERVAL_MS)
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
