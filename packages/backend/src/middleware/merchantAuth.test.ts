// db-mock-exempt: no database behaviour is under test here. The pool is mocked
// at the repository seam, so this suite pins the MIDDLEWARE contract — which
// credential each door accepts, the refusal bodies, the account binding and the
// last-used hook. The table invariants (the UNIQUE hash, the revocation CHECK,
// the throttle against real NOW()) are proven on the real-Postgres harness in
// `routes/__tests__/merchant-keys.db.test.ts`.
/**
 * `merchantAuthMiddleware` (#4896, epic #4885).
 *
 * What is pinned, in the order the middleware checks it:
 *
 * 1. No `sk_merchant_` credential → 401 `MERCHANT_KEY_REQUIRED`, and no query
 *    at all.
 * 2. An unknown key, a revoked key and a key whose account is no longer a
 *    merchant account all answer the SAME 401 `MERCHANT_KEY_INVALID` body —
 *    which of them it was is not something an unauthenticated caller is told.
 * 3. A valid key for an account whose merchant services are off → 403
 *    `MERCHANT_SERVICES_OFF`. Every key of that account is refused.
 * 4. A valid key decorates `request.merchant` with the KEY'S account, resolved
 *    from the row. A request naming another account in its query, body or
 *    headers cannot steer it — including the same user's other accounts.
 * 5. The middleware writes nothing: the only statement it issues is the SELECT.
 * 6. The mutation proof for "a merchant key is refused on agent, payment and
 *    dashboard routes": the same secret, stored in `agents` and given the agent
 *    prefix, IS accepted by `agentAuthMiddleware`. So the refusal is the
 *    prefix/table, not a test that cannot fail.
 * 7. The last-used hook writes only after a 2xx, and its UPDATE carries the
 *    one-minute throttle.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

import {
  MERCHANT_INVALID_KEY_BODY,
  MERCHANT_MISSING_KEY_BODY,
  MERCHANT_SERVICES_OFF_BODY,
  merchantAuthMiddleware,
  registerMerchantLastUsedHook,
} from './merchantAuth.js'
import { agentAuthMiddleware } from './agentAuth.js'
import { authMiddleware } from './auth.js'
import { hashMerchantKey } from '../domain/merchant-keys.js'
import { TOUCH_MERCHANT_KEY_LAST_USED_SQL } from '../infra/repositories/merchant-keys.js'

const SECRET = 'sk_merchant_' + 'a1'.repeat(24)
const OTHER_SECRET = 'sk_merchant_' + 'b2'.repeat(24)
const KEY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_KEY_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_ACCOUNT_ID = '55555555-5555-4555-8555-555555555555'
const ACCOUNT_ADDRESS = '0x' + 'cd'.repeat(20)
const OTHER_ACCOUNT_ADDRESS = '0x' + 'ef'.repeat(20)

interface AuthRow {
  key_id: string
  user_id: string
  account_id: string
  account_address: string
  chain_id: number
  revoked_at: string | null
  is_merchant_account: boolean
  services_enabled: boolean
}

function authRow(overrides: Partial<AuthRow> = {}): AuthRow {
  return {
    key_id: KEY_ID,
    user_id: USER_ID,
    account_id: ACCOUNT_ID,
    account_address: ACCOUNT_ADDRESS,
    chain_id: 84532,
    revoked_at: null,
    is_merchant_account: true,
    services_enabled: true,
    ...overrides,
  }
}

/** The merchant route the middleware guards. A test route IS a merchant route. */
function buildMerchantApp(): FastifyInstance {
  const app = Fastify({ logger: false })
  app.get('/merchant/sales', { preHandler: merchantAuthMiddleware }, async (request) => ({
    account_id: request.merchant?.account_id,
    account_address: request.merchant?.account_address,
    chain_id: request.merchant?.chain_id,
    key_id: request.merchant?.key_id,
  }))
  return app
}

/** The agent door and the dashboard door, for the cross-door refusals. */
async function buildOtherDoors(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyJwt, { secret: 'test-secret' })
  app.get('/agent/payment-tool', { preHandler: agentAuthMiddleware }, async () => ({ ok: true }))
  app.get('/dashboard/read', { preHandler: authMiddleware }, async () => ({ ok: true }))
  return app
}

