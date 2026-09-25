/**
 * #3295 — the /accounts overview card under a degraded portfolio read, on
 * the RENDERED screen (AC 3). The card fetches its own portfolio through
 * `usePortfolio`, so that hook's mock is the seam.
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockSetActiveSafe = vi.fn()
const mockUseAccounts = vi.fn()
const mockUseAgents = vi.fn()
const mockUsePreferences = vi.fn()
const mockUsePortfolio = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  setActiveAccount: (...args: unknown[]) => mockSetActiveSafe(...args),
}))

vi.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => mockUseAccounts(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: (...args: unknown[]) => mockUsePortfolio(...args),
}))

vi.mock('@/hooks/useDeployableChains', () => ({
  useDeployableChains: () => ({
    chains: [
      { chainId: 8453, name: 'Base' },
      { chainId: 84532, name: 'Base Sepolia' },
    ],
    loading: false,
  }),
}))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, isConnected: false }) }))
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: Object.assign(() => null, { Custom: () => null }),
}))

import AccountsOverviewClient from '../AccountsOverviewClient'

function account(id: string, name: string, chainId: number, isDefault = false) {
  return {
    id,
    account_address: `0x${id.padEnd(40, '0')}`,
    chain_id: chainId,
    name,
    is_default: isDefault,
    created_at: '2026-06-01T00:00:00Z',
  }
}

const BASE = account('base1', 'Base account', 8453, true)

const STALE_AS_OF = '2026-09-25T07:55:00.000Z'

describe('AccountsOverviewClient — degraded balance reads (#3295)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUsePortfolio.mockReturnValue({ totalUsd: 0, totalEur: 0, totalSek: 0, breakdown: [], loading: false })
    mockUseAccounts.mockReturnValue({ accounts: [BASE], loading: false })
    mockUseAuth.mockReturnValue({ activeAccount: BASE, setActiveAccount: mockSetActiveSafe })
  })

  it('shows the last-known total with the stale indicator when a token read failed', () => {
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
    })
    render(<AccountsOverviewClient />)

    const activeCard = screen.getByLabelText('Base account')
    // The last-known figure, never an understated zero, never "Unavailable".
    expect(within(activeCard).getByText('$1,234.56')).toBeInTheDocument()
    expect(within(activeCard).getByText(/as of /)).toBeInTheDocument()
    expect(within(activeCard).queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('an unread token shows "Unavailable" beside the card total rather than a fake zero', () => {
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
    })
    render(<AccountsOverviewClient />)

    const activeCard = screen.getByLabelText('Base account')
    expect(within(activeCard).getByText('Unavailable')).toBeInTheDocument()
    expect(within(activeCard).queryByText(/as of /)).not.toBeInTheDocument()
  })

  it('a clean read renders no indicator at all', () => {
    mockUsePortfolio.mockReturnValue({
      totalUsd: 500,
      totalEur: 460,
      totalSek: 5200,
      breakdown: [
        { symbol: 'USDC', balance: '400000000', formatted: '400.00', usdValue: 400, eurValue: 368, sekValue: 4160 },
        { symbol: 'ETH', balance: '0', formatted: '0.00', usdValue: 100, eurValue: 92, sekValue: 1040 },
      ],
      loading: false,
    })
    render(<AccountsOverviewClient />)

    const activeCard = screen.getByLabelText('Base account')
    expect(within(activeCard).getByText('$500.00')).toBeInTheDocument()
    expect(within(activeCard).queryByText(/as of /)).not.toBeInTheDocument()
    expect(within(activeCard).queryByText('Unavailable')).not.toBeInTheDocument()
  })
})
