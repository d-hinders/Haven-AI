import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FIRST_AGENT_PAYMENT_POLL_INTERVAL_MS,
  useFirstAgentPayment,
} from '@/hooks/useFirstAgentPayment'

/**
 * #4707: the first-agent-payment read.
 *
 * The AC this suite carries: "A test walks unsettled → settled and proves the
 * card and Peak appear only after the merchant-paid condition is true, and
 * that fetching stops after that." The backend decides "merchant-paid" (the
 * repository test proves the SQL); here the walk is the CLIENT's half — a
 * `null` row is not a claim, and the poll keeps asking until a row arrives,
 * then stops.
 */

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
}

const PAYMENT = {
  id: 'payment-1',
  agentName: 'Research agent',
  amountHuman: '0.05',
  amountRaw: '50000',
  tokenSymbol: 'USDC',
  chainId: 8453,
  confirmedAt: '2026-11-08T12:00:00.000Z',
  usdValue: 0.05,
  eurValue: 0.046,
  sekValue: 0.54,
  merchantName: null,
  x402ResourceUrl: 'https://research.example/paper',
}

describe('useFirstAgentPayment (#4707)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
    vi.unstubAllGlobals()
  })

  /** A fetch stub whose answers are consumed in order; the last one repeats. */
  function stubApi(...payloads: unknown[]) {
    let index = 0
    const fetchMock = vi.fn(async () => {
      const payload = payloads[Math.min(index, payloads.length - 1)]
      index += 1
      return Response.json(payload)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function calls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/dashboard/first-agent-payment'),
    )
  }

  it('does not request anything while disabled', async () => {
    const fetchMock = stubApi({ payment: PAYMENT })
    renderHook(() => useFirstAgentPayment(false))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(calls(fetchMock)).toHaveLength(0)
  })

  it('walks unsettled → settled: no row until the merchant-paid answer, then stops fetching', async () => {
    // First answer: the merchant leg is not proven yet — the server says null.
    // Second answer: it settled, so the row arrives.
    const fetchMock = stubApi({ payment: null }, { payment: PAYMENT })
    const { result } = renderHook(() => useFirstAgentPayment(true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.payment).toBeNull()
    expect(calls(fetchMock)).toHaveLength(1)

    // One 60 s tick: still unsettled, still no claim.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_AGENT_PAYMENT_POLL_INTERVAL_MS)
    })
    expect(result.current.payment).toEqual(PAYMENT)
    expect(calls(fetchMock)).toHaveLength(2)

    // Settled: the poll stops. Three more cadences issue nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_AGENT_PAYMENT_POLL_INTERVAL_MS * 3)
    })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it('polls at 60 s, not the 10 s default', async () => {
    const fetchMock = stubApi({ payment: null })
    renderHook(() => useFirstAgentPayment(true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(calls(fetchMock)).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(calls(fetchMock)).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    expect(calls(fetchMock)).toHaveLength(2)
  })

  it('a 404 from an older backend leaves the row null and renders nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    )
    const { result } = renderHook(() => useFirstAgentPayment(true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.payment).toBeNull()
    expect(result.current.error).not.toBeNull()
  })

  it('clears the row when it is disabled (a dismissal)', async () => {
    stubApi({ payment: PAYMENT })
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useFirstAgentPayment(enabled),
      { initialProps: { enabled: true } },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.payment).toEqual(PAYMENT)

    rerender({ enabled: false })
    expect(result.current.payment).toBeNull()
  })
})
