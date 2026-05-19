import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockApiPut = vi.hoisted(() => vi.fn())

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/lib/api', () => {
  const ApiRequestError = class extends Error {
    status: number

    constructor(message: string, status = 400) {
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

import { ApiRequestError } from '@/lib/api'
import ProfileClient from '@/app/(authenticated)/profile/ProfileClient'

describe('ProfileClient', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockApiPut.mockReset()

    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        wallet_address: null,
        safe_address: null,
        safes: [],
        created_at: '2025-01-15T12:00:00.000Z',
      },
      updateUser: vi.fn(),
    })
  })

  it('renders the current profile details', () => {
    render(<ProfileClient />)

    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('January 15, 2025')).toBeInTheDocument()
    expect(screen.getByText('Haven account')).toBeInTheDocument()
  })

  it('updates the user name', async () => {
    const user = userEvent.setup()
    const updateUser = vi.fn()
    mockApiPut.mockResolvedValue({ name: 'Grace Hopper' })
    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        wallet_address: null,
        safe_address: null,
        safes: [],
        created_at: '2025-01-15T12:00:00.000Z',
      },
      updateUser,
    })

    render(<ProfileClient />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), ' Grace   Hopper ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/user/profile', { name: 'Grace Hopper' })
    })
    expect(updateUser).toHaveBeenCalledWith({ name: 'Grace Hopper' })
    expect(screen.getByText('Name updated.')).toBeInTheDocument()
  })

  it('shows a validation error before saving an empty name', async () => {
    const user = userEvent.setup()

    render(<ProfileClient />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Name'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Enter a name for your Haven account.')).toBeInTheDocument()
    expect(mockApiPut).not.toHaveBeenCalled()
  })

  it('shows an API error when the name cannot be saved', async () => {
    const user = userEvent.setup()
    mockApiPut.mockRejectedValue(new ApiRequestError('We could not save your name right now.', 500))

    render(<ProfileClient />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Grace Hopper')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('We could not save your name right now.')).toBeInTheDocument()
  })
})
