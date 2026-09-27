/**
 * #3295 — the /accounts/[id] detail screen under a degraded portfolio read,
 * on the RENDERED screen (AC 3). `usePortfolio` feeds both the headline and
 * the token table, so its mock is the seam.
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseAccounts = vi.fn()
const mockUseBalances = vi.fn()
const mockUseTransactionsFeed = vi.fn()
const mockUsePortfolio = vi.fn()
const mockUsePreferences = vi.fn()
const mockUseContacts = vi.fn()
const mockUseAgents = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ accountId: 'account-1' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => mockUseAccounts(),
}))

vi.mock('@/hooks/useBalances', () => ({
  useBalances: () => mockUseBalances(),
}))

vi.mock('@/hooks/useTransactionsFeed', () => ({
  useTransactionsFeed: () => mockUseTransactionsFeed(),
}))

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: (...args: unknown[]) => mockUsePortfolio(...args),
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

vi.mock('@/components/AccountSignersCard', () => ({
  default: () => <div data-testid="signers-card" />,
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  default: () => <div data-testid="transactions-table" />,
}))

vi.mock('@/components/DelegationSendModal', () => ({
  default: () => null,
}))

vi.mock('@/components/ReceiveFundsModal', () => ({
  default: () => null,
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

import AccountDetailClient from '../AccountDetailClient'

const ACCOUNT = {
  id: 'account-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
}

const STALE_AS_OF = '2026-09-25T07:55:00.000Z'

function mockBaseState() {
  mockUseAuth.mockReturnValue({
    user: {
      id: 'user-1',
      email: 'ada@example.com',
      accounts: [ACCOUNT],
    },
    activeAccount: ACCOUNT,
    setActiveAccount: vi.fn(),
    loading: false,
    passkeys: [],
  })
  mockUseAccounts.mockReturnValue({
    renameAccount: vi.fn(),
    removeAccount: vi.fn(),
    setDefault: vi.fn(),
    loading: false,
  })
  mockUsePreferences.mockReturnValue({ currency: 'USD' })
  mockUseContacts.mockReturnValue({
    contacts: [],
    error: null,
    resolveAddress: vi.fn(() => null),
  })
  mockUseAgents.mockReturnValue({ agents: [], loading: false, error: null, refetch: vi.fn() })
  mockUseBalances.mockReturnValue({ balances: [], error: null, refetch: vi.fn() })
  mockUseTransactionsFeed.mockReturnValue({
    transactions: [],
    loadingInitial: false,
    error: null,
    total: 0,
    hasMore: false,
    truncated: false,
    refresh: vi.fn(),
  })
}

describe('AccountDetailClient — degraded balance reads (#3295)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBaseState()
  })

  it('shows the last-known headline with the stale indicator and per-token markers', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 1234.56,
      totalEur: 1100,
      totalSek: 13000.5,
      breakdown: [
        {
          symbol: 'USDC',
          balance: '1200000000',
          formatted: '1200.00',
          usdValue: 1200,
          eurValue: 1069,
          sekValue: 12636,
          balanceFreshness: { status: 'stale', asOf: STALE_AS_OF },
        },
        { symbol: 'ETH', balance: '0', formatted: '0.00', usdValue: 34.56, eurValue: 31, sekValue: 364.5 },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    render(<AccountDetailClient />)

    // Headline: the last-known total with a subtle "as of …", never
    // "Unavailable" and never an unmarked understated figure.
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getAllByText(/as of /).length).toBeGreaterThan(0)
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()

    // The degraded TOKEN row shows its own indicator beside the figure.
    const row = screen.getByText('1200.00').closest('div.grid') as HTMLElement
    expect(within(row).getByText(/as of /)).toBeInTheDocument()
    // The fresh token row carries none.
    const ethRow = screen.getByText('0.00').closest('div.grid') as HTMLElement
    expect(within(ethRow).queryByText(/as of /)).not.toBeInTheDocument()
  })

  it('an unread token shows "Unavailable" in its row, not a bare zero', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 0,
      totalEur: 0,
      totalSek: 0,
      breakdown: [
        {
          symbol: 'USDC',
          balance: '0',
          formatted: '0.00',
          usdValue: 0,
          eurValue: 0,
          sekValue: 0,
          balanceFreshness: { status: 'unavailable' },
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    render(<AccountDetailClient />)

    const row = screen.getByText('0.00').closest('div.grid') as HTMLElement
    expect(within(row).getByText('Unavailable')).toBeInTheDocument()
    // No fake timestamp for a token that has never been read.
    expect(within(row).queryByText(/as of /)).not.toBeInTheDocument()
  })

  it('a clean read renders no indicator anywhere', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 500,
      totalEur: 460,
      totalSek: 5200,
      breakdown: [
        { symbol: 'USDC', balance: '400000000', formatted: '400.00', usdValue: 400, eurValue: 368, sekValue: 4160 },
        { symbol: 'ETH', balance: '0', formatted: '0.00', usdValue: 100, eurValue: 92, sekValue: 1040 },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    render(<AccountDetailClient />)

    expect(screen.getByText('$500.00')).toBeInTheDocument()
    expect(screen.queryByText(/as of /)).not.toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })
})
