/**
 * `useCompanyDetails` (#3332) directly, with `@/lib/api` mocked — the parts
 * `CompanyDetailsCard.test.tsx` cannot see through the UI because a status
 * transition unmounts the control a second click would need (`renderHook`
 * side-steps that entirely, the same reason `useAgentConnectionSetupStatus`
 * has its own hook-level test file).
 *
 * Covers three #3332 review findings that are load-bearing at the HOOK
 * level, not the component's rendering of them:
 *
 * - B1: a poll tick that sees the row was removed elsewhere (a `null` body)
 *   moves `status` to `'empty'` without ever reading a property of `null`.
 * - M1: the poll's 60s bound sets `pollTimedOut`, stops ticking, and
 *   RESTARTS (a fresh bound, `pollTimedOut` cleared) when `updated_at`
 *   moves while `vies_status` stays `pending` — a re-save landing back on
 *   `pending` must not inherit an already-elapsed bound.
 * - M1 round 2: a poll tick that sees a STALE generation (save/remove
 *   bumped it, but then FAILED so `details` never changed) drops the
 *   response yet keeps the bounded schedule going — reschedules under the
 *   bound, or sets `pollTimedOut` at it — the same branch the catch path
 *   takes, so a failed save/remove never strands the row on "Checking…"
 *   with no way to reach "Check again".
 * - M2: `save`/`remove`/`recheckVies` each bump a shared generation counter
 *   that a poll tick (and `load`) check before applying their own response,
 *   so a slow poll or load in flight can never clobber a newer one —
 *   covered for all three of `save`, `remove`, and `recheckVies`, not just
 *   `save`.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), getText: vi.fn() },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ApiRequestError: actual.ApiRequestError, api: mockApi }
})

import { ApiRequestError } from '@/lib/api'
import {
  useCompanyDetails,
  VIES_POLL_INTERVAL_MS,
  VIES_POLL_MAX_MS,
  type CompanyDetailsRow,
} from '@/hooks/useCompanyDetails'

function row(overrides: Partial<CompanyDetailsRow> = {}): CompanyDetailsRow {
  return {
    legal_name: 'Ada Lovelace AB',
    country: 'SE',
    org_number: '556677-8899',
    vat_number: 'SE556677889901',
    vies_status: 'pending',
    vies_checked_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-20T10:00:00.000Z',
    ...overrides,
  }
}

const SAVE_BODY = {
  legal_name: 'Ada Lovelace AB',
  country: 'SE',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
}

beforeEach(() => {
  mockApi.get.mockReset()
  mockApi.put.mockReset()
  mockApi.post.mockReset()
  mockApi.delete.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCompanyDetails — poll receiving null (B1)', () => {
  it('moves to status "empty" when a poll tick finds the row removed elsewhere, never reading a property of null', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    mockApi.get.mockImplementation(() => Promise.resolve(null))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })
    expect(result.current.status).toBe('empty')
    expect(result.current.details).toBeNull()
  })
})

describe('useCompanyDetails — poll bound and restart (M1)', () => {
  it('sets pollTimedOut once the 60s bound elapses and stops ticking past it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.pollTimedOut).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_MAX_MS + VIES_POLL_INTERVAL_MS)
    })
    expect(result.current.pollTimedOut).toBe(true)
    const callsAtBound = mockApi.get.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS * 3)
    })
    expect(mockApi.get.mock.calls.length).toBe(callsAtBound)
  })

  it('restarts the bound (pollTimedOut clears, a fresh 60s) when updated_at moves while still pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row({ updated_at: '2026-09-20T10:00:00.000Z' })))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    // Elapse most of the bound.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    expect(result.current.pollTimedOut).toBe(false)

    // A re-save lands back on `pending`, with a NEW `updated_at`.
    mockApi.put.mockResolvedValue(row({ updated_at: '2026-09-20T10:05:00.000Z' }))
    await act(async () => {
      await result.current.save(SAVE_BODY)
    })
    expect(result.current.pollTimedOut).toBe(false)

    // 50s more — 100s from the ORIGINAL start, only 50s since the restart.
    // Without the updated_at-keyed restart this would already read timed out.
    mockApi.get.mockImplementation(() => Promise.resolve(row({ updated_at: '2026-09-20T10:05:00.000Z' })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    expect(result.current.pollTimedOut).toBe(false)
  })
})

describe('useCompanyDetails — poll/save generation race (M2)', () => {
  it('discards an in-flight poll response that resolves after save() has started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    // Arm a poll tick that will not resolve until told to.
    let resolvePoll!: (value: CompanyDetailsRow) => void
    const pending = new Promise<CompanyDetailsRow>((resolve) => {
      resolvePoll = resolve
    })
    mockApi.get.mockImplementation(() => pending)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })
    // The poll's GET is now in flight, unresolved.

    // The owner saves a different legal name while that poll is still out.
    // `vies_status`/`updated_at` are DELIBERATELY unchanged by this save (a
    // same-millisecond write is a real, if rare, possibility) so the poll
    // effect's own `[vies_status, updated_at]` dependency array does not
    // change and its `cancelled` closure never fires — isolating the
    // generation counter as the ONLY thing that can discard the stale
    // response landing below. A save that also changed `updated_at` would
    // pass even with the generation check deleted, because the effect
    // cleanup would race-proof it by coincidence instead.
    mockApi.put.mockResolvedValue(row({ legal_name: 'New Name AB' }))
    await act(async () => {
      await result.current.save({ ...SAVE_BODY, legal_name: 'New Name AB' })
    })
    expect(result.current.details?.legal_name).toBe('New Name AB')

    // The stale poll response lands late — it must not clobber the save.
    await act(async () => {
      resolvePoll(row({ legal_name: 'STALE FROM POLL' }))
      await Promise.resolve()
    })
    expect(result.current.details?.legal_name).toBe('New Name AB')
  })

  it('the load generation guard: a stale load response cannot overwrite a newer one', async () => {
    let resolveFirst!: (value: CompanyDetailsRow | null) => void
    const first = new Promise<CompanyDetailsRow | null>((resolve) => {
      resolveFirst = resolve
    })
    let call = 0
    mockApi.get.mockImplementation(() => {
      call += 1
      if (call === 1) return first
      return Promise.resolve(row({ vies_status: null, vies_checked_at: null }))
    })
    const { result } = renderHook(() => useCompanyDetails())
    // The initial load (call 1) is still in flight — start a newer one.
    await act(async () => {
      void result.current.reload()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.details?.legal_name).toBe('Ada Lovelace AB')

    // The first, now-stale, response lands late.
    await act(async () => {
      resolveFirst(row({ legal_name: 'STALE', vies_status: null, vies_checked_at: null }))
      await Promise.resolve()
    })
    expect(result.current.details?.legal_name).toBe('Ada Lovelace AB')
    expect(result.current.status).toBe('ready')
  })

  it('discards an in-flight poll response that resolves after remove() has started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    let resolvePoll!: (value: CompanyDetailsRow) => void
    const pending = new Promise<CompanyDetailsRow>((resolve) => {
      resolvePoll = resolve
    })
    mockApi.get.mockImplementation(() => pending)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })

    mockApi.delete.mockResolvedValue({ ok: true })
    await act(async () => {
      await result.current.remove()
    })
    expect(result.current.status).toBe('empty')
    expect(result.current.details).toBeNull()

    // The stale poll response lands late — it must not resurrect the row.
    await act(async () => {
      resolvePoll(row({ legal_name: 'STALE FROM POLL' }))
      await Promise.resolve()
    })
    expect(result.current.status).toBe('empty')
    expect(result.current.details).toBeNull()
  })

  it('discards an in-flight poll response that resolves after recheckVies() has started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    let resolvePoll!: (value: CompanyDetailsRow) => void
    const pending = new Promise<CompanyDetailsRow>((resolve) => {
      resolvePoll = resolve
    })
    mockApi.get.mockImplementation(() => pending)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })

    mockApi.post.mockResolvedValue(row({ legal_name: 'Rechecked AB' }))
    await act(async () => {
      await result.current.recheckVies()
    })
    expect(result.current.details?.legal_name).toBe('Rechecked AB')

    // The stale poll response lands late — it must not clobber the recheck.
    await act(async () => {
      resolvePoll(row({ legal_name: 'STALE FROM POLL' }))
      await Promise.resolve()
    })
    expect(result.current.details?.legal_name).toBe('Rechecked AB')
  })
})

describe('useCompanyDetails — stale-generation poll keeps its bounded schedule (M1 round 2)', () => {
  it('a save that fails (429) while a poll GET is in flight keeps polling, and still times out to "Check again"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    // Arm a poll tick that will not resolve until told to.
    let resolvePoll!: (value: CompanyDetailsRow) => void
    const pending = new Promise<CompanyDetailsRow>((resolve) => {
      resolvePoll = resolve
    })
    mockApi.get.mockImplementation(() => pending)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })

    // The save fails — the generation bumps, but `details` never changes.
    mockApi.put.mockRejectedValue(new ApiRequestError('Too many requests', 429))
    await act(async () => {
      await result.current.save(SAVE_BODY)
    })
    expect(result.current.saveError).toEqual({ code: 'rate_limited' })

    // The stale poll response lands late — it must be dropped, but the poll
    // must reschedule rather than going quiet forever.
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    await act(async () => {
      resolvePoll(row())
      await Promise.resolve()
    })

    const callsBeforeBound = mockApi.get.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })
    expect(mockApi.get.mock.calls.length).toBeGreaterThan(callsBeforeBound)

    // It still reaches the bound and offers "Check again" (pollTimedOut).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_MAX_MS)
    })
    expect(result.current.pollTimedOut).toBe(true)
  })

  it('a remove that fails while a poll GET is in flight keeps polling, and still times out to "Check again"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    const { result } = renderHook(() => useCompanyDetails())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.status).toBe('ready')

    let resolvePoll!: (value: CompanyDetailsRow) => void
    const pending = new Promise<CompanyDetailsRow>((resolve) => {
      resolvePoll = resolve
    })
    mockApi.get.mockImplementation(() => pending)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })

    // The remove fails (e.g. the confirm dialog's request 500s) — the
    // generation bumps, but `details` never changes; the row stays put.
    mockApi.delete.mockRejectedValue(new ApiRequestError('Server error', 500))
    await act(async () => {
      await result.current.remove()
    })
    expect(result.current.deleteError).toBe(true)
    expect(result.current.status).toBe('ready')

    mockApi.get.mockImplementation(() => Promise.resolve(row()))
    await act(async () => {
      resolvePoll(row())
      await Promise.resolve()
    })

    const callsBeforeBound = mockApi.get.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_INTERVAL_MS)
    })
    expect(mockApi.get.mock.calls.length).toBeGreaterThan(callsBeforeBound)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VIES_POLL_MAX_MS)
    })
    expect(result.current.pollTimedOut).toBe(true)
  })
})
