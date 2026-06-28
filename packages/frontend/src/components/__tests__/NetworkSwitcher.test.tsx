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

const BASE_SAFE = { id: 'base-1', chain_id: 8453, name: 'Base account' }
const SEPOLIA_SAFE = { id: 'sep-1', chain_id: 84532, name: 'Sepolia account' }

const mockSetActiveSafe = vi.fn()

function auth(activeSafe: unknown, safes: unknown[]) {
  mockUseAuth.mockReturnValue({
    user: { safes },
    activeSafe,
    setActiveSafe: mockSetActiveSafe,
  })
}

describe('NetworkSwitcher', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockSetActiveSafe.mockReset()
    mockPush.mockReset()
  })

  it('renders nothing before an account exists', () => {
    auth(null, [])
    const { container } = render(<NetworkSwitcher />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the active account and its chain on the chip', () => {
    auth(BASE_SAFE, [BASE_SAFE, SEPOLIA_SAFE])
    render(<NetworkSwitcher />)
    const chip = screen.getByRole('button', { name: /Active account Base account on Base/ })
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveTextContent('Base account')
    expect(chip).toHaveTextContent('Base')
  })

  it('switches the active account when another is picked from the dropdown', () => {
    auth(BASE_SAFE, [BASE_SAFE, SEPOLIA_SAFE])
    render(<NetworkSwitcher />)

    fireEvent.click(screen.getByRole('button', { name: /Active account/ }))
    // Pick the Sepolia account from the open menu.
    fireEvent.click(screen.getByText('Sepolia account'))

    expect(mockSetActiveSafe).toHaveBeenCalledWith(SEPOLIA_SAFE)
  })

  it('routes to Accounts from the manage item', () => {
    auth(BASE_SAFE, [BASE_SAFE])
    render(<NetworkSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Active account/ }))
    fireEvent.click(screen.getByText('Manage accounts'))
    expect(mockPush).toHaveBeenCalledWith('/accounts')
  })
})
