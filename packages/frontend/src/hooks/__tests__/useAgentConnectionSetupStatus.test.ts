import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import {
  AWAITING_CONNECTION_RECOVERY_MS,
  AWAITING_CONNECTION_SLOW_MS,
  useAgentConnectionSetupStatus,
} from '@/hooks/useAgentConnectionSetupStatus'

describe('useAgentConnectionSetupStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockApiGet.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not poll without a setup id', async () => {
    renderHook(() => useAgentConnectionSetupStatus(null))

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })

    expect(mockApiGet).not.toHaveBeenCalled()
  })

  it('loads setup status and polls waiting setups every 3 seconds', async () => {
    mockApiGet.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    })

    const { result } = renderHook(() => useAgentConnectionSetupStatus('setup-1'))

    await act(async () => { await Promise.resolve() })
    expect(result.current.data?.status).toBe('awaiting_connection')
    expect(mockApiGet).toHaveBeenCalledWith('/agent-connection-setups/setup-1')

    await act(async () => {
      vi.advanceTimersByTime(3100)
      await Promise.resolve()
    })
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('stops polling terminal setup states', async () => {
    mockApiGet.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'expired',
      expires_at: '2026-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    })

    renderHook(() => useAgentConnectionSetupStatus('setup-1'))

    await act(async () => { await Promise.resolve() })
    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })

    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })

  it('stages starting → slow → recovery only while Haven continues to report awaiting_connection', async () => {
    mockApiGet.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    })

    const { result } = renderHook(() => useAgentConnectionSetupStatus('setup-1'))
    await act(async () => { await Promise.resolve() })
    expect(result.current.awaitingConnectionStage).toBe('starting')

    // A slow first run is acknowledged, NOT treated as a failure: the screen
    // must not be offering recovery at this point (#1399).
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_CONNECTION_SLOW_MS)
      await Promise.resolve()
    })
    expect(result.current.awaitingConnectionStage).toBe('slow')

    await act(async () => {
      vi.advanceTimersByTime(AWAITING_CONNECTION_RECOVERY_MS - AWAITING_CONNECTION_SLOW_MS)
      await Promise.resolve()
    })
    expect(result.current.awaitingConnectionStage).toBe('recovery')

    mockApiGet.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'connected_local',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    })
    await act(async () => { await result.current.refetch() })
    expect(result.current.awaitingConnectionStage).toBe('starting')
  })

  it('reassures well before it offers recovery, with room for a cold npx download', () => {
    // What actually matters is the ORDER and the gap: the user is reassured
    // first, and recovery only appears long after a slow first run would
    // normally have finished downloading the connector. The exact 3 minutes is
    // a judgement call, so this pins the relationship rather than a literal.
    expect(AWAITING_CONNECTION_SLOW_MS).toBeLessThan(AWAITING_CONNECTION_RECOVERY_MS)
    expect(AWAITING_CONNECTION_RECOVERY_MS).toBeGreaterThanOrEqual(150_000)
  })

  it('never treats a status-read error as proof that the connector is stalled', async () => {
    mockApiGet.mockResolvedValueOnce({
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    })
    const { result } = renderHook(() => useAgentConnectionSetupStatus('setup-1'))
    await act(async () => { await Promise.resolve() })

    mockApiGet.mockRejectedValueOnce(new Error('Network unavailable'))
    await act(async () => {
      vi.advanceTimersByTime(3_100)
      await Promise.resolve()
    })
    expect(result.current.error).toBe('Network unavailable')
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_CONNECTION_RECOVERY_MS - 3_100)
      await Promise.resolve()
    })

    expect(result.current.awaitingConnectionStage).toBe('starting')
  })

  // #1404: a single dropped request used to end the poll loop for the
  // modal's life — the screen promised auto-advance while nothing was being
  // checked. These drive the failure → recovery path WITHOUT remount.
  it('recovers from a failed read on its own: the next poll still happens and advances the modal', async () => {
    const waiting = {
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    }
    mockApiGet
      .mockResolvedValueOnce(waiting)
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ ...waiting, status: 'connected_local' })

    const { result } = renderHook(() => useAgentConnectionSetupStatus('setup-1'))
    await act(async () => { await Promise.resolve() })

    // Poll 2 fails…
    await act(async () => {
      vi.advanceTimersByTime(3_100)
      await Promise.resolve()
    })
    expect(result.current.error).toBe('Network unavailable')

    // …and poll 3 STILL happens (first retry at the base 3s cadence) and
    // advances the modal — no remount, no user action.
    await act(async () => {
      vi.advanceTimersByTime(3_100)
      await Promise.resolve()
    })
    expect(mockApiGet).toHaveBeenCalledTimes(3)
    expect(result.current.data?.status).toBe('connected_local')
    expect(result.current.error).toBeNull()
  })

  it('backs off on repeated failures instead of hot-looping at the fast cadence', async () => {
    mockApiGet.mockRejectedValue(new Error('Network unavailable'))
    renderHook(() => useAgentConnectionSetupStatus('setup-1'))
    await act(async () => { await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(1)

    // Failure 1 → retry after 3s.
    await act(async () => { vi.advanceTimersByTime(3_100); await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(2)

    // Failure 2 → next retry waits 6s: nothing at +3s…
    await act(async () => { vi.advanceTimersByTime(3_100); await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(2)
    // …but it fires by +6s.
    await act(async () => { vi.advanceTimersByTime(3_100); await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(3)

    // The backoff is capped: after many failures the loop is still alive and
    // a 30s wait always yields exactly one more attempt.
    for (let i = 0; i < 6; i++) {
      await act(async () => { vi.advanceTimersByTime(30_100); await Promise.resolve() })
    }
    const after = mockApiGet.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(30_100); await Promise.resolve() })
    expect(mockApiGet.mock.calls.length).toBe(after + 1)
  })

  it('a success after failures resets the backoff to the normal cadence', async () => {
    const waiting = {
      setup_id: 'setup-1',
      status: 'awaiting_connection',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    }
    mockApiGet
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue(waiting)

    renderHook(() => useAgentConnectionSetupStatus('setup-1'))
    await act(async () => { await Promise.resolve() })
    // failure 1 → +3s → failure 2 → +6s → success
    await act(async () => { vi.advanceTimersByTime(3_100); await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(6_100); await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(3)

    // Back at the fast 3s cadence — the failure streak is forgotten.
    await act(async () => { vi.advanceTimersByTime(3_100); await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(4)
  })
})
