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

const mockToastSuccess = vi.fn()
const mockToastError = vi.fn()
const mockToastInfo = vi.fn()
vi.mock('@/components/ui/Toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/Toast')>(
    '@/components/ui/Toast',
  )
  return {
    ...actual,
    useToast: () => ({
      toast: Object.assign(vi.fn(), {
        success: mockToastSuccess,
        error: mockToastError,
        info: mockToastInfo,
      }),
      dismiss: vi.fn(),
      toasts: [],
    }),
  }
})

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
    loading: false,
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
    window.sessionStorage.clear()
    mockBaseState()
  })

  it('leads with total balance, primary actions, attention, and metric cards', () => {
    render(<DashboardClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('2 agent payments need your action')).toBeInTheDocument()
    expect(screen.getByText('Agents connected')).toBeInTheDocument()
    expect(screen.getByText('Monthly agent spend')).toBeInTheDocument()
    expect(screen.getByText('$42.00')).toBeInTheDocument()
    expect(screen.getByText('Successful transactions')).toBeInTheDocument()
    expect(screen.getByText('Active accounts')).toBeInTheDocument()
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
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
  })

  it('does not show the unfunded receive CTA before balances finish loading', () => {
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: true,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive funds' })).not.toBeInTheDocument()
    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
  })

  it('shows a focused first-run guide instead of the full dashboard when the account needs funds', () => {
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
    expect(screen.queryByText('Agents connected')).not.toBeInTheDocument()
    expect(screen.queryByText('Recent transactions')).not.toBeInTheDocument()
    expect(screen.queryByText('Monthly agent spend')).not.toBeInTheDocument()
  })

  it('does not persist first-run guide dismissal across browser sessions', () => {
    window.localStorage.setItem('haven_dashboard_onboarding_dismissed:user-1:fund', '1')
    mockUseAggregatedBalances.mockReturnValue({
      balances: [],
      loading: false,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('Onboarding guide')).toBeInTheDocument()
  })

  it('does not show the connect-agent guide before agents finish loading', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.queryByText('Onboarding guide')).not.toBeInTheDocument()
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

  describe('first-arrival welcome toast', () => {
    it('fires a welcome toast and clears the flag when arriving from onboarding', () => {
      window.sessionStorage.setItem('haven-just-onboarded', '1')

      render(<DashboardClient />)

      expect(mockToastSuccess).toHaveBeenCalledOnce()
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Welcome to Haven, Ada — your account is live.',
      )
      // Flag is consumed so a refresh later in the session does NOT re-fire.
      expect(window.sessionStorage.getItem('haven-just-onboarded')).toBeNull()
    })

    it('does not fire the welcome toast on a normal dashboard render', () => {
      // No session flag set.
      render(<DashboardClient />)

      expect(mockToastSuccess).not.toHaveBeenCalledWith(
        expect.stringContaining('Welcome to Haven'),
      )
    })

    it('falls back silently when sessionStorage is unavailable', () => {
      // Simulate private-browsing-style failure on read.
      const getSpy = vi
        .spyOn(window.sessionStorage.__proto__, 'getItem')
        .mockImplementation(() => {
          throw new Error('sessionStorage disabled')
        })

      expect(() => render(<DashboardClient />)).not.toThrow()
      expect(mockToastSuccess).not.toHaveBeenCalledWith(
        expect.stringContaining('Welcome to Haven'),
      )

      getSpy.mockRestore()
    })
  })
})
