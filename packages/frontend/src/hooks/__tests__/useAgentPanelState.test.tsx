/**
 * Direct unit tests for the agents-panel flow logic (#989) — no panel render.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseAgents,
  mockUseOnChainAllowances,
  mockUsePublicClient,
  mockUseSafeDetails,
  mockUseActiveSigner,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseOnChainAllowances: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseActiveSigner: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: () => mockUsePublicClient(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useOnChainAllowances', () => ({
  useOnChainAllowances: (...args: unknown[]) => mockUseOnChainAllowances(...args),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (...args: unknown[]) => mockUseSafeDetails(...args),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => mockUseActiveSigner(),
  isSafeCapableSigner: (s: { type?: string } | null) => s !== null && s.type !== 'delegator_passkey',
}))

import { useAgentPanelState } from '@/hooks/useAgentPanelState'
import type { Agent } from '@/hooks/useAgents'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
}

const NEW_DELEGATE = '0x9999999999999999999999999999999999999999'

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x2222222222222222222222222222222222222222',
    safe_id: 'safe-1',
    safe_address: SAFE.safe_address,
    safe_name: 'Main account',
    safe_chain_id: 100,
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
    mockUseAuth.mockReturnValue({ activeSafe: SAFE })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      deleteAgent: vi.fn(),
      refetch: vi.fn().mockResolvedValue([]),
    })
    mockUseSafeDetails.mockReturnValue({ details: null })
    mockUsePublicClient.mockReturnValue({})
    mockUseActiveSigner.mockReturnValue(null)
    mockUseOnChainAllowances.mockReturnValue({
      data: new Map(),
      chainTimeSec: null,
      loading: false,
      onChainDelegates: [],
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('agentUsesActiveSafe', () => {
    it('matches by safe_id first', () => {
      const { result } = renderHook(() => useAgentPanelState())
      expect(result.current.agentUsesActiveSafe(baseAgent({ safe_id: 'safe-1' }))).toBe(true)
      expect(result.current.agentUsesActiveSafe(baseAgent({ safe_id: 'safe-other' }))).toBe(false)
    })

    it('falls back to address + chain when there is no safe_id', () => {
      const { result } = renderHook(() => useAgentPanelState())
      expect(
        result.current.agentUsesActiveSafe(
          baseAgent({ safe_id: null as unknown as string, safe_address: SAFE.safe_address.toUpperCase(), safe_chain_id: 100 }),
        ),
      ).toBe(true)
      expect(
        result.current.agentUsesActiveSafe(
          baseAgent({ safe_id: null as unknown as string, safe_address: SAFE.safe_address, safe_chain_id: 8453 }),
        ),
      ).toBe(false)
    })
  })

  describe('unmanaged-delegate classification', () => {
    beforeEach(() => {
      mockUseOnChainAllowances.mockReturnValue({
        data: new Map([
          [NEW_DELEGATE.toLowerCase(), {
            allowances: [{
              token: '0xddAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
              amount: 1_000_000n,
              spent: 0n,
              resetTimeMin: 1440,
              lastResetMin: 0,
              nonce: 0,
            }],
          }],
        ]),
        chainTimeSec: 1_700_000_000,
        loading: false,
        onChainDelegates: [NEW_DELEGATE],
        refetch: vi.fn(),
      })
    })

    it('classifies an on-chain-only delegate as unmanaged', () => {
      const { result, unmount } = renderHook(() => useAgentPanelState())
      expect(result.current.unmanagedDelegates).toHaveLength(1)
      expect(result.current.unmanagedDelegates[0].address).toBe(NEW_DELEGATE)
      expect(result.current.isPendingHavenSetup(NEW_DELEGATE)).toBe(false)
      unmount()
    })

    it('handleSetupUpdated suppresses the fresh delegate and marks it as a Haven setup', async () => {
      const { result, unmount } = renderHook(() => useAgentPanelState())

      act(() => {
        result.current.handleSetupUpdated({ delegateAddress: NEW_DELEGATE })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })

      expect(result.current.unmanagedDelegates).toHaveLength(0)
      expect(result.current.finalizingAgent).toBe(true)
      expect(result.current.isPendingHavenSetup(NEW_DELEGATE)).toBe(true)
      // Unmount cancels the in-flight poll.
      unmount()
    })

    it('the suppression expires after 30s, leaving the pending-Haven-setup label', async () => {
      const { result, unmount } = renderHook(() => useAgentPanelState())

      act(() => {
        result.current.handleSetupUpdated({ delegateAddress: NEW_DELEGATE })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })

      expect(result.current.finalizingAgent).toBe(false)
      expect(result.current.finalizeTimedOut).toBe(true)
      expect(result.current.unmanagedDelegates).toHaveLength(1)
      expect(result.current.isPendingHavenSetup(NEW_DELEGATE)).toBe(true)
      unmount()
    })
  })

  it('splits visible and revoked agents', () => {
    mockUseAgents.mockReturnValue({
      agents: [baseAgent(), baseAgent({ id: 'agent-2', status: 'revoked' })],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      deleteAgent: vi.fn(),
      refetch: vi.fn().mockResolvedValue([]),
    })
    const { result } = renderHook(() => useAgentPanelState())
    expect(result.current.visibleAgents.map((a) => a.id)).toEqual(['agent-1'])
    expect(result.current.revokedAgents.map((a) => a.id)).toEqual(['agent-2'])
  })
})
