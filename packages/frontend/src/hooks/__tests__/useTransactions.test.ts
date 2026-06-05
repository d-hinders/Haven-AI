import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useTransactions } from '@/hooks/useTransactions'
import type { Transaction, TransactionsResponse } from '@/types/transactions'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'

function tx(hash: string): Transaction {
  return {
    hash,
    type: 'native',
    from: '0x2222222222222222222222222222222222222222',
    to: SAFE_ADDRESS,
    value: '1000000000000000000',
    valueFormatted: '1',
    asset: 'ETH',
    decimals: 18,
    direction: 'in',
    timestamp: 1778240999,
    blockNumber: 45725826,
    isError: false,
  }
}

function response(transactions: Transaction[]): TransactionsResponse {
  return {
    transactions,
    total: transactions.length,
    page: 1,
    limit: 10,
    pages: transactions.length > 0 ? 1 : 0,
  }
}

describe('useTransactions', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue(response([]))
  })

  it('requests transactions for the provided chain when chainId is known', async () => {
    const { result } = renderHook(() =>
      useTransactions(SAFE_ADDRESS, { limit: 5, chainId: 8453 }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(
      `/transactions/${SAFE_ADDRESS}?page=1&limit=5&chain_id=8453`,
    )
  })

  it('keeps the legacy address-only request when chainId is omitted', async () => {
    const { result } = renderHook(() => useTransactions(SAFE_ADDRESS, 7))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(
      `/transactions/${SAFE_ADDRESS}?page=1&limit=7`,
    )
  })

  it('ignores stale transactions when an older chain request resolves late', async () => {
    let resolveGnosis!: (value: TransactionsResponse) => void
    let resolveBase!: (value: TransactionsResponse) => void
    const gnosisResponse = response([tx('0xgnosis')])
    const baseResponse = response([tx('0xbase')])

    mockApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveGnosis = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveBase = resolve }))

    const { result, rerender } = renderHook(
      ({ chainId }) => useTransactions(SAFE_ADDRESS, { chainId }),
      { initialProps: { chainId: 100 } },
    )

    rerender({ chainId: 8453 })

    await act(async () => {
      resolveBase(baseResponse)
      await Promise.resolve()
    })
    expect(result.current.transactions).toEqual(baseResponse.transactions)

    await act(async () => {
      resolveGnosis(gnosisResponse)
      await Promise.resolve()
    })
    expect(result.current.transactions).toEqual(baseResponse.transactions)
  })
})
