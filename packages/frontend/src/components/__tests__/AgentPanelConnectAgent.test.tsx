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
    account_address: '0x1111111111111111111111111111111111111111',
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  // #3165: the list toolbar mirrors its state to the URL.
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/ConnectAgentModal', () => ({
  default: ({ open, starterAllowance, onClose }: { open: boolean; starterAllowance?: boolean; onClose?: () => void }) =>
    open ? (
      <div role="dialog">
        Connect Agent Modal{starterAllowance ? ' (starter allowance)' : ''}
        <button type="button" onClick={onClose}>
          Close connect modal
        </button>
      </div>
    ) : null,
}))

// #4065: the inline first-agent flow is the shared flow's other container.
// The modal mock above does not cover it, so without this stand-in every
// zero-agent case here would run the real flow hook unmocked. The real
// container is exercised in AgentPanelInlineSetup.test.tsx.
vi.mock('@/components/connect-agent/InlineAgentSetup', () => ({
  InlineAgentSetup: ({ onClose }: { onClose?: () => void }) => (
    <section aria-label="Connect your first agent">
      Inline connect flow
      <button type="button" onClick={onClose}>
        Leave inline flow
      </button>
    </section>
  ),
}))

import AgentPanel from '@/components/AgentPanel'

const AGENT = {
  id: 'agent-1',
  name: 'Research agent',
  description: null,
  delegate_address: '0x2222222222222222222222222222222222222222',
  status: 'active',
  created_at: '2026-10-19T00:00:00.000Z',
  account_chain_id: 100,
  archived_at: null,
  allowances: [],
  labels: [],
}

function setAgents(agents: unknown[], extra: Record<string, unknown> = {}) {
  mockUseAgents.mockReturnValue({
    agents,
    loading: false,
    revokeAgent: vi.fn(),
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    archiveAgent: vi.fn(),
    unarchiveAgent: vi.fn(),
    refetch: vi.fn(),
    ...extra,
  })
}

const inlineFlow = () => screen.queryByRole('region', { name: 'Connect your first agent' })

describe('AgentPanel Connect Agent entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ user: { accounts: [SAFE] } })
    setAgents([])
  })

  it('opens ConnectAgentModal when the Connect agent button is clicked (agents exist)', () => {
    // #4065: at zero agents the inline flow replaces this button; the
    // header button and its modal are for every agent after the first.
    setAgents([AGENT])
    render(<AgentPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))
    expect(screen.getByText('Connect Agent Modal')).toBeInTheDocument()
  })

  it('does not render a legacy Manual setup button', () => {
    render(<AgentPanel />)

    expect(screen.queryByRole('button', { name: 'Manual setup' })).not.toBeInTheDocument()
  })

  it('auto-opens the connect modal with a starter allowance on ?setup=first when agents exist (#352)', () => {
    setAgents([AGENT])
    window.history.replaceState(null, '', '/agents?setup=first')

    render(<AgentPanel />)

    expect(screen.getByText('Connect Agent Modal (starter allowance)')).toBeInTheDocument()
    // the param is consumed so refresh/back doesn't re-trigger the hand-off
    expect(window.location.search).toBe('')

    window.history.replaceState(null, '', '/')
  })

  it('lands ?setup=first on the inline flow with no agents — no modal on top of it (#4065)', () => {
    window.history.replaceState(null, '', '/agents?setup=first')

    render(<AgentPanel />)

    expect(inlineFlow()).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.location.search).toBe('')

    window.history.replaceState(null, '', '/')
  })

  it('decides ?setup=first after the first list load, not on mount (#4065)', () => {
    setAgents([], { loading: true })
    window.history.replaceState(null, '', '/agents?setup=first')

    const { rerender } = render(<AgentPanel />)
    // Still loading: nothing is decided yet — no modal, no inline flow.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(inlineFlow()).not.toBeInTheDocument()

    setAgents([AGENT])
    rerender(<AgentPanel />)
    expect(screen.getByText('Connect Agent Modal (starter allowance)')).toBeInTheDocument()

    window.history.replaceState(null, '', '/')
  })

  it('still opens the modal on ?setup=first when the list failed to load — inline does not render there', () => {
    setAgents([], { error: 'request failed' })
    window.history.replaceState(null, '', '/agents?setup=first')

    render(<AgentPanel />)

    expect(inlineFlow()).not.toBeInTheDocument()
    expect(screen.getByText('Connect Agent Modal (starter allowance)')).toBeInTheDocument()

    window.history.replaceState(null, '', '/')
  })

  it('closing a resumed ?setup=<id> hand-off drops only `setup` — the list filters stay (#3165)', () => {
    window.history.replaceState(null, '', '/agents?q=research&setup=2f1c0f7e-6f1d-4c7e-9a8f-1234567890ab&status=active')

    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Close connect modal' }))

    // Mutation: put the old `replaceState(null, '', '/agents')` back → red.
    expect(window.location.search).toBe('?q=research&status=active')

    window.history.replaceState(null, '', '/')
  })

  it('a resumed ?setup=<id> keeps the modal and renders no inline flow under it; closing it shows inline (#4065)', () => {
    window.history.replaceState(null, '', '/agents?setup=2f1c0f7e-6f1d-4c7e-9a8f-1234567890ab')

    render(<AgentPanel />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(inlineFlow()).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close connect modal' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(inlineFlow()).toBeInTheDocument()

    window.history.replaceState(null, '', '/')
  })

  it('without the setup param, a user with no agents gets the inline flow and no dialog', () => {
    window.history.replaceState(null, '', '/agents')

    render(<AgentPanel />)

    // #4065: inline is never a dialog, so "no dialog" alone would hold either
    // way — the positive half is that the inline flow is what renders.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(inlineFlow()).toBeInTheDocument()

    window.history.replaceState(null, '', '/')
  })
})
