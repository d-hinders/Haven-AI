import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import type { ReactNode } from 'react'

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
    },
    ApiRequestError,
  }
})

import { api } from '@/lib/api'

const mockApi = api as {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
}

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  wallet_address: null,
  safe_address: null,
}

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    const signupResponse = { id: 'user-1', email: 'test@example.com' }
    mockApi.post.mockResolvedValue(signupResponse)

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
    expect(response).toEqual(signupResponse)
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
})
