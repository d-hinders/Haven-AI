import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUseOwnerDirectory = vi.fn()
const mockUsePreferences = vi.fn()
const mockPush = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/context/OwnerDirectoryContext', () => ({
  useOwnerDirectory: () => mockUseOwnerDirectory(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

const mockApiPut = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => {
  const ApiRequestError = class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = 'ApiRequestError'
      this.status = status
    }
  }
  return {
    api: { put: mockApiPut },
    ApiRequestError,
  }
})

import SettingsClient from '@/app/(authenticated)/settings/SettingsClient'

describe('SettingsClient', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUsePreferences.mockReset()
    mockPush.mockReset()
    mockApiPut.mockReset()

    mockUsePreferences.mockReturnValue({
      currency: 'USD',
      setCurrency: vi.fn(),
      saving: false,
    })
    mockUseOwnerDirectory.mockReturnValue({
      owners: [],
      loading: false,
      error: null,
      partialFailure: false,
      failedSafeIds: [],
      renameOwner: vi.fn(),
      clearOwner: vi.fn(),
    })
  })

  it('shows a passkey-friendly wallet value when the user has no wallet address', () => {
    mockUseAuth.mockReturnValue({
      user: {
        name: null,
        email: 'passkey@example.com',
        wallet_address: null,
        safes: [],
      },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })

    render(<SettingsClient />)

    expect(screen.getAllByText('Connected wallet').length).toBeGreaterThan(0)
    expect(screen.getByText('Passkey-managed account')).toBeInTheDocument()
    expect(screen.getByText('Recovery and safety')).toBeInTheDocument()
  })

  it('shows and updates the user name', async () => {
    const user = userEvent.setup()
    const updateUser = vi.fn()
    mockApiPut.mockResolvedValue({ name: 'Grace Hopper' })
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        wallet_address: null,
        safes: [],
      },
      passkeys: [],
      logout: vi.fn(),
      updateUser,
    })

    render(<SettingsClient />)

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), ' Grace   Hopper ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/user/profile', { name: 'Grace Hopper' })
    })
    expect(updateUser).toHaveBeenCalledWith({ name: 'Grace Hopper' })
  })

  it('shows approvers and saves an approver alias', async () => {
    const user = userEvent.setup()
    const renameOwner = vi.fn().mockResolvedValue(undefined)
    mockUseOwnerDirectory.mockReturnValue({
      owners: [
        {
          owner_address: '0x5555555555555555555555555555555555555555',
          name: null,
          accounts: [
            {
              id: 'safe-1',
              safe_address: '0x1111111111111111111111111111111111111111',
              chain_id: 100,
              name: 'Main account',
            },
          ],
        },
      ],
      loading: false,
      error: null,
      partialFailure: false,
      failedSafeIds: [],
      renameOwner,
      clearOwner: vi.fn(),
    })
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        wallet_address: '0x5555555555555555555555555555555555555555',
        safes: [
          {
            id: 'safe-1',
            safe_address: '0x1111111111111111111111111111111111111111',
            chain_id: 100,
            name: 'Main account',
          },
        ],
      },
      passkeys: [],
      logout: vi.fn(),
      updateUser: vi.fn(),
    })

    render(<SettingsClient />)

    expect(screen.getByText('Approvers')).toBeInTheDocument()
    expect(screen.getByText('Listed')).toBeInTheDocument()
    expect(screen.getAllByText('Connected wallet').length).toBeGreaterThan(0)
    expect(screen.getByText('Main account · Gnosis Chain')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Name' }))
    await user.type(screen.getByLabelText('Name for 0x5555...5555'), ' Ledger   main ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(renameOwner).toHaveBeenCalledWith(
        '0x5555555555555555555555555555555555555555',
        'Ledger main',
      )
    })
  })
})
