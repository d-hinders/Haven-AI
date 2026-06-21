import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * #492 — the legacy asserting bookkeeping surfaces (SIE export, finished voucher
 * push) must be unreachable when HAVEN_LEGACY_BOOKKEEPING_ENABLED is off, and
 * behave normally when on. The mocked config is mutable so each test flips the
 * flag (the routes read it at request time).
 */
const { mockConfig, mockQuery } = vi.hoisted(() => ({
  mockConfig: {
    legacyBookkeepingEnabled: false,
    frontendUrl: 'http://frontend.test',
    fortnoxClientId: '',
    fortnoxClientSecret: '',
    fortnoxRedirectUri: '',
  },
  mockQuery: vi.fn(),
}))

vi.mock('../../config.js', () => ({ config: mockConfig }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (req: { user?: unknown }) => { req.user = { sub: 'u1' } },
}))

import accountingRoutes from '../accounting.js'
import fortnoxRoutes from '../fortnox.js'

describe('legacy bookkeeping gate (#492)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(accountingRoutes, { prefix: '/accounting' })
    await app.register(fortnoxRoutes, { prefix: '/accounting/fortnox' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [] })
    mockConfig.legacyBookkeepingEnabled = false
  })

  it('SIE export returns 410 when the legacy flag is off', async () => {
    const res = await app.inject({ method: 'GET', url: '/accounting/export?format=sie' })
    expect(res.statusCode).toBe(410)
  })

  it('SIE export is reachable when the legacy flag is on', async () => {
    mockConfig.legacyBookkeepingEnabled = true
    const res = await app.inject({ method: 'GET', url: '/accounting/export?format=sie' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('#SIETYP 4')
  })

  it('voucher push returns 410 when the legacy flag is off', async () => {
    const res = await app.inject({ method: 'POST', url: '/accounting/fortnox/push' })
    expect(res.statusCode).toBe(410)
  })

  it('voucher push passes the gate when on (then fails only on no connection)', async () => {
    mockConfig.legacyBookkeepingEnabled = true
    const res = await app.inject({ method: 'POST', url: '/accounting/fortnox/push' })
    expect(res.statusCode).not.toBe(410)
    expect(res.statusCode).toBe(400) // "Fortnox is not connected"
  })

  it('fortnox status reports the legacy flag for the UI', async () => {
    const off = await app.inject({ method: 'GET', url: '/accounting/fortnox/status' })
    expect(off.json().legacyBookkeeping).toBe(false)
    mockConfig.legacyBookkeepingEnabled = true
    const on = await app.inject({ method: 'GET', url: '/accounting/fortnox/status' })
    expect(on.json().legacyBookkeeping).toBe(true)
  })
})
