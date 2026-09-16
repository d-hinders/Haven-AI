import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `/user/safes*` prefix is RETIRED (#2914, naming epic #2906 phase 5).
 *
 * #2907 served both vocabularies from one handler module for a release. This
 * slice stops the old prefix serving. What the suite pins is that it stopped
 * LOUDLY, which is the slice's stated acceptance bar — an old client must get
 * a typed refusal naming where to go, never a bare 404 that reads as a
 * transient routing error.
 *
 * Every retired address gets four assertions, because "answers 410" alone
 * would still pass if the tombstone had reached the database on its way to
 * refusing, or if it had quietly taken the new vocabulary down with it:
 *
 *   1. status is 410 — not 404 (#834/#1328 precedent), not 200;
 *   2. the body names the REPLACEMENT path, in a field a client can route on
 *      rather than only in prose;
 *   3. nothing was touched — no pool query, no `pool.connect`;
 *   4. the `/user/accounts` twin at the same address still SERVES.
 *
 * (4) is the positive control, and it is the assertion that earns the file.
 * Deleting the `/user/accounts` registration would satisfy 1–3 perfectly
 * while breaking every caller that did what the migration asked — so a suite
 * without it proves the retirement and not the survival.
 *
 * A fifth case pins ORDER: `authMiddleware` is an `onRequest` hook and the
 * refusal is the route HANDLER, so an anonymous caller gets 401 and never
 * learns which paths this deployment used to serve. Same property
 * `safe-inflow-retired.test.ts` pins next door, asserted rather than assumed
 * because Fastify's lifecycle is what makes it true.
 */

// db-mock-exempt: the point of this suite is that the database is NEVER
// reached — the pool stand-in exists so `expect(mockPoolQuery).not
// .toHaveBeenCalled()` can be asserted at all, and there is no database
// BEHAVIOUR here to prove on the real-Postgres harness (#1219). A real
// database would make these assertions weaker: it cannot distinguish "no
// query ran" from "a query ran and found nothing".
const { mockPoolQuery, mockClientQuery, mockRelease, mockConnect } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockConnect: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}))

import userAccountsRoutes from '../user-accounts.js'
import userAccountsRetiredRoutes from '../user-accounts-retired.js'
import userRoutes from '../user.js'

const USER = 'user-1'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Every retired address, with the twin that must still serve. Written out
 * rather than derived from the module's own table: a table-driven test that
 * reads the implementation's list proves the list matches itself, and would
 * go green if a route were dropped from both at once.
 */
const RETIRED = [
  { method: 'GET', url: '/user/safes', twin: '/user/accounts', replacement: 'GET /user/accounts' },
  { method: 'PUT', url: `/user/safes/${ACCOUNT_ID}`, twin: `/user/accounts/${ACCOUNT_ID}`, replacement: 'PUT /user/accounts/:accountId' },
  { method: 'PUT', url: `/user/safes/${ACCOUNT_ID}/default`, twin: `/user/accounts/${ACCOUNT_ID}/default`, replacement: 'PUT /user/accounts/:accountId/default' },
  { method: 'DELETE', url: `/user/safes/${ACCOUNT_ID}`, twin: `/user/accounts/${ACCOUNT_ID}`, replacement: 'DELETE /user/accounts/:accountId' },
  { method: 'GET', url: `/user/safes/${ACCOUNT_ID}/funding`, twin: `/user/accounts/${ACCOUNT_ID}/funding`, replacement: 'GET /user/accounts/:accountId/funding' },
] as const

describe('/user/safes is retired and answers 410 (#2914)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userAccountsRetiredRoutes, { prefix: '/user/safes' })
    await app.register(userAccountsRoutes, { prefix: '/user/accounts' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockClientQuery.mockReset()
    mockRelease.mockReset()
    mockConnect.mockReset()
    // Deliberately generous, as the sibling suite is: if a handler DID run,
    // these resolve happily and the "nothing was touched" assertion is what
    // catches it — not a crash that could be mistaken for the refusal working.
    mockPoolQuery.mockResolvedValue({ rows: [] })
    mockClientQuery.mockResolvedValue({ rows: [] })
    mockConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    })
  })

  function auth() {
    return { authorization: `Bearer ${token}` }
  }

  it.each(RETIRED)('$method $url → 410 naming its replacement, database untouched', async ({ method, url, replacement }) => {
    const res = await app.inject({ method, url, headers: auth() })

    expect(res.statusCode).toBe(410)
    const body = res.json() as { error: string; replacement: string }
    expect(body.replacement).toBe(replacement)
    // The prose names the epic and the vocabulary, so a human reading a log
    // line knows this is a rename and not an outage.
    expect(body.error).toMatch(/retired \(#2906\)/)
    expect(body.error).toContain(replacement)

    expect(mockPoolQuery).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it.each(RETIRED)('the $method $twin twin still SERVES — the retirement did not take both down', async ({ method, twin }) => {
    const res = await app.inject({ method, url: twin, headers: auth() })

    // Not asserting a specific success code: these handlers hit a mocked pool
    // and answer 200/404/400 depending on the route. The property under test
    // is that the address is still LIVE — anything but 410 proves the twin
    // survived, and 410 here would mean the contraction removed both.
    expect(res.statusCode).not.toBe(410)
  })

  it('an anonymous caller gets 401, never the 410 — auth runs before the tombstone', async () => {
    // Ordering, not content: `authMiddleware` is an `onRequest` hook and the
    // refusal is the handler, so this is a Fastify-lifecycle guarantee. An
    // unauthenticated stranger must not learn which paths this deployment
    // used to serve.
    for (const { method, url } of RETIRED) {
      const res = await app.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })

  it('PUT /user/safe answers the SAME naming 410, naming PUT /user/account', async () => {
    // The singular path is a tombstone twice over: #1984 closed the import
    // flow, #2914 retired the path's vocabulary. It answers the NAMING
    // refusal, because that is the one an old client can act on — the rail
    // refusal lives on `/user/account`, which is where it points.
    const userApp = Fastify({ logger: false })
    await userApp.register(fastifyJwt, { secret: 'test-secret' })
    await userApp.register(userRoutes, { prefix: '/user' })
    const userToken = userApp.jwt.sign({ sub: USER, email: 'ada@example.com' })

    const res = await userApp.inject({
      method: 'PUT',
      url: '/user/safe',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { account_address: '0x'.padEnd(42, 'a') },
    })

    expect(res.statusCode).toBe(410)
    const body = res.json() as { error: string; replacement: string }
    expect(body.replacement).toBe('PUT /user/account')
    expect(body.error).toMatch(/retired \(#2906\)/)
    expect(mockPoolQuery).not.toHaveBeenCalled()

    await userApp.close()
  })

  it('POST /user/safes and /deploy answer 410 too, so the whole prefix refuses one way', async () => {
    // These two were already 410 from the Safe-rail inflow closure
    // (#1984/#1988). Re-stated under the naming body so a caller hitting two
    // retired addresses does not get two different explanations for the same
    // status. The Safe-rail refusal still lives on the /user/accounts twins,
    // which is a different fact and still true.
    for (const url of ['/user/safes', '/user/safes/deploy']) {
      const res = await app.inject({ method: 'POST', url, headers: auth() })
      expect(res.statusCode, url).toBe(410)
      expect((res.json() as { replacement: string }).replacement, url).toContain('/user/accounts')
    }
  })
})
