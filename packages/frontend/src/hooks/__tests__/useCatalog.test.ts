import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => mockApiGet(...args),
      post: (...args: unknown[]) => mockApiPost(...args),
    },
  }
})

import { getSubmissionStatus, submitCatalog, useMerchant, useMerchants } from '@/hooks/useCatalog'
import { act, renderHook, waitFor } from '@testing-library/react'
import { ApiRequestError } from '@/lib/api'

describe('catalog submission api (#1715)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('posts the resource url and keeps the honeypot website field empty', async () => {
    mockApiPost.mockResolvedValue({
      id: 'sub-1',
      verify_token: 'tok-123',
      status: 'submitted',
    })

    const result = await submitCatalog('https://merchant.example/pay')

    // The `website` field is a honeypot: it must stay empty, and a filled
    // value must never be forwarded to the backend.
    expect(mockApiPost).toHaveBeenCalledWith('/catalog/submit', {
      resource_url: 'https://merchant.example/pay',
      website: '',
    })
    expect(result.verify_token).toBe('tok-123')
  })

  it('fetches the coarse public status for a submission id', async () => {
    mockApiGet.mockResolvedValue({
      id: 'sub-1',
      status: 'ownership_verified',
      name: null,
      description: null,
      entrypoint: null,
      instructions: null,
    })

    const result = await getSubmissionStatus('sub-1')

    expect(mockApiGet).toHaveBeenCalledWith('/catalog/submit/sub-1')
    expect(result.status).toBe('ownership_verified')
  })

  it('forwards merchant_name/merchant_website only when given, distinct from the honeypot (#3078)', async () => {
    mockApiPost.mockResolvedValue({ id: 'sub-2', verify_token: 'tok-456', status: 'submitted' })

    await submitCatalog('https://merchant.example/pay', {
      name: 'Merchant Example',
      website: 'https://merchant.example',
    })

    expect(mockApiPost).toHaveBeenCalledWith('/catalog/submit', {
      resource_url: 'https://merchant.example/pay',
      website: '',
      merchant_name: 'Merchant Example',
      merchant_website: 'https://merchant.example',
    })

    mockApiPost.mockClear()
    await submitCatalog('https://merchant.example/pay')
    expect(mockApiPost).toHaveBeenCalledWith('/catalog/submit', {
      resource_url: 'https://merchant.example/pay',
      website: '',
    })
  })
})

describe('useMerchants (#3078)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('lists merchants from GET /merchants', async () => {
    mockApiGet.mockResolvedValue({ merchants: [{ id: 'm-1', slug: 'm-1', name: 'M1' }] })
    const { result } = renderHook(() => useMerchants())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockApiGet).toHaveBeenCalledWith('/merchants')
    expect(result.current.merchants).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a load error', async () => {
    mockApiGet.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useMerchants())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network down')
  })
})

describe('useMerchant (#3078)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('fetches a merchant and its offers by slug', async () => {
    mockApiGet.mockResolvedValue({
      merchant: { id: 'm-1', slug: 'ampersend', name: 'Ampersend' },
      offers: [{ id: 'o-1' }],
    })
    const { result } = renderHook(() => useMerchant('ampersend'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockApiGet).toHaveBeenCalledWith('/merchants/ampersend')
    expect(result.current.merchant?.slug).toBe('ampersend')
    expect(result.current.offers).toHaveLength(1)
    expect(result.current.notFound).toBe(false)
  })

  it('sets notFound (not error) on a 404, and error on anything else', async () => {
    mockApiGet.mockRejectedValueOnce(new ApiRequestError('Merchant not found', 404))
    const { result, rerender } = renderHook(({ slug }) => useMerchant(slug), {
      initialProps: { slug: 'unknown' },
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.notFound).toBe(true)
    expect(result.current.error).toBeNull()

    mockApiGet.mockRejectedValueOnce(new ApiRequestError('boom', 500))
    rerender({ slug: 'unknown-2' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.notFound).toBe(false)
    expect(result.current.error).toBe('boom')
  })

  it('ignores a late answer for a previous slug (a → b, a resolves last)', async () => {
    const pending = new Map<string, (v: unknown) => void>()
    mockApiGet.mockImplementation(
      (url: string) => new Promise((resolve) => pending.set(url, resolve)),
    )
    const { result, rerender } = renderHook(({ slug }) => useMerchant(slug), {
      initialProps: { slug: 'a' },
    })
    rerender({ slug: 'b' })
    await waitFor(() => expect(pending.has('/merchants/b')).toBe(true))

    pending.get('/merchants/b')!({ merchant: { slug: 'b' }, offers: [{ id: 'o-b' }] })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.merchant?.slug).toBe('b')

    // The stale answer must not overwrite the current page.
    await act(async () => {
      pending.get('/merchants/a')!({ merchant: { slug: 'a' }, offers: [{ id: 'o-a' }] })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.merchant?.slug).toBe('b')
    expect(result.current.offers).toEqual([{ id: 'o-b' }])
    expect(result.current.loading).toBe(false)
  })
})
