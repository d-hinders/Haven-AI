import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useBalances } from '@/hooks/useBalances'
import type { BalancesResponse } from '@/types/transactions'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const BALANCES: BalancesResponse = {
  balances: [
    {
      symbol: 'USDC',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      balance: '1000000',
      formatted: '1.00',
      decimals: 6,
    },
  ],
}

describe('useBalances', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue(BALANCES)
  })

  it('requests balances for the provided chain when chainId is known', async () => {
    const { result } = renderHook(() => useBalances(SAFE_ADDRESS, { chainId: 8453 }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(`/balances/${SAFE_ADDRESS}?chain_id=8453`)
    expect(result.current.balances).toEqual([
      {
        ...BALANCES.balances[0],
        chainId: 8453,
      },
    ])
  })

  it('keeps the legacy address-only request when chainId is omitted', async () => {
    const { result } = renderHook(() => useBalances(SAFE_ADDRESS))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(`/balances/${SAFE_ADDRESS}`)
    expect(result.current.balances).toEqual(BALANCES.balances)
  })

  it('ignores stale balances when an older chain request resolves late', async () => {
    let resolveGnosis!: (value: BalancesResponse) => void
    let resolveBase!: (value: BalancesResponse) => void
    const gnosisBalances: BalancesResponse = {
      balances: [{ ...BALANCES.balances[0], balance: '1000000', formatted: '1.00' }],
    }
    const baseBalances: BalancesResponse = {
      balances: [{ ...BALANCES.balances[0], balance: '2500000', formatted: '2.50' }],
    }

    mockApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveGnosis = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveBase = resolve }))

    const { result, rerender } = renderHook(
      ({ chainId }) => useBalances(SAFE_ADDRESS, { chainId }),
      { initialProps: { chainId: 100 } },
    )

    rerender({ chainId: 8453 })

    await act(async () => {
      resolveBase(baseBalances)
      await Promise.resolve()
    })
    expect(result.current.balances).toEqual([
      {
        ...baseBalances.balances[0],
        chainId: 8453,
      },
    ])

    await act(async () => {
      resolveGnosis(gnosisBalances)
      await Promise.resolve()
    })
    expect(result.current.balances).toEqual([
      {
        ...baseBalances.balances[0],
        chainId: 8453,
      },
    ])
  })
})
