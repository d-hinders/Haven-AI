import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()
const mockUseAuth = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import {
  useAggregatedBalances,
  useAggregatedPortfolio,
  useAggregatedTransactions,
} from '@/hooks/useAggregatedPortfolio'
import type { BalanceItem, Transaction } from '@/types/transactions'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const SECOND_SAFE_ADDRESS = '0x2222222222222222222222222222222222222222'
const TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function mockSafes(
  safes: Array<{ id: string; safe_address: string; chain_id: number }>,
) {
  mockUseAuth.mockReturnValue({
    user: {
      safes: safes.map((safe) => ({
        ...safe,
        name: safe.id,
        is_default: false,
        created_at: '2026-06-05T00:00:00.000Z',
      })),
    },
  })
}

function usdc(balance: string): BalanceItem {
  return {
    symbol: 'USDC',
    address: TOKEN_ADDRESS,
    balance,
    formatted: balance,
    decimals: 6,
  }
}

function transaction(hash: string): Transaction {
  return {
    hash,
    type: 'erc20',
    from: SAFE_ADDRESS,
    to: '0x3333333333333333333333333333333333333333',
    value: '1000000',
    valueFormatted: '1',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1778240999,
    blockNumber: 45725826,
    isError: false,
    tokenAddress: TOKEN_ADDRESS,
    tokenSymbol: 'USDC',
  }
}

describe('aggregated portfolio hooks', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockUseAuth.mockReset()
  })

  it('requests aggregate portfolio totals for each Safe chain', async () => {
    mockSafes([
      { id: 'gnosis', safe_address: SAFE_ADDRESS, chain_id: 100 },
      { id: 'base', safe_address: SAFE_ADDRESS, chain_id: 8453 },
    ])
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === `/portfolio/${SAFE_ADDRESS}?chain_id=100`) {
        return { totalUsd: 1, totalEur: 0.92, breakdown: [] }
      }
      if (path === `/portfolio/${SAFE_ADDRESS}?chain_id=8453`) {
        return { totalUsd: 2, totalEur: 1.84, breakdown: [] }
      }
      return { totalUsd: 0, totalEur: 0, breakdown: [] }
    })

    const { result } = renderHook(() => useAggregatedPortfolio())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(`/portfolio/${SAFE_ADDRESS}?chain_id=100`)
    expect(mockApiGet).toHaveBeenCalledWith(`/portfolio/${SAFE_ADDRESS}?chain_id=8453`)
    expect(result.current.totalUsd).toBe(3)
    expect(result.current.totalEur).toBeCloseTo(2.76)
  })

  it('keeps same-symbol balances separate across chains', async () => {
    mockSafes([
      { id: 'gnosis', safe_address: SAFE_ADDRESS, chain_id: 100 },
      { id: 'base', safe_address: SAFE_ADDRESS, chain_id: 8453 },
    ])
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === `/balances/${SAFE_ADDRESS}?chain_id=100`) {
        return { balances: [usdc('1000000')] }
      }
      if (path === `/balances/${SAFE_ADDRESS}?chain_id=8453`) {
        return { balances: [usdc('2500000')] }
      }
      return { balances: [] }
    })

    const { result } = renderHook(() => useAggregatedBalances())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(`/balances/${SAFE_ADDRESS}?chain_id=100`)
    expect(mockApiGet).toHaveBeenCalledWith(`/balances/${SAFE_ADDRESS}?chain_id=8453`)
    expect(result.current.balances).toEqual([
      { ...usdc('1000000'), chainId: 100 },
      { ...usdc('2500000'), chainId: 8453 },
    ])
  })

  it('merges matching token balances on the same chain', async () => {
    mockSafes([
      { id: 'base-1', safe_address: SAFE_ADDRESS, chain_id: 8453 },
      { id: 'base-2', safe_address: SECOND_SAFE_ADDRESS, chain_id: 8453 },
    ])
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === `/balances/${SAFE_ADDRESS}?chain_id=8453`) {
        return { balances: [usdc('1000000')] }
      }
      if (path === `/balances/${SECOND_SAFE_ADDRESS}?chain_id=8453`) {
        return { balances: [usdc('2500000')] }
      }
      return { balances: [] }
    })

    const { result } = renderHook(() => useAggregatedBalances())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.balances).toEqual([
      {
        ...usdc('1000000'),
        balance: '3500000',
        formatted: '3.5',
        chainId: 8453,
      },
    ])
  })

  it('surfaces an aggregate balance error instead of treating failures as zero funds', async () => {
    mockSafes([
      { id: 'base', safe_address: SAFE_ADDRESS, chain_id: 8453 },
    ])
    mockApiGet.mockRejectedValue(new Error('temporarily unavailable'))

    const { result } = renderHook(() => useAggregatedBalances())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.balances).toEqual([])
    expect(result.current.error).toBe('Failed to load balances')
  })

  it('requests aggregate transactions for each Safe chain', async () => {
    mockSafes([
      { id: 'gnosis', safe_address: SAFE_ADDRESS, chain_id: 100 },
      { id: 'base', safe_address: SAFE_ADDRESS, chain_id: 8453 },
    ])
    const sharedTransaction = transaction('0xshared')
    mockApiGet.mockImplementation(async (path: string) => {
      if (path === `/transactions/${SAFE_ADDRESS}?page=1&limit=10&chain_id=100`) {
        return { transactions: [sharedTransaction], total: 1, page: 1, limit: 10, pages: 1 }
      }
      if (path === `/transactions/${SAFE_ADDRESS}?page=1&limit=10&chain_id=8453`) {
        return { transactions: [sharedTransaction], total: 1, page: 1, limit: 10, pages: 1 }
      }
      return { transactions: [], total: 0, page: 1, limit: 10, pages: 0 }
    })

    const { result } = renderHook(() => useAggregatedTransactions())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(
      `/transactions/${SAFE_ADDRESS}?page=1&limit=10&chain_id=100`,
    )
    expect(mockApiGet).toHaveBeenCalledWith(
      `/transactions/${SAFE_ADDRESS}?page=1&limit=10&chain_id=8453`,
    )
    expect(result.current.transactions).toHaveLength(2)
    expect(result.current.total).toBe(2)
  })

  it('surfaces aggregate transaction errors instead of treating failures as empty history', async () => {
    mockSafes([
      { id: 'base', safe_address: SAFE_ADDRESS, chain_id: 8453 },
    ])
    mockApiGet.mockRejectedValue(new Error('temporarily unavailable'))

    const { result } = renderHook(() => useAggregatedTransactions())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.transactions).toEqual([])
    expect(result.current.total).toBe(0)
    expect(result.current.error).toBe('Failed to load transactions')
  })
})
