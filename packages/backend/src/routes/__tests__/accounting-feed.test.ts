import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
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
 * `entitlements.accountingFeedAvailable` is mocked, which drives BOTH the route
 * and the real `requireAccountingFeed` middleware, so the gate is genuinely
 * exercised.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: { hosted: true, accountingEnabled: true },
}))
vi.mock('../../config.js', () => ({ config: configMock }))

// #2861: the status route reads the three-part answer (available / entitled /
// mode) so it can say WHY; the gating middleware still reads the boolean. Both
// are mocked from ONE factory — two factories on one specifier would have the
// second silently win.
const entitlementMocks = vi.hoisted(() => ({
  accountingFeedAvailable: vi.fn(),
  accountingFeedAvailability: vi.fn(),
}))
vi.mock('../../modules/agents/index.js', () => entitlementMocks)

/** Keep the two mocks in step: the boolean is the `available` half of the triple. */
function setAvailability(available: boolean, entitled = available, entitlementMode: 'granted' | 'all' = 'granted') {
  entitlementMocks.accountingFeedAvailable.mockReset().mockResolvedValue(available)
  entitlementMocks.accountingFeedAvailability.mockReset().mockResolvedValue({ available, entitled, entitlementMode })
}

const orchestratorMocks = vi.hoisted(() => ({
  getAccountingFeedStatus: vi.fn(),
  syncUser: vi.fn(),
}))
const connectorMocks = vi.hoisted(() => ({ hasLiveConnector: vi.fn() }))
const fortnoxMocks = vi.hoisted(() => ({ getFortnoxConnection: vi.fn(), verifyFortnoxInvoice: vi.fn(), reopenMissingPushed: vi.fn() }))
// feed-orchestrator.ts, connector.ts and fortnox-connection.ts all fold into
// one public entry point post-#998 (modules/accounting/index.ts) — a single
// mock factory merging all three, not three vi.mock calls to the same
// specifier (the last one silently wins otherwise).
vi.mock('../../modules/accounting/index.js', () => ({
  ...orchestratorMocks,
  ...connectorMocks,
  ...fortnoxMocks,
}))

import accountingFeedRoutes from '../accounting-feed.js'

const USER = 'user-1'

