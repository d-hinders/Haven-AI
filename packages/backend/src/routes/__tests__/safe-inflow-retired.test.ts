import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The inflow is CLOSED (#1984, epic #1440 slice 1) and the implementation
 * behind it is DELETED (#1988, slice 5).
 *
 * This file is the single place that proves the Safe rail refuses new
 * accounts. There are FOUR ways a Safe could enter Haven, and a closure that
 * shuts three of them is not a closure — the fourth is simply the one an
 * attacker or an old client uses. All four are pinned here, at the names they
 * are reachable at TODAY:
 *
 *   POST /safe/deploy           passkey-owned Safe deployment
 *   POST /user/accounts/deploy  relay-sponsored, wallet-owned Safe deployment
 *   POST /user/accounts         importing an existing account
 *   PUT  /user/account          the legacy single-account link — also an import
 *
 * Each route gets three assertions, because "returns 410" alone would still
 * pass if the handler had already spent a relayer transaction or written a
 * row on its way to the refusal:
 *
 *   1. the status is 410 (not 404 — a permanently-gone flow must not read as
 *      a transient routing error that invites retries, per #834/#1328);
 *   2. the body names the retirement and the delegation-rail replacement;
 *   3. NOTHING was touched — no pool query, no pool.connect, no relay deploy.
 *
 * A fourth assertion pins ORDER: authentication still runs first, so an
 * unauthenticated caller gets 401 and never learns the route's disposition.
 * `authMiddleware` is an `onRequest` hook and the refusal is the route
 * HANDLER, so this is a real ordering guarantee rather than a coincidence.
 *
 * **#1988 changed the shape underneath these assertions and they still hold,
 * which is the point.** #1984 refused in a route `preHandler` so the live
 * handler bodies could stay verbatim for this slice to delete. Those bodies
 * are gone, so the refusal is now the handler itself
 * (`retiredSafeInflowHandler`) — one code path, nothing to reach around. The
 * "nothing was touched" assertions survive the change of mechanism because
 * they assert on the database and the relayer, not on Fastify's lifecycle.
 *
 * **#2914 (naming epic #2906 phase 5, the contraction) moved three of the
 * four addresses.** `POST /safe/deploy` still answers the RAIL refusal
 * (`safeRailRetired`) directly at its historical URL, because it is a single
 * dynamic-free path with no Safe-vocabulary segment to retire. The other
 * three moved house: `/user/safes*` is now itself a NAMING tombstone
 * (`user-accounts-retired.ts`, covered by
 * `routes/__tests__/user-accounts-retired.test.ts`) that answers 410 naming
 * an `/user/accounts*` replacement — so `POST /user/safes/deploy`,
 * `POST /user/safes` and `PUT /user/safe` no longer reach the RAIL refusal at
 * all; they are refused one hop earlier, for a different reason. The rail
 * refusal for those three inflows is reachable only at the NEW names:
 * `POST /user/accounts/deploy`, `POST /user/accounts`, `PUT /user/account`.
 * Both hops are asserted below, at the app-wiring registration #2914 shipped
 * (see `index.ts`): `/user/safes` → the naming tombstone, `/user/accounts` →
 * the live (rail-closed) routes.
 *
 * The same slice deleted the APPROVER surface, so this file also pins its
 * absence — a deletion nobody asserts is a deletion that comes back — and,
 * since #2847, pins the same for `POST /safe/exec`: the last live Safe-rail
 * execution route is gone, not tombstoned.
 */

// db-mock-exempt: this suite's whole point is that the database is NEVER
// reached — the pool stand-in exists so `expect(mockPoolQuery).not
// .toHaveBeenCalled()` can be asserted, and there is no database BEHAVIOUR
// here to prove on the real-Postgres harness (#1219): the refusal is a
// Fastify preHandler that returns before any query is issued. A real
// database would make these assertions weaker, not stronger — it cannot
// distinguish "no query ran" from "a query ran and found nothing". The three
// read-path cases at the bottom are deliberately shallow for the same reason:
// they assert the routes still SERVE, and their query semantics stay pinned
// where they already are, in smart-accounts-characterization.test.ts and the
// repository suites.
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

// #1984 mocked `relaySafeDeploy` here to prove the refusal never reached it.
// #1988 deleted the function and its module, which is a strictly stronger
// statement than a mock that was never called: there is nothing left to call.

import safeDeployRoutes from '../safe-deploy.js'
import userAccountsRoutes from '../user-accounts.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import userAccountsRetiredRoutes from '../user-accounts-retired.js'
import userRoutes from '../user.js'
import { safeRailRetired } from '../../middleware/safe-inflow-retired.js'
import { retiredSafePath } from '../user-accounts-retired.js'

const USER = 'user-1'
const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const OWNER_ADDRESS = '0x2222222222222222222222222222222222222222'

// A linked-account id is a uuid and the spec's path parameter says so; with
// the module enforced (#3030) 'safe-1' is refused before the handler.
const ACCOUNT_ID = '2f6e1a9c-8b3d-4e5f-a7c1-9d0b2e4f6a8c'

describe('Safe-rail inflow is closed (#1984) and its implementation deleted (#1988)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // The production wiring (#3030, slice 2 of #3028): root-scope install, the
    // module(s) enforced — off-spec requests answer the 400 envelope before the
    // handler, conformant ones reach it unchanged.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/user-accounts.ts', 'routes/user.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(safeDeployRoutes, { prefix: '/safe' })
    // Mirrors index.ts's real wiring (#2914): the naming tombstone owns
    // `/user/safes`, the live (rail-closed) routes own `/user/accounts`.
    await app.register(userAccountsRetiredRoutes, { prefix: '/user/safes' })
    await app.register(userAccountsRoutes, { prefix: '/user/accounts' })
    await app.register(userRoutes, { prefix: '/user' })
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
    // Deliberately generous: if any handler DID run, these resolve happily and
    // the "nothing was touched" assertions are what catches it — not a crash
    // that could be mistaken for the refusal working.
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

  /** Every inflow, as (name, request) — the table IS the closure's definition. */
  const INFLOWS = [
    {
      name: 'POST /safe/deploy — passkey-owned Safe deployment',
      kind: 'deploy' as const,
      method: 'POST' as const,
      url: '/safe/deploy',
      payload: { chain_id: 84532 },
    },
    {
      name: 'POST /user/accounts/deploy — relay-sponsored account deployment',
      kind: 'deploy' as const,
      method: 'POST' as const,
      url: '/user/accounts/deploy',
      payload: { chain_id: 84532, owner_address: OWNER_ADDRESS },
    },
    {
      name: 'POST /user/accounts — account import',
      kind: 'import' as const,
      method: 'POST' as const,
      url: '/user/accounts',
      payload: { safe_address: SAFE_ADDRESS, chain_id: 84532 },
    },
    {
      name: 'PUT /user/account — legacy single-account link (also an import)',
      kind: 'import' as const,
      method: 'PUT' as const,
      url: '/user/account',
      payload: { safe_address: SAFE_ADDRESS, chain_id: 84532 },
    },
  ]

  for (const inflow of INFLOWS) {
    describe(inflow.name, () => {
      it('refuses with 410 — the Safe rail is retired', async () => {
        const res = await app.inject({
          method: inflow.method,
          url: inflow.url,
          headers: auth(),
          payload: inflow.payload,
        })

        expect(res.statusCode).toBe(410)
      })

      it('names the retirement and the delegation-rail replacement', async () => {
        const res = await app.inject({
          method: inflow.method,
          url: inflow.url,
          headers: auth(),
          payload: inflow.payload,
        })

        expect(res.json()).toEqual(safeRailRetired(inflow.kind).body)
        expect(res.json().error).toMatch(/Safe rail is retired/)
        expect(res.json().error).toMatch(/POST \/accounts\/hybrid/)
      })

      it('refuses BEFORE any database or relayer work — nothing was touched', async () => {
        await app.inject({
          method: inflow.method,
          url: inflow.url,
          headers: auth(),
          payload: inflow.payload,
        })

        expect(mockPoolQuery).not.toHaveBeenCalled()
        expect(mockConnect).not.toHaveBeenCalled()
        expect(mockClientQuery).not.toHaveBeenCalled()
      })

      it('still authenticates first — an anonymous caller gets 401, not 410', async () => {
        const res = await app.inject({
          method: inflow.method,
          url: inflow.url,
          payload: inflow.payload,
        })

        expect(res.statusCode).toBe(401)
      })

      it('answers 410 BEFORE request validation — a body the spec would refuse is still told the flow is gone (#3030)', async () => {
        // The route modules are enforced now; the retired ops still declare
        // their old request bodies in the spec (the fixture payloads above
        // are off-spec against them already — `safe_address` where the
        // spec says `account_address`). The 410 is a route-level onRequest
        // hook (`retiredSafeInflowRoute`), so it precedes the preValidation
        // step. Mutation: drop the options from the registration → 400
        // envelope here.
        const res = await app.inject({
          method: inflow.method,
          url: inflow.url,
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        })
        expect(res.statusCode).toBe(410)
        expect(res.json()).toEqual(safeRailRetired(inflow.kind).body)
      })
    })
  }

  /**
   * #2914 moved three of the four historical inflow URLs behind the NAMING
   * tombstone first. An old client posting to one of these never reaches
   * `safeRailRetired` at all — it is refused one hop earlier, for a
   * different, equally loud reason. Both refusals are 410, so the only way
   * to tell them apart is the body: the naming refusal names a REPLACEMENT
   * PATH, the rail refusal does not.
   */
  describe('the old /user/safes* names answer the NAMING tombstone, not the rail message', () => {
    it('POST /user/safes/deploy routes to the live POST /accounts/hybrid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/user/safes/deploy',
        headers: auth(),
        payload: { chain_id: 84532, owner_address: OWNER_ADDRESS },
      })

      expect(res.statusCode).toBe(410)
      const body = res.json() as { error: string; replacement: string }
      // #2914 review: naming a replacement that is ITSELF 410 would send a
      // caller in a circle, and this module advertises `replacement` as a
      // field a client can ROUTE on. So the field carries the live path and
      // the prose explains why the operation is gone.
      expect(body.replacement).toBe('POST /accounts/hybrid')
      expect(body.error).toMatch(/#1984/)
      expect(body.error).toMatch(/rather than a second tombstone/)
      expect(res.json()).not.toEqual(safeRailRetired('deploy').body)
    })

    it('POST /user/safes routes to the live POST /accounts/hybrid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/user/safes',
        headers: auth(),
        payload: { safe_address: SAFE_ADDRESS, chain_id: 84532 },
      })

      expect(res.statusCode).toBe(410)
      const body = res.json() as { error: string; replacement: string }
      expect(body.replacement).toBe('POST /accounts/hybrid')
      expect(body.error).toMatch(/#1984/)
      expect(body.error).toMatch(/rather than a second tombstone/)
      expect(res.json()).not.toEqual(safeRailRetired('import').body)
    })

    it('PUT /user/safe names PUT /user/account', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: auth(),
        payload: { safe_address: SAFE_ADDRESS, chain_id: 84532 },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().replacement).toBe('PUT /user/account')
      expect(res.json()).not.toEqual(safeRailRetired('import').body)
    })
  })

  describe('the refusal body', () => {
    it('distinguishes creating from importing', () => {
      expect(safeRailRetired('deploy').body.error).toMatch(/no longer creates Safe accounts/)
      expect(safeRailRetired('import').body.error).toMatch(/can no longer be imported/)
      expect(safeRailRetired('deploy').statusCode).toBe(410)
      expect(safeRailRetired('import').statusCode).toBe(410)
    })
  })

  /**
   * The other half of the acceptance criteria, and the reason this is not
   * just a deletion: an EXISTING account must stay fully usable. These pin
   * that the closure did not spill onto the read/edit paths of the very same
   * routers — at the ONE surviving name, `/user/accounts` (#2914 deleted the
   * twin address names, and keeps the `safes` envelope key for one more
   * release for the published CLI; see
   * `openapi/session-account-schema.test.ts` and `spec.test.ts`).
   */
  describe('an existing account is untouched', () => {
    it('GET /user/accounts still lists the caller’s accounts', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ id: ACCOUNT_ID, account_address: SAFE_ADDRESS, chain_id: 84532, is_default: true }],
      })

      const res = await app.inject({ method: 'GET', url: '/user/accounts', headers: auth() })

      expect(res.statusCode).toBe(200)
      expect(res.json().accounts).toHaveLength(1)
      // The `safes` twin is gone (#2914 follow-up): `latest` now resolves to
      // a CLI that reads `accounts`.
      expect(res.json().safes).toBeUndefined()
      expect(mockPoolQuery).toHaveBeenCalled()
    })

    it('PUT /user/accounts/:accountId still renames an existing account', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ id: ACCOUNT_ID, account_address: SAFE_ADDRESS, chain_id: 84532, name: 'Renamed' }],
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/user/accounts/${ACCOUNT_ID}`,
        headers: auth(),
        payload: { name: 'Renamed' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().name).toBe('Renamed')
    })

    it('PUT /user/accounts/:accountId/default still re-defaults an existing account', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: ACCOUNT_ID, account_address: SAFE_ADDRESS }] })
      mockClientQuery.mockResolvedValue({ rows: [] })

      const res = await app.inject({
        method: 'PUT',
        url: `/user/accounts/${ACCOUNT_ID}/default`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
    })

    it('DELETE /user/accounts/:accountId still unlinks an existing account', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ is_default: false }] })
      // The tenant-scoped DELETE matches the owned row, as on a real database (#3227).
      mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 })

      const res = await app.inject({
        method: 'DELETE',
        url: `/user/accounts/${ACCOUNT_ID}`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
    })
  })

  /**
   * #1988's own deletions, asserted rather than assumed.
   *
   * A deletion that nothing pins is a deletion that grows back — and the
   * post-deletion failure mode this repo has on record is the opposite one: a
   * guard left behind that now guards an empty set. So both directions are
   * measured here. The approver paths must be GONE (404 from the router, not
   * 410: they are not a retired flow a client should be told about, they are
   * routes that no longer exist). This block used to pin `POST /safe/exec` as
   * still THERE; #2847 deleted it, and the block below pins that instead.
   */
  describe('the approver surface is deleted (#1988)', () => {
    const APPROVER_PATHS = [
      { method: 'GET' as const, url: '/user/accounts/known-approvers' },
      { method: 'GET' as const, url: '/user/accounts/safe-1/approvers' },
      { method: 'POST' as const, url: '/user/accounts/safe-1/approvers/tx' },
      { method: 'POST' as const, url: '/user/accounts/safe-1/approvers' },
      {
        method: 'DELETE' as const,
        url: '/user/accounts/safe-1/approvers/0x3333333333333333333333333333333333333333',
      },
    ]

    for (const path of APPROVER_PATHS) {
      it(`${path.method} ${path.url} no longer exists`, async () => {
        const res = await app.inject({
          method: path.method,
          url: path.url,
          headers: auth(),
          payload: { action: 'add', address: OWNER_ADDRESS },
        })

        expect(res.statusCode).toBe(404)
        expect(mockPoolQuery).not.toHaveBeenCalled()
        expect(mockConnect).not.toHaveBeenCalled()
      })
    }
  })

  /**
   * #2847 deleted `POST /safe/exec` outright — the LAST live Safe-rail
   * behaviour. #1986 had held it open on the #1986/#1988 boundary: owner-
   * signed execution for an owner moving funds out of an account they hold.
   * With the route deleted that boundary is gone from the backend; the card's
   * owner decision (2026-09-10) is that the tombstone treatment the inflow
   * got is NOT applied here — the route no longer exists. Asserted as 404
   * WITH credentials too: the old assertion proved the route was there by an
   * anonymous 401; this proves it is gone by BOTH statuses, since a 410-
   * shaped tombstone would answer neither.
   */
  describe('POST /safe/exec is deleted (#2847)', () => {
    it('no longer exists — the router answers 404', async () => {
      const res = await app.inject({ method: 'POST', url: '/safe/exec', payload: {} })

      expect(res.statusCode).toBe(404)
    })

    it('answers 404, not 401, for an authenticated caller too — nothing is mounted there', async () => {
      const res = await app.inject({ method: 'POST', url: '/safe/exec', headers: auth(), payload: {} })

      expect(res.statusCode).toBe(404)
    })
  })
})
