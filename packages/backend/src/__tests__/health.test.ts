import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { registerHealthRoutes, type HealthRouteOptions } from '../routes/health.js'

describe('GET /health', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function buildHealthApp(overrides: Partial<HealthRouteOptions> = {}): FastifyInstance {
    app = Fastify({ logger: false })
    registerHealthRoutes(app, {
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      getRelayerStatus: () => [
        {
          chainId: 8453,
          address: '0x1234567890123456789012345678901234567890',
          balanceWei: '42',
          low: false,
          checkedAt: '2026-09-04T00:00:00.000Z',
        },
      ],
      getPassportStatus: () => ({ configured: true }) as never,
      trustProxyHops: 1,
      opsToken: 'operator-secret',
      ...overrides,
    })
    return app
  }

  it('returns 200 with status ok and timestamp', async () => {
    const response = await buildHealthApp().inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('ok')
    expect(body.timestamp).toBeDefined()
    // Verify timestamp is a valid ISO string
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
    expect(Object.keys(body).sort()).toEqual(['db', 'status', 'timestamp'])
    expect(body.db).toEqual(expect.objectContaining({ status: 'ok' }))
    expect(JSON.stringify(body)).not.toMatch(/0x[0-9a-fA-F]{40}|balanceWei/)
  })

  it('returns only minimal health details when the database is degraded', async () => {
    const response = await buildHealthApp({ checkDatabase: vi.fn().mockRejectedValue(new Error('secret db detail')) }).inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: 'degraded',
      timestamp: expect.any(String),
      db: { status: 'error' },
    })
    expect(JSON.stringify(response.json())).not.toMatch(/secret db detail|0x[0-9a-fA-F]{40}|balanceWei/)
  })
})

describe('GET /health/ops', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function buildOpsApp(opsToken: string): FastifyInstance {
    app = Fastify({ logger: false })
    registerHealthRoutes(app, {
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      getRelayerStatus: () => [],
      getPassportStatus: () => ({ configured: true }) as never,
      trustProxyHops: 1,
      opsToken,
    })
    return app
  }

  it('returns 404 when the route is not configured', async () => {
    const response = await buildOpsApp('').inject({
      method: 'GET',
      url: '/health/ops',
      headers: { 'x-haven-ops-token': 'anything' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('rejects an invalid token and returns diagnostics for a valid one', async () => {
    const app = buildOpsApp('operator-secret')
    const invalid = await app.inject({ method: 'GET', url: '/health/ops', headers: { 'x-haven-ops-token': 'wrong' } })
    expect(invalid.statusCode).toBe(401)

    const valid = await app.inject({
      method: 'GET',
      url: '/health/ops',
      headers: { 'x-haven-ops-token': 'operator-secret' },
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.json()).toEqual({
      relayer: [],
      passport: { configured: true },
      trustProxy: { hops: 1, authRateLimitArmed: true },
    })
  })

  it('uses constant-time token comparison', async () => {
    const source = await readFile(new URL('../middleware/ops-token.ts', import.meta.url), 'utf8')
    expect(source).toContain('timingSafeEqual')
  })
})
