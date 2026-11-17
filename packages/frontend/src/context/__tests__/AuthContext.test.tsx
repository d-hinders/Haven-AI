import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor, act } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import type { ReactNode } from 'react'
import { passkeyStorageKey } from '@/lib/signer'
import { clearEntryLatches, hasEntered, markEntered } from '@/lib/entry-latch'

// #4827: `clearEntryLatches` is counted, not replaced — the real one still runs
// so `hasEntered` keeps telling the truth.
vi.mock('@/lib/entry-latch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entry-latch')>()
  return {
    ...actual,
    clearEntryLatches: vi.fn(actual.clearEntryLatches),
  }
})

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
    // #4827: the API client's 401 reaction. The mocked `api.get` never reaches
    // the real client, so the load-time 401 is handled by AuthContext's own
    // catch — which is the same one-sign-out path the real handler lands on.
    setSessionExpiredHandler: vi.fn(),
  }
})

import { api, ApiRequestError, setSessionExpiredHandler } from '@/lib/api'

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  listPasskeys: ReturnType<typeof vi.fn>
}

const mockUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'test@example.com',
  wallet_address: null,
  account_address: null,
  accounts: [],
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

  // #4704: signing back in is an entrance again (the balance counts up), so
  // both ways a session ends clear this tab's entry latches.
  it('logout() clears the entry latch, so signing back in is an entrance', async () => {
    mockApi.get.mockRejectedValue(new Error('no token'))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    mockApi.post.mockResolvedValue({ token: 'jwt-token', user: mockUser })
    await act(async () => {
      await result.current.login('test@example.com', 'password')
    })
    markEntered('count-up', mockUser.id)
    act(() => {
      result.current.logout()
    })
    expect(hasEntered('count-up', mockUser.id)).toBe(false)
  })

  it('an expired session clears the entry latch too', async () => {
    markEntered('count-up', mockUser.id)
    localStorage.setItem('haven_token', 'expired-token')
    // #4827: the discriminator is an `ApiRequestError` with status 401 — a bare
    // `Error('401')` carries no status and is now a failed READ, not an ended
    // session. This is the #4704 guard.
    mockApi.get.mockRejectedValue(new ApiRequestError('Unauthorized', 401))
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.token).toBeNull()
    expect(result.current.loadError).toBe(false)
    expect(hasEntered('count-up', mockUser.id)).toBe(false)
    // One sign-out per ended session: the load-time 401 is one, not two.
    expect(clearEntryLatches).toHaveBeenCalledTimes(1)
  })

  /**
   * #4827: a failed READ is not an ended session. Only a 401 (and a 404
   * `User not found`) ends the session; every other failure keeps the token,
   * the entry latches and the session, and surfaces `loadError` so the route
   * can offer Try again instead of a redirect to `/login`.
   */
  describe('load-time /auth/me failures (#4827)', () => {
    it.each([
      ['a rejected fetch', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['a 500', () => Promise.reject(new ApiRequestError('Internal error', 500))],
      ['a 502', () => Promise.reject(new ApiRequestError('Bad gateway', 502))],
      ['a 503', () => Promise.reject(new ApiRequestError('Unavailable', 503))],
      ['a 429', () => Promise.reject(new ApiRequestError('Too many requests', 429))],
      ['a 2xx whose body is not JSON', () => Promise.reject(new SyntaxError('Unexpected token <'))],
    ])('%s keeps the token and the entry latches, and reports loadError', async (_label: string, reject: () => Promise<never>) => {
      markEntered('count-up', mockUser.id)
      localStorage.setItem('haven_token', 'valid-token')
      mockApi.get.mockImplementation(reject)

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.loadError).toBe(true)
      expect(result.current.user).toBeNull()
      expect(localStorage.getItem('haven_token')).toBe('valid-token')
      expect(hasEntered('count-up', mockUser.id)).toBe(true)
      expect(clearEntryLatches).not.toHaveBeenCalled()
    })

    it('a 404 `User not found` ends the session', async () => {
      markEntered('count-up', mockUser.id)
      localStorage.setItem('haven_token', 'valid-token')
      mockApi.get.mockRejectedValue(new ApiRequestError('User not found', 404))

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.loadError).toBe(false)
      expect(result.current.token).toBeNull()
      expect(localStorage.getItem('haven_token')).toBeNull()
      expect(hasEntered('count-up', mockUser.id)).toBe(false)
    })

    it('a 404 that is not `User not found` is a failed read, not an ended session', async () => {
      localStorage.setItem('haven_token', 'valid-token')
      mockApi.get.mockRejectedValue(new ApiRequestError('Not found', 404))

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.loadError).toBe(true)
      expect(localStorage.getItem('haven_token')).toBe('valid-token')
    })

    it('retryLoad repeats the read and clears loadError when it answers', async () => {
      localStorage.setItem('haven_token', 'valid-token')
      mockApi.get.mockRejectedValueOnce(new ApiRequestError('Bad gateway', 502))

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.loadError).toBe(true)

      mockApi.get.mockResolvedValue(mockUser)
      await act(async () => {
        result.current.retryLoad()
      })
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(result.current.loadError).toBe(false)
      expect(result.current.user).toEqual(mockUser)
      expect(mockApi.get).toHaveBeenCalledTimes(2)
    })

    /**
     * The API client's 401 reaction is registered on mount and is the one
     * sign-out path for a session that ends while the dashboard is open. The
     * token is the latch, so a second 401 for the same session is a no-op.
     */
    it('the registered 401 handler ends the session exactly once', async () => {
      markEntered('count-up', mockUser.id)
      localStorage.setItem('haven_token', 'valid-token')
      mockApi.get.mockResolvedValue(mockUser)

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.user).toEqual(mockUser)

      const handler = (setSessionExpiredHandler as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as () => void
      expect(typeof handler).toBe('function')

      act(() => {
        handler()
        handler()
      })

      expect(localStorage.getItem('haven_token')).toBeNull()
      expect(result.current.user).toBeNull()
      expect(result.current.token).toBeNull()
      expect(clearEntryLatches).toHaveBeenCalledTimes(1)
      expect(hasEntered('count-up', mockUser.id)).toBe(false)
    })

    /**
     * The forced sign-out is the load-time expiry's effects plus `setUser(null)`.
     * Stored passkey signer pointers are device state, not session state, so
     * they stay — the same as `logout()`'s account-scoped clearing does NOT
     * apply here.
     */
    it('the forced sign-out keeps stored passkey signer pointers', async () => {
      const accountAddress = '0x07058311f995c89F4DbE17Db61fa1A3CDe638975'
      const userWithAccount = {
        ...mockUser,
        accounts: [
          {
            id: 'acct-1',
            account_address: accountAddress,
            chain_id: 100,
            name: 'Main',
            is_default: true,
            created_at: '2026-05-04T00:00:00.000Z',
          },
        ],
      }

      localStorage.setItem('haven_token', 'valid-token')
      localStorage.setItem('haven_passkey_device_credential-123', '1')
      mockApi.get.mockImplementation((path: string) =>
        path === '/auth/me' ? Promise.resolve(userWithAccount) : Promise.resolve({}),
      )
      mockApi.listPasskeys.mockResolvedValue({
        passkeys: [
          {
            id: 'passkey-1',
            credential_id: 'credential-123',
            signer_address: '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2',
            chain_id: 100,
            account_address: accountAddress,
            created_at: '2026-05-04T00:00:00.000Z',
          },
        ],
      })

      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      const key = passkeyStorageKey(accountAddress, 100)
      expect(localStorage.getItem(key)).not.toBeNull()

      const handler = (setSessionExpiredHandler as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as () => void
      act(() => {
        handler()
      })

      expect(localStorage.getItem('haven_token')).toBeNull()
      expect(localStorage.getItem(key)).not.toBeNull()
    })
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
      response = await result.current.signup('Ada Lovelace', 'test@example.com', 'password')
    })

    expect(mockApi.post).toHaveBeenCalledWith('/auth/signup', {
      name: 'Ada Lovelace',
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
      accounts: [
        {
          id: 'safe-1',
          account_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
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
          account_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
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

  it('clears stored passkey entries for all accounts on logout', async () => {
    mockApi.get.mockRejectedValue(new Error('no token'))
    const userWithAccounts = {
      ...mockUser,
      accounts: [
        {
          id: 'safe-1',
          account_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
          chain_id: 100,
          name: 'Main Safe',
          is_default: true,
          created_at: '2026-05-04T00:00:00.000Z',
        },
        {
          id: 'safe-2',
          account_address: '0x1111111111111111111111111111111111111111',
          chain_id: 8453,
          name: 'Base Safe',
          is_default: false,
          created_at: '2026-05-04T00:00:00.000Z',
        },
      ],
    }

    mockApi.post.mockResolvedValue({ token: 'jwt-token', user: userWithAccounts })

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

  /**
   * #4024: the New account dialog must tell "the re-read found nothing" from
   * "the re-read failed". reloadUser reports which; refreshUser keeps its
   * swallow-everything contract for every other caller.
   */
  describe('reloadUser / refreshUser (#4024)', () => {
    it('reloadUser resolves true and replaces the user when /auth/me answers', async () => {
      mockApi.get.mockRejectedValue(new Error('no token'))
      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockApi.get.mockResolvedValue({ ...mockUser, name: 'Reloaded' })
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.reloadUser()
      })
      expect(ok).toBe(true)
      expect(result.current.user?.name).toBe('Reloaded')
    })

    it('reloadUser resolves false when the read fails, and refreshUser still swallows it', async () => {
      mockApi.get.mockRejectedValue(new Error('no token'))
      const { result } = renderHook(() => useAuth(), { wrapper })
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockApi.get.mockRejectedValue(new Error('offline'))
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.reloadUser()
      })
      expect(ok).toBe(false)
      await act(async () => {
        await expect(result.current.refreshUser()).resolves.toBeUndefined()
      })
    })
  })
})
