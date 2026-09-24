import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockPush = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import NetworkSwitcher from '@/components/NetworkSwitcher'

const BASE_ACCOUNT = { id: 'base-1', chain_id: 8453, name: 'Base account' }
const SEPOLIA_ACCOUNT = { id: 'sep-1', chain_id: 84532, name: 'Sepolia account' }

const mockSetActiveAccount = vi.fn()

function auth(activeAccount: unknown, accounts: unknown[]) {
  mockUseAuth.mockReturnValue({
    user: { accounts },
    activeAccount,
    setActiveAccount: mockSetActiveAccount,
  })
}

describe('NetworkSwitcher', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockSetActiveAccount.mockReset()
    mockPush.mockReset()
  })

  it('renders nothing before an account exists', () => {
    auth(null, [])
    const { container } = render(<NetworkSwitcher />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the active account and its chain on the chip', () => {
    auth(BASE_ACCOUNT, [BASE_ACCOUNT, SEPOLIA_ACCOUNT])
    render(<NetworkSwitcher />)
    const chip = screen.getByRole('button', { name: /Active account Base account on Base/ })
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveTextContent('Base account')
    expect(chip).toHaveTextContent('Base')
  })

  it('switches the active account when another is picked from the dropdown', () => {
    auth(BASE_ACCOUNT, [BASE_ACCOUNT, SEPOLIA_ACCOUNT])
    render(<NetworkSwitcher />)

    fireEvent.click(screen.getByRole('button', { name: /Active account/ }))
    // Pick the Sepolia account from the open menu.
    fireEvent.click(screen.getByText('Sepolia account'))

    expect(mockSetActiveAccount).toHaveBeenCalledWith(SEPOLIA_ACCOUNT)
  })

  it('routes to Accounts from the manage item', () => {
    auth(BASE_ACCOUNT, [BASE_ACCOUNT])
    render(<NetworkSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Active account/ }))
    fireEvent.click(screen.getByText('Manage accounts'))
    expect(mockPush).toHaveBeenCalledWith('/accounts')
  })
})
