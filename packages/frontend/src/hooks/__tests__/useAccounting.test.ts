import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * #2862: the accounting hooks point at the provider-generic routes
 * (`/accounting/providers`, `/accounting/connections/*`) — the
 * `/accounting/fortnox/*` router is gone. #2868 removed `useFortnox` with the
 * feed page's connect card (Settings owns the connection now) and added the
 * settings PATCH and the backfill POST (#2867). Headless equivalent of the
 * browser check: the exact URLs, methods and bodies called.
 */

const { mockApiGet, mockApiPost, mockApiPatch, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPatch: vi.fn(),
  mockApiDelete: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ApiRequestError: actual.ApiRequestError,
    api: {
      get: (...args: unknown[]) => mockApiGet(...args),
      post: (...args: unknown[]) => mockApiPost(...args),
      patch: (...args: unknown[]) => mockApiPatch(...args),
      delete: (...args: unknown[]) => mockApiDelete(...args),
    },
  }
})

import { ApiRequestError } from '@/lib/api'
import { accountingRefusal, useAccountingConnections, useAccountingProviders } from '@/hooks/useAccounting'

const PROVIDERS = {
  providers: [
    { id: 'fortnox', displayName: 'Fortnox', authKind: 'oauth2', availability: 'live', configured: true, capabilities: { attachments: true, verify: true, revoke: false, companyInfo: true }, requiredScopes: [] },
    { id: 'accounted', displayName: 'Accounted', authKind: 'oauth2', availability: 'coming_soon', configured: false, capabilities: { attachments: false, verify: false, revoke: false, companyInfo: false }, requiredScopes: [] },
  ],
}
const CONNECTED = {
  connections: [
    { provider: 'fortnox', displayName: 'Fortnox', authKind: 'oauth2', status: 'connected', statusReason: null, isActiveDestination: true, feedFrom: null, grantedScope: 'bookkeeping', missingScopes: [], tokenExpiresAt: '2099-01-01T00:00:00.000Z', externalCompanyId: '1', externalCompanyName: 'Ada AB', baseCurrency: 'SEK', lastPushAt: null, lastError: null, connectedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', settings: { suggestedAccount: null, autoFeed: true } },
  ],
}

function routeGet(url: string) {
  if (url === '/accounting/providers') return Promise.resolve(PROVIDERS)
  if (url === '/accounting/connections') return Promise.resolve(CONNECTED)
  return Promise.reject(new Error(`unexpected GET ${url}`))
}

describe('accounting hooks on the generic routes (#2862)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('useAccountingProviders lists the registry from GET /accounting/providers', async () => {
    mockApiGet.mockImplementation(routeGet)
    const { result } = renderHook(() => useAccountingProviders())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockApiGet).toHaveBeenCalledWith('/accounting/providers')
    expect(result.current.providers.map((p) => [p.id, p.availability])).toEqual([['fortnox', 'live'], ['accounted', 'coming_soon']])
  })

  it('useAccountingConnections drives connect-url / api-key / disconnect / activate on the provider-scoped routes', async () => {
    mockApiGet.mockImplementation(routeGet)
    mockApiPost.mockResolvedValue({ url: 'https://apps.fortnox.se/oauth-v1/auth?state=s' })
    mockApiDelete.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAccountingConnections())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connections[0]).toMatchObject({ provider: 'fortnox', isActiveDestination: true })

    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, set href(v: string) { assign(v) } } })
    try {
      await act(() => result.current.connect('fortnox'))
      expect(mockApiPost).toHaveBeenCalledWith('/accounting/connections/fortnox/connect-url')
      expect(assign).toHaveBeenCalledWith('https://apps.fortnox.se/oauth-v1/auth?state=s')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }

    await act(() => result.current.connectWithApiKey('light', 'k'))
    expect(mockApiPost).toHaveBeenCalledWith('/accounting/connections/light/api-key', { apiKey: 'k' })
    await act(() => result.current.disconnect('fortnox'))
    expect(mockApiDelete).toHaveBeenCalledWith('/accounting/connections/fortnox')
    await act(() => result.current.activate('fortnox'))
    expect(mockApiPost).toHaveBeenCalledWith('/accounting/connections/fortnox/activate')
  })

  it('only the FIRST listing is `loading`; a later re-list is `refreshing` and keeps the rows (#2903)', async () => {
    let releaseRelist: ((v: unknown) => void) | null = null
    mockApiGet.mockImplementation(routeGet)
    mockApiDelete.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAccountingConnections())
    expect(result.current.loading).toBe(true)
    expect(result.current.refreshing).toBe(false)
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockApiGet.mockImplementation((url: string) =>
      url === '/accounting/connections' ? new Promise((resolve) => { releaseRelist = resolve }) : routeGet(url),
    )
    let done: Promise<void> | undefined
    act(() => { done = result.current.disconnect('fortnox') })
    await waitFor(() => expect(result.current.refreshing).toBe(true))
    // Mid-refetch: not `loading`, and the rows the caller had are still there.
    expect(result.current.loading).toBe(false)
    expect(result.current.connections).toHaveLength(1)

    await act(async () => {
      releaseRelist!({ connections: [] })
      await done
    })
    expect(result.current.refreshing).toBe(false)
    expect(result.current.loading).toBe(false)
    expect(result.current.connections).toEqual([])
  })

  it('updateSettings PATCHes …/settings with the snake_case body and swaps the returned row in place', async () => {
    mockApiGet.mockImplementation(routeGet)
    const merged = { ...CONNECTED.connections[0], settings: { suggestedAccount: '6540', autoFeed: false } }
    mockApiPatch.mockResolvedValue({ connection: merged })
    const { result } = renderHook(() => useAccountingConnections())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.updateSettings('fortnox', { suggested_account: '6540', auto_feed: false }))
    expect(mockApiPatch).toHaveBeenCalledWith('/accounting/connections/fortnox/settings', {
      suggested_account: '6540',
      auto_feed: false,
    })
    // No re-list: the PATCH answer IS the row.
    expect(mockApiGet.mock.calls.filter((c) => c[0] === '/accounting/connections')).toHaveLength(1)
    expect(result.current.connections[0].settings).toEqual({ suggestedAccount: '6540', autoFeed: false })
  })

  it('a refused PATCH leaves the list untouched and rejects with the ApiRequestError', async () => {
    mockApiGet.mockImplementation(routeGet)
    mockApiPatch.mockRejectedValue(
      new ApiRequestError('suggested_account must be a four-digit BAS account', 400, {
        error: 'suggested_account must be a four-digit BAS account',
        error_code: 'INVALID_SETTING',
        key: 'suggested_account',
      }),
    )
    const { result } = renderHook(() => useAccountingConnections())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await expect(act(() => result.current.updateSettings('fortnox', { suggested_account: '12' }))).rejects.toBeInstanceOf(ApiRequestError)
    expect(result.current.connections[0].settings).toEqual({ suggestedAccount: null, autoFeed: true })
  })

  it('backfill POSTs …/backfill with `since` exactly as given, then re-lists', async () => {
    mockApiGet.mockImplementation(routeGet)
    mockApiPost.mockResolvedValue({ feedFrom: '2026-01-01T00:00:00.000Z', fed: 3 })
    const { result } = renderHook(() => useAccountingConnections())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let answer: unknown
    await act(async () => {
      answer = await result.current.backfill('fortnox', '2026-01-01')
    })
    expect(mockApiPost).toHaveBeenCalledWith('/accounting/connections/fortnox/backfill', { since: '2026-01-01' })
    expect(answer).toEqual({ feedFrom: '2026-01-01T00:00:00.000Z', fed: 3 })
    expect(mockApiGet).toHaveBeenCalledWith('/accounting/connections')
    expect(mockApiGet.mock.calls.filter((c) => c[0] === '/accounting/connections')).toHaveLength(2)
  })

  it('accountingRefusal narrows the structured body and degrades to code:null on anything else', () => {
    expect(
      accountingRefusal(new ApiRequestError('no', 400, { error: 'no', error_code: 'SINCE_NOT_EARLIER' })),
    ).toEqual({ code: 'SINCE_NOT_EARLIER', key: null, message: 'no' })
    expect(
      accountingRefusal(new ApiRequestError('bad', 400, { error: 'bad', error_code: 'INVALID_SETTING', key: 'auto_feed' })),
    ).toEqual({ code: 'INVALID_SETTING', key: 'auto_feed', message: 'bad' })
    expect(accountingRefusal(new ApiRequestError('plain', 500, { error: 'plain' }))).toEqual({ code: null, key: null, message: 'plain' })
    expect(accountingRefusal(new Error('network'))).toEqual({ code: null, key: null, message: 'network' })
    expect(accountingRefusal('nope')).toEqual({ code: null, key: null, message: '' })
  })
})