describe('merchantAuthMiddleware (#4896)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('refuses a request with no merchant credential, and queries nothing', async () => {
    const app = buildMerchantApp()
    const response = await app.inject({ method: 'GET', url: '/merchant/sales' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual(MERCHANT_MISSING_KEY_BODY)
    expect(response.json().error_code).toBe('MERCHANT_KEY_REQUIRED')
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('refuses an agent key at the merchant door — it is not a merchant credential', async () => {
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: 'Bearer sk_agent_' + 'a1'.repeat(24) },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error_code).toBe('MERCHANT_KEY_REQUIRED')
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('refuses a dashboard session token and a device-login token, with the structured error and nothing written', async () => {
    // Both are JWTs, not `sk_merchant_` credentials. The merchant door refuses
    // them before any lookup — the same body as a missing key, because neither
    // is a merchant credential at all.
    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    app.get('/merchant/sales', { preHandler: merchantAuthMiddleware }, async () => ({ ok: true }))

    const sign = app.jwt.sign as (payload: Record<string, unknown>) => string
    const sessionToken = sign({ sub: USER_ID, email: 'ada@example.com' })
    const deviceLoginToken = sign({ sub: USER_ID, purpose: 'owner_cli' })

    for (const token of [sessionToken, deviceLoginToken]) {
      const response = await app.inject({
        method: 'GET',
        url: '/merchant/sales',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual(MERCHANT_MISSING_KEY_BODY)
      expect(response.json().error_code).toBe('MERCHANT_KEY_REQUIRED')
    }
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('an unknown key answers the invalid body', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${SECRET}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual(MERCHANT_INVALID_KEY_BODY)
    expect(response.json().error_code).toBe('MERCHANT_KEY_INVALID')
    await app.close()
  })

  it('a revoked key answers the SAME body as an unknown key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [authRow({ revoked_at: '2026-11-17T00:00:00Z' })] })
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${SECRET}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual(MERCHANT_INVALID_KEY_BODY)
    await app.close()
  })

  it('a key whose account is no longer a merchant account answers the invalid body', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [authRow({ is_merchant_account: false })] })
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${SECRET}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual(MERCHANT_INVALID_KEY_BODY)
    await app.close()
  })

  it('refuses every key of an account whose merchant services are off', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [authRow({ services_enabled: false })] })
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${SECRET}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual(MERCHANT_SERVICES_OFF_BODY)
    expect(response.json().error_code).toBe('MERCHANT_SERVICES_OFF')
    await app.close()
  })

  it('accepts a valid key and decorates the request with the KEY\'S account', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [authRow()] })
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${SECRET}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      account_id: ACCOUNT_ID,
      account_address: ACCOUNT_ADDRESS,
      chain_id: 84532,
      key_id: KEY_ID,
    })
    // The lookup is keyed on the SHA-256 of the presented secret, never on the
    // secret itself.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][1]).toEqual([hashMerchantKey(SECRET)])
    await app.close()
  })

  it('accepts the key from X-API-Key as well as Authorization', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [authRow()] })
    const app = buildMerchantApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { 'x-api-key': SECRET },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().account_id).toBe(ACCOUNT_ID)
    await app.close()
  })

  it('the account is the key\'s, never the request\'s — including the same user\'s other accounts', async () => {
    // Two keys of ONE user, bound to two different accounts. Each resolves to
    // its own account, and a request that names the other account in its query,
    // body and headers cannot steer it: there is no request field the
    // middleware reads for the account.
    mockQuery
      .mockResolvedValueOnce({ rows: [authRow()] })
      .mockResolvedValueOnce({
        rows: [
          authRow({
            key_id: OTHER_KEY_ID,
            account_id: OTHER_ACCOUNT_ID,
            account_address: OTHER_ACCOUNT_ADDRESS,
          }),
        ],
      })

    const app = buildMerchantApp()
    const first = await app.inject({
      method: 'GET',
      url: `/merchant/sales?account_id=${OTHER_ACCOUNT_ID}`,
      headers: {
        authorization: `Bearer ${SECRET}`,
        'x-account-id': OTHER_ACCOUNT_ID,
      },
      payload: { account_id: OTHER_ACCOUNT_ID },
    })
    const second = await app.inject({
      method: 'GET',
      url: `/merchant/sales?account_id=${ACCOUNT_ID}`,
      headers: {
        authorization: `Bearer ${OTHER_SECRET}`,
        'x-account-id': ACCOUNT_ID,
      },
      payload: { account_id: ACCOUNT_ID },
    })

    expect(first.statusCode).toBe(200)
    expect(first.json().account_id).toBe(ACCOUNT_ID)
    expect(first.json().account_address).toBe(ACCOUNT_ADDRESS)
    expect(second.statusCode).toBe(200)
    expect(second.json().account_id).toBe(OTHER_ACCOUNT_ID)
    expect(second.json().account_address).toBe(OTHER_ACCOUNT_ADDRESS)
    await app.close()
  })

  it('writes nothing: the only statement is the SELECT', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [authRow()] })
    const app = buildMerchantApp()
    await app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${SECRET}` },
    })

    const statements = mockQuery.mock.calls.map(([sql]) => String(sql))
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^SELECT/)
    expect(statements.some((s) => /INSERT|UPDATE|DELETE/.test(s))).toBe(false)
    await app.close()
  })

  it('MUTATION PROOF: the same secret stored in `agents` with the agent prefix IS accepted by the agent door', async () => {
    // The acceptance criterion says a merchant key is refused on agent, payment
    // and dashboard routes, and that the test is proven by showing it goes red
    // when the key is stored in `agents` or given the agent prefix. This is
    // that cell: the SAME secret body, with the agent prefix and an `agents`
    // row, authenticates at the agent door. So the merchant key's refusal below
    // is the prefix and the table, not a door that refuses everything.
    const agentSecret = 'sk_agent_' + SECRET.slice('sk_merchant_'.length)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'agent-1',
          user_id: USER_ID,
          name: 'Agent',
          delegate_address: '0x' + '11'.repeat(20),
          account_address: ACCOUNT_ADDRESS,
          chain_id: 84532,
          status: 'active',
          archived_at: null,
          has_bound_account: true,
        },
      ],
    })

    const app = await buildOtherDoors()
    const accepted = await app.inject({
      method: 'GET',
      url: '/agent/payment-tool',
      headers: { authorization: `Bearer ${agentSecret}` },
    })
    expect(accepted.statusCode).toBe(200)

    // And the merchant key itself is refused at BOTH other doors.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const atAgentDoor = await app.inject({
      method: 'GET',
      url: '/agent/payment-tool',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(atAgentDoor.statusCode).toBe(401)
    expect(atAgentDoor.json().error).toBe('Missing or invalid API key')

    const atDashboardDoor = await app.inject({
      method: 'GET',
      url: '/dashboard/read',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(atDashboardDoor.statusCode).toBe(401)
    expect(atDashboardDoor.json().error).toBe('Unauthorized')
    await app.close()
  })
})

describe('registerMerchantLastUsedHook (#4896)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  function buildApp(): FastifyInstance {
    const app = Fastify({ logger: false })
    registerMerchantLastUsedHook(app)
    app.get('/merchant/ok', { preHandler: merchantAuthMiddleware }, async () => ({ ok: true }))
    app.get('/merchant/refused', { preHandler: merchantAuthMiddleware }, async () => ({ ok: true }))
    return app
  }

  it('writes last_used_at after an ACCEPTED request, with the one-minute throttle in the SQL', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [authRow()] }) // the auth SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // the throttled UPDATE

    const app = buildApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/ok',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(response.statusCode).toBe(200)

    const statements = mockQuery.mock.calls.map(([sql]) => String(sql))
    expect(statements).toHaveLength(2)
    expect(statements[1]).toBe(TOUCH_MERCHANT_KEY_LAST_USED_SQL)
    expect(statements[1]).toMatch(/make_interval\(secs => \$2\)/)
    expect(mockQuery.mock.calls[1][1]).toEqual([KEY_ID, 60])
    await app.close()
  })

  it('writes nothing after a REFUSED request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }) // unknown key

    const app = buildApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/refused',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(response.statusCode).toBe(401)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('swallows a failing liveness write — the response is unaffected', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [authRow()] })
      .mockRejectedValueOnce(new Error('db down'))

    const app = buildApp()
    const response = await app.inject({
      method: 'GET',
      url: '/merchant/ok',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(response.statusCode).toBe(200)
    await app.close()
  })
})
