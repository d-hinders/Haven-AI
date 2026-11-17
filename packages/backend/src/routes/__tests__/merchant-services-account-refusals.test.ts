// db-mock-exempt: no database behaviour is under test here. The pool is mocked
// at the repository seam so the suite pins the two ROUTE refusals #4895 adds —
// unlinking the merchant account and making it the default — plus the positive
// control that an ordinary account still does both. The marker's database
// invariant is proven on the real-Postgres harness in
// `merchant-services.db.test.ts`.
/**
 * The merchant-account refusals on `DELETE /user/accounts/:id` and
 * `PUT /user/accounts/:id/default` (#4895, epic #4885).
 *
 * Unlinking is a hard DELETE of the account row, and the indexed payments go
 * with it — so the account merchant payments are received into cannot be
 * unlinked while it holds the marker. Making it the default would put the
 * user's ordinary spending on the receiving account, so that is refused too.
 * Both carry a code the dialog branches on.
 *
 * The positive controls matter as much as the refusals: an ordinary account
 * must still unlink and still become the default, so the guard is specific to
 * the marker rather than a blanket refusal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import userAccountsRoutes from '../user-accounts.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const ACCOUNT_ID = '9b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40'
const ADDRESS = '0x' + 'cd'.repeat(20)

interface MockOpts {
  /** The ownership read's row, or null when the account is not the caller's. */
  owned?: { id: string; account_address: string; is_default: boolean; is_merchant_account: boolean } | null
}

function mockDb(opts: MockOpts = {}) {
  const calls: Array<[string, unknown[]]> = []
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql)
    calls.push([s, params ?? []])
    if (/SELECT id, account_address, is_default, is_merchant_account/.test(s)) {
      return Promise.resolve({ rows: opts.owned ? [opts.owned] : [] })
    }
    if (/DELETE FROM smart_accounts/.test(s)) {
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
  return calls
}

const ORDINARY = { id: ACCOUNT_ID, account_address: ADDRESS, is_default: false, is_merchant_account: false }
const MERCHANT = { ...ORDINARY, is_merchant_account: true }

describe('the merchant account cannot be unlinked or made default (#4895)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userAccountsRoutes, { prefix: '/user/accounts' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  function call(method: 'PUT' | 'DELETE', url: string) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
  }

  it('refuses to unlink the merchant account with MERCHANT_ACCOUNT_UNLINK_REFUSED', async () => {
    const calls = mockDb({ owned: MERCHANT })
    const res = await call('DELETE', `/user/accounts/${ACCOUNT_ID}`)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'MERCHANT_ACCOUNT_UNLINK_REFUSED' })
    expectMatchesSpec('DELETE', '/user/accounts/{accountId}', res.json(), '409')
    // Nothing was deleted.
    expect(calls.some(([s]) => /DELETE FROM smart_accounts/.test(s))).toBe(false)
  })

  it('refuses to make the merchant account the default with MERCHANT_ACCOUNT_DEFAULT_REFUSED', async () => {
    const calls = mockDb({ owned: MERCHANT })
    const res = await call('PUT', `/user/accounts/${ACCOUNT_ID}/default`)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'MERCHANT_ACCOUNT_DEFAULT_REFUSED' })
    expectMatchesSpec('PUT', '/user/accounts/{accountId}/default', res.json(), '409')
    // The default pointer was never touched.
    expect(calls.some(([s]) => /SET is_default = true/.test(s))).toBe(false)
  })

  it('POSITIVE CONTROL: an ordinary account still unlinks', async () => {
    mockDb({ owned: ORDINARY })
    const res = await call('DELETE', `/user/accounts/${ACCOUNT_ID}`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ success: true })
  })

  it('POSITIVE CONTROL: an ordinary account can still become the default', async () => {
    mockDb({ owned: ORDINARY })
    const res = await call('PUT', `/user/accounts/${ACCOUNT_ID}/default`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ success: true })
  })

  it('404s an account the caller does not own, before either refusal', async () => {
    mockDb({ owned: null })
    const unlink = await call('DELETE', `/user/accounts/${ACCOUNT_ID}`)
    const makeDefault = await call('PUT', `/user/accounts/${ACCOUNT_ID}/default`)
    expect(unlink.statusCode).toBe(404)
    expect(makeDefault.statusCode).toBe(404)
  })
})
