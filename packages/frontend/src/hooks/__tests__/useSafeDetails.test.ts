import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

import { useSafeDetails } from '@/hooks/useSafeDetails'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const SAFE_DETAILS = {
  address: SAFE_ADDRESS,
  owners: ['0x2222222222222222222222222222222222222222'],
  threshold: 1,
  nonce: 7,
}

describe('useSafeDetails', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue(SAFE_DETAILS)
  })

  it('requests Safe details for the provided chain when chainId is known', async () => {
    const { result } = renderHook(() => useSafeDetails(SAFE_ADDRESS, { chainId: 8453 }))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mockApiGet).toHaveBeenCalledWith(`/safe/${SAFE_ADDRESS}/details?chain_id=8453`)
    expect(result.current.details).toEqual(SAFE_DETAILS)
  })

  it('keeps the legacy address-only request when chainId is omitted', async () => {
    renderHook(() => useSafeDetails(SAFE_ADDRESS))

    await waitFor(() => expect(mockApiGet).toHaveBeenCalled())

    expect(mockApiGet).toHaveBeenCalledWith(`/safe/${SAFE_ADDRESS}/details`)
  })

  it('ignores stale details when an older chain request resolves late', async () => {
    let resolveGnosis!: (value: typeof SAFE_DETAILS) => void
    let resolveBase!: (value: typeof SAFE_DETAILS) => void
    const gnosisDetails = { ...SAFE_DETAILS, threshold: 1, nonce: 7 }
    const baseDetails = { ...SAFE_DETAILS, threshold: 2, nonce: 12 }

    mockApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveGnosis = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveBase = resolve }))

    const { result, rerender } = renderHook(
      ({ chainId }) => useSafeDetails(SAFE_ADDRESS, { chainId }),
      { initialProps: { chainId: 100 } },
    )

    rerender({ chainId: 8453 })

    await act(async () => {
      resolveBase(baseDetails)
      await Promise.resolve()
    })
    expect(result.current.details).toEqual(baseDetails)

    await act(async () => {
      resolveGnosis(gnosisDetails)
      await Promise.resolve()
    })
    expect(result.current.details).toEqual(baseDetails)
  })
})
