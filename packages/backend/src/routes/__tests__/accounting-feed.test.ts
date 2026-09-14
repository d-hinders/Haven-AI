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
  // #2866: the pending / failed / exhausted counts next to the list.
  getAccountingFeedCounts: vi.fn(),
  syncUser: vi.fn(),
}))
const connectorMocks = vi.hoisted(() => ({ hasLiveConnector: vi.fn() }))
// #2862: the feed routes act on the ACTIVE connection through the generic
// service (`getActiveConnectionSummary`, `verifyPushedPayment`), not on
// Fortnox. #2864: the reopen goes through the company-aware
// `reopenPushedPayment`, and the status carries the active company's name.
const fortnoxMocks = vi.hoisted(() => ({
  getActiveConnectionSummary: vi.fn(),
  // #2865: the DESTINATION row whatever its status — where `missingScopes` comes from.
  getDestinationSummary: vi.fn(),
  verifyPushedPayment: vi.fn(),
  reopenPushedPayment: vi.fn(),
  PREVIOUS_COMPANY_REASON: 'belongs to the previous company',
}))
/** What `getActiveConnectionSummary` answers for a connected user — the summary's company half. */
const ACTIVE = { provider: 'fortnox', displayName: 'Fortnox', externalCompanyId: '1234567', externalCompanyName: 'Haven Sandbox AB', baseCurrency: 'SEK', isActiveDestination: true, status: 'connected', missingScopes: [] as string[], lastPushAt: '2026-08-13T09:00:05.000Z' as string | null }
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
    orchestratorMocks.getAccountingFeedCounts.mockReset().mockResolvedValue({ pending: 0, failed: 0, exhausted: 0 })
    orchestratorMocks.syncUser.mockReset().mockResolvedValue({ fed: 0, total: 0 })
    connectorMocks.hasLiveConnector.mockReset().mockReturnValue(false)
    fortnoxMocks.getActiveConnectionSummary.mockReset().mockResolvedValue(null)
    fortnoxMocks.getDestinationSummary.mockReset().mockResolvedValue(null)
    fortnoxMocks.verifyPushedPayment.mockReset()
    fortnoxMocks.reopenPushedPayment.mockReset()
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
      fortnoxMocks.getActiveConnectionSummary.mockResolvedValue(null)
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
    /** The complete off-state payload (#2869): every key the spec requires, no gated data. */
    const OFF = (hosted: boolean, enabled: boolean) => ({
      hosted,
      enabled,
      flagEnabled: enabled,
      liveSyncReady: false,
      entitled: false,
      entitlementMode: 'granted',
      available: false,
      connected: false,
      companyName: null,
      destination: null,
      missingScopes: [],
      syncs: [],
      counts: { pending: 0, failed: 0, exhausted: 0 },
    })

    it('reports base flags without the gated data path when the feed is unavailable', async () => {
      setAvailability(false)
      configMock.accountingEnabled = false
      connectorMocks.hasLiveConnector.mockReturnValue(false)

      const res = await authed('GET', '/accounting/feed/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(OFF(true, false))
      expectMatchesSpec('GET', '/accounting/feed/status', res.json())
      // The synchronous connector-registry read for the base flags still runs
      // (it's not gated), but the gated DATA path — the Fortnox connection and
      // sync status — is never touched for an unentitled account.
      expect(connectorMocks.hasLiveConnector).toHaveBeenCalled()
      expect(fortnoxMocks.getActiveConnectionSummary).not.toHaveBeenCalled()
      expect(fortnoxMocks.getDestinationSummary).not.toHaveBeenCalled()
      expect(orchestratorMocks.getAccountingFeedStatus).not.toHaveBeenCalled()
      expect(orchestratorMocks.getAccountingFeedCounts).not.toHaveBeenCalled()
    })

    // #2869: the two OFF states the dashboard renders differently — "Coming
    // soon" (hosted, flag off) and "not available on self-hosted" (not
    // hosted) — are BOTH a 200 with the full shape, `enabled` saying which,
    // while every gated action stays 404. MUTATION-TESTED: gating `/status`
    // with `requireAccountingFeed` turns both cases red at the status code.
    it.each([
      ['hosted=true, enabled=false (Coming soon)', true, false],
      ['hosted=false (self-hosted, never coming soon)', false, false],
      ['hosted=false with the flag on (still off — hosted wins)', false, true],
    ])('answers 200 with the complete off shape for %s, and the actions 404', async (_label, hosted, enabled) => {
      configMock.hosted = hosted
      configMock.accountingEnabled = enabled
      setAvailability(false)

      const status = await authed('GET', '/accounting/feed/status')
      expect(status.statusCode).toBe(200)
      expect(status.json()).toEqual(OFF(hosted, enabled))
      expectMatchesSpec('GET', '/accounting/feed/status', status.json())

      expect((await authed('POST', '/accounting/feed/sync')).statusCode).toBe(404)
      expect((await authed('GET', '/accounting/feed/verify/pay-1')).statusCode).toBe(404)
      expect((await authed('POST', '/accounting/feed/reopen/pay-1')).statusCode).toBe(404)
      expect(orchestratorMocks.syncUser).not.toHaveBeenCalled()
      expect(fortnoxMocks.verifyPushedPayment).not.toHaveBeenCalled()
    })

    it('returns availability, connection state and syncs when entitled', async () => {
      setAvailability(true)
      connectorMocks.hasLiveConnector.mockReturnValue(true)
      fortnoxMocks.getActiveConnectionSummary.mockResolvedValue(ACTIVE)
      fortnoxMocks.getDestinationSummary.mockResolvedValue(ACTIVE)
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
      // #2866: counts are over EVERY row, not the capped list — 4 here
      // against a one-row list is the point.
      orchestratorMocks.getAccountingFeedCounts.mockResolvedValue({ pending: 1, failed: 2, exhausted: 1 })

      const res = await authed('GET', '/accounting/feed/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        hosted: true,
        enabled: true,
        flagEnabled: true,
        liveSyncReady: true,
        entitled: true,
        entitlementMode: 'granted',
        available: true,
        connected: true,
        // #2864: "Connected to Haven Sandbox AB" — the active connection's company.
        companyName: 'Haven Sandbox AB',
        // #2869: the destination row's summary — what the page's summary
        // line and the sidebar badge read.
        destination: {
          provider: 'fortnox',
          displayName: 'Fortnox',
          status: 'connected',
          companyName: 'Haven Sandbox AB',
          lastPushAt: '2026-08-13T09:00:05.000Z',
        },
        missingScopes: [],
        syncs,
        counts: { pending: 1, failed: 2, exhausted: 1 },
      })
      expect(orchestratorMocks.getAccountingFeedStatus).toHaveBeenCalledWith(USER)
      expect(orchestratorMocks.getAccountingFeedCounts).toHaveBeenCalledWith(USER)
      expectMatchesSpec('GET', '/accounting/feed/status', res.json())
    })

    it('reports connected:false when entitled but Fortnox is not connected', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(true)
      fortnoxMocks.getActiveConnectionSummary.mockResolvedValue(null)

      const res = await authed('GET', '/accounting/feed/status')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ available: true, connected: false, companyName: null })
    })

    it('#2864: companyName is null when the active grant could not read the company (a null name)', async () => {
      fortnoxMocks.getActiveConnectionSummary.mockResolvedValue({ ...ACTIVE, externalCompanyId: null, externalCompanyName: null })
      const res = await authed('GET', '/accounting/feed/status')
      expect(res.json()).toMatchObject({ connected: true, companyName: null })
      expectMatchesSpec('GET', '/accounting/feed/status', res.json())
    })

    it('#2865: a scope_missing destination is connected:false AND names its missing scopes from the destination row', async () => {
      // The active (connected) read sees nothing; the destination read sees
      // the degraded row — the route must read the second one for the scopes.
      fortnoxMocks.getActiveConnectionSummary.mockResolvedValue(null)
      fortnoxMocks.getDestinationSummary.mockResolvedValue({ ...ACTIVE, status: 'scope_missing', missingScopes: ['connectfile', 'companyinformation'] })
      const res = await authed('GET', '/accounting/feed/status')
      expect(res.json()).toMatchObject({ connected: false, companyName: null, missingScopes: ['connectfile', 'companyinformation'] })
      // #2869: the attention state reaches the dashboard through `destination.status`.
      expect(res.json().destination).toEqual({
        provider: 'fortnox',
        displayName: 'Fortnox',
        status: 'scope_missing',
        companyName: 'Haven Sandbox AB',
        lastPushAt: '2026-08-13T09:00:05.000Z',
      })
      expectMatchesSpec('GET', '/accounting/feed/status', res.json())
    })

    it('#2869: entitled with no destination row at all — destination is null, not an empty object', async () => {
      fortnoxMocks.getActiveConnectionSummary.mockResolvedValue(null)
      fortnoxMocks.getDestinationSummary.mockResolvedValue(null)
      const res = await authed('GET', '/accounting/feed/status')
      expect(res.json()).toMatchObject({ available: true, connected: false, destination: null })
      expectMatchesSpec('GET', '/accounting/feed/status', res.json())
    })
  })

  describe('GET /verify/:paymentId (#1362)', () => {
    it('is hard-gated like /sync: 404 when unavailable, no provider read', async () => {
      entitlementMocks.accountingFeedAvailable.mockResolvedValue(false)
      const res = await authed('GET', '/accounting/feed/verify/pay-1')
      expect(res.statusCode).toBe(404)
      expect(fortnoxMocks.verifyPushedPayment).not.toHaveBeenCalled()
    })

    it('returns the verification for the AUTHENTICATED user (never a caller-chosen one)', async () => {
      fortnoxMocks.verifyPushedPayment.mockResolvedValue({
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
      expect(fortnoxMocks.verifyPushedPayment).toHaveBeenCalledWith(USER, 'pay-1')
      expectMatchesSpec('GET', '/accounting/feed/verify/{paymentId}', res.json())
    })

    it('maps refusals to an actionable 409 with the error code', async () => {
      fortnoxMocks.verifyPushedPayment.mockResolvedValue({
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
      provider: 'fortnox',
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
      expect(fortnoxMocks.verifyPushedPayment).not.toHaveBeenCalled()
      expect(fortnoxMocks.reopenPushedPayment).not.toHaveBeenCalled()
    })

    it('reopens ONLY when the provider confirms the invoice is gone — on the ACTIVE connection\'s provider', async () => {
      fortnoxMocks.verifyPushedPayment.mockResolvedValue(GONE)
      fortnoxMocks.reopenPushedPayment.mockResolvedValue({ reopened: true })
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ reopened: true, payment_id: 'pay-1' })
      expect(fortnoxMocks.reopenPushedPayment).toHaveBeenCalledWith(
        USER, 'fortnox', 'pay-1', expect.stringMatching(/no longer exists/),
      )
      expectMatchesSpec('POST', '/accounting/feed/reopen/{paymentId}', res.json())
    })

    it('a company-switch collision reopens with an HONEST reason — never "no longer exists" (#1376 review)', async () => {
      fortnoxMocks.verifyPushedPayment.mockResolvedValue({
        ok: true,
        provider: 'fortnox',
        verification: { ...GONE.verification, missing: 'foreign_invoice' as const },
      })
      fortnoxMocks.reopenPushedPayment.mockResolvedValue({ reopened: true })
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(200)
      const reason = String(fortnoxMocks.reopenPushedPayment.mock.calls[0][3])
      expect(reason).toMatch(/different external invoice number/)
      expect(reason).not.toMatch(/no longer exists/)
    })

    it('MUTATION PROOF: an invoice that still EXISTS refuses — 409, nothing written', async () => {
      // Removing the registered-check in the route (reopening regardless of
      // the verification verdict) flips this to a 200 — the double-post the
      // gate exists to prevent.
      fortnoxMocks.verifyPushedPayment.mockResolvedValue({
        ok: true,
        provider: 'fortnox',
        verification: { ...GONE.verification, registered: true, missing: null, booked: false },
      })
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'invoice_exists', invoice_number: 11 })
      expect(fortnoxMocks.reopenPushedPayment).not.toHaveBeenCalled()
    })

    it('#2864: a pushed row from BEFORE the connection\'s company switch is refused as "belongs to the previous company" — 409, nothing written', async () => {
      // The provider says the invoice is missing in the CURRENT company —
      // correct, it was delivered into the previous one — and the
      // company-aware reopen refuses instead of flipping pushed → failed.
      fortnoxMocks.verifyPushedPayment.mockResolvedValue(GONE)
      fortnoxMocks.reopenPushedPayment.mockResolvedValue({
        reopened: false, error_code: 'previous_company', switched_at: '2026-09-11T10:00:00.000Z', company_name: 'Old Company AB',
      })
      const res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'previous_company', switched_at: '2026-09-11T10:00:00.000Z' })
      expect(res.json().error).toContain('belongs to the previous company')
      expect(res.json().error).toContain('Old Company AB')
      expect(res.json()).not.toHaveProperty('reopened')
      expectMatchesSpec('POST', '/accounting/feed/reopen/{paymentId}', res.json(), '409')
    })

    it('maps verification refusals and the raced row-state honestly', async () => {
      fortnoxMocks.verifyPushedPayment.mockResolvedValue({ ok: false, error_code: 'not_pushed', status: 'failed' })
      let res = await authed('POST', '/accounting/feed/reopen/pay-1')
      expect(res.statusCode).toBe(409)
      expect(res.json().error_code).toBe('not_pushed')

      // Verification says gone, but the row moved before the flip (raced).
      fortnoxMocks.verifyPushedPayment.mockResolvedValue(GONE)
      fortnoxMocks.reopenPushedPayment.mockResolvedValue({ reopened: false, error_code: 'not_pushed' })
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
      // The real syncUser returns { fed, total } (#2915): `fed` is the count
      // of payments actually pushed to the connector, `total` the count
      // enumerated; the route is a transparent passthrough of that shape.
      orchestratorMocks.syncUser.mockResolvedValue({ fed: 3, total: 3 })

      const res = await authed('POST', '/accounting/feed/sync')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ fed: 3, total: 3 })
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
