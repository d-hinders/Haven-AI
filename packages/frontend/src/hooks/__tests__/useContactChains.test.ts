import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()
const mockUseAuth = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...args) },
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import { useContactChains } from '@/hooks/useContactChains'

const SAFE_BASE = '0x1111111111111111111111111111111111111111'
const SAFE_GNOSIS = '0x2222222222222222222222222222222222222222'
const ALICE = '0xAaAa000000000000000000000000000000000001'
const BOB = '0xbBbB000000000000000000000000000000000002'

function tx(overrides: Record<string, unknown>) {
  return {
    hash: '0xhash',
    type: 'erc20',
    from: '0x0',
    to: '0x0',
    value: '1',
    valueFormatted: '1',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1,
    blockNumber: 1,
    isError: false,
    ...overrides,
  }
}

describe('useContactChains', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockUseAuth.mockReturnValue({
      user: {
        safes: [
          { id: 's1', safe_address: SAFE_BASE, chain_id: 8453 },
          { id: 's2', safe_address: SAFE_GNOSIS, chain_id: 100 },
        ],
      },
    })
  })

  it('maps each counterparty to the chains it has activity on', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.includes('chain_id=8453')) {
        return Promise.resolve({
          transactions: [
            tx({ direction: 'out', to: ALICE }),
            tx({ direction: 'in', from: BOB }),
          ],
          total: 2,
        })
      }
      // Gnosis safe — Alice again, on a second chain.
      return Promise.resolve({ transactions: [tx({ direction: 'out', to: ALICE })], total: 1 })
    })

    const { result } = renderHook(() => useContactChains())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const map = result.current.chainsByAddress
    expect(map.get(ALICE.toLowerCase())).toEqual([100, 8453])
    expect(map.get(BOB.toLowerCase())).toEqual([8453])
  })

  it('tolerates a single Safe failing without blanking the rest', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.includes('chain_id=8453')) {
        return Promise.resolve({ transactions: [tx({ direction: 'out', to: ALICE })], total: 1 })
      }
      return Promise.reject(new Error('boom'))
    })

    const { result } = renderHook(() => useContactChains())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.chainsByAddress.get(ALICE.toLowerCase())).toEqual([8453])
  })

  it('is empty when the user has no safes', async () => {
    mockUseAuth.mockReturnValue({ user: { safes: [] } })
    const { result } = renderHook(() => useContactChains())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.chainsByAddress.size).toBe(0)
    expect(mockApiGet).not.toHaveBeenCalled()
  })
})
