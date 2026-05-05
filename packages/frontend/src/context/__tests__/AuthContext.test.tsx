import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor, act } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import type { ReactNode } from 'react'
import { passkeyStorageKey } from '@/lib/signer'

// Mock the api module
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
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      listPasskeys: vi.fn(),
    },
    ApiRequestError,
  }
})

import { api } from '@/lib/api'

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  listPasskeys: ReturnType<typeof vi.fn>
}

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  wallet_address: null,
  safe_address: null,
  safes: [],
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.listPasskeys.mockResolvedValue({ passkeys: [] })
  })

  it('login() stores token in localStorage and sets user state', async () => {
    mockApi.get.mockRejectedValue(new Error('no token'))
    mockApi.post.mockResolvedValue({
      token: 'jwt-token',
      user: mockUser,
    })

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      const user = await result.current.login('test@example.com', 'password')
      expect(user).toEqual(mockUser)
    })

    expect(localStorage.setItem).toHaveBeenCalledWith('haven_token', 'jwt-token')
    expect(result.current.user).toEqual(mockUser)
    expect(result.current.token).toBe('jwt-token')
  })

  it('logout() clears token and user', async () => {
    mockApi.get.mockRejectedValue(new Error('no token'))

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.loading).toBe(false))

    // First login
    mockApi.post.mockResolvedValue({ token: 'jwt-token', user: mockUser })
    await act(async () => {
      await result.current.login('test@example.com', 'password')
    })
    expect(result.current.user).toEqual(mockUser)

    // Then logout
    act(() => {
      result.current.logout()
    })

    expect(localStorage.removeItem).toHaveBeenCalledWith('haven_token')
    expect(result.current.user).toBeNull()
    expect(result.current.token).toBeNull()
  })

  it('signup() calls the API and returns response', async () => {
    mockApi.get.mockRejectedValue(new Error('no token'))
    mockApi.post.mockResolvedValue({
      token: 'jwt-token',
      user: mockUser,
    })

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.loading).toBe(false))

    let response: unknown
    await act(async () => {
      response = await result.current.signup('test@example.com', 'password')
    })

    expect(mockApi.post).toHaveBeenCalledWith('/auth/signup', {
      email: 'test@example.com',
      password: 'password',
    })
    expect(response).toEqual(mockUser)
  })

  it('useAuth() throws when used outside AuthProvider', () => {
    // Suppress console.error for the expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => {
      renderHook(() => useAuth())
    }).toThrow('useAuth must be used within an AuthProvider')

    spy.mockRestore()
  })

  it('on mount with existing token, fetches /auth/me to restore session', async () => {
    localStorage.setItem('haven_token', 'existing-token')
    mockApi.get.mockResolvedValue(mockUser)

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApi.get).toHaveBeenCalledWith('/auth/me')
    expect(result.current.user).toEqual(mockUser)
  })

  it('hydrates stored passkeys for known device credentials on session restore', async () => {
    const userWithSafe = {
      ...mockUser,
      safes: [
        {
          id: 'safe-1',
          safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
          chain_id: 100,
          name: 'Main Safe',
          is_default: true,
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    }

    localStorage.setItem('haven_token', 'existing-token')
    localStorage.setItem('haven_passkey_device_credential-123', '1')
    mockApi.get.mockResolvedValue(userWithSafe)
    mockApi.listPasskeys.mockResolvedValue({
      passkeys: [
        {
          id: 'passkey-1',
          credential_id: 'credential-123',
          signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
          chain_id: 100,
          safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    })

    renderHook(() => useAuth(), { wrapper })

    await waitFor(() => {
      expect(localStorage.setItem).toHaveBeenCalledWith(
        passkeyStorageKey('0x07058311f995c89F4DbE17Db61fa1A3CDe638975', 100),
        expect.stringContaining('"schemaVersion":1'),
      )
    })
  })

  it('clears stored passkey entries for all safes on logout', async () => {
    mockApi.get.mockRejectedValue(new Error('no token'))
    const userWithSafes = {
      ...mockUser,
      safes: [
        {
          id: 'safe-1',
          safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
          chain_id: 100,
          name: 'Main Safe',
          is_default: true,
          created_at: '2026-05-04T00:00:00.000Z',
        },
        {
          id: 'safe-2',
          safe_address: '0x1111111111111111111111111111111111111111',
          chain_id: 8453,
          name: 'Base Safe',
          is_default: false,
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    }

    mockApi.post.mockResolvedValue({ token: 'jwt-token', user: userWithSafes })

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.login('test@example.com', 'password')
    })

    act(() => {
      result.current.logout()
    })

    expect(localStorage.removeItem).toHaveBeenCalledWith(
      passkeyStorageKey('0x07058311f995c89F4DbE17Db61fa1A3CDe638975', 100),
    )
    expect(localStorage.removeItem).toHaveBeenCalledWith(
      passkeyStorageKey('0x1111111111111111111111111111111111111111', 8453),
    )
  })
})
