/**
 * Direct unit tests for the agents-panel flow logic (#989) — no panel render.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseAgents,
  mockRouterPush,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockRouterPush: vi.fn(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}))

import { useAgentPanelState } from '@/hooks/useAgentPanelState'
import type { Agent } from '@/hooks/useAgents'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
}

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x2222222222222222222222222222222222222222',
    account_id: 'safe-1',
    account_address: SAFE.account_address,
    account_name: 'Main account',
    account_chain_id: 100,
    status: 'active',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    ...overrides,
  } as Agent
}

describe('useAgentPanelState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAuth.mockReturnValue({ activeAccount: SAFE })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn(),
      refetch: vi.fn().mockResolvedValue([]),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * #3168: the card's "Details" action routes through `handleViewDetails`,
   * which is a client-side router push — the same navigation every card gets,
   * regardless of which account the agent belongs to (the old
   * `canUseWalletActions` fork is gone with the modal it guarded).
   */
  describe('handleViewDetails (#3168)', () => {
    it('pushes /agents/{id} through the Next router', () => {
      const { result } = renderHook(() => useAgentPanelState())
      act(() => {
        result.current.handleViewDetails(baseAgent({ id: 'agent-42' }))
      })
      expect(mockRouterPush).toHaveBeenCalledTimes(1)
      expect(mockRouterPush).toHaveBeenCalledWith('/agents/agent-42')
    })

    it('pushes the agent id that was passed, not the active account id', () => {
      const { result } = renderHook(() => useAgentPanelState())
      act(() => {
        result.current.handleViewDetails(baseAgent({ id: 'agent-other' }))
      })
      expect(mockRouterPush).toHaveBeenCalledWith('/agents/agent-other')
    })
  })

  // #1402: the primary list hides only ARCHIVED agents. A revoked-but-not-
  // archived agent stays visible (with its status chip) so an interrupted
  // remove is never invisible; Removed is keyed off archived_at alone.
  it('splits the list on archived_at, not status', () => {
    mockUseAgents.mockReturnValue({
      agents: [
        baseAgent(),
        baseAgent({ id: 'agent-2', status: 'revoked' }),
        baseAgent({ id: 'agent-3', status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
      ],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn(),
      refetch: vi.fn().mockResolvedValue([]),
    })
    const { result } = renderHook(() => useAgentPanelState())
    expect(result.current.visibleAgents.map((a) => a.id)).toEqual(['agent-1', 'agent-2'])
    expect(result.current.removedAgents.map((a) => a.id)).toEqual(['agent-3'])
  })

  // #1402: handleArchive deliberately RETHROWS (its only caller is
  // RemoveAgentDialog, which owns the failure UI) while handleRestore
  // keeps the catch-and-toast convention of its siblings. A future "make
  // them consistent" edit must fail here, not ship silently.
  it('handleArchive rethrows the archive failure instead of toasting it', async () => {
    const archiveAgent = vi.fn().mockRejectedValue(new Error('boom'))
    mockUseAgents.mockReturnValue({
      agents: [baseAgent()],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent,
      unarchiveAgent: vi.fn(),
      refetch: vi.fn().mockResolvedValue([]),
    })
    const { result } = renderHook(() => useAgentPanelState())
    await act(async () => {
      await expect(result.current.handleArchive(baseAgent())).rejects.toThrow('boom')
    })
    expect(archiveAgent).toHaveBeenCalledWith('agent-1')
    expect(result.current.toastMessage).toBeNull()
    // busy state is released even on the throwing path
    expect(result.current.busyAgentId).toBeNull()
  })

  it('handleRestore catches and toasts — the direct-button convention', async () => {
    mockUseAgents.mockReturnValue({
      agents: [baseAgent()],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn().mockRejectedValue(new Error('boom')),
      refetch: vi.fn().mockResolvedValue([]),
    })
    const { result } = renderHook(() => useAgentPanelState())
    await act(async () => {
      await result.current.handleRestore(baseAgent())
    })
    expect(result.current.toastMessage).toMatch(/could not be restored/i)
  })
})
