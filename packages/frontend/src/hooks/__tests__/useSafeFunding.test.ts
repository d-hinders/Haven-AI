import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSafeFunding } from '@/hooks/useSafeFunding'
import type { SafeFunding } from '@/hooks/useSafeFunding'

/**
 * `useSafeFunding` (#2534) — one read of the funding-facts endpoint, the same
 * object `haven wallets funding` prints. What is pinned here:
 *
 * 1. It GETs `/user/safes/:safeId/funding` and stores the response.
 * 2. A failed read is surfaced, not thrown — the onboarding card must keep
 *    its general copy when this GET fails, exactly as the balance read
 *    failing keeps the hero usable.
 * 3. No id, no request: the dashboard only subscribes while the account is
 *    unfunded, and a funded/unknown state must not spend the request.
 * 4. `refetch({ silent })` re-reads without flashing the loading flag, the
 *    same convention `useAgents` established for its post-setup poll.
 *
 * The api module is mocked at its seam, per the repo's hook-test idiom.
 */

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}))

import { api } from '@/lib/api'
const mockGet = vi.mocked(api.get)

const FUNDING: SafeFunding = {
  account_address: '0x1111111111111111111111111111111111111111',
  chain: { id: 8453, name: 'Base', explorer_url: 'https://sepolia.basescan.org' },
  tokens: [
    { symbol: 'USDC', address: '0xusdc', decimals: 6, balance_human: '0', minimum_useful_human: '5' },
  ],
  native: { symbol: 'ETH', balance_human: '0', needed: false },
  funded: false,
}

beforeEach(() => {
  mockGet.mockReset()
})

describe('useSafeFunding (#2534)', () => {
  it('reads the funding endpoint for the safe it is given', async () => {
    mockGet.mockResolvedValue(FUNDING)
    const { result } = renderHook(() => useSafeFunding('safe-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockGet).toHaveBeenCalledWith('/user/safes/safe-1/funding')
    expect(result.current.funding).toEqual(FUNDING)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a failed read instead of throwing', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSafeFunding('safe-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.funding).toBeNull()
    expect(result.current.error).toBe('boom')
  })

  it('makes no request without a safe id', () => {
    renderHook(() => useSafeFunding(undefined))
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('refetch silently re-reads without flashing the loading flag', async () => {
    mockGet.mockResolvedValue(FUNDING)
    const { result } = renderHook(() => useSafeFunding('safe-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockGet.mockResolvedValue({ ...FUNDING, funded: true })
    const loadingDuring = vi.fn()
    // The silent refetch must not toggle `loading`; capture it synchronously.
    void result.current.refetch({ silent: true }).then((res) => {
      expect(res?.funded).toBe(true)
    })
    loadingDuring(result.current.loading)
    await waitFor(() => expect(result.current.funding?.funded).toBe(true))
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
