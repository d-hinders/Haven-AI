import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * `GET /accounts/hybrid/:address/signers` under an `owner_cli` token (#3597).
 *
 * `hybrid-signers.test.ts` covers the route's response shape but mocks
 * `middleware/auth.js` wholesale, so it cannot exercise the REAL
 * `authMiddleware` → `routeAllowsOwnerCli` decision this route now depends
 * on. This file registers the real auth plugin and signs a real
 * `purpose: 'owner_cli'` token, the same device-flow shape
 * `routes/auth.ts:384` mints — the thing the CLI's feedback secret check
 * (layer 3) actually sends.
 *
 * This file proves AUTH ROUTING ONLY — which token reaches the handler —
 * never what Postgres returns once it does. `resolveOwnedHybridAccount` runs
 * its ownership check (`FIND_OWNED_HYBRID_ACCOUNT_SQL`, scoped by `user_id`)
 * as a raw pool query inside `hybrid-accounts.ts` itself (a pre-existing
 * `pg-only-in-infra` dep-lint waiver — no repository to mock at a narrower
 * boundary), so EVERY test of this route, including its sibling
 * `hybrid-signers.test.ts`, mocks the pool module the same way this file
 * does — the exemption is not this file being special, it is that nothing
 * anywhere proves `FIND_OWNED_HYBRID_ACCOUNT_SQL`'s user-scoping against a
 * real database today; that gap is pre-existing and not introduced here.
 */
// db-mock-exempt: auth-routing-only test; the route's ownership query has no
// real-DB test anywhere (pre-existing gap — see the file header above)

const { mockQuery, mockLoadOwner } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLoadOwner: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../rails/hybrid-account-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-account-config.js')>()
  return { ...actual, loadHybridOwnerConfig: mockLoadOwner }
})

const routes = (await import('../hybrid-accounts.js')).default
const ACCOUNT = '0x' + 'ab'.repeat(20)

describe('GET /accounts/hybrid/:address/signers accepts an owner_cli token (#3597)', () => {
  let app: FastifyInstance
  let ownerCliToken: string
  let dashboardToken: string
  let otherUserOwnerCliToken: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(routes, { prefix: '/accounts' })
    ownerCliToken = app.jwt.sign(
      { sub: 'user-1', email: 'ada@example.com', purpose: 'owner_cli' } as unknown as {
        sub: string
        email: string
      },
    )
    dashboardToken = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
    // N-d: a DIFFERENT user, also owner_cli — the allow-list grants the
    // ROUTE, never the account. Ownership scoping is the thing that must
    // still refuse.
    otherUserOwnerCliToken = app.jwt.sign(
      { sub: 'user-2', email: 'bob@example.com', purpose: 'owner_cli' } as unknown as {
        sub: string
        email: string
      },
    )
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockLoadOwner.mockReset()
    // One row is enough for `resolveOwnedHybridAccount`'s ownership check
    // (`owned.rows.length === 0` → 404); `listAccountPasskeys`'s own read
    // tolerates the same shape (it only maps rows with a `created_at`, and
    // this test's `config.passkeys` is empty, so the map is never consulted).
    mockQuery.mockResolvedValue({ rows: [{ id: 'account-1' }] })
    mockLoadOwner.mockResolvedValue({
      accountId: 'account-1',
      config: { ownerAddress: '0x' + 'cd'.repeat(20), passkeys: [] },
    })
  })

  function get(token?: string) {
    return app.inject({
      method: 'GET',
      url: `/accounts/hybrid/${ACCOUNT}/signers?chain_id=84532`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  }

  it('an owner_cli token reaches the handler (200), same as a dashboard token', async () => {
    const owner = await get(ownerCliToken)
    expect(owner.statusCode).toBe(200)
    const dashboard = await get(dashboardToken)
    expect(dashboard.statusCode).toBe(200)
    expect(owner.json()).toEqual(dashboard.json())
  })

  it('an anonymous caller is still refused', async () => {
    const res = await get()
    expect(res.statusCode).toBe(401)
  })

  it('N-d: an owner_cli token for a DIFFERENT user is refused 404 — the allow-list grants the route, never the account', async () => {
    // Override just the ownership check's own query: an empty result is
    // exactly what `FIND_OWNED_HYBRID_ACCOUNT_SQL` returns for an address
    // this caller does not own, and `resolveOwnedHybridAccount` 404s on it
    // before anything else runs.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const res = await get(otherUserOwnerCliToken)
    expect(res.statusCode).toBe(404)
  })
})
