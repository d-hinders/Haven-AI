import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPost, mockRefreshUser, mockReloadUser, callOrder } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockRefreshUser: vi.fn(),
  mockReloadUser: vi.fn(),
  callOrder: [] as string[],
}))

vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => mockPost(...args), put: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { accounts: [] }, refreshUser: mockRefreshUser, reloadUser: mockReloadUser }),
}))

import { useAccounts } from '../useAccounts'

const BODY = {
  source_account_id: 'main1',
  key_id: '0xabcd',
  chain_id: 84532,
  name: 'Reserve',
  idempotency_key: '7f0c4c3e-0000-4000-8000-000000004024',
}

describe('useAccounts().createAccount (#4024)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    mockPost.mockImplementation(async () => {
      callOrder.push('post')
      return { id: 'new1', account_address: '0x4024', chain_id: 84532 }
    })
    mockRefreshUser.mockImplementation(async () => {
      callOrder.push('refresh')
    })
  })

  it('posts the create-additional request as given, then refreshes the account list', async () => {
    const { result } = renderHook(() => useAccounts())
    let created: unknown
    await act(async () => {
      created = await result.current.createAccount(BODY)
    })

    expect(mockPost).toHaveBeenCalledWith('/accounts/hybrid', BODY)
    // The refresh is what makes the new card appear: the list is read from
    // the session payload, so it must be re-read AFTER the create commits.
    expect(callOrder).toEqual(['post', 'refresh'])
    expect(created).toMatchObject({ id: 'new1' })
  })

  it('rethrows a refusal without refreshing', async () => {
    const refusal = Object.assign(new Error('cap'), { status: 422 })
    mockPost.mockRejectedValue(refusal)
    const { result } = renderHook(() => useAccounts())

    await act(async () => {
      await expect(result.current.createAccount(BODY)).rejects.toBe(refusal)
    })
    expect(mockRefreshUser).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it('refreshAccounts reports whether the re-read happened (reloadUser, not refreshUser)', async () => {
    const { result } = renderHook(() => useAccounts())
    mockReloadUser.mockResolvedValueOnce(false)
    await expect(result.current.refreshAccounts()).resolves.toBe(false)
    mockReloadUser.mockResolvedValueOnce(true)
    await expect(result.current.refreshAccounts()).resolves.toBe(true)
    expect(mockRefreshUser).not.toHaveBeenCalled()
  })
})
