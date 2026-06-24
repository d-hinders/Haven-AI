import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Route-level credential-hygiene guard for the Fortnox surface.
 *
 * Fortnox `access_token` / `refresh_token` are OAuth secrets held server-side
 * only (`fortnox_connections`). This suite pins that they NEVER reach an API
 * response, matching the redaction bar set for delegate keys (PRs #261–#264).
 * The connection row deliberately carries the tokens (the server needs them to
 * push vouchers); the redaction boundary is the route, so that is where the
 * guard lives.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: {
    frontendUrl: 'https://app.test',
    legacyBookkeepingEnabled: false,
  },
}))

vi.mock('../../config.js', () => ({ config: configMock }))

const fortnoxConnectionMocks = vi.hoisted(() => ({
  fortnoxConfigured: vi.fn(),
  fortnoxCredentials: vi.fn(() => ({
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'https://app.test/cb',
  })),
  getFortnoxConnection: vi.fn(),
  getValidFortnoxAccessToken: vi.fn(),
  saveFortnoxConnection: vi.fn(),
  deleteFortnoxConnection: vi.fn(),
}))
vi.mock('../../lib/fortnox-connection.js', () => fortnoxConnectionMocks)

const fortnoxMocks = vi.hoisted(() => ({
  buildFortnoxAuthorizeUrl: vi.fn(() => 'https://apps.fortnox.se/oauth-v1/auth?client_id=cid'),
  exchangeCodeForTokens: vi.fn(),
  pushVoucher: vi.fn(),
  toFortnoxVoucher: vi.fn(),
  // Match the real class signature (message, status) so the mock stays
  // contract-faithful if a future test reaches the push error path.
  FortnoxError: class FortnoxError extends Error {
    constructor(message: string, public status: number) {
      super(message)
    }
  },
}))
vi.mock('../../lib/fortnox.js', () => fortnoxMocks)

vi.mock('../../lib/accounting-entry.js', () => ({
  buildAccountingEntries: vi.fn(async () => []),
}))

import fortnoxRoutes from '../fortnox.js'

// Sentinel secrets. If either string ever appears in a response body or header,
// the route has leaked an OAuth token.
const ACCESS_TOKEN = 'LEAKED_ACCESS_TOKEN_3f9a'
const REFRESH_TOKEN = 'LEAKED_REFRESH_TOKEN_b71c'

const CONNECTION_ROW = {
  user_id: 'user-1',
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  token_type: 'Bearer',
  scope: 'bookkeeping',
  expires_at: '2099-01-01T00:00:00.000Z',
}

function leaks(text: string): boolean {
  return text.includes(ACCESS_TOKEN) || text.includes(REFRESH_TOKEN)
}

describe('fortnox routes — OAuth token redaction', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(fortnoxRoutes, { prefix: '/accounting/fortnox' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    configMock.frontendUrl = 'https://app.test'
    configMock.legacyBookkeepingEnabled = false
    fortnoxConnectionMocks.fortnoxConfigured.mockReset().mockReturnValue(true)
    fortnoxConnectionMocks.getFortnoxConnection.mockReset().mockResolvedValue(CONNECTION_ROW)
    fortnoxConnectionMocks.saveFortnoxConnection.mockReset().mockResolvedValue(undefined)
    fortnoxConnectionMocks.deleteFortnoxConnection.mockReset().mockResolvedValue(undefined)
    fortnoxMocks.exchangeCodeForTokens.mockReset().mockResolvedValue({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      tokenType: 'Bearer',
      scope: 'bookkeeping',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    })
  })

  it('GET /status returns only safe connection metadata, never the tokens', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/accounting/fortnox/status',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The handler reads the full connection row (which holds the tokens) but
    // must only surface non-secret metadata.
    expect(body).toMatchObject({
      configured: true,
      connected: true,
      scope: 'bookkeeping',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    expect(body).not.toHaveProperty('access_token')
    expect(body).not.toHaveProperty('refresh_token')
    expect(leaks(res.body)).toBe(false)
    expect(leaks(JSON.stringify(res.headers))).toBe(false)
  })

  it('GET /status requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounting/fortnox/status' })
    expect(res.statusCode).toBe(401)
    expect(leaks(res.body)).toBe(false)
  })

  it('OAuth callback persists tokens but redirects without echoing them', async () => {
    const state = app.jwt.sign(
      { sub: 'user-1', purpose: 'fortnox_oauth' } as unknown as { sub: string; email: string },
      { expiresIn: '10m' },
    )

    const res = await app.inject({
      method: 'GET',
      url: `/accounting/fortnox/callback?code=auth-code&state=${state}`,
    })

    expect(res.statusCode).toBe(302)
    // Tokens were exchanged + saved server-side …
    expect(fortnoxConnectionMocks.saveFortnoxConnection).toHaveBeenCalledOnce()
    // … but the browser-facing redirect carries no token material.
    expect(res.headers.location).toBe('https://app.test/settings?fortnox=connected')
    expect(leaks(res.headers.location as string)).toBe(false)
    expect(leaks(res.body)).toBe(false)
  })

  it('POST /connect-url returns a consent URL with no token material', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/accounting/fortnox/connect-url',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('url')
    expect(leaks(res.body)).toBe(false)
  })

  it('DELETE disconnects without returning token material', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/accounting/fortnox',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(204)
    expect(fortnoxConnectionMocks.deleteFortnoxConnection).toHaveBeenCalledOnce()
    expect(leaks(res.body)).toBe(false)
    expect(leaks(JSON.stringify(res.headers))).toBe(false)
  })
})

