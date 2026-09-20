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
}))

vi.mock('../ConnectAgentModal', () => ({
  default: () => null,
}))

vi.mock('../ConfirmDialog', () => ({
  default: () => null,
}))

import AgentPanel from '../AgentPanel'

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
