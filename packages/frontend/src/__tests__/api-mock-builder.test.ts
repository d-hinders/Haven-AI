import { describe, expect, it } from 'vitest'
import { API_MOCK_DEFAULTS, apiMock } from '../../e2e/fixtures/api-mock'

/**
 * The builder's own runtime contract (#3027; review of #3034 found it pinned
 * by nothing — ConnectionsCard and useAgents stayed green with query
 * stripping removed). Four behaviours, each proven red by mutation of
 * `api-mock.ts` before this file landed.
 */
describe('apiMock() builder semantics (#3027)', () => {
  it('an unrouted path REJECTS instead of resolving undefined', async () => {
    const { api } = apiMock()
    await expect(api.get('/accounts')).rejects.toThrow('apiMock: unrouted /accounts')
  })

  it('matches by pathname — a query string does not miss the route', async () => {
    const { api } = apiMock()
    await expect(api.get('/agents?include=revoked')).resolves.toBe(API_MOCK_DEFAULTS['/agents'])
  })

  it('a function override receives the full requested path and can refuse', async () => {
    const seen: string[] = []
    const { api } = apiMock({
      '/accounting/connections': (path) => {
        seen.push(path)
        return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
      },
    })
    await expect(api.get('/accounting/connections?x=1')).rejects.toMatchObject({ status: 404 })
    expect(seen).toEqual(['/accounting/connections?x=1'])
  })

  it('an object override merges one level deep: untouched top-level keys keep their default, a given key is replaced whole', async () => {
    const providers = API_MOCK_DEFAULTS['/accounting/providers'].providers
    const { api } = apiMock({
      '/accounting/feed/status': { destination: null },
      '/accounting/providers': { providers: [providers[0]!] },
    })
    const status = (await api.get('/accounting/feed/status')) as typeof API_MOCK_DEFAULTS['/accounting/feed/status']
    expect(status.destination).toBeNull()
    expect(status.entitlementMode).toBe(API_MOCK_DEFAULTS['/accounting/feed/status'].entitlementMode)
    const list = (await api.get('/accounting/providers')) as typeof API_MOCK_DEFAULTS['/accounting/providers']
    expect(list.providers).toHaveLength(1)
    expect(providers.length).toBeGreaterThan(1)
  })
})
