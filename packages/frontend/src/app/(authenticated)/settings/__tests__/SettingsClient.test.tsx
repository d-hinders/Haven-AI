import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUsePreferences = vi.fn()
const mockPush = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

import SettingsClient from '@/app/(authenticated)/settings/SettingsClient'

describe('SettingsClient', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUsePreferences.mockReset()
    mockPush.mockReset()

    mockUsePreferences.mockReturnValue({
      currency: 'USD',
      setCurrency: vi.fn(),
      saving: false,
    })
  })

  it('shows a passkey-friendly wallet value when the user has no wallet address', () => {
    mockUseAuth.mockReturnValue({
      user: {
        email: 'passkey@example.com',
        wallet_address: null,
        safes: [],
      },
      passkeys: [],
      logout: vi.fn(),
    })

    render(<SettingsClient />)

    expect(screen.getByText('Connected Wallet')).toBeInTheDocument()
    expect(screen.getByText('Passkey-managed account')).toBeInTheDocument()
  })
})
