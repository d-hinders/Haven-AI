import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Provider-generic connection routes (#2862, epic #2858) — the successor of
 * `routes/__tests__/fortnox.test.ts`, keeping its redaction bar.
 *
 * What runs REAL here: the route handlers, the connection service
 * (`modules/accounting/connections.ts`), the registry gate
 * (`assertConnectable`), the state issuance and the single-use consumption
 * (`oauth-state.ts`). What is stubbed: the database (repository functions
 * replaced by an in-memory map), the provider HTTP behind the OAuth2 flow
 * (`completeOAuth2Connect`) and the API-key flow, and the state store's
 * table (`incrementRateLimit` → an in-memory counter with the same first-call
 * semantic). So "a replayed state is refused" is the real callback path with
 * the real consumption logic — a mutation that drops the jti consumption
 * makes that test go red.
 *
 * Sentinel secrets: if either string appears in any body or header, a route
 * has leaked credential material.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: {
    frontendUrl: 'https://app.test',
    fortnoxClientId: 'cid',
    fortnoxClientSecret: 'csecret',
    fortnoxRedirectUri: 'https://api.test/accounting/connections/fortnox/callback',
    legacyBookkeepingEnabled: false,
  },
}))
vi.mock('../../config.js', () => ({ config: configMock }))

// In-memory `accounting_connections`: keyed (user, provider). The repository's
// SQL is covered on the real database elsewhere; the routes need only the
// function contract.
const { rows, repo } = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>()
  const key = (u: string, p: string) => `${u}::${p}`
  const repo = {
    getConnection: vi.fn(async (u: string, p: string) => rows.get(key(u, p)) ?? null),
    getActiveConnection: vi.fn(async (u: string) =>
      [...rows.values()].find((r) => r.user_id === u && r.is_active_destination && r.status === 'connected') ?? null),
    listConnections: vi.fn(async (u: string) => [...rows.values()].filter((r) => r.user_id === u)),
    setActiveDestination: vi.fn(async (u: string, p: string, opts: { feedFrom?: Date } = {}) => {
      for (const r of rows.values()) if (r.user_id === u) r.is_active_destination = false
      const r = rows.get(key(u, p))
      if (r) { r.is_active_destination = true; if (opts.feedFrom) r.feed_from = opts.feedFrom }
    }),
    setStatus: vi.fn(async () => {}),
    disconnect: vi.fn(async (u: string, p: string, reason: string) => {
      const r = rows.get(key(u, p))
      if (r) { r.status = 'disconnected'; r.status_reason = reason; r.secrets_ciphertext = null; r.is_active_destination = false }
    }),
    setCompanyInfo: vi.fn(async () => {}),
    updateSecrets: vi.fn(async () => {}),
    upsertConnection: vi.fn(async () => { throw new Error('not used here') }),
  }
  return { rows, repo }
})
vi.mock('../../infra/repositories/accounting-connections.js', () => repo)

// The state store: same first-call semantic as `rate_limit_counters`.
const { stateStore } = vi.hoisted(() => {
  const counts = new Map<string, number>()
  return {
    stateStore: {
      counts,
      incrementRateLimit: vi.fn(async (k: string): Promise<{ current: number; ttl: number } | null> => {
        const n = (counts.get(k) ?? 0) + 1
        counts.set(k, n)
        return { current: n, ttl: 1000 }
      }),
    },
  }
})
vi.mock('../../infra/repositories/rate-limit-counters.js', () => ({ incrementRateLimit: stateStore.incrementRateLimit }))

const flowMocks = vi.hoisted(() => ({ completeOAuth2Connect: vi.fn(), connectWithApiKey: vi.fn() }))
vi.mock('../../modules/accounting/oauth-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/accounting/oauth-flow.js')>()),
  completeOAuth2Connect: flowMocks.completeOAuth2Connect,
}))
vi.mock('../../modules/accounting/api-key-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/accounting/api-key-flow.js')>()),
  connectWithApiKey: flowMocks.connectWithApiKey,
}))

