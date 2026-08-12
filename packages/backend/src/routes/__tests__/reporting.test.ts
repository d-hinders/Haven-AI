import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Route-level invariants for the reporting feed API (epic #491).
 *
 * Pins how the route wires the entitlement gate and the sync orchestrator —
 * NOT the dedup mechanism itself, which is covered at the lib level
 * (feed-sync / feed-orchestrator / feed-dedup.integration). The route's job is:
 * authenticate; report availability without leaking the gated data path when
 * the account lacks the entitlement; hard-gate /sync to 404 when unavailable;
 * and delegate a single sync request to exactly one `syncUser` call (so the
 * route never adds its own double-post on top of the lib's idempotency).
 *
 * `entitlements.reportingFeedAvailable` is mocked, which drives BOTH the route
 * and the real `requireReportingFeed` middleware, so the gate is genuinely
 * exercised.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: { hosted: true, reportingFeedEnabled: true },
}))
vi.mock('../../config.js', () => ({ config: configMock }))

const entitlementMocks = vi.hoisted(() => ({ reportingFeedAvailable: vi.fn() }))
vi.mock('../../modules/agents/index.js', () => entitlementMocks)

const orchestratorMocks = vi.hoisted(() => ({
  getReportingStatus: vi.fn(),
  syncUser: vi.fn(),
}))
const connectorMocks = vi.hoisted(() => ({ hasLiveConnector: vi.fn() }))
const fortnoxMocks = vi.hoisted(() => ({ getFortnoxConnection: vi.fn(), verifyFortnoxInvoice: vi.fn() }))
// feed-orchestrator.ts, connector.ts and fortnox-connection.ts all fold into
// one public entry point post-#998 (modules/reporting/index.ts) — a single
// mock factory merging all three, not three vi.mock calls to the same
// specifier (the last one silently wins otherwise).
vi.mock('../../modules/reporting/index.js', () => ({
  ...orchestratorMocks,
  ...connectorMocks,
  ...fortnoxMocks,
}))

import reportingRoutes from '../reporting.js'

const USER = 'user-1'

