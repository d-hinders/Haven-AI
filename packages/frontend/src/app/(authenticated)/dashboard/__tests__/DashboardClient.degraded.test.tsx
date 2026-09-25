/**
 * #3295 — the dashboard hero under a degraded balance read, on the RENDERED
 * screen (AC 3). The dashboard reads `useAggregatedBalances` (never
 * `useAggregatedPortfolio` — no screen calls that hook) for the funding
 * state, and `/dashboard/overview` for the headline figure, so both seams
 * carry the #3295 markers here.
 */
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
const mockUseAccountOperationGate = vi.fn()

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

vi.mock('@/hooks/useAccountOperationGate', () => ({
  useAccountOperationGate: () => mockUseAccountOperationGate(),
}))

vi.mock('@/components/DashboardOnboardingGuide', () => ({
  default: () => null,
}))

vi.mock('@/components/ConnectAgentModal', () => ({
  default: () => null,
}))

vi.mock('@/components/DashboardActionPickerModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ReceiveFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/AddFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/PasskeyOtherDeviceNotice', () => ({
  default: () => <div>Use another device</div>,
}))

vi.mock('@/components/ui/Toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/Toast')>(
    '@/components/ui/Toast',
  )
  return {
    ...actual,
    useToast: () => ({
      toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
      dismiss: vi.fn(),
      toasts: [],
    }),
  }
})

import DashboardClient from '../DashboardClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
  account_type: 'delegator_hybrid' as const,
}

const STALE_AS_OF = '2026-09-25T07:55:00.000Z'

function overviewWith(change: Record<string, unknown>) {
  return {
    totals: { usd: 1234.56, eur: 1100, sek: 13000.5 },
    change: {
      available: true,
      usdAmount: 12.34,
      eurAmount: 11,
      sekAmount: 120,
      usdPercent: 1.23,
      eurPercent: 1,
      sekPercent: 0.9,
      ...change,
    },
    metrics: {
      connectedAgents: 1,
      monthlyAgentSpendUsd: 42,
      monthlyAgentSpendEur: 38,
      monthlyAgentSpendSek: 440,
      successfulTransactions: 4,
      activeAccounts: 1,
    },
    actionableApprovals: 0,
    pendingApprovals: 0,
    onboardingProgress: { hasFirstAgentPayment: false },
    agents: [],
    transactions: [],
  }
}

function mockBaseState() {
  mockUseAuth.mockReturnValue({
    user: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      wallet_address: '0x5555555555555555555555555555555555555555',
      accounts: [SAFE],
    },
    activeAccount: SAFE,
    passkeys: [],
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
    balances: [{ symbol: 'USDC', balance: '1000000', decimals: 6 }],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseDashboardOverview.mockReturnValue({
    data: overviewWith({}),
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
  mockUseBalances.mockReturnValue({ balances: [], loading: false, error: null, refetch: vi.fn() })
  mockUseSafeDetails.mockReturnValue({ details: null, loading: false, error: null })
  mockUseAccountOperationGate.mockReturnValue({ kind: 'ready' })
}

describe('DashboardClient — degraded balance reads (#3295)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    mockBaseState()
  })

  it('shows the headline figure with the stale indicator when the aggregated read is stale', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: overviewWith({ balancesFreshness: { status: 'stale', asOf: STALE_AS_OF } }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    // The last-known figure, NOT "Unavailable" and NOT a zero.
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    // The subtle stale indicator: a quiet "as of …", never an alarm.
    expect(screen.getByText(/as of /)).toBeInTheDocument()
  })

  it('keeps the change line for a merely stale aggregate — last-known figures diff normally', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: overviewWith({ balancesFreshness: { status: 'stale', asOf: STALE_AS_OF } }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    expect(screen.getByText('+$12.34 (+1.23%) today')).toBeInTheDocument()
  })

  it('reports the change as unavailable when some token has no known value — never a swing from a zero', () => {
    mockUseDashboardOverview.mockReturnValue({
      data: overviewWith({ usdAmount: null, eurAmount: null, sekAmount: null, balancesFreshness: { status: 'unavailable' } }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    // The figure still renders (never an understated zero), but no swing is
    // claimed from a total understated by an unknown amount.
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.queryByText('+$12.34 (+1.23%) today')).not.toBeInTheDocument()
    expect(screen.getByText('Across all linked Haven accounts.')).toBeInTheDocument()
    // 'unavailable' renders the word, not a fake timestamp.
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText(/as of /)).not.toBeInTheDocument()
  })

  it('a failed read with a known balance never sends a funded user to the Fund step (AC 4)', () => {
    // One token's last-known balance is 1 USDC; another token's read has
    // never succeeded. The account holds funds and must read as funded.
    mockUseAggregatedBalances.mockReturnValue({
      balances: [
        { symbol: 'USDC', balance: '1000000', decimals: 6, balanceFreshness: { status: 'stale', asOf: STALE_AS_OF } },
        { symbol: 'ETH', balance: '0', decimals: 18, balanceFreshness: { status: 'unavailable' } },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    // Funding KNOWN + has funds → the funded action order ("Receive"), never
    // the unfunded prompt ("Receive funds").
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive funds' })).not.toBeInTheDocument()
  })

  it('all-zero balances with an unread token count as funding-unknown, not unfunded (AC 4)', () => {
    // Every balance string is a filler zero and one read has never succeeded:
    // the account LOOKS empty but might not be — the hero must not claim the
    // funding state is known.
    mockUseAggregatedBalances.mockReturnValue({
      balances: [
        { symbol: 'USDC', balance: '0', decimals: 6, balanceFreshness: { status: 'unavailable' } },
        { symbol: 'ETH', balance: '0', decimals: 18, balanceFreshness: { status: 'unavailable' } },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<DashboardClient />)

    // fundingStateKnown=false → the NEUTRAL action order, not "Receive funds".
    expect(screen.queryByRole('button', { name: 'Receive funds' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument()
  })

  it('a clean read renders no indicator and keeps the change line', () => {
    render(<DashboardClient />)

    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.queryByText(/as of /)).not.toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
    expect(screen.getByText('+$12.34 (+1.23%) today')).toBeInTheDocument()
  })
})
