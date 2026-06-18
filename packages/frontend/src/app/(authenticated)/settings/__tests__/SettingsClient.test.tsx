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

// ManageApprovers pulls wagmi/signer/api; the page test only cares that the
// Approvers section hosts it. The component has its own focused test.
vi.mock('@/components/settings/ManageApprovers', () => ({
  default: () => <div>Manage approvers component</div>,
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

  it('renders the Access and Recovery sections for a passkey-managed account', () => {
    mockUseAuth.mockReturnValue({
      user: { name: null, email: 'passkey@example.com', wallet_address: null, safes: [] },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })

    render(<SettingsClient />)

    expect(screen.getByText('Access')).toBeInTheDocument()
    expect(screen.getByText('Passkey status')).toBeInTheDocument()
    expect(screen.getByText('Recovery and safety')).toBeInTheDocument()
  })

  it('hosts the per-account approver management under the Approvers section', () => {
    mockUseAuth.mockReturnValue({
      user: { name: 'Ada', email: 'ada@example.com', wallet_address: null, safes: [] },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })

    render(<SettingsClient />)

    expect(screen.getByText('Approvers')).toBeInTheDocument()
    expect(screen.getByText('Manage approvers component')).toBeInTheDocument()
  })

  it('links profile management to the profile page', () => {
    mockUseAuth.mockReturnValue({
      user: { name: 'Ada Lovelace', email: 'ada@example.com', wallet_address: null, safes: [] },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })

    render(<SettingsClient />)

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', '/profile')
  })
})
