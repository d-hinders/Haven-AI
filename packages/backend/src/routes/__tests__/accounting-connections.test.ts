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
    // #2918: on by default so every existing test above exercises the
    // feature ON. The gate describe block below flips these two.
    hosted: true,
    accountingEnabled: true,
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
    stampFeedFromIfUnset: vi.fn(async () => null),
    updateSecrets: vi.fn(async () => {}),
    upsertConnection: vi.fn(async () => { throw new Error('not used here') }),
    // #2867: the same MERGE semantic as `MERGE_CONNECTION_SETTINGS_SQL`
    // (`settings || patch`) — other keys survive. The SQL itself is proven
    // on the real database in backfill-and-settings.db.test.ts.
    mergeSettings: vi.fn(async (u: string, p: string, patch: Record<string, unknown>) => {
      const r = rows.get(key(u, p))
      if (!r) return null
      r.settings = { ...(r.settings as Record<string, unknown>), ...patch }
      return r
    }),
    // #2867: `RECORD_BACKFILL_SQL`'s guard — only an existing, non-null
    // floor that is LATER than `since` moves; anything else updates nothing.
    recordBackfill: vi.fn(async (u: string, p: string, input: { since: Date; requestedAt: Date }) => {
      const r = rows.get(key(u, p))
      if (!r || !r.feed_from || (r.feed_from as Date).getTime() <= input.since.getTime()) return null
      r.feed_from = input.since
      r.settings = { ...(r.settings as Record<string, unknown>), backfill: { since: input.since.toISOString(), requestedAt: input.requestedAt.toISOString() } }
      return r
    }),
  }
  return { rows, repo }
})
// The pure helpers (`connectionSettings`, the settings key names, …) stay
// real; only the data access is replaced.
vi.mock('../../infra/repositories/accounting-connections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/repositories/accounting-connections.js')>()),
  ...repo,
}))

// #2867: the backfill's one bounded sync — the orchestrator is proven on the
// real database; here only "it was triggered, once, after the move" matters.
const orchestratorMocks = vi.hoisted(() => ({ syncUser: vi.fn(async () => ({ fed: 0, total: 0 })) }))
vi.mock('../../modules/accounting/feed-orchestrator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/accounting/feed-orchestrator.js')>()),
  syncUser: orchestratorMocks.syncUser,
}))

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

// #2918: the entitlement repository — mocked so a connect can be proven to
// never consult it (the #2861 decision: entitlement gates the FEED, not
// connecting). A plain always-throwing `vi.fn` (not the positional
// once-chained resolver the db-mock ratchet counts) that would fail any
// assertion the moment it runs.
const entitlementRepo = vi.hoisted(() => ({
  hasEntitlementRow: vi.fn(async () => {
    throw new Error('hasEntitlementRow must not be consulted by a connection route (#2861)')
  }),
}))
vi.mock('../../infra/repositories/account-entitlements.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/repositories/account-entitlements.js')>()),
  hasEntitlementRow: entitlementRepo.hasEntitlementRow,
}))

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
  UnsupportedBaseCurrencyError,
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
    external_company_id: '1234567',
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

/** What the stub connectors were asked to revoke (#2863: Fortnox declares the capability). */
const revoked: Array<{ provider: string; secrets: Record<string, unknown> }> = []

