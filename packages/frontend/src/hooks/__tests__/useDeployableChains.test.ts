import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...args) },
}))

import { useDeployableChains } from '@/hooks/useDeployableChains'
import { SUPPORTED_CHAIN_IDS } from '@/lib/chains'

describe('useDeployableChains (#679)', () => {
  beforeEach(() => mockApiGet.mockReset())

  it('offers only the chains the backend serves, intersected with supported', async () => {
    mockApiGet.mockResolvedValue({ deployable: [84532] })
    const { result } = renderHook(() => useDeployableChains())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.chains.map((c) => c.chainId)).toEqual([84532])
  })

  it('falls back to all supported chains when the endpoint is unavailable', async () => {
    // An old backend with no /chains (or a malformed body) → no usable list.
    mockApiGet.mockResolvedValue({})
    const { result } = renderHook(() => useDeployableChains())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.chains.map((c) => c.chainId).sort()).toEqual(
      [...SUPPORTED_CHAIN_IDS].sort(),
    )
  })

  it('never returns an empty list even if the backend serves nothing known', async () => {
    mockApiGet.mockResolvedValue({ deployable: [999999] })
    const { result } = renderHook(() => useDeployableChains())
    await waitFor(() => expect(result.current.loading).toBe(false))

    // No overlap with supported → degrade to all supported rather than brick.
    expect(result.current.chains.length).toBeGreaterThan(0)
  })
})
