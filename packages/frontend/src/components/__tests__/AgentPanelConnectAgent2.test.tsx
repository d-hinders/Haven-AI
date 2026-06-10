import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  mockUseAuth,
  mockUseAgents,
  mockUseSafeDetails,
  mockUseOnChainAllowances,
  mockUsePublicClient,
  mockUseActiveSigner,
} = vi.hoisted(() => ({
  SAFE: {
    id: 'safe-1',
    name: 'Operating wallet',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 100,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
  },
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseSafeDetails: vi.fn(),
  mockUseOnChainAllowances: vi.fn(),
  mockUsePublicClient: vi.fn(),
  mockUseActiveSigner: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: (args: unknown) => mockUsePublicClient(args),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: (safeAddress: string | null) => mockUseSafeDetails(safeAddress),
}))

vi.mock('@/hooks/useOnChainAllowances', () => ({
  useOnChainAllowances: (...args: unknown[]) => mockUseOnChainAllowances(...args),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
}))

vi.mock('@/components/CreateAgentModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div role="dialog">Old Connect Agent Modal</div> : null),
}))

vi.mock('@/components/ConnectAgent2Modal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div role="dialog">Connect Agent 2 Modal</div> : null),
}))

import AgentPanel from '@/components/AgentPanel'

describe('AgentPanel Connect Agent 2 entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ activeSafe: SAFE })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      deleteAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseSafeDetails.mockReturnValue({ details: null, loading: false, error: null })
    mockUseOnChainAllowances.mockReturnValue({
      data: new Map(),
      loading: false,
      onChainDelegates: [],
      refetch: vi.fn(),
    })
    mockUsePublicClient.mockReturnValue({})
    mockUseActiveSigner.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('opens ConnectAgent2Modal when NEXT_PUBLIC_CONNECT_AGENT_2_ENABLED is true', () => {
    vi.stubEnv('NEXT_PUBLIC_CONNECT_AGENT_2_ENABLED', 'true')
    render(<AgentPanel />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect agent' })[0])
    expect(screen.getByText('Connect Agent 2 Modal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manual setup' })).not.toBeInTheDocument()
  })

  it('falls back to old modal and shows Manual setup when ConnectAgent2 is explicitly disabled', () => {
    vi.stubEnv('NEXT_PUBLIC_CONNECT_AGENT_2_ENABLED', 'false')
    render(<AgentPanel />)

    // "Connect agent" opens the legacy modal when ConnectAgent2 is off
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect agent' })[0])
    expect(screen.getByText('Old Connect Agent Modal')).toBeInTheDocument()

    // "Manual setup" is also visible (appears in both header and empty state)
    expect(screen.getAllByRole('button', { name: 'Manual setup' }).length).toBeGreaterThan(0)
  })

  it('opens ConnectAgent2Modal by default when the env var is unset', () => {
    // Unset env — ConnectAgent2 should be enabled by default (opt-out model)
    render(<AgentPanel />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect agent' })[0])
    expect(screen.getByText('Connect Agent 2 Modal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manual setup' })).not.toBeInTheDocument()
  })
})