/** A stand-in for the live Fortnox adapter: registered, so Fortnox is "configured". */
function stubConnector(provider: string): AccountingConnector {
  return {
    provider,
    isConnected: async () => true,
    pushTransaction: async () => ({ externalRef: null, status: 'skipped' }),
    verify: async () => ({ ok: false, error_code: 'not_connected' }),
    getCompanyInfo: async () => ({ externalCompanyId: null, name: null, baseCurrency: 'SEK' }),
    revoke: async (secrets) => { revoked.push({ provider, secrets }) },
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
    orchestratorMocks.syncUser.mockReset().mockResolvedValue({ fed: 0, total: 0 })
    entitlementRepo.hasEntitlementRow.mockClear()
    configMock.hosted = true
    configMock.accountingEnabled = true
  })

  const authed = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
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
        // #2864: the company the connection points at — id, name, currency.
        externalCompanyId: '1234567',
        externalCompanyName: 'Ada AB',
        baseCurrency: 'SEK',
        // #2867: settings with defaults applied — an empty JSONB reads as these.
        settings: { suggestedAccount: null, autoFeed: true },
      })
      expect(connections[0]).not.toHaveProperty('secrets_ciphertext')
      // #2865: a grant that carries only `bookkeeping` is short of the other
      // six — named in the descriptor's order, even on a `connected` row.
      expect(connections[0].missingScopes).toEqual(['supplierinvoice', 'supplier', 'archive', 'inbox', 'connectfile', 'companyinformation'])
      expect(connections[0]).not.toHaveProperty('companySwitches')
      expect(leaks(res.body)).toBe(false)
      expect(leaks(JSON.stringify(res.headers))).toBe(false)
      expectMatchesSpec('GET', '/accounting/connections', res.json())
    })

    it('#2865: missingScopes is empty for a full grant, and names what a push-time refusal recorded on a scope_missing row', async () => {
      const full = 'bookkeeping supplierinvoice supplier archive inbox connectfile companyinformation'
      rows.set(`${USER}::fortnox`, row('fortnox', { granted_scope: full }))
      let res = await authed('GET', '/accounting/connections')
      expect(res.json().connections[0].missingScopes).toEqual([])

      // The scope string looked complete, but Fortnox refused the file
      // connection: the reason written at push time names the scope.
      rows.set(`${USER}::fortnox`, row('fortnox', {
        granted_scope: full,
        status: 'scope_missing',
        status_reason: 'missing scopes: connectfile — receipt attachment failed: Fortnox POST /supplierinvoicefileconnections failed (HTTP 400: Har inte behörighet för scope. [2000663]).',
      }))
      res = await authed('GET', '/accounting/connections')
      expect(res.json().connections[0]).toMatchObject({ status: 'scope_missing', missingScopes: ['connectfile'] })
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

    it('#2865 RE-CONSENT: an existing scope_missing connection gets a fresh consent URL — not a refusal', async () => {
      rows.set(`${USER}::fortnox`, row('fortnox', { status: 'scope_missing', status_reason: 'missing scopes: connectfile — …', is_active_destination: true }))
      const res = await authed('POST', '/accounting/connections/fortnox/connect-url')
      expect(res.statusCode).toBe(200)
      expect(res.json().url.startsWith('https://apps.fortnox.se/oauth-v1/auth?')).toBe(true)
      // The row is untouched by issuing the URL — only the callback changes it.
      expect(rows.get(`${USER}::fortnox`)).toMatchObject({ status: 'scope_missing', is_active_destination: true })
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

    it('#2865 RE-CONSENT: the callback on an EXISTING connection updates that row — one row, same id, connected, settings and feed_from kept', async () => {
      const feedFrom = new Date('2026-09-01T12:00:00.000Z')
      rows.set(`${USER}::fortnox`, row('fortnox', {
        status: 'scope_missing', status_reason: 'missing scopes: connectfile — …', is_active_destination: true,
        feed_from: feedFrom, settings: { autoFeed: false, companySwitches: [{ at: '2026-09-02T00:00:00.000Z', fromCompanyId: '1', toCompanyId: '2' }] },
      }))
      // The flow's real preservation is proven on the database
      // (scope-missing.db.test.ts); here the ROUTE must reach the flow with
      // the existing user + provider and hand back the updated row's summary.
      flowMocks.completeOAuth2Connect.mockImplementation(async ({ userId, provider }) => {
        const existing = rows.get(`${userId}::${provider.id}`)!
        Object.assign(existing, { status: 'connected', status_reason: null, granted_scope: 'bookkeeping supplierinvoice supplier archive inbox connectfile companyinformation' })
        return existing
      })
      const state = await issueState()
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=re-consent-code&state=${state}` })
      expect(res.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=connected')
      expect(flowMocks.completeOAuth2Connect.mock.calls[0][0]).toMatchObject({ userId: USER, provider: { id: 'fortnox' } })
      expect(rows.size).toBe(1)
      const list = await authed('GET', '/accounting/connections')
      expect(list.json().connections).toHaveLength(1)
      expect(list.json().connections[0]).toMatchObject({
        status: 'connected', statusReason: null, missingScopes: [], isActiveDestination: true, feedFrom: feedFrom.toISOString(),
      })
      expect(rows.get(`${USER}::fortnox`)!.settings).toEqual({ autoFeed: false, companySwitches: [{ at: '2026-09-02T00:00:00.000Z', fromCompanyId: '1', toCompanyId: '2' }] })
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

    it('collapses a failed connect (provider declined, key missing) to the same error redirect', async () => {
      const state = await issueState()
      flowMocks.completeOAuth2Connect.mockRejectedValueOnce(new Error('token exchange failed: body with ' + ACCESS_TOKEN))
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
      expect(res.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error')
      expect(leaks(res.headers.location as string)).toBe(false)
    })

    it('#2864/#2877: an UNSUPPORTED ledger currency is the one named refusal — connect=error&reason=unsupported_currency, nothing stored', async () => {
      const state = await issueState()
      flowMocks.completeOAuth2Connect.mockRejectedValueOnce(new UnsupportedBaseCurrencyError('JPY'))
      const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error&reason=unsupported_currency')
      expect(rows.size).toBe(0)
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

    it('#2864/#2877: a company that books in an UNSUPPORTED currency is refused (409) with the supported list named, and nothing is stored', async () => {
      registerTestProvider(KEYED)
      registerConnector(stubConnector('keyed'))
      // The flow throws BEFORE it stores (proven on the real database by the
      // conformance suite's case 7 for both flows); the route maps the error.
      flowMocks.connectWithApiKey.mockRejectedValueOnce(new UnsupportedBaseCurrencyError('JPY'))
      const res = await authed('POST', '/accounting/connections/keyed/api-key', { apiKey: API_KEY })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'UNSUPPORTED_BASE_CURRENCY' })
      expect(res.json().error).toContain('Haven feeds SEK, EUR, USD, DKK, NOK and GBP ledgers')
      expect(res.json().error).toContain('JPY')
      expect(res.json()).not.toHaveProperty('connection')
      expect(rows.size).toBe(0)
      expect(leaks(res.body)).toBe(false)
      expectMatchesSpec('POST', '/accounting/connections/{provider}/api-key', res.json(), '409')
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
      revoked.length = 0
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true }))
      const res = await authed('DELETE', '/accounting/connections/fortnox')
      expect(res.statusCode).toBe(204)
      // #2863: Fortnox declares `revoke`, so the grant is revoked at the
      // provider — with the refresh token still in hand — before the row is
      // cleared. The real HTTP shape is the conformance suite's; here the
      // dispatch and the order are what the route owns.
      expect(revoked).toEqual([{ provider: 'fortnox', secrets: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } }])
      expect(repo.disconnect).toHaveBeenCalledWith(USER, 'fortnox', 'user disconnected (grant revoked at provider)')
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
  describe('POST /accounting/connections/:provider/backfill (#2867)', () => {
    const FLOOR = new Date('2026-06-01T00:00:00.000Z')
    const active = () => rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true, feed_from: FLOOR, settings: { companySwitches: [{ at: '2026-05-01T00:00:00.000Z', fromCompanyId: '1', fromCompanyName: 'Old AB', toCompanyId: '1234567', toCompanyName: 'Ada AB' }] } }))

    it('moves feed_from EARLIER to `since`, records the choice, runs ONE sync and answers { feedFrom, fed, total }', async () => {
      active()
      orchestratorMocks.syncUser.mockResolvedValue({ fed: 3, total: 4 })
      const before = Date.now()
      const res = await authed('POST', '/accounting/connections/fortnox/backfill', { since: '2026-01-01' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ feedFrom: '2026-01-01T00:00:00.000Z', fed: 3, total: 4 })
      expectMatchesSpec('POST', '/accounting/connections/{provider}/backfill', res.json())
      // The move happened BEFORE the sync, on this user only.
      expect(repo.recordBackfill).toHaveBeenCalledOnce()
      expect(orchestratorMocks.syncUser).toHaveBeenCalledOnce()
      expect(orchestratorMocks.syncUser).toHaveBeenCalledWith(USER)
      expect(repo.recordBackfill.mock.invocationCallOrder[0]).toBeLessThan(orchestratorMocks.syncUser.mock.invocationCallOrder[0])
      const stored = rows.get(`${USER}::fortnox`)!
      expect((stored.feed_from as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z')
      const settings = stored.settings as { backfill: { since: string; requestedAt: string }; companySwitches: unknown[] }
      expect(settings.backfill.since).toBe('2026-01-01T00:00:00.000Z')
      expect(new Date(settings.backfill.requestedAt).getTime()).toBeGreaterThanOrEqual(before)
      // The merge preserved the #2864 log.
      expect(settings.companySwitches).toHaveLength(1)
      expect(leaks(res.body)).toBe(false)
    })

    it('REFUSES a `since` at or after the current feed_from — the floor and the sync are untouched (400 SINCE_NOT_EARLIER)', async () => {
      active()
      for (const since of ['2026-06-01T00:00:00.000Z', '2026-07-15']) {
        const res = await authed('POST', '/accounting/connections/fortnox/backfill', { since })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toMatchObject({ error_code: 'SINCE_NOT_EARLIER' })
        expect(res.json().error).toContain('2026-06-01T00:00:00.000Z')
        expectMatchesSpec('POST', '/accounting/connections/{provider}/backfill', res.json(), '400')
      }
      expect((rows.get(`${USER}::fortnox`)!.feed_from as Date).toISOString()).toBe(FLOOR.toISOString())
      expect(rows.get(`${USER}::fortnox`)!.settings).not.toHaveProperty('backfill')
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })

    it('refuses a connection with NO floor the same way — nothing earlier to include', async () => {
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true, feed_from: null }))
      const res = await authed('POST', '/accounting/connections/fortnox/backfill', { since: '2026-01-01' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error_code: 'SINCE_NOT_EARLIER' })
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })

    it('400s SINCE_INVALID for a missing, unparseable, future or pre-2020 `since` — before any read', async () => {
      active()
      // Strict ISO (review on #2901): free-form dates, TZ-less times and rolled-over days are refused too.
      for (const payload of [{}, { since: 'yesterday' }, { since: 42 }, { since: '2999-01-01' }, { since: '2019-12-31' }, { since: 'Jan 5 2026' }, { since: '2026-01-01T00:00:00' }, { since: '2026-02-30' }, { since: '2025' }]) {
        const res = await authed('POST', '/accounting/connections/fortnox/backfill', payload)
        expect(res.statusCode, JSON.stringify(payload)).toBe(400)
        expect(res.json()).toMatchObject({ error_code: 'SINCE_INVALID' })
        expectMatchesSpec('POST', '/accounting/connections/{provider}/backfill', res.json(), '400')
      }
      expect(repo.recordBackfill).not.toHaveBeenCalled()
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
      expect((rows.get(`${USER}::fortnox`)!.feed_from as Date).toISOString()).toBe(FLOOR.toISOString())
    })

    it('404s a missing connection and 409s one that is not the active connected destination', async () => {
      expect((await authed('POST', '/accounting/connections/fortnox/backfill', { since: '2026-01-01' })).statusCode).toBe(404)
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: false, feed_from: FLOOR }))
      const inactive = await authed('POST', '/accounting/connections/fortnox/backfill', { since: '2026-01-01' })
      expect(inactive.statusCode).toBe(409)
      expect(inactive.json()).toMatchObject({ error_code: 'NOT_ACTIVE' })
      rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true, status: 'needs_reauthorisation', feed_from: FLOOR }))
      expect((await authed('POST', '/accounting/connections/fortnox/backfill', { since: '2026-01-01' })).statusCode).toBe(409)
      expect(repo.recordBackfill).not.toHaveBeenCalled()
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'POST', url: '/accounting/connections/fortnox/backfill', payload: { since: '2026-01-01' } })).statusCode).toBe(401)
    })
  })

  describe('PATCH /accounting/connections/:provider/settings (#2867)', () => {
    const withLog = () => rows.set(`${USER}::fortnox`, row('fortnox', { settings: { companySwitches: [{ at: '2026-05-01T00:00:00.000Z', fromCompanyId: '1', fromCompanyName: null, toCompanyId: '1234567', toCompanyName: 'Ada AB' }], backfill: { since: '2026-01-01T00:00:00.000Z', requestedAt: '2026-06-01T00:00:00.000Z' } } }))

    it('stores suggested_account and auto_feed as a MERGE — the company-switch log and the backfill record survive', async () => {
      withLog()
      const res = await authed('PATCH', '/accounting/connections/fortnox/settings', { suggested_account: '6540', auto_feed: false })
      expect(res.statusCode).toBe(200)
      expect(res.json().connection).toMatchObject({ provider: 'fortnox', settings: { suggestedAccount: '6540', autoFeed: false } })
      expectMatchesSpec('PATCH', '/accounting/connections/{provider}/settings', res.json())
      expect(repo.mergeSettings).toHaveBeenCalledWith(USER, 'fortnox', { suggested_account: '6540', auto_feed: false })
      const stored = rows.get(`${USER}::fortnox`)!.settings as Record<string, unknown>
      expect(stored).toMatchObject({ suggested_account: '6540', auto_feed: false })
      expect(stored.companySwitches).toHaveLength(1)
      expect(stored.backfill).toEqual({ since: '2026-01-01T00:00:00.000Z', requestedAt: '2026-06-01T00:00:00.000Z' })
      // The wire summary never exposes the raw JSONB.
      expect(res.json().connection.settings).not.toHaveProperty('companySwitches')
      expect(leaks(res.body)).toBe(false)

      // One key at a time, and null clears the hint.
      const clear = await authed('PATCH', '/accounting/connections/fortnox/settings', { suggested_account: null })
      expect(clear.json().connection.settings).toEqual({ suggestedAccount: null, autoFeed: false })
      const on = await authed('PATCH', '/accounting/connections/fortnox/settings', { auto_feed: true })
      expect(on.json().connection.settings).toEqual({ suggestedAccount: null, autoFeed: true })
      // GET reads the same thing back.
      const list = await authed('GET', '/accounting/connections')
      expect(list.json().connections[0].settings).toEqual({ suggestedAccount: null, autoFeed: true })
    })

    it('a non-BAS account is refused for Fortnox with a 400 that names the key — nothing stored', async () => {
      withLog()
      // MUTATION TARGET: loosen `BAS_ACCOUNT_RE` (e.g. to three digits) and
      // the 3-digit case below is accepted.
      for (const bad of ['654', '65400', '9540', '0540', 'abcd', '', ' ']) {
        const res = await authed('PATCH', '/accounting/connections/fortnox/settings', { suggested_account: bad })
        expect(res.statusCode, JSON.stringify(bad)).toBe(400)
        expect(res.json()).toEqual({ error: expect.stringContaining('four-digit BAS account'), error_code: 'INVALID_SETTING', key: 'suggested_account' })
        expectMatchesSpec('PATCH', '/accounting/connections/{provider}/settings', res.json(), '400')
      }
      expect(repo.mergeSettings).not.toHaveBeenCalled()
      expect(rows.get(`${USER}::fortnox`)!.settings).not.toHaveProperty('suggested_account')
      // The positive control for the regex: the four BAS classes' edges.
      for (const ok of ['1000', '8999', ' 6540 ']) {
        expect((await authed('PATCH', '/accounting/connections/fortnox/settings', { suggested_account: ok })).statusCode).toBe(200)
      }
      expect(rows.get(`${USER}::fortnox`)!.settings).toMatchObject({ suggested_account: '6540' })
    })

    it('a non-Fortnox provider takes any non-empty account of at most 32 characters', async () => {
      rows.set(`${USER}::memory`, row('memory'))
      expect((await authed('PATCH', '/accounting/connections/memory/settings', { suggested_account: 'Travel:Software' })).statusCode).toBe(200)
      const long = await authed('PATCH', '/accounting/connections/memory/settings', { suggested_account: 'x'.repeat(33) })
      expect(long.statusCode).toBe(400)
      expect(long.json()).toMatchObject({ error_code: 'INVALID_SETTING', key: 'suggested_account' })
      expect((await authed('PATCH', '/accounting/connections/memory/settings', { suggested_account: '' })).statusCode).toBe(400)
    })

    it('an unknown key or a wrong type is a 400 that names the key; nothing else in the patch is applied', async () => {
      withLog()
      const unknown = await authed('PATCH', '/accounting/connections/fortnox/settings', { auto_feed: false, supplier_strategy: 'per_payment' })
      expect(unknown.statusCode).toBe(400)
      expect(unknown.json()).toEqual({ error: expect.stringContaining('supplier_strategy'), error_code: 'INVALID_SETTING', key: 'supplier_strategy' })
      const typed = await authed('PATCH', '/accounting/connections/fortnox/settings', { auto_feed: 'no' })
      expect(typed.statusCode).toBe(400)
      expect(typed.json()).toMatchObject({ error_code: 'INVALID_SETTING', key: 'auto_feed' })
      const camel = await authed('PATCH', '/accounting/connections/fortnox/settings', { suggestedAccount: '6540' })
      expect(camel.statusCode).toBe(400)
      expect(camel.json()).toMatchObject({ key: 'suggestedAccount' })
      expect(repo.mergeSettings).not.toHaveBeenCalled()
      expect(rows.get(`${USER}::fortnox`)!.settings).not.toHaveProperty('auto_feed')
    })

    it('an empty patch is a no-op that still answers with the row; a missing connection is 404', async () => {
      withLog()
      const res = await authed('PATCH', '/accounting/connections/fortnox/settings', {})
      expect(res.statusCode).toBe(200)
      expect(res.json().connection.settings).toEqual({ suggestedAccount: null, autoFeed: true })
      expect(repo.mergeSettings).not.toHaveBeenCalled()
      expect((await authed('PATCH', '/accounting/connections/memory/settings', { auto_feed: false })).statusCode).toBe(404)
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'PATCH', url: '/accounting/connections/fortnox/settings', payload: { auto_feed: false } })).statusCode).toBe(401)
    })
  })

  /**
   * #2918: the connection routes carried `authMiddleware` only — a signed-in
   * user on a deployment that is not hosted, or is hosted with the flag off,
   * could still start an OAuth consent, store a grant and set a destination.
   * `requireAccountingFeature` (middleware/accountingFeed.ts) closes that:
   * `config.hosted && config.accountingEnabled`, same 404 body shape as
   * `requireAccountingFeed`, and — the #2861 decision this issue explicitly
   * preserves — NOT the account entitlement, which stays the feed's gate.
   *
   * `/accounting/providers` is deliberately absent from `GATED_ROUTES`: it
   * stays session-only so the Coming soon page (#2869) can still list
   * platforms with the flag off.
   *
   * MUTATION-TESTED: removing `requireAccountingFeature` from any route
   * below turns its 404 assertion into a 200/201/204, and removing the
   * off-path `consumeOAuthState` call (or moving the feature check ahead of
   * it) turns the replay assertion in the last block green when it should
   * be red.
   */
  describe('feature gate: hosted && accountingEnabled (#2918)', () => {
    const GATED_ROUTES: Array<{ name: string; method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; url: string; payload?: unknown }> = [
      { name: 'GET /accounting/connections', method: 'GET', url: '/accounting/connections' },
      { name: 'POST connect-url', method: 'POST', url: '/accounting/connections/fortnox/connect-url' },
      { name: 'POST api-key', method: 'POST', url: '/accounting/connections/fortnox/api-key', payload: { apiKey: API_KEY } },
      { name: 'DELETE connection', method: 'DELETE', url: '/accounting/connections/fortnox' },
      { name: 'POST activate', method: 'POST', url: '/accounting/connections/fortnox/activate' },
      { name: 'POST backfill', method: 'POST', url: '/accounting/connections/fortnox/backfill', payload: { since: '2026-01-01' } },
      { name: 'PATCH settings', method: 'PATCH', url: '/accounting/connections/fortnox/settings', payload: { auto_feed: false } },
    ]

    const CASES: Array<[string, () => void]> = [
      ['hosted:false', () => { configMock.hosted = false }],
      ['hosted:true, accountingEnabled:false', () => { configMock.accountingEnabled = false }],
    ]

    for (const [label, flipOff] of CASES) {
      describe(label, () => {
        beforeEach(() => {
          // A real connection exists, so a route that "worked" would have
          // something to act on — the 404 has to come from the gate, not
          // from an incidental NOT_FOUND on empty state.
          rows.set(`${USER}::fortnox`, row('fortnox', { is_active_destination: true }))
          flipOff()
        })

        for (const { name, method, url, payload } of GATED_ROUTES) {
          it(`${name} answers 404 with the shared body and calls nothing downstream`, async () => {
            const res = await authed(method, url, payload)
            expect(res.statusCode).toBe(404)
            expect(res.json()).toEqual({ error: 'Not found' })
            expect(leaks(res.body)).toBe(false)
            // Nothing downstream ran: neither the OAuth/API-key flows, the
            // orchestrator, nor a single repository write.
            expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
            expect(flowMocks.connectWithApiKey).not.toHaveBeenCalled()
            expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
            expect(repo.setActiveDestination).not.toHaveBeenCalled()
            expect(repo.disconnect).not.toHaveBeenCalled()
            expect(repo.recordBackfill).not.toHaveBeenCalled()
            expect(repo.mergeSettings).not.toHaveBeenCalled()
          })
        }

        it('GET /accounting/providers still answers 200 — the Coming soon page reads it (#2869)', async () => {
          const res = await authed('GET', '/accounting/providers')
          expect(res.statusCode).toBe(200)
          expect(res.json().providers.length).toBeGreaterThan(0)
        })
      })
    }

    describe('GET .../callback mid-flight (never a bare 404)', () => {
      async function issueState(provider = 'fortnox'): Promise<string> {
        const res = await authed('POST', `/accounting/connections/${provider}/connect-url`)
        return new URL(res.json().url).searchParams.get('state')!
      }

      it('a consent already in flight when the flag is flipped off lands on the redirect with reason=feature_off, and the state is consumed', async () => {
        const state = await issueState()
        configMock.accountingEnabled = false
        const off = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
        expect(off.statusCode).toBe(302)
        expect(off.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error&reason=feature_off')
        expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
        expect(leaks(off.headers.location as string)).toBe(false)

        // The flag comes back on before the replay — the state must still
        // be dead: it was consumed on the off-path, not skipped.
        configMock.accountingEnabled = true
        const replay = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
        expect(replay.statusCode).toBe(302)
        expect(replay.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error')
        expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
      })

      it('self-hosted (hosted:false) mid-flight behaves the same way', async () => {
        const state = await issueState()
        configMock.hosted = false
        const res = await app.inject({ method: 'GET', url: `/accounting/connections/fortnox/callback?code=c&state=${state}` })
        expect(res.statusCode).toBe(302)
        expect(res.headers.location).toBe('https://app.test/accounting?provider=fortnox&connect=error&reason=feature_off')
        expect(flowMocks.completeOAuth2Connect).not.toHaveBeenCalled()
      })
    })

    it('#2861 preserved: connecting needs no entitlement row — the entitlement repository is never consulted', async () => {
      const res = await authed('POST', '/accounting/connections/fortnox/connect-url')
      expect(res.statusCode).toBe(200)
      expect(entitlementRepo.hasEntitlementRow).not.toHaveBeenCalled()
    })
  })
})
