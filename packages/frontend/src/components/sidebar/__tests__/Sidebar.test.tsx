import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseApprovals = vi.fn()
const mockUsePathname = vi.fn()
const mockPush = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useApprovals', () => ({
  useApprovals: () => mockUseApprovals(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import Sidebar from '@/components/sidebar/Sidebar'

describe('Sidebar', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUseApprovals.mockReset()
    mockUsePathname.mockReset()
    mockPush.mockReset()

    mockUsePathname.mockReturnValue('/dashboard')
    mockUseApprovals.mockReturnValue({ actionableCount: 0 })
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [],
      },
      logout: vi.fn(),
    })
  })

  it('opens profile from the bottom-left identity area', () => {
    render(<Sidebar />)

    const profileLink = screen.getByRole('link', { name: 'Open profile for Ada Lovelace' })
    expect(profileLink).toHaveAttribute('href', '/profile')
  })

  it('shows Profile, Settings, and sign out in the account menu', async () => {
    const user = userEvent.setup()
    const logout = vi.fn()
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [],
      },
      logout,
    })
    render(<Sidebar />)

    await user.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    expect(logout).toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/')
  })
})
