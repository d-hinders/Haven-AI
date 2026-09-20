import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.hoisted(() => vi.fn())
const mockUseAgents = vi.hoisted(() => vi.fn())
const mockRouterPush = vi.hoisted(() => vi.fn())

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  // #3165: the list toolbar mirrors its state to the URL.
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../ConnectAgentModal', () => ({
  default: () => null,
}))

vi.mock('../ConfirmDialog', () => ({
  default: () => null,
}))

import AgentPanel from '../AgentPanel'
import { MCP_NOT_RECORDED_NOTE } from '../agent-panel/McpServerName'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
  account_type: 'delegator_hybrid',
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x2222222222222222222222222222222222222222',
    account_id: SAFE.id,
    account_address: SAFE.account_address,
    account_name: SAFE.name,
    account_chain_id: SAFE.chain_id,
    account_type: SAFE.account_type,
    status: 'active',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    labels: [],
    ...overrides,
  }
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

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAuth.mockReturnValue({ activeAccount: SAFE })
  setAgents([])
})

describe('AgentPanel agent detail navigation (#3168)', () => {
  it('routes the card Details action to /agents/{id} through the Next router', () => {
    setAgents([agent({ id: 'agent-9' })])

    render(<AgentPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Open details for Research agent' }))
    expect(mockRouterPush).toHaveBeenCalledTimes(1)
    expect(mockRouterPush).toHaveBeenCalledWith('/agents/agent-9')
  })

  it('leaves no Edit modal affordance on the list — the detail page owns name and description editing', () => {
    setAgents([agent()])

    render(<AgentPanel />)

    expect(screen.queryByRole('button', { name: 'Edit Research agent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open details for Research agent' })).toBeInTheDocument()
  })
})

describe('AgentPanel rail affordances', () => {
  it('announces the agent list loading state', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn(),
      refetch: vi.fn(),
    })

    render(<AgentPanel />)

    expect(screen.getByRole('status', { name: 'Loading agents' })).toHaveAttribute('aria-busy', 'true')
  })

  it('keeps the delegation connect entry point and agent budget readable', () => {
    setAgents([agent({ allowances: [{
      id: 'allowance-1',
      agent_id: 'agent-1',
      token_address: '0x3333333333333333333333333333333333333333',
      token_symbol: 'USDC',
      allowance_amount: '1000000',
      reset_period_min: 1440,
    }] })])

    render(<AgentPanel />)

    expect(screen.getAllByRole('button', { name: 'Connect agent' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('1.00')).toBeInTheDocument()
  })

  it('shows a retry state instead of claiming there are no agents when the list fails', () => {
    const refetch = vi.fn()
    setAgents([], { error: 'request failed', refetch })

    render(<AgentPanel />)

    expect(screen.getByRole('heading', { name: 'Agents could not load' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No agents yet' })).not.toBeInTheDocument()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(refetch).toHaveBeenCalled()
  })

  it('marks a populated list as stale when refreshing agents fails', () => {
    setAgents([agent()], { error: 'request failed' })

    render(<AgentPanel />)

    expect(screen.getByRole('alert')).toHaveTextContent('Showing the last loaded records')
    expect(screen.getByText('Research agent')).toBeInTheDocument()
  })

  it('exposes Removed as an accessible disclosure', () => {
    setAgents([agent({ id: 'archived-agent', name: 'Old agent', archived_at: '2026-06-01T00:00:00Z' })])

    render(<AgentPanel />)

    const toggle = screen.getByRole('button', { name: /Removed\s*\(1\)/ })
    const controlled = document.getElementById('removed-agent-list')
    expect(controlled).not.toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'removed-agent-list')
    expect(controlled).toHaveAttribute('hidden')

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Old agent')).toBeVisible()
    expect(controlled).not.toHaveAttribute('hidden')
  })
})

describe('AgentPanel list toolbar (#3165)', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ activeAccount: SAFE, activeChainId: SAFE.chain_id })
  })

  it('renders the toolbar above a non-empty list and filters the cards through it', () => {
    setAgents([agent({ id: 'a1', name: 'Alpha', status: 'active' }), agent({ id: 'a2', name: 'Bravo', status: 'paused' })])
    render(<AgentPanel />)
    expect(screen.getByTestId('agent-list-toolbar')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Bravo')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /Search agents/ }), { target: { value: 'brav' } })
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Bravo')).toBeInTheDocument()
    expect(screen.getByTestId('agent-list-count')).toHaveTextContent('1 of 2 agents shown')
  })

  it('a zero-result filter shows the reset affordance and never hides the toolbar', () => {
    setAgents([agent({ id: 'a1', name: 'Alpha' })])
    render(<AgentPanel />)
    fireEvent.change(screen.getByRole('textbox', { name: /Search agents/ }), { target: { value: 'zzz' } })
    expect(screen.getByText('No agents match these filters')).toBeInTheDocument()
    // The toolbar must survive the zero state (mutation: gate it on the
    // filtered length → this line goes red), and exactly ONE reset is
    // offered — the EmptyState's; the bar's steps back.
    expect(screen.getByTestId('agent-list-toolbar')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Clear filters' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('the MCP "not recorded" note follows the filtered list, not every visible agent', () => {
    setAgents([
      agent({ id: 'a1', name: 'Alpha', mcp_server_name: null, mcp_last_seen_at: '2026-09-01T00:00:00Z' }),
      agent({ id: 'a2', name: 'Bravo', mcp_server_name: 'claude-desktop' }),
    ])
    render(<AgentPanel />)
    expect(screen.getByText(MCP_NOT_RECORDED_NOTE)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /Search agents/ }), { target: { value: 'bravo' } })
    // Alpha (the unrecorded one) is filtered out, so the note explaining its
    // label has nothing on the page to explain. Mutation: gate the predicate
    // on `visibleAgents` again → red.
    expect(screen.queryByText(MCP_NOT_RECORDED_NOTE)).toBeNull()
  })

  it('no toolbar on an empty list — the empty state owns that screen', () => {
    setAgents([])
    render(<AgentPanel />)
    expect(screen.queryByTestId('agent-list-toolbar')).toBeNull()
  })
})