describe('reporting routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(accountingFeedRoutes, { prefix: '/accounting/feed' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    configMock.hosted = true
    configMock.accountingEnabled = true
    setAvailability(true)
    orchestratorMocks.getAccountingFeedStatus.mockReset().mockResolvedValue([])
    orchestratorMocks.syncUser.mockReset().mockResolvedValue({ fed: 0 })
    connectorMocks.hasLiveConnector.mockReset().mockReturnValue(false)
    fortnoxMocks.getFortnoxConnection.mockReset().mockResolvedValue(null)
    fortnoxMocks.verifyFortnoxInvoice.mockReset()
    fortnoxMocks.reopenMissingPushed.mockReset()
  })

  function authed(method: 'GET' | 'POST', url: string) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
  }

  describe('authentication', () => {
    it('GET /status rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'GET', url: '/accounting/feed/status' })
      expect(res.statusCode).toBe(401)
      expect(entitlementMocks.accountingFeedAvailable).not.toHaveBeenCalled()
    })

    it('POST /sync rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'POST', url: '/accounting/feed/sync' })
      expect(res.statusCode).toBe(401)
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })
  })

  describe('entitlement mode (#2861)', () => {
    it('mode all: a user with no entitlement row sees the feed as available, and the status says so', async () => {
      setAvailability(true, true, 'all')
      connectorMocks.hasLiveConnector.mockReturnValue(true)
      fortnoxMocks.getFortnoxConnection.mockResolvedValue(null)
      orchestratorMocks.getAccountingFeedStatus.mockResolvedValue([])
      const res = await authed('GET', '/accounting/feed/status')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ available: true, entitled: true, entitlementMode: 'all', connected: false })
    })

    it('mode granted: the same user without a row is refused on the gated routes (404) and the status says why', async () => {
      setAvailability(false, false, 'granted')
      const status = await authed('GET', '/accounting/feed/status')
      expect(status.json()).toMatchObject({ available: false, entitled: false, entitlementMode: 'granted' })
      const sync = await authed('POST', '/accounting/feed/sync')
      expect(sync.statusCode).toBe(404)
    })
  })

  describe('GET /status', () => {
    it('reports base flags without the gated data path when the feed is unavailable', async () => {
      setAvailability(false)
      configMock.accountingEnabled = false
      connectorMocks.hasLiveConnector.mockReturnValue(false)

      const res = await authed('GET', '/accounting/feed/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        hosted: true,
        flagEnabled: false,
        liveSyncReady: false,
        entitled: false,
        entitlementMode: 'granted',
        available: false,
        connected: false,
        syncs: [],
      })
      // The synchronous connector-registry read for the base flags still runs
      // (it's not gated), but the gated DATA path — the Fortnox connection and
      // sync status — is never touched for an unentitled account.
      expect(connectorMocks.hasLiveConnector).toHaveBeenCalled()
      expect(fortnoxMocks.getFortnoxConnection).not.toHaveBeenCalled()
      expect(orchestratorMocks.getAccountingFeedStatus).not.toHaveBeenCalled()
    })

    it('returns availability, connection state and syncs when entitled', async () => {
      setAvailability(true)
      connectorMocks.hasLiveConnector.mockReturnValue(true)
      fortnoxMocks.getFortnoxConnection.mockResolvedValue({ user_id: USER })
      // A whole FeedSyncRow, as listSyncs really returns one (#1446) — a
      // partial fixture describes a response the table cannot produce.
      const syncs = [{
        id: 'e4a9c1b7-2f38-4d05-9a61-8c7e3b0f5d42',
        user_id: '9d3e6a12-5c47-4b80-a1f9-2e7d4c8b0356',
        provider: 'fortnox',
        payment_id: 'pi-1',
        external_ref: '13',
        status: 'pushed',
        error: null,
        attempts: 1,
        created_at: '2026-08-13T09:00:00.000Z',
        updated_at: '2026-08-13T09:00:05.000Z',
      }]
      orchestratorMocks.getAccountingFeedStatus.mockResolvedValue(syncs)

      const res = await authed('GET', '/accounting/feed/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        hosted: true,
        flagEnabled: true,
        liveSyncReady: true,
        entitled: true,
        entitlementMode: 'granted',
        available: true,
        connected: true,
        syncs,
      })
      expect(orchestratorMocks.getAccountingFeedStatus).toHaveBeenCalledWith(USER)
      expectMatchesSpec('GET', '/accounting/feed/status', res.json())
    })

    it('reports connected:false when entitled but Fortnox is not connected', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(true)
      fortnoxMocks.getFortnoxConnection.mockResolvedValue(null)

      const res = await authed('GET', '/accounting/feed/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ available: true, connected: false })
    })
  })

  describe('GET /verify/:paymentId (#1362)', () => {
    it('is hard-gated like /sync: 404 when unavailable, no Fortnox read', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(false)
      const res = await authed('GET', '/accounting/feed/verify/pay-1')
      expect(res.statusCode).toBe(404)
      expect(fortnoxMocks.verifyFortnoxInvoice).not.toHaveBeenCalled()
    })

    it('returns the verification for the AUTHENTICATED user (never a caller-chosen one)', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({
        ok: true,
        verification: {
          registered: true, missing: null, booked: false, cancelled: false,
          invoice_number: 11, voucher: null, invoice_date: '2026-08-12',
          total: 10.42, checked_at: '2026-08-12T14:00:00.000Z',
        },
      })
      const res = await authed('GET', '/accounting/feed/verify/pay-1')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ registered: true, booked: false, invoice_number: 11 })
      expect(fortnoxMocks.verifyFortnoxInvoice).toHaveBeenCalledWith(USER, 'pay-1')
      expectMatchesSpec('GET', '/accounting/feed/verify/{paymentId}', res.json())
    })

    it('maps refusals to an actionable 409 with the error code', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({
        ok: false, error_code: 'not_pushed', status: 'failed',
      })
      const res = await authed('GET', '/accounting/feed/verify/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'not_pushed', status: 'failed' })
      expect(res.json().error).toMatch(/not been pushed/)
    })
  })

  describe('POST /reopen/:paymentId (#1365)', () => {
    const GONE = {
      ok: true as const,
      verification: {
        registered: false, missing: 'deleted' as const, booked: null, cancelled: null,
        invoice_number: 11, voucher: null, invoice_date: null,
        total: null, checked_at: '2026-08-13T08:00:00.000Z',
      },
    }

    it('is hard-gated: 404 when unavailable, no verification and no write', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(false)
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(404)
      expect(fortnoxMocks.verifyFortnoxInvoice).not.toHaveBeenCalled()
      expect(fortnoxMocks.reopenMissingPushed).not.toHaveBeenCalled()
    })

    it('reopens ONLY when Fortnox confirms the invoice is gone', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue(GONE)
      fortnoxMocks.reopenMissingPushed.mockResolvedValue(true)
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ reopened: true, payment_id: 'pay-1' })
      expect(fortnoxMocks.reopenMissingPushed).toHaveBeenCalledWith(
        USER, 'fortnox', 'pay-1', expect.stringMatching(/no longer exists/),
      )
      expectMatchesSpec('POST', '/accounting/feed/reopen/{paymentId}', res.json())
    })

    it('a company-switch collision reopens with an HONEST reason — never "no longer exists" (#1376 review)', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({
        ok: true,
        verification: { ...GONE.verification, missing: 'foreign_invoice' as const },
      })
      fortnoxMocks.reopenMissingPushed.mockResolvedValue(true)
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(200)
      const reason = String(fortnoxMocks.reopenMissingPushed.mock.calls[0][3])
      expect(reason).toMatch(/different external invoice number/)
      expect(reason).not.toMatch(/no longer exists/)
    })

    it('MUTATION PROOF: an invoice that still EXISTS refuses — 409, nothing written', async () => {
      // Removing the registered-check in the route (reopening regardless of
      // the verification verdict) flips this to a 200 — the double-post the
      // gate exists to prevent.
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({
        ok: true,
        verification: { ...GONE.verification, registered: true, missing: null, booked: false },
      })
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'invoice_exists', invoice_number: 11 })
      expect(fortnoxMocks.reopenMissingPushed).not.toHaveBeenCalled()
    })

    it('maps verification refusals and the raced row-state honestly', async () => {
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue({ ok: false, error_code: 'not_pushed', status: 'failed' })
      let res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json().error_code).toBe('not_pushed')

      // Verification says gone, but the row moved before the flip (raced).
      fortnoxMocks.verifyFortnoxInvoice.mockResolvedValue(GONE)
      fortnoxMocks.reopenMissingPushed.mockResolvedValue(false)
      res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json().error_code).toBe('not_pushed')
    })
  })

  describe('POST /sync', () => {
    it('is hard-gated: 404 when the feed is unavailable, without running a sync', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(false)

      const res = await authed('POST', '/accounting/feed/sync')

      expect(res.statusCode).toBe(404)
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
    })

    it('delegates a single request to exactly one syncUser call and returns its result', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(true)
      // The real syncUser returns { fed: number } (count of payments fed to the
      // connector); the route is a transparent passthrough of that shape.
      orchestratorMocks.syncUser.mockResolvedValue({ fed: 3 })

      const res = await authed('POST', '/accounting/feed/sync')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ fed: 3 })
      // One POST → exactly one orchestrator invocation for the caller. The
      // "never double-post" guarantee on repeat syncs lives in syncUser and is
      // covered by the lib-level dedup tests; here we pin that the route adds no
      // extra invocation of its own.
      expect(orchestratorMocks.syncUser).toHaveBeenCalledTimes(1)
      expect(orchestratorMocks.syncUser).toHaveBeenCalledWith(USER)
      expectMatchesSpec('POST', '/accounting/feed/sync', res.json())
    })
  })
})