describe('fortnox routes — route invariants', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(fortnoxRoutes, { prefix: '/accounting/fortnox' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    configMock.frontendUrl = 'https://app.test'
    configMock.legacyBookkeepingEnabled = false
    fortnoxConnectionMocks.fortnoxConfigured.mockReset().mockReturnValue(true)
    fortnoxConnectionMocks.getFortnoxConnection.mockReset().mockResolvedValue(CONNECTION_ROW)
    fortnoxConnectionMocks.getValidFortnoxAccessToken.mockReset().mockResolvedValue('access')
    fortnoxConnectionMocks.deleteFortnoxConnection.mockReset().mockResolvedValue(undefined)
    fortnoxMocks.exchangeCodeForTokens.mockReset()
  })

  describe('authentication', () => {
    it('POST /connect-url rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'POST', url: '/accounting/fortnox/connect-url' })
      expect(res.statusCode).toBe(401)
    })

    it('POST /push rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'POST', url: '/accounting/fortnox/push' })
      expect(res.statusCode).toBe(401)
    })

    it('DELETE rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/accounting/fortnox' })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('GET /status', () => {
    it('reports configured:false when Fortnox is not configured', async () => {
      fortnoxConnectionMocks.fortnoxConfigured.mockReturnValue(false)
      const res = await app.inject({
        method: 'GET',
        url: '/accounting/fortnox/status',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ configured: false, connected: false, legacyBookkeeping: false })
      // No connection is read when the integration isn't configured.
      expect(fortnoxConnectionMocks.getFortnoxConnection).not.toHaveBeenCalled()
    })

    it('reports connected:false with null metadata when no connection is stored', async () => {
      fortnoxConnectionMocks.getFortnoxConnection.mockResolvedValue(null)
      const res = await app.inject({
        method: 'GET',
        url: '/accounting/fortnox/status',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        configured: true,
        connected: false,
        scope: null,
        expiresAt: null,
      })
    })
  })

  describe('POST /push (legacy voucher push)', () => {
    it('returns 410 Gone while legacy bookkeeping is disabled', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/accounting/fortnox/push',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(410)
      // The gate short-circuits before any token/accounting work runs.
      expect(fortnoxConnectionMocks.getValidFortnoxAccessToken).not.toHaveBeenCalled()
    })

    it('rejects a malformed "from" date with 400 before doing work', async () => {
      configMock.legacyBookkeepingEnabled = true
      const res = await app.inject({
        method: 'POST',
        url: '/accounting/fortnox/push?from=not-a-date',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(400)
      expect(fortnoxConnectionMocks.getValidFortnoxAccessToken).not.toHaveBeenCalled()
    })

    it('rejects a malformed "to" date with 400 before doing work', async () => {
      configMock.legacyBookkeepingEnabled = true
      const res = await app.inject({
        method: 'POST',
        url: '/accounting/fortnox/push?to=13-2026-01',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(400)
      expect(fortnoxConnectionMocks.getValidFortnoxAccessToken).not.toHaveBeenCalled()
    })
  })

  describe('OAuth callback error redirects', () => {
    it('redirects with fortnox=denied when the user denies consent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounting/fortnox/callback?error=access_denied',
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://app.test/settings?fortnox=denied')
    })

    it('redirects with fortnox=error when code or state is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/accounting/fortnox/callback' })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://app.test/settings?fortnox=error')
    })

    it('redirects with fortnox=error on a forged/unverifiable state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/accounting/fortnox/callback?code=auth-code&state=not-a-valid-jwt',
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://app.test/settings?fortnox=error')
      // A forged state must never reach the token exchange.
      expect(fortnoxMocks.exchangeCodeForTokens).not.toHaveBeenCalled()
    })

    it('redirects with fortnox=error when the state has the wrong purpose', async () => {
      const wrongPurpose = app.jwt.sign(
        { sub: 'user-1', purpose: 'something_else' } as unknown as { sub: string; email: string },
      )
      const res = await app.inject({
        method: 'GET',
        url: `/accounting/fortnox/callback?code=auth-code&state=${wrongPurpose}`,
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('https://app.test/settings?fortnox=error')
      expect(fortnoxMocks.exchangeCodeForTokens).not.toHaveBeenCalled()
    })
  })
})
