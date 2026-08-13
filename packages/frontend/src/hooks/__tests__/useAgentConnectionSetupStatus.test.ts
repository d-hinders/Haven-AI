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

  it('holds the recovery bound at the connector\'s own approval-wait bound', () => {
    // Not an arbitrary number: when the dashboard starts advising "run the
    // command again", @haven_ai/connect's waitForBudgetApproval has just hit
    // its 180s bound and exited, so the advice is sound. Moving one without
    // the other silently breaks that (#1399).
    expect(AWAITING_CONNECTION_RECOVERY_MS).toBe(180_000)
    expect(AWAITING_CONNECTION_SLOW_MS).toBeLessThan(AWAITING_CONNECTION_RECOVERY_MS)
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
})
