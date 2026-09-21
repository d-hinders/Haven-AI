import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

/**
 * Route-level invariants for `GET /user/accounts` (the account list).
 *
 * The existing user-accounts suites cover approvers and delete; the list
 * endpoint had no coverage. This pins the two things that matter for it: it
 * requires auth, and it returns only the *calling* user's accounts (the
 * query is scoped to the JWT subject, never a client-supplied id).
 *
 * #2914 (naming epic #2906 phase 5, the contraction) removed the
 * `safe_address` twin `#2907` dual-emitted for one release. The `safes`
 * ENVELOPE key outlived it by one more, because the published CLI
 * destructured it and a published client cannot dual-read; #2914's own
 * follow-up removed that. One name now, `{ accounts }`, `account_address`
 * only.
 */

const { mockPoolQuery } = vi.hoisted(() => ({ mockPoolQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

// Avoid pulling chain/ethers deploy machinery into this route test.
// #1988 deleted `relaySafeDeploy`; the route no longer imports the accounts
// module, so there is nothing left to mock.

import userAccountsRoutes from '../user-accounts.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

const USER = 'user-1'

describe('GET /user/accounts — list invariants', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // The production wiring (#3030, slice 2 of #3028): root-scope install, the
    // module(s) enforced — off-spec requests answer the 400 envelope before the
    // handler, conformant ones reach it unchanged.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/user-accounts.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userAccountsRoutes, { prefix: '/user/accounts' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] })
  })

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/accounts' })
    expect(res.statusCode).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // #2914: one name, one envelope. `rows` below is the exact row shape
  // `LIST_ACCOUNTS_FOR_USER_SQL` returns; the response carries it unchanged
  // under `{ accounts }` — no `safes` key, no `safe_address` twin.
  it('returns the caller-scoped accounts under { accounts }, with the `safes` twin but no retired row fields', async () => {
    const rows = [
      // A real row: smart_accounts.id is a UUID and account_address is a full
      // 20-byte address, so 's1'/'0xabc' described a response the table
      // cannot produce (#1446).
      {
        id: 'd2c47f10-9a83-4e61-8b25-7c3f0e91a4d6',
        account_address: '0x' + 'ab'.repeat(20),
        chain_id: 8453,
        name: 'Main',
        is_default: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    mockPoolQuery.mockResolvedValueOnce({ rows })

    const res = await app.inject({
      method: 'GET',
      url: '/user/accounts',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    // ONE envelope key. `safes` outlived #2914 by exactly one release,
    // because `@haven_ai/cli` on `latest` destructured it at five call sites
    // and a published client cannot dual-read; `latest` is 0.3.0-alpha.0 now.
    // `toEqual` is exact, so this fails if the twin ever comes back.
    expect(res.json()).toEqual({ accounts: rows })
    expect(res.json().accounts[0].safe_address).toBeUndefined()
    // Scoped by the JWT subject — never a client-supplied id.
    const [, params] = mockPoolQuery.mock.calls[0]
    expect(params).toEqual([USER])
    // #1446: the documented shape, against the real payload.
    expectMatchesSpec('GET', '/user/accounts', res.json())
  })

  it('scopes the query to the *calling* user, so one user cannot list another’s accounts', async () => {
    const otherToken = app.jwt.sign({ sub: 'user-2', email: 'grace@example.com' })
    const res = await app.inject({
      method: 'GET',
      url: '/user/accounts',
      headers: { authorization: `Bearer ${otherToken}` },
    })

    expect(res.statusCode).toBe(200)
    const [, params] = mockPoolQuery.mock.calls[0]
    expect(params).toEqual(['user-2'])
  })
})