import accountingConnectionsRoutes from '../accounting-connections.js'
import {
  InMemoryConnector,
  OAUTH_STATE_PURPOSE,
  clearConnectors,
  clearTestProviders,
  registerConnector,
  registerTestProvider,
  type AccountingConnector,
} from '../../modules/accounting/index.js'

const ACCESS_TOKEN = 'LEAKED_ACCESS_TOKEN_3f9a'
const REFRESH_TOKEN = 'LEAKED_REFRESH_TOKEN_b71c'
const API_KEY = 'LEAKED_API_KEY_9c2e'
const USER = 'user-1'

function leaks(text: string): boolean {
  return text.includes(ACCESS_TOKEN) || text.includes(REFRESH_TOKEN) || text.includes(API_KEY)
}

function row(provider: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${provider}`,
    user_id: USER,
    provider,
    auth_kind: 'oauth2',
    secrets_ciphertext: Buffer.from(JSON.stringify({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN })),
    secrets_key_version: 0,
    external_company_id: null,
    external_company_name: 'Ada AB',
    base_currency: 'SEK',
    status: 'connected',
    status_reason: null,
    granted_scope: 'bookkeeping',
    token_expires_at: new Date('2099-01-01T00:00:00.000Z'),
    is_active_destination: false,
    feed_from: null,
    settings: {},
    last_push_at: null,
    last_error: null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  }
}

/** A stand-in for the live Fortnox adapter: registered, so Fortnox is "configured". */
function stubConnector(provider: string): AccountingConnector {
  return {
    provider,
    isConnected: async () => true,
    pushTransaction: async () => ({ externalRef: null, status: 'skipped' }),
    verify: async () => ({ ok: false, error_code: 'not_connected' }),
    getCompanyInfo: async () => ({ externalCompanyId: null, name: null, baseCurrency: 'SEK' }),
    revoke: async () => {},
  }
}

describe('accounting connection routes (#2862)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(accountingConnectionsRoutes, { prefix: '/accounting' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    rows.clear()
    stateStore.counts.clear()
    clearConnectors()
    clearTestProviders()
    registerConnector(stubConnector('fortnox'))
    for (const m of Object.values(repo)) m.mockClear()
    flowMocks.completeOAuth2Connect.mockReset().mockImplementation(async ({ userId, provider }) => {
      const r = row(provider.id, { user_id: userId, is_active_destination: true })
      rows.set(`${userId}::${provider.id}`, r)
      return r
    })
    flowMocks.connectWithApiKey.mockReset()
  })

  const authed = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) })

  describe('GET /accounting/providers', () => {
    it('lists the four providers with their availability; only Fortnox is live', async () => {
      const res = await authed('GET', '/accounting/providers')
      expect(res.statusCode).toBe(200)
      const { providers } = res.json()
      expect(providers.map((p: { id: string; availability: string }) => [p.id, p.availability])).toEqual([
        ['fortnox', 'live'],
        ['accounted', 'coming_soon'],
        ['light', 'coming_soon'],
        ['igdrasil', 'coming_soon'],
      ])
      expect(providers[0]).toMatchObject({ authKind: 'oauth2', configured: true, capabilities: { attachments: true, verify: true } })
      expect(providers[0].requiredScopes).toContain('connectfile')
      expectMatchesSpec('GET', '/accounting/providers', res.json())
    })

    it('reports configured:false for a live provider with no connector on this deployment', async () => {
      clearConnectors()
      const res = await authed('GET', '/accounting/providers')
      expect(res.json().providers[0]).toMatchObject({ id: 'fortnox', configured: false })
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'GET', url: '/accounting/providers' })).statusCode).toBe(401)
    })
  })

  describe('GET /accounting/connections', () => {
    it('returns metadata only — never the secrets blob or a token', async () => {
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true }))
      const res = await authed('GET', '/accounting/connections')
      expect(res.statusCode).toBe(200)
      const { connections } = res.json()
      expect(connections).toHaveLength(1)
      expect(connections[0]).toMatchObject({
        provider: 'fortnox',
        displayName: 'Fortnox',
        status: 'connected',
        isActiveDestination: true,
        grantedScope: 'bookkeeping',
        tokenExpiresAt: '2099-01-01T00:00:00.000Z',
        externalCompanyName: 'Ada AB',
      })
      expect(connections[0]).not.toHaveProperty('secrets_ciphertext')
      expect(leaks(res.body)).toBe(false)
      expect(leaks(JSON.stringify(res.headers))).toBe(false)
      expectMatchesSpec('GET', '/accounting/connections', res.json())
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'GET', url: '/accounting/connections' })).statusCode).toBe(401)
    })
  })

  describe('POST /accounting/connections/:provider/connect-url', () => {
    it('issues a consent URL carrying a purpose-scoped, provider-bound, jti-bearing state and no token material', async () => {
      const res = await authed('POST', '/accounting/connections/fortnox/connect-url')
      expect(res.statusCode).toBe(200)
      const { url } = res.json()
      expect(url.startsWith('https://apps.fortnox.se/oauth-v1/auth?')).toBe(true)
      const state = new URL(url).searchParams.get('state')!
      const claims = app.jwt.verify<{ sub: string; purpose: string; provider: string; jti: string; exp: number; iat: number }>(state)
      expect(claims).toMatchObject({ sub: USER, purpose: OAUTH_STATE_PURPOSE, provider: 'fortnox' })
      expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/)
      expect(claims.exp - claims.iat).toBe(600)
      expect(leaks(res.body)).toBe(false)
      expectMatchesSpec('POST', '/accounting/connections/{provider}/connect-url', res.json())
    })

    it('LIVE-ONLY GATE: a coming_soon provider is refused even with a connector registered', async () => {
      // With a connector present, the ONLY thing standing between this call
      // and a consent URL is the availability check — the mutation target.
      registerConnector(stubConnector('accounted'))
      const res = await authed('POST', '/accounting/connections/accounted/connect-url')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'PROVIDER_NOT_LIVE' })
      expect(res.json()).not.toHaveProperty('url')
    })

    it('404s an unknown provider and 503s a live provider that is not configured here', async () => {
      expect((await authed('POST', '/accounting/connections/nope/connect-url')).statusCode).toBe(404)
      clearConnectors()
      const res = await authed('POST', '/accounting/connections/fortnox/connect-url')
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ error_code: 'PROVIDER_NOT_CONFIGURED' })
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'POST', url: '/accounting/connections/fortnox/connect-url' })).statusCode).toBe(401)
    })
  })

  describe('GET /accounting/connections/:provider/callback', () => {
    async function issueState(provider = 'fortnox'): Promise<string> {
      const res = await authed('POST', `/accounting/connections/${provider}/connect-url`)
      return new URL(res.json().url).searchParams.get('state')!
    }

    it('completes the connect for the user in the state and redirects without echoing anything', async () => {
      const state = await issueState()
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=auth-code&state=${state}` })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=connected')
      expect(flowMocks.completeOAuth2Connect).toHaveBeenCalledOnce()
      expect(flowMocks.completeOAuth2Connect.mock.calls[0][0]).toMatchObject({ userId: USER, code: 'auth-code', provider: { id: 'fortnox' } })
      expect(leaks(res.headers.location as string)).toBe(false)
      expect(leaks(res.body)).toBe(false)
    })

    it('SINGLE-USE: the same state replayed after a successful callback is refused before the code exchange', async () => {
      const state = await issueState()
      const first = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=code-1&state=${state}` })
      expect(first.headers.location).toContain('connect=connected')

      const replay = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=code-2&state=${state}` })
      expect(replay.statusCode).toBe(302)
      expect(replay.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error')
      // The second code never reached the provider.
      expect(flowMocks.completeOAuth2Connect).toHaveBeenCalledOnce()
    })

    it('two DIFFERENT states from the same user are each usable once', async () => {
      const a = await issueState()
      const b = await issueState()
      await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${a}` })
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${b}` })
      expect(res.headers.location).toContain('connect=connected')
      expect(flowMocks.completeOAuth2Connect).toHaveBeenCalledTimes(2)
    })

    it('fails closed when the state store cannot answer', async () => {
      const state = await issueState()
      stateStore.incrementRateLimit.mockImplementationOnce(async () => null)
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
      expect(res.headers.location).toContain('connect=error')
      expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
    })

    it('a state issued for one provider cannot complete another provider\'s callback', async () => {
      const state = await issueState('fortnox')
      registerTestProvider({ id: 'other', displayName: 'Other', authKind: 'oauth2', availability: 'live', capabilities: { attachments: false, verify: false, revoke: false, companyInfo: false }, requiredScopes: [] })
      registerConnector(stubConnector('other'))
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/other/callback?code=c&state=${state}` })
      expect(res.headers.location).toBe('https://app.test/accounting?provider=other&connect=error')
      expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
      // And the state was NOT consumed by the mismatch — it is still good for its own provider.
      const own = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
      expect(own.headers.location).toContain('connect=connected')
    })

    it('redirects denied / error for a declined consent, a missing code, a forged state, a session JWT, and a wrong purpose', async () => {
      const at = (url: string) => app.inject({ method: 'GET', url })
      expect((await at('/accounting/connections/fortnox/callback?error=access_denied')).headers.location).toBe(
        'https://app.test/accounting?provider=fortnox&connect=denied',
      )
      expect((await at('/accounting/connections/fortnox/callback')).headers.location).toContain('connect=error')
      expect((await at('/accounting/connections/fortnox/callback?code=c&state=not-a-jwt')).headers.location).toContain('connect=error')
      // An ordinary session token is not OAuth state (#1640).
      expect((await at(`/accounting/connections/fortnox/callback?code=c&state=${token}`)).headers.location).toContain('connect=error')
      const wrongPurpose = app.jwt.sign({ sub: USER, purpose: 'something_else', provider: 'fortnox', jti: 'x' } as unknown as { sub: string; email: string })
      expect((await at(`/accounting/connections/fortnox/callback?code=c&state=${wrongPurpose}`)).headers.location).toContain('connect=error')
      expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
    })

    it('collapses a failed connect (provider declined, key missing, currency refused) to the same error redirect', async () => {
      const state = await issueState()
      flowMocks.completeOAuth2Connect.mockRejectedValueOnce(new Error('token exchange failed: body with ' + ACCESS_TOKEN))
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
      expect(res.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error')
      expect(leaks(res.headers.location as string)).toBe(false)
    })
  })

  describe('POST /accounting/connections/:provider/api-key', () => {
    const KEYED = { id: 'keyed', displayName: 'Keyed', authKind: 'api_key' as const, availability: 'live' as const, capabilities: { attachments: false, verify: false, revoke: true, companyInfo: true }, requiredScopes: [] }

    it('validates at the provider, stores, and answers with metadata that never echoes the key', async () => {
      registerTestProvider(KEYED)
      registerConnector(stubConnector('keyed'))
      flowMocks.connectWithApiKey.mockImplementation(async ({ userId }) => row('keyed', { user_id: userId, auth_kind: 'api_key', granted_scope: null, token_expires_at: null }))
      const res = await authed('POST', '/accounting/connections/keyed/api-key', { apiKey: API_KEY })
      expect(res.statusCode).toBe(201)
      expect(flowMocks.connectWithApiKey.mock.calls[0][0]).toMatchObject({ userId: USER, apiKey: API_KEY, provider: { id: 'keyed' } })
      expect(res.json().connection).toMatchObject({ provider: 'keyed', authKind: 'api_key', status: 'connected' })
      expect(leaks(res.body)).toBe(false)
      expectMatchesSpec('POST', '/accounting/connections/{provider}/api-key', res.json(), '201')
    })

    it('400s a missing key, 409s an OAuth provider and a coming_soon provider — before any provider call', async () => {
      registerTestProvider(KEYED)
      registerConnector(stubConnector('keyed'))
      expect((await authed('POST', '/accounting/connections/keyed/api-key', {})).statusCode).toBe(400)
      const oauth = await authed('POST', '/accounting/connections/fortnox/api-key', { apiKey: API_KEY })
      expect(oauth.statusCode).toBe(409)
      expect(oauth.json()).toMatchObject({ error_code: 'WRONG_AUTH_KIND' })
      const soon = await authed('POST', '/accounting/connections/light/api-key', { apiKey: API_KEY })
      expect(soon.statusCode).toBe(409)
      expect(soon.json()).toMatchObject({ error_code: 'PROVIDER_NOT_LIVE' })
      expect(flowMocks.connectWithApiKey).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /accounting/connections/:provider', () => {
    it('disconnects (row kept, secrets cleared) and returns no token material', async () => {
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true }))
      const res = await authed('DELETE', '/accounting/connections/fortnox')
      expect(res.statusCode).toBe(204)
      expect(repo.disconnect).toHaveBeenCalledWith(USER, 'fortnox', 'user disconnected')
      expect(rows.get(`${USER}::fortnox`)).toMatchObject({ status: 'disconnected', secrets_ciphertext: null })
      expect(leaks(res.body)).toBe(false)
      expect(leaks(JSON.stringify(res.headers))).toBe(false)
    })

    it('revokes at the provider first when the descriptor declares the capability', async () => {
      const mem = new InMemoryConnector()
      registerTestProvider({ id: 'memory', displayName: 'Memory', authKind: 'api_key', availability: 'live', capabilities: { attachments: false, verify: true, revoke: true, companyInfo: true }, requiredScopes: [] })
      registerConnector(mem)
      rows.set(`${USER}::memory`, row('memory', { secrets_ciphertext: Buffer.from(JSON.stringify({ apiKey: API_KEY })) }))
      const res = await authed('DELETE', '/accounting/connections/memory')
      expect(res.statusCode).toBe(204)
      expect(mem.revoked).toEqual([{ apiKey: API_KEY }])
      expect(repo.disconnect).toHaveBeenCalledWith(USER, 'memory', 'user disconnected (grant revoked at provider)')
    })

    it('is idempotent — disconnecting nothing still succeeds', async () => {
      expect((await authed('DELETE', '/accounting/connections/fortnox')).statusCode).toBe(204)
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'DELETE', url: '/accounting/connections/fortnox' })).statusCode).toBe(401)
    })
  })

  describe('POST /accounting/connections/:provider/activate', () => {
    it('makes the connection the destination and stamps feed_from = now', async () => {
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true }))
      rows.set(`${USER}::memory`, row('memory'))
      const before = Date.now()
      const res = await authed('POST', '/accounting/connections/memory/activate')
      expect(res.statusCode).toBe(200)
      const [, , opts] = repo.setActiveDestination.mock.calls[0]
      expect(opts?.feedFrom).toBeInstanceOf(Date)
      expect(opts!.feedFrom!.getTime()).toBeGreaterThanOrEqual(before)
      expect(res.json().connection).toMatchObject({ provider: 'memory', isActiveDestination: true })
      expect(new Date(res.json().connection.feedFrom).getTime()).toBeGreaterThanOrEqual(before)
      expect(rows.get(`${USER}::fortnox`)).toMatchObject({ is_active_destination: false })
      expectMatchesSpec('POST', '/accounting/connections/{provider}/activate', res.json())
    })

    it('404s a missing connection and 409s one that is not connected', async () => {
      expect((await authed('POST', '/accounting/connections/fortnox/activate')).statusCode).toBe(404)
      rows.set(`${USER}::fortnox`, row('fortnox', { status: 'scope_missing' }))
      const res = await authed('POST', '/accounting/connections/fortnox/activate')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'NOT_CONNECTED' })
      expect(repo.setActiveDestination).not.toHaveBeenCalled()
    })
  })
})
