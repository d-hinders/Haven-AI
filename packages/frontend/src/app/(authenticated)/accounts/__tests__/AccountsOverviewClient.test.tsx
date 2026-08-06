import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockUseAuth,
  mockUseUserSafes,
  mockUseAgents,
  mockUsePreferences,
  mockSetActiveSafe,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseUserSafes: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUsePreferences: vi.fn(),
  mockSetActiveSafe: vi.fn(),
}))

vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))
vi.mock('@/hooks/useUserSafes', () => ({ useUserSafes: () => mockUseUserSafes() }))
vi.mock('@/hooks/useAgents', () => ({ useAgents: () => mockUseAgents() }))
vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => mockUsePreferences() }))
vi.mock('@/hooks/usePortfolio', () => ({
  usePortfolio: () => ({ totalUsd: 0, totalEur: 0, breakdown: [], loading: false }),
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

function safe(id: string, name: string, chainId: number, isDefault = false) {
  return {
    id,
    safe_address: `0x${id.padEnd(40, '0')}`,
    chain_id: chainId,
    name,
    is_default: isDefault,
    created_at: '2026-06-01T00:00:00Z',
  }
}

const BASE = safe('base1', 'Base account', 8453, true)
const SEPOLIA = safe('sep1', 'Sepolia account', 84532)

describe('AccountsOverviewClient — active account (#629)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseUserSafes.mockReturnValue({
      safes: [BASE, SEPOLIA],
      loading: false,
      addSafe: vi.fn(),
      setDefault: vi.fn(),
    })
    mockUseAuth.mockReturnValue({ activeSafe: BASE, setActiveSafe: mockSetActiveSafe })
  })

  it('marks the active account and offers Set active only on the others', () => {
    render(<AccountsOverviewClient />)

    const activeCard = screen.getByLabelText('Base account')
    expect(within(activeCard).getByText('Active')).toBeInTheDocument()
    // The active card has no "set active" affordance.
    expect(within(activeCard).queryByLabelText(/Set Base account as active/)).toBeNull()

    // The other card offers a switch.
    expect(screen.getByLabelText('Set Sepolia account as active')).toBeInTheDocument()
  })

  it('switches the active account via Set active without navigating', () => {
    render(<AccountsOverviewClient />)

    fireEvent.click(screen.getByLabelText('Set Sepolia account as active'))
    expect(mockSetActiveSafe).toHaveBeenCalledWith(SEPOLIA)
  })
})
