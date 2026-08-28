import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}))

import { getSubmissionStatus, submitCatalog } from '@/hooks/useCatalog'

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
})
