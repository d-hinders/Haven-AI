import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  mockUseAuth,
  mockUseAgents,
} = vi.hoisted(() => ({
  SAFE: {
    id: 'safe-1',
    name: 'Operating wallet',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 100,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    account_type: 'delegator_hybrid',
  },
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/components/ConnectAgentModal', () => ({
  default: ({ open, starterAllowance }: { open: boolean; starterAllowance?: boolean }) =>
    open ? (
      <div role="dialog">
        Connect Agent Modal{starterAllowance ? ' (starter allowance)' : ''}
      </div>
    ) : null,
}))

import AgentPanel from '@/components/AgentPanel'

describe('AgentPanel Connect Agent entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ activeSafe: SAFE })
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn(),
      refetch: vi.fn(),
    })
  })

  it('opens ConnectAgentModal when the Connect agent button is clicked', () => {
    render(<AgentPanel />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect agent' })[0])
    expect(screen.getByText('Connect Agent Modal')).toBeInTheDocument()
  })

  it('does not render a legacy Manual setup button', () => {
    render(<AgentPanel />)

    expect(screen.queryByRole('button', { name: 'Manual setup' })).not.toBeInTheDocument()
  })

  it('auto-opens the connect flow with a starter allowance on ?setup=first (#352)', () => {
    window.history.replaceState(null, '', '/agents?setup=first')

    render(<AgentPanel />)

    expect(screen.getByText('Connect Agent Modal (starter allowance)')).toBeInTheDocument()
    // the param is consumed so refresh/back doesn't re-trigger the hand-off
    expect(window.location.search).toBe('')

    window.history.replaceState(null, '', '/')
  })

  it('does not auto-open the connect flow without the setup param', () => {
    window.history.replaceState(null, '', '/agents')

    render(<AgentPanel />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    window.history.replaceState(null, '', '/')
  })
})
