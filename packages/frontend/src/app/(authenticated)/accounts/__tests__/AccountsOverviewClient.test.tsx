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

/**
 * The dashboard half of the inflow closure (#1984, epic #1440).
 *
 * `AddSafeModal` was the only place in the signed-in app that could mint or
 * attach a Safe: a three-mode modal (choose / deploy / import) reached from
 * an "Add account" button in the page header and from the empty state's
 * "Add your first account". Both routes it called now answer 410, so the
 * trigger is gone with the modal. Asserting the ABSENCE of an affordance is
 * weak by nature, so this asserts it in both states the page can be in and
 * on both the accessible name and the modal's own headings — the specific
 * strings a reintroduction would have to render.
 */
describe('AccountsOverviewClient — the Safe inflow is closed (#1984)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAgents.mockReturnValue({ agents: [] })
    mockUsePreferences.mockReturnValue({ currency: 'USD' })
    mockUseAuth.mockReturnValue({ activeSafe: BASE, setActiveSafe: mockSetActiveSafe })
  })

  it('offers no Add-account entry point when accounts exist', () => {
    mockUseUserSafes.mockReturnValue({
      safes: [BASE, SEPOLIA],
      loading: false,
      setDefault: vi.fn(),
    })

    render(<AccountsOverviewClient />)

    // The cards still render — this is a read/manage surface, not a deletion.
    expect(screen.getByLabelText('Base account')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /add account/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /add your first account/i })).toBeNull()
    expect(screen.queryByText('Import existing account')).toBeNull()
    expect(screen.queryByText('Create Haven account')).toBeNull()
  })

  it('offers no Add-account entry point from the empty state either', () => {
    mockUseUserSafes.mockReturnValue({ safes: [], loading: false, setDefault: vi.fn() })

    render(<AccountsOverviewClient />)

    expect(screen.getByText('No Haven accounts yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull()
    expect(screen.queryByText('Import existing account')).toBeNull()
  })
})
