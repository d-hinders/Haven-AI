import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { LOCALE_STORAGE_KEY } from '@/lib/i18n'

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

function renderSettings() {
  return render(
    <LocaleProvider>
      <SettingsClient />
    </LocaleProvider>,
  )
}

describe('SettingsClient', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUsePreferences.mockReset()
    mockPush.mockReset()
    window.localStorage.clear()

    mockUsePreferences.mockReturnValue({
      currency: 'USD',
      setCurrency: vi.fn(),
      saving: false,
    })
    mockUseAuth.mockReturnValue({
      user: { name: null, email: 'passkey@example.com', wallet_address: null, safes: [] },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })
  })

  it('renders the Access and Recovery sections for a passkey-managed account', () => {
    renderSettings()

    expect(screen.getByText('Access')).toBeInTheDocument()
    expect(screen.getByText('Passkey status')).toBeInTheDocument()
    expect(screen.getByText('Recovery and safety')).toBeInTheDocument()
  })

  it('hosts the per-account approver management under the Approvers section', () => {
    renderSettings()

    expect(screen.getByText('Approvers')).toBeInTheDocument()
    expect(screen.getByText('Manage approvers component')).toBeInTheDocument()
  })

  it('links profile management to the profile page', () => {
    renderSettings()

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View profile' })).toHaveAttribute('href', '/profile')
  })

  it('offers a language toggle and switches the UI copy to Swedish on select', async () => {
    renderSettings()

    // Defaults to English copy.
    expect(screen.getByText('Preferred currency')).toBeInTheDocument()

    // The language control exposes English + Svenska as radio options.
    const swedish = screen.getByRole('radio', { name: 'Svenska' })
    fireEvent.click(swedish)

    // Copy flips to Swedish and the choice is persisted device-local.
    await waitFor(() => expect(screen.getByText('Föredragen valuta')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Visa profil' })).toBeInTheDocument()
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('sv')
  })

  it('restores a previously chosen language from storage', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'sv')
    renderSettings()

    await waitFor(() => expect(screen.getByText('Åtkomst')).toBeInTheDocument())
  })
})
