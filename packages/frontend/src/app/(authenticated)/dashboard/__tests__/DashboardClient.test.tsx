import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUseAggregatedBalances = vi.fn()
const mockUseDashboardOverview = vi.fn()
const mockUseBalances = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUseSafeOperationGate = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => mockUseContacts(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useAggregatedPortfolio', () => ({
  useAggregatedBalances: () => mockUseAggregatedBalances(),
}))

vi.mock('@/hooks/useDashboardOverview', () => ({
  useDashboardOverview: () => mockUseDashboardOverview(),
}))

vi.mock('@/hooks/useBalances', () => ({
  useBalances: () => mockUseBalances(),
}))

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: () => mockUseSafeDetails(),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: () => mockUseSafeOperationGate(),
}))

vi.mock('@/components/DashboardOnboardingGuide', () => ({
  default: () => <div>Onboarding guide</div>,
}))

vi.mock('@/components/CreateAgentModal', () => ({
  default: () => null,
}))

vi.mock('@/components/SendModal', () => ({
  default: () => null,
}))

vi.mock('@/components/DashboardActionPickerModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ReceiveFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ComingSoonModal', () => ({
  default: () => null,
}))

vi.mock('@/components/PasskeyOtherDeviceNotice', () => ({
  default: () => <div>Use another device</div>,
}))

import DashboardClient from '../DashboardClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
}

function mockBaseState() {
  mockUseAuth.mockReturnValue({
    user: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      wallet_address: '0x5555555555555555555555555555555555555555',
      safes: [SAFE],
    },
    activeSafe: SAFE,
  })
  mockUsePreferences.mockReturnValue({ currency: 'USD' })
  mockUseContacts.mockReturnValue({
    contacts: [],
    error: null,
    resolveAddress: vi.fn(() => null),
  })
  mockUseAgents.mockReturnValue({
    agents: [{ id: 'agent-1', name: 'Research agent' }],
    refetch: vi.fn(),
  })
  mockUseAggregatedBalances.mockReturnValue({
    balances: [{ balance: '1000000' }],
    loading: false,
    refetch: vi.fn(),
  })
  mockUseDashboardOverview.mockReturnValue({
    data: {
      totals: { usd: 1234.56, eur: 1100 },
      change: {
        available: true,
        usdAmount: 12.34,
        eurAmount: 11,
        usdPercent: 1.23,
        eurPercent: 1,
      },
      metrics: {
        connectedAgents: 1,
        monthlyAgentSpendUsd: 42,
        monthlyAgentSpendEur: 38,
        successfulTransactions: 4,
        activeAccounts: 1,
      },
      actionableApprovals: 2,
      pendingApprovals: 2,
      agents: [],
      transactions: [],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseBalances.mockReturnValue({
    balances: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseSafeDetails.mockReturnValue({
    details: null,
    loading: false,
    error: null,
  })
  mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
}

describe('DashboardClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    mockBaseState()
  })

  it('leads with total balance, primary actions, attention, and compact facts', () => {
    render(<DashboardClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('2 agent payments need your action')).toBeInTheDocument()
    expect(screen.getByText('Agent spend this month')).toBeInTheDocument()
    expect(screen.getByText('$42.00')).toBeInTheDocument()
  })

  it('uses singular copy for one agent payment that needs action', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: {
        totals: { usd: 1234.56, eur: 1100 },
        change: {
          available: true,
          usdAmount: 12.34,
          eurAmount: 11,
          usdPercent: 1.23,
          eurPercent: 1,
        },
        metrics: {
          connectedAgents: 1,
          monthlyAgentSpendUsd: 42,
          monthlyAgentSpendEur: 38,
          successfulTransactions: 4,
          activeAccounts: 1,
        },
        actionableApprovals: 1,
        pendingApprovals: 1,
        agents: [],
        transactions: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('1 agent payment needs your action')).toBeInTheDocument()
  })

  it('does not show empty preview states while overview is loading', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.queryByText('No transactions yet')).not.toBeInTheDocument()
    expect(screen.queryByText('No connected agents right now')).not.toBeInTheDocument()
  })

  it('does not show a zero balance when dashboard totals fail to load', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: null,
      loading: false,
      error: 'Dashboard is temporarily unavailable.',
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getByText('Dashboard data could not load')).toBeInTheDocument()
    expect(screen.getByText('Haven could not refresh balances, agents, and activity.')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard is temporarily unavailable.')).not.toBeInTheDocument()
    expect(screen.getByText('Agent preview unavailable')).toBeInTheDocument()
    expect(screen.getByText('Activity preview unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No transactions yet')).not.toBeInTheDocument()
  })
})
