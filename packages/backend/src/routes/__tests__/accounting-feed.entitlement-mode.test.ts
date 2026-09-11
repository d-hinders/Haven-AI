import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * #2861 acceptance, proven through the REAL entitlement gate.
 *
 * `accounting-feed.test.ts` mocks `accountingFeedAvailability`, which pins the
 * route's wiring but cannot prove the acceptance criterion itself: "a fresh
 * dev user with no entitlement row sees the feed as available under mode
 * `all`, and is refused (404 on gated routes) under mode `granted`". Here the
 * gate (`modules/agents/entitlements.ts`) and the middleware run unmocked;
 * only the repository row lookup is stubbed to "no row" and the config is
 * flipped between the two modes.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: { hosted: true, accountingEnabled: true, accountingEntitlementMode: 'granted' as 'granted' | 'all' },
}))
vi.mock('../../config.js', () => ({ config: configMock }))

const repoMocks = vi.hoisted(() => ({
  hasEntitlementRow: vi.fn(),
  grantEntitlementRow: vi.fn(),
  revokeEntitlementRow: vi.fn(),
}))
vi.mock('../../infra/repositories/account-entitlements.js', () => repoMocks)

const accountingMocks = vi.hoisted(() => ({
  getAccountingFeedStatus: vi.fn(),
  getAccountingFeedCounts: vi.fn(),
  syncUser: vi.fn(),
  hasLiveConnector: vi.fn(),
  getActiveConnectionSummary: vi.fn(),
  // #2865: the status names the destination's missing scopes.
  getDestinationSummary: vi.fn(),
  verifyPushedPayment: vi.fn(),
  reopenPushedPayment: vi.fn(),
  PREVIOUS_COMPANY_REASON: 'belongs to the previous company',
}))
vi.mock('../../modules/accounting/index.js', () => accountingMocks)

import accountingFeedRoutes from '../accounting-feed.js'

describe('accounting feed routes × real entitlement gate (#2861)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(accountingFeedRoutes, { prefix: '/accounting/feed' })
    token = app.jwt.sign({ sub: 'fresh-dev-user', email: 'fresh@example.com' })
  })
  afterAll(async () => { await app.close() })

  beforeEach(() => {
    configMock.hosted = true
    configMock.accountingEnabled = true
    // A fresh user: the entitlement table has NO row for them.
    repoMocks.hasEntitlementRow.mockReset().mockResolvedValue(false)
    accountingMocks.getAccountingFeedStatus.mockReset().mockResolvedValue([])
    accountingMocks.getDestinationSummary.mockReset().mockResolvedValue(null)
    accountingMocks.getAccountingFeedCounts.mockReset().mockResolvedValue({ pending: 0, failed: 0, exhausted: 0 })
    accountingMocks.syncUser.mockReset().mockResolvedValue({ fed: 0 })
    accountingMocks.hasLiveConnector.mockReset().mockReturnValue(true)
    accountingMocks.getActiveConnectionSummary.mockReset().mockResolvedValue(null)
  })

  const authed = (method: 'GET' | 'POST', url: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })

  it('mode all: no row, yet the feed is available and the gated route answers', async () => {
    configMock.accountingEntitlementMode = 'all'
    const status = await authed('GET', '/accounting/feed/status')
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ available: true, entitled: true, entitlementMode: 'all' })
    const sync = await authed('POST', '/accounting/feed/sync')
    expect(sync.statusCode).toBe(200)
    expect(accountingMocks.syncUser).toHaveBeenCalledTimes(1)
    // The row lookup is not even consulted in mode all.
    expect(repoMocks.hasEntitlementRow).not.toHaveBeenCalled()
  })

  it('mode granted: the same user is refused until a row exists', async () => {
    configMock.accountingEntitlementMode = 'granted'
    const status = await authed('GET', '/accounting/feed/status')
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ available: false, entitled: false, entitlementMode: 'granted' })
    const sync = await authed('POST', '/accounting/feed/sync')
    expect(sync.statusCode).toBe(404)
    expect(accountingMocks.syncUser).not.toHaveBeenCalled()
    expect(repoMocks.hasEntitlementRow).toHaveBeenCalled()
  })

  it('mode granted: a row makes the user entitled — the table still means something', async () => {
    configMock.accountingEntitlementMode = 'granted'
    repoMocks.hasEntitlementRow.mockResolvedValue(true)
    const sync = await authed('POST', '/accounting/feed/sync')
    expect(sync.statusCode).toBe(200)
  })

  it('mode all does not bypass the hosted/flag checks: flag off is still unavailable', async () => {
    configMock.accountingEntitlementMode = 'all'
    configMock.accountingEnabled = false
    const sync = await authed('POST', '/accounting/feed/sync')
    expect(sync.statusCode).toBe(404)
  })
})