describe('reporting routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(reportingRoutes, { prefix: '/accounting/reporting' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    configMock.hosted = true
    configMock.reportingFeedEnabled = true
    entitlementMocks.reportingFeedAvailable.mockReset().mockResolvedValue(true)
    orchestratorMocks.getReportingStatus.mockReset().mockResolvedValue([])
    orchestratorMocks.syncUser.mockReset().mockResolvedValue({ fed: 0 })
    connectorMocks.hasLiveConnector.mockReset().mockReturnValue(false)
    fortnoxMocks.getFortnoxConnection.mockReset().mockResolvedValue(null)
    fortnoxMocks.verifyFortnoxInvoice.mockReset()
  })

  function authed(method: 'GET' | 'POST', url: string) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
  }

  describe('authentication', () => {
    it('GET /status rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'GET', url: '/accounting/reporting/status' })
      expect(res.statusCode).toBe(401)
      expect(entitlementMocks.reportingFeedAvailable).not.toHaveBeenCalled()
    })

    it('POST /sync rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'POST', url: '/accounting/reporting/sync' })
      expect(res.statusCode).toBe(401)
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })
  })

  describe('GET /status', () => {
    it('reports base flags without the gated data path when the feed is unavailable', async () => {
      entitlementMocks.reportingFeedAvailable.mockResolvedValue(false)
      configMock.reportingFeedEnabled = false
      connectorMocks.hasLiveConnector.mockReturnValue(false)

      const res = await authed('GET', '/accounting/reporting/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        hosted: true,
        flagEnabled: false,
        liveSyncReady: false,
        available: false,
        connected: false,
        syncs: [],
      })
      // The synchronous connector-registry read for the base flags still runs
      // (it's not gated), but the gated DATA path — the Fortnox connection and
      // sync status — is never touched for an unentitled account.
      expect(connectorMocks.hasLiveConnector).toHaveBeenCalled()
      expect(fortnoxMocks.getFortnoxConnection).not.toHaveBeenCalled()
      expect(orchestratorMocks.getReportingStatus).not.toHaveBeenCalled()
    })

    it('returns availability, connection state and syncs when entitled', async () => {
      entitlementMocks.reportingFeedAvailable.mockResolvedValue(true)
      connectorMocks.hasLiveConnector.mockReturnValue(true)
      fortnoxMocks.getFortnoxConnection.mockResolvedValue({ user_id: USER })
      const syncs = [{ payment_id: 'pi-1', status: 'pushed' }]
      orchestratorMocks.getReportingStatus.mockResolvedValue(syncs)

      const res = await authed('GET', '/accounting/reporting/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        hosted: true,
        flagEnabled: true,
        liveSyncReady: true,
        available: true,
        connected: true,
        syncs,
      })
      expect(orchestratorMocks.getReportingStatus).toHaveBeenCalledWith(USER)
    })

    it('reports connected:false when entitled but Fortnox is not connected', async () => {
      entitlementMocks.reportingFeedAvailable.mockResolvedValue(true)
      fortnoxMocks.getFortnoxConnection.mockResolvedValue(null)

      const res = await authed('GET', '/accounting/reporting/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ available: true, connected: false })
    })
  })

  describe('GET /verify/:paymentId (#1362)', () => {
    it('is hard-gated like /sync: 404 when unavailable, no Fortnox read', async () => {
      entitlementMocks.reportingFeedAvailable.mockResolvedValue(false)
      const res = await authed('GET', '/accounting/reporting/verify/pay-1')
      expect(res.statusCode).toBe(404)
      expect(fortnoxMocks.verifyFortnoxInvoice).not.toHaveBeenCalled()
    })

    it('returns the verification for the AUTHENTICATED user (never a caller-chosen one)', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({
        ok: true,
        verification: {
          registered: true, booked: false, cancelled: false,
          invoice_number: 11, voucher: null, invoice_date: '2026-08-12',
          total: 10.42, checked_at: '2026-08-12T14:00:00.000Z',
        },
      })
      const res = await authed('GET', '/accounting/reporting/verify/pay-1')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ registered: true, booked: false, invoice_number: 11 })
      expect(fortnoxMocks.verifyFortnoxInvoice).toHaveBeenCalledWith(USER, 'pay-1')
    })

    it('maps refusals to an actionable 409 with the error code', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({
        ok: false, error_code: 'not_pushed', status: 'failed',
      })
      const res = await authed('GET', '/accounting/reporting/verify/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'not_pushed', status: 'failed' })
      expect(res.json().error).toMatch(/not been pushed/)
    })
  })

  describe('POST /sync', () => {
    it('is hard-gated: 404 when the feed is unavailable, without running a sync', async () => {
      entitlementMocks.reportingFeedAvailable.mockResolvedValue(false)

      const res = await authed('POST', '/accounting/reporting/sync')

      expect(res.statusCode).toBe(404)
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })

    it('delegates a single request to exactly one syncUser call and returns its result', async () => {
      entitlementMocks.reportingFeedAvailable.mockResolvedValue(true)
      // The real syncUser returns { fed: number } (count of payments fed to the
      // connector); the route is a transparent passthrough of that shape.
      orchestratorMocks.syncUser.mockResolvedValue({ fed: 3 })

      const res = await authed('POST', '/accounting/reporting/sync')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ fed: 3 })
      // One POST → exactly one orchestrator invocation for the caller. The
      // "never double-post" guarantee on repeat syncs lives in syncUser and is
      // covered by the lib-level dedup tests; here we pin that the route adds no
      // extra invocation of its own.
      expect(orchestratorMocks.syncUser).toHaveBeenCalledTimes(1)
      expect(orchestratorMocks.syncUser).toHaveBeenCalledWith(USER)
    })
  })
})
