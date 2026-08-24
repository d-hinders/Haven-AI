import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The inflow is CLOSED (#1984, epic #1440 slice 1).
 *
 * This file is the single place that proves the Safe rail refuses new
 * accounts. There are FOUR ways a Safe could enter Haven, and a closure that
 * shuts three of them is not a closure — the fourth is simply the one an
 * attacker or an old client uses. All four are pinned here:
 *
 *   POST /safe/deploy        passkey-owned Safe deployment
 *   POST /user/safes/deploy  relay-sponsored, wallet-owned Safe deployment
 *   POST /user/safes         importing an existing Safe
 *   PUT  /user/safe          the legacy single-Safe link — also an import
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
 * The refusal is a route `preHandler`, and `authMiddleware` is an `onRequest`
 * hook, so this is a real ordering guarantee rather than a coincidence.
 *
 * What is NOT closed here, deliberately (later slices of #1440): an existing
 * `allowance_module` account still reads, still edits and still pays. The
 * payment 410 is #1986, sequenced after this slice on purpose.
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
// where they already are, in user-safes-characterization.test.ts and the
// repository suites.
const { mockPoolQuery, mockClientQuery, mockRelease, mockConnect, mockRelaySafeDeploy } =
  vi.hoisted(() => ({
    mockPoolQuery: vi.fn(),
    mockClientQuery: vi.fn(),
    mockRelease: vi.fn(),
    mockConnect: vi.fn(),
    mockRelaySafeDeploy: vi.fn(),
  }))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}))

vi.mock('../../modules/accounts/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../modules/accounts/index.js')>(
      '../../modules/accounts/index.js',
    )
  return { ...actual, relaySafeDeploy: (...args: unknown[]) => mockRelaySafeDeploy(...args) }
})

import safeDeployRoutes from '../safe-deploy.js'
import userSafesRoutes from '../user-safes.js'
import userRoutes from '../user.js'
import { safeRailRetired } from '../../middleware/safe-inflow-retired.js'

const USER = 'user-1'
const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const OWNER_ADDRESS = '0x2222222222222222222222222222222222222222'

describe('Safe-rail inflow is closed (#1984)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(safeDeployRoutes, { prefix: '/safe' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
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
    mockRelaySafeDeploy.mockReset()
    // Deliberately generous: if any handler DID run, these resolve happily and
    // the "nothing was touched" assertions are what catches it — not a crash
    // that could be mistaken for the refusal working.
    mockPoolQuery.mockResolvedValue({ rows: [] })
    mockClientQuery.mockResolvedValue({ rows: [] })
    mockConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    })
    mockRelaySafeDeploy.mockResolvedValue({ safeAddress: SAFE_ADDRESS, txHash: '0xdeadbeef' })
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
      name: 'POST /user/safes/deploy — relay-sponsored Safe deployment',
      kind: 'deploy' as const,
      method: 'POST' as const,
      url: '/user/safes/deploy',
      payload: { chain_id: 84532, owner_address: OWNER_ADDRESS },
    },
    {
      name: 'POST /user/safes — Safe import',
      kind: 'import' as const,
      method: 'POST' as const,
      url: '/user/safes',
      payload: { safe_address: SAFE_ADDRESS, chain_id: 84532 },
    },
    {
      name: 'PUT /user/safe — legacy single-Safe link (also an import)',
      kind: 'import' as const,
      method: 'PUT' as const,
      url: '/user/safe',
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
        expect(mockRelaySafeDeploy).not.toHaveBeenCalled()
      })

      it('still authenticates first — an anonymous caller gets 401, not 410', async () => {
        const res = await app.inject({
          method: inflow.method,
          url: inflow.url,
          payload: inflow.payload,
        })

        expect(res.statusCode).toBe(401)
      })
    })
  }

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
   * just a deletion: an EXISTING Safe account must stay fully usable. These
   * pin that the closure did not spill onto the read/edit paths of the very
   * same routers.
   */
  describe('an existing Safe account is untouched', () => {
    it('GET /user/safes still lists the caller’s Safes', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ id: 'safe-1', safe_address: SAFE_ADDRESS, chain_id: 84532, is_default: true }],
      })

      const res = await app.inject({ method: 'GET', url: '/user/safes', headers: auth() })

      expect(res.statusCode).toBe(200)
      expect(res.json().safes).toHaveLength(1)
      expect(mockPoolQuery).toHaveBeenCalled()
    })

    it('PUT /user/safes/:safeId still renames an existing Safe', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [{ id: 'safe-1', safe_address: SAFE_ADDRESS, chain_id: 84532, name: 'Renamed' }],
      })

      const res = await app.inject({
        method: 'PUT',
        url: '/user/safes/safe-1',
        headers: auth(),
        payload: { name: 'Renamed' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().name).toBe('Renamed')
    })

    it('DELETE /user/safes/:safeId still unlinks an existing Safe', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ is_default: false }] })
      mockClientQuery.mockResolvedValue({ rows: [] })

      const res = await app.inject({
        method: 'DELETE',
        url: '/user/safes/safe-1',
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
    })
  })
})
