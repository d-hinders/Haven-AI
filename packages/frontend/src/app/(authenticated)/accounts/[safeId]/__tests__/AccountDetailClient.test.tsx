import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseOwnerDirectory = vi.fn()
const mockUseUserSafes = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()
const mockUseSafeDetails = vi.fn()
const mockUsePortfolio = vi.fn()
const mockUseBalances = vi.fn()
const mockUseTransactionsFeed = vi.fn()

vi.mock('next/navigation', () => ({
  useParams: () => ({ safeId: 'safe-1' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/context/OwnerDirectoryContext', () => ({
  useOwnerDirectory: () => mockUseOwnerDirectory(),
}))

vi.mock('@/hooks/useUserSafes', () => ({
  useUserSafes: () => mockUseUserSafes(),
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

vi.mock('@/hooks/useSafeDetails', () => ({
  useSafeDetails: () => mockUseSafeDetails(),
}))

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: () => mockUsePortfolio(),
}))

vi.mock('@/hooks/useBalances', () => ({
  useBalances: () => mockUseBalances(),
}))

vi.mock('@/hooks/useTransactionsFeed', () => ({
  useTransactionsFeed: () => mockUseTransactionsFeed(),
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  default: () => <div>Transactions table</div>,
}))

vi.mock('@/components/SendModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ReceiveFundsModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => null,
}))

import AccountDetailClient from '../AccountDetailClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
}

describe('AccountDetailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555',
        safes: [SAFE],
      },
      activeSafe: SAFE,
      setActiveSafe: vi.fn(),
      loading: false,
      passkeys: [],
    })
    mockUseOwnerDirectory.mockReturnValue({
      getOwnerAlias: (address: string) =>
        address.toLowerCase() === '0x5555555555555555555555555555555555555555'
          ? 'Personal wallet'
          : null,
    })
    mockUseUserSafes.mockReturnValue({
      renameSafe: vi.fn(),
      removeSafe: vi.fn(),
      loading: false,
    })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseContacts.mockReturnValue({
      contacts: [],
      error: null,
      resolveAddress: vi.fn(),
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          safe_id: 'safe-1',
          status: 'active',
          allowances: [
            {
              id: 'allowance-1',
              agent_id: 'agent-1',
              token_address: '0x0000000000000000000000000000000000000000',
              // USDC.e on Gnosis has 6 decimals — raw 100_000_000 = 100.
              // This exercises the decimals formatter we extracted into
              // lib/allowance-format.ts; the old code dumped the raw bigint
              // straight into the label, which is the bug the PR fixes.
              token_symbol: 'USDC.e',
              allowance_amount: '100000000',
              reset_period_min: 1440,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUseSafeDetails.mockReturnValue({
      details: {
        address: SAFE.safe_address,
        owners: ['0x5555555555555555555555555555555555555555'],
        threshold: 1,
        nonce: 1,
      },
      loading: false,
      error: null,
    })
    mockUsePortfolio.mockReturnValue({
      totalUsd: 42,
      totalEur: 39,
      breakdown: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUseBalances.mockReturnValue({
      balances: [],
      error: null,
      refetch: vi.fn(),
    })
    mockUseTransactionsFeed.mockReturnValue({
      transactions: [],
      loadingInitial: false,
      error: null,
      total: 0,
      hasMore: false,
      refresh: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leads with wallet control, agent access, and advanced account details', () => {
    render(<AccountDetailClient />)

    expect(screen.getByRole('heading', { level: 1, name: 'Main account' })).toBeInTheDocument()
    expect(screen.getByText('Control the funds, agent access, and recent activity for this Haven wallet.')).toBeInTheDocument()
    expect(screen.getByText('$42.00')).toBeInTheDocument()
    expect(screen.getByText('1 of 1 approver required')).toBeInTheDocument()
    expect(screen.getByText('Agent access')).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('100.00 USDC.e per day · Not connected yet')).toBeInTheDocument()
    expect(screen.getByText('Advanced account details')).toBeInTheDocument()
    expect(screen.getByText('Approvers')).toBeInTheDocument()
    expect(screen.getByText('Wallet')).toBeInTheDocument()
    expect(screen.getByText('Personal wallet')).toBeInTheDocument()
  })

  it('does not show a zero balance when portfolio data fails', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 0,
      totalEur: 0,
      breakdown: [],
      loading: false,
      error: 'Balances are temporarily unavailable.',
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    expect(screen.getByText('Balances could not load')).toBeInTheDocument()
  })

  it('does not claim there are no agents while agent access is loading', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.queryByText('No agents connected')).not.toBeInTheDocument()
  })

  it('shows a retry state when agent access cannot be verified', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: false,
      error: 'Could not load agents',
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('Agent access could not load')).toBeInTheDocument()
    expect(screen.queryByText('No agents connected')).not.toBeInTheDocument()
  })

  it('shows last-seen metadata for connected agents', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          safe_id: 'safe-1',
          status: 'active',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
          allowances: [
            {
              id: 'allowance-1',
              agent_id: 'agent-1',
              token_address: '0x0000000000000000000000000000000000000000',
              token_symbol: 'USDC.e',
              allowance_amount: '100000000',
              reset_period_min: 1440,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<AccountDetailClient />)

    expect(screen.getByText('100.00 USDC.e per day · Last seen 2h ago')).toBeInTheDocument()
  })
})
