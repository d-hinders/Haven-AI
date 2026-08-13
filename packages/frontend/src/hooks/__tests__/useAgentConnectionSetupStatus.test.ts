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

  it('flags a bounded recovery state only while Haven continues to report awaiting_connection', async () => {
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
    expect(result.current.awaitingConnectionStalled).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(AWAITING_CONNECTION_RECOVERY_MS)
      await Promise.resolve()
    })
    expect(result.current.awaitingConnectionStalled).toBe(true)

    mockApiGet.mockResolvedValue({
      setup_id: 'setup-1',
      status: 'connected_local',
      expires_at: '2099-01-01T00:00:00.000Z',
      agent: { name: 'Research Agent' },
      haven_wallet: { id: 'safe-1', name: 'Wallet', address: '0x1', chain_id: 100, network: 'Gnosis' },
      agent_budget: [],
    })
    await act(async () => { await result.current.refetch() })
    expect(result.current.awaitingConnectionStalled).toBe(false)
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

    expect(result.current.awaitingConnectionStalled).toBe(false)
  })
})
