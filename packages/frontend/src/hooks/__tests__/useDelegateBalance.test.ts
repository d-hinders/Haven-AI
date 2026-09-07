import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useDelegateBalance, type DelegateBalance } from '@/hooks/useDelegateBalance'

function balance(overrides: Partial<DelegateBalance> = {}): DelegateBalance {
  return {
    delegate_address: '0x2222222222222222222222222222222222222222',
    safe_address: '0x1111111111111111111111111111111111111111',
    chain_id: 8453,
    eth: '0',
    eth_atomic: '0',
    usdc: '0',
    usdc_atomic: '0',
    usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    sweep_min_usdc: '0.01',
    ...overrides,
  }
}

describe('useDelegateBalance', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('flags USDC as recoverable but ETH-only as not recoverable', async () => {
    mockApiGet.mockResolvedValueOnce(balance({ usdc: '0.04', usdc_atomic: '40000' }))
    const usdc = renderHook(() => useDelegateBalance('agent-usdc'))
    await waitFor(() => expect(usdc.result.current.hasRecoverableUsdc).toBe(true))
    expect(usdc.result.current.hasStranded).toBe(true)

    mockApiGet.mockResolvedValueOnce(balance({ eth: '0.01', eth_atomic: '10000000000000000' }))
    const eth = renderHook(() => useDelegateBalance('agent-eth'))
    await waitFor(() => expect(eth.result.current.hasStranded).toBe(true))
    expect(eth.result.current.hasRecoverableUsdc).toBe(false)
  })

  it('does not mark USDC below the configured sweep minimum as recoverable', async () => {
    mockApiGet.mockResolvedValueOnce(balance({ usdc: '0.005', usdc_atomic: '5000' }))
    const { result } = renderHook(() => useDelegateBalance('agent-dust'))

    await waitFor(() => expect(result.current.hasBelowMinimumUsdc).toBe(true))
    expect(result.current.hasRecoverableUsdc).toBe(false)
    expect(result.current.hasStranded).toBe(true)
  })

  it('does not expose recovery eligibility without a verified destination', async () => {
    mockApiGet.mockResolvedValueOnce(
      balance({ usdc: '1.00', usdc_atomic: '1000000', safe_address: null }),
    )
    const { result } = renderHook(() => useDelegateBalance('agent-unlinked'))

    await waitFor(() => expect(result.current.balance?.usdc_atomic).toBe('1000000'))
    expect(result.current.hasRecoverableUsdc).toBe(false)
    expect(result.current.hasBelowMinimumUsdc).toBe(false)
  })

  it('ignores a late response from a superseded agentId', async () => {
    // First agent's fetch resolves slowly; second agent's resolves first.
    let resolveOld: (b: DelegateBalance) => void = () => {}
    mockApiGet.mockImplementationOnce(
      () => new Promise<DelegateBalance>((resolve) => { resolveOld = resolve }),
    )

    const { result, rerender } = renderHook(({ id }) => useDelegateBalance(id), {
      initialProps: { id: 'agent-old' },
    })

    // Navigate to a new agent before the old fetch resolves.
    mockApiGet.mockResolvedValueOnce(balance({ usdc: '1.0', usdc_atomic: '1000000' }))
    rerender({ id: 'agent-new' })
    await waitFor(() => expect(result.current.balance?.usdc_atomic).toBe('1000000'))

    // The stale old response arrives late and must NOT overwrite the new agent.
    resolveOld(balance({ usdc: '999.0', usdc_atomic: '999000000' }))
    await Promise.resolve()
    expect(result.current.balance?.usdc_atomic).toBe('1000000')
  })

  it('ignores a late response from an older manual refetch', async () => {
    mockApiGet.mockResolvedValueOnce(balance({ usdc: '1.00', usdc_atomic: '1000000' }))
    const { result } = renderHook(() => useDelegateBalance('agent-1'))
    await waitFor(() => expect(result.current.balance?.usdc_atomic).toBe('1000000'))

    let resolveOld: (b: DelegateBalance) => void = () => {}
    mockApiGet.mockImplementationOnce(
      () => new Promise<DelegateBalance>((resolve) => { resolveOld = resolve }),
    )
    mockApiGet.mockResolvedValueOnce(balance({ usdc: '2.00', usdc_atomic: '2000000' }))

    let oldRefetch!: Promise<void>
    let newRefetch!: Promise<void>
    await act(async () => {
      oldRefetch = result.current.refetch()
      newRefetch = result.current.refetch()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.balance?.usdc_atomic).toBe('2000000'))

    await act(async () => {
      resolveOld(balance({ usdc: '999.00', usdc_atomic: '999000000' }))
      await oldRefetch
      await newRefetch
    })

    expect(result.current.balance?.usdc_atomic).toBe('2000000')
  })
})
