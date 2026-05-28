import { renderHook, act } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// ── Mock @/lib/api ────────────────────────────────────────────────

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useAgentLastSeen } from '@/hooks/useAgentLastSeen'

describe('useAgentLastSeen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockApiGet.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null before the first poll resolves', () => {
    // Return a promise that never resolves — simulates in-flight request
    mockApiGet.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useAgentLastSeen('agent-1'))

    expect(result.current.lastSeenAt).toBeNull()
    expect(result.current.isConnected).toBe(false)
  })

  it('returns null when agent has not made any MCP calls', async () => {
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: null })

    const { result } = renderHook(() => useAgentLastSeen('agent-1'))

    // Flush the microtask queue so the first poll completes
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.lastSeenAt).toBeNull()
    expect(result.current.isConnected).toBe(false)
    expect(mockApiGet).toHaveBeenCalledWith('/agents/agent-1')
  })

  it('sets lastSeenAt and isConnected when agent has connected', async () => {
    const ts = '2026-05-28T14:00:00.000Z'
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: ts })

    const { result } = renderHook(() => useAgentLastSeen('agent-1'))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.lastSeenAt).toBe(ts)
    expect(result.current.isConnected).toBe(true)
  })

  it('does not poll when agentId is null', async () => {
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: null })

    renderHook(() => useAgentLastSeen(null))

    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })

    expect(mockApiGet).not.toHaveBeenCalled()
  })

  it('resets to null when agentId changes', async () => {
    const ts = '2026-05-28T14:00:00.000Z'
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: ts })

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useAgentLastSeen(id),
      { initialProps: { id: 'agent-1' as string | null } },
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.lastSeenAt).toBe(ts)

    // Switch to a new agent — mock returns null
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: null })
    rerender({ id: 'agent-2' })

    // State resets immediately on agentId change
    expect(result.current.lastSeenAt).toBeNull()
  })

  it('polls again after the waiting interval (3s) when last_seen_at is null', async () => {
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: null })

    renderHook(() => useAgentLastSeen('agent-1'))

    // First poll fires immediately
    await act(async () => { await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(1)

    // Advance to just under 3s — no new call
    await act(async () => { vi.advanceTimersByTime(2_900) })
    expect(mockApiGet).toHaveBeenCalledTimes(1)

    // Advance past 3s — second poll fires
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('uses the longer (10s) interval once the agent has connected', async () => {
    const ts = '2026-05-28T14:00:00.000Z'
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: ts })

    renderHook(() => useAgentLastSeen('agent-1'))

    // Initial poll fires and resolves to connected
    await act(async () => { await Promise.resolve() })
    expect(mockApiGet).toHaveBeenCalledTimes(1)

    // Advance 9.9s — no new call (10s connected interval)
    await act(async () => { vi.advanceTimersByTime(9_900) })
    expect(mockApiGet).toHaveBeenCalledTimes(1)

    // Advance past 10s — second poll
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('handles API errors gracefully (no crash) and retries', async () => {
    mockApiGet.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useAgentLastSeen('agent-1'))

    await act(async () => { await Promise.resolve() })

    // Error must not crash the hook
    expect(result.current.lastSeenAt).toBeNull()
    expect(result.current.isConnected).toBe(false)

    // After the waiting-interval retry, it should try again
    const ts = '2026-05-28T14:00:00.000Z'
    mockApiGet.mockResolvedValue({ mcp_last_seen_at: ts })

    await act(async () => {
      vi.advanceTimersByTime(3_100)
      await Promise.resolve()
    })

    expect(result.current.lastSeenAt).toBe(ts)
  })
})
