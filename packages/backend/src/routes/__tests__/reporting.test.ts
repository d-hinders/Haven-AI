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
vi.mock('../../lib/entitlements.js', () => entitlementMocks)

const orchestratorMocks = vi.hoisted(() => ({
  getReportingStatus: vi.fn(),
  syncUser: vi.fn(),
}))
vi.mock('../../lib/reporting/feed-orchestrator.js', () => orchestratorMocks)

const connectorMocks = vi.hoisted(() => ({ hasLiveConnector: vi.fn() }))
vi.mock('../../lib/reporting/connector.js', () => connectorMocks)

const fortnoxMocks = vi.hoisted(() => ({ getFortnoxConnection: vi.fn() }))
vi.mock('../../lib/fortnox-connection.js', () => fortnoxMocks)

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
