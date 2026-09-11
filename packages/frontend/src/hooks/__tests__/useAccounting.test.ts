import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * #2862: the accounting hooks point at the provider-generic routes
 * (`/accounting/providers`, `/accounting/connections/*`) — the
 * `/accounting/fortnox/*` router is gone. `useFortnox` keeps its surface for
 * the page (slice 10 redesigns it) but derives its status from the generic
 * listings. Headless equivalent of the browser check: the exact URLs called.
 */

const { mockApiGet, mockApiPost, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiDelete: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}))

import { useAccountingConnections, useAccountingProviders, useFortnox } from '@/hooks/useAccounting'

const PROVIDERS = {
  providers: [
    { id: 'fortnox', displayName: 'Fortnox', authKind: 'oauth2', availability: 'live', configured: true, capabilities: { attachments: true, verify: true, revoke: false, companyInfo: true }, requiredScopes: [] },
    { id: 'accounted', displayName: 'Accounted', authKind: 'oauth2', availability: 'coming_soon', configured: false, capabilities: { attachments: false, verify: false, revoke: false, companyInfo: false }, requiredScopes: [] },
  ],
}
const CONNECTED = {
  connections: [
    { provider: 'fortnox', displayName: 'Fortnox', authKind: 'oauth2', status: 'connected', statusReason: null, isActiveDestination: true, feedFrom: null, grantedScope: 'bookkeeping', tokenExpiresAt: '2099-01-01T00:00:00.000Z', externalCompanyName: 'Ada AB', baseCurrency: 'SEK', lastPushAt: null, lastError: null, connectedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
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

  it('useFortnox derives configured/connected from the generic listings and disconnects on the generic route', async () => {
    mockApiGet.mockImplementation(routeGet)
    mockApiDelete.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFortnox())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toEqual({ configured: true, connected: true, scope: 'bookkeeping', expiresAt: '2099-01-01T00:00:00.000Z' })
    // Nothing Fortnox-shaped is called any more.
    for (const call of mockApiGet.mock.calls) expect(String(call[0])).not.toMatch(/accounting\/fortnox/)

    await act(() => result.current.disconnect())
    expect(mockApiDelete).toHaveBeenCalledWith('/accounting/connections/fortnox')
  })

  it('useFortnox reports not connected when the connection row is disconnected', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === '/accounting/connections'
        ? Promise.resolve({ connections: [{ ...CONNECTED.connections[0], status: 'disconnected', isActiveDestination: false }] })
        : routeGet(url),
    )
    const { result } = renderHook(() => useFortnox())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toMatchObject({ configured: true, connected: false, scope: null, expiresAt: null })
  })
})
