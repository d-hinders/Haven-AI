import { describe, it, expect, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { registerHealthRoutes, type HealthRouteOptions } from '../routes/health.js'

/** The zero webhook counter block (#3019) — the shape `/health/ops` carries. */
function zeroWebhookCounters() {
  return {
    received: 0,
    bad_signature: 0,
    stale: 0,
    unknown_token: 0,
    duplicate: 0,
    processed: 0,
    feature_off: 0,
    unknown_type: 0,
    confirmed: 0,
  }
}

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
      getAccountingCounters: async () => ({ exhaustedSyncs: 0, connectionsNeedingAttention: 0, webhookCounters: zeroWebhookCounters() }),
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

  function buildOpsApp(opsToken: string, overrides: Partial<HealthRouteOptions> = {}): FastifyInstance {
    app = Fastify({ logger: false })
    registerHealthRoutes(app, {
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      getRelayerStatus: () => [],
      getPassportStatus: () => ({ configured: true }) as never,
      trustProxyHops: 1,
      opsToken,
      getAccountingCounters: async () => ({ exhaustedSyncs: 0, connectionsNeedingAttention: 0, webhookCounters: zeroWebhookCounters() }),
      ...overrides,
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
      accounting: { exhaustedSyncs: 0, connectionsNeedingAttention: 0, webhookCounters: zeroWebhookCounters() },
      // The request-validation shadow counters (#3029). This bare app installs
      // no plugin, so the module-level counters sit at their pre-install
      // default: mode 'off', nothing counted (vitest isolates per test file).
      // `wouldCoerce`/`coerceByRouteField` joined the payload with #3082 —
      // a body coercion is a shadow/enforce divergence a refusal never shows.
      request_validation: {
        mode: 'off',
        wouldRefuse: 0,
        wouldCoerce: 0,
        byRouteField: {},
        coerceByRouteField: {},
      },
    })
  })

  it('carries the two accounting counters (#2872) verbatim from the module, and nothing else about accounting', async () => {
    const getAccountingCounters = vi.fn(async () => ({ exhaustedSyncs: 3, connectionsNeedingAttention: 2, webhookCounters: zeroWebhookCounters() }))
    const app = buildOpsApp('operator-secret', { getAccountingCounters })
    const res = await app.inject({ method: 'GET', url: '/health/ops', headers: { 'x-haven-ops-token': 'operator-secret' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().accounting).toEqual({ exhaustedSyncs: 3, connectionsNeedingAttention: 2, webhookCounters: zeroWebhookCounters() })
    expect(getAccountingCounters).toHaveBeenCalledTimes(1)
    // A refused token never reaches the database.
    getAccountingCounters.mockClear()
    await app.inject({ method: 'GET', url: '/health/ops', headers: { 'x-haven-ops-token': 'wrong' } })
    expect(getAccountingCounters).not.toHaveBeenCalled()
    // No user, payment or provider identifiers on the wire — counts only.
    expect(JSON.stringify(res.json())).not.toMatch(/user_id|userId|payment_id|paymentId|fortnox/)
  })

  it('degrades accounting to nulls + unavailable when the counters throw — relayer and passport still answer, 200 (#2905)', async () => {
    // MUTATION TARGET (routes/health.ts): remove the try/catch around
    // getAccountingCounters and this is a 500 with no relayer on the wire.
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() }
    app = Fastify({ logger: false })
    app.addHook('onRequest', async (request) => {
      request.log = log as never
    })
    registerHealthRoutes(app, {
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      getRelayerStatus: () => [
        { chainId: 8453, address: '0x1234567890123456789012345678901234567890', balanceWei: '42', low: true, checkedAt: '2026-09-12T00:00:00.000Z' },
      ],
      getPassportStatus: () => ({ configured: true }) as never,
      trustProxyHops: 1,
      opsToken: 'operator-secret',
      getAccountingCounters: vi.fn(async () => {
        const err = new Error('connect ECONNREFUSED db.internal:5432 password=hunter2')
        err.name = 'DatabaseConnectionError'
        throw err
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/health/ops', headers: { 'x-haven-ops-token': 'operator-secret' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      relayer: [expect.objectContaining({ chainId: 8453, low: true })],
      passport: { configured: true },
      trustProxy: { hops: 1, authRateLimitArmed: true },
      accounting: { exhaustedSyncs: null, connectionsNeedingAttention: null, webhookCounters: null, unavailable: true },
      // The request-validation shadow counters (#3029, plus #3082's coercion
      // pair); pre-install default, same reason as the valid-token test above.
      request_validation: {
        mode: 'off',
        wouldRefuse: 0,
        wouldCoerce: 0,
        byRouteField: {},
        coerceByRouteField: {},
      },
    })
    // The failure is logged at warn with the error's class only — never its message.
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toEqual({ errName: 'DatabaseConnectionError' })
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toMatch(/hunter2|db\.internal|ECONNREFUSED/)
    expect(JSON.stringify(res.json())).not.toMatch(/hunter2|db\.internal|ECONNREFUSED/)
  })

  it('uses constant-time token comparison', async () => {
    const source = await readFile(new URL('../middleware/ops-token.ts', import.meta.url), 'utf8')
    expect(source).toContain('timingSafeEqual')
  })
})
