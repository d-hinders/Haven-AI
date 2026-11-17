// db-mock-exempt: no database behaviour is under test here. The pool is mocked
// at the repository seam, so this suite pins the ROUTE contract — the secret
// returned once, the list carrying prefixes only, the idempotent revoke, the
// closed create body and the no-merchant-account refusal. The table invariants
// (the UNIQUE hash, the revocation CHECK, the throttle against real NOW()) are
// proven on the real-Postgres harness in `merchant-keys.db.test.ts`.
/**
 * `POST/GET/DELETE /merchant-keys` (#4896, epic #4885).
 *
 * What is pinned, in the order the route checks it:
 *
 * 1. Every route needs an owner session; an unauthenticated request is 401.
 * 2. `POST` refuses with `MERCHANT_ACCOUNT_REQUIRED` when the caller has no
 *    merchant account — it never mints a credential that could never
 *    authenticate.
 * 3. `POST` returns the secret in that one response, and the row it stores
 *    carries only the hash and the prefix. The account is the caller's merchant
 *    account; the request names none.
 * 4. `GET` returns prefixes only — no secret, no hash — plus the who/when
 *    columns and `last_used_at`.
 * 5. `DELETE` records who revoked the key and when; a second revoke answers the
 *    row unchanged; a key that is not the caller's is 404, never 403.
 * 6. The create body is closed: a body naming an account to bind the key to is
 *    refused by the schema, before the handler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

import merchantKeyRoutes from '../merchant-keys.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { hashMerchantKey } from '../../domain/merchant-keys.js'

const USER_ID = '33333333-3333-4333-8333-333333333333'
const ACCOUNT_ID = '9b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40'
const KEY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_KEY_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_ADDRESS = '0x' + 'cd'.repeat(20)

interface KeyRow {
  id: string
  key_prefix: string
  created_by: string
  created_at: string
  revoked_by: string | null
  revoked_at: string | null
  last_used_at: string | null
}

const LIVE_KEY: KeyRow = {
  id: KEY_ID,
  key_prefix: 'sk_merchant_' + 'a1'.repeat(6),
  created_by: USER_ID,
  created_at: '2026-11-17T00:00:00Z',
  revoked_by: null,
  revoked_at: null,
  last_used_at: null,
}

const REVOKED_KEY: KeyRow = {
  ...LIVE_KEY,
  revoked_by: USER_ID,
  revoked_at: '2026-11-17T01:00:00Z',
}

interface MockOpts {
  /** The caller's merchant account, or null when merchant services are off/never on. */
  merchantAccount?: { id: string; account_address: string; chain_id: number; name: string; created_at: string } | null
  keys?: KeyRow[]
  /** The row the revoke UPDATE returns, or null when it matched nothing. */
  revoked?: KeyRow | null
  /** The row the scoped SELECT returns (already revoked, or not the caller's). */
  existing?: KeyRow | null
}

/** Pattern-matched DB mock (#775), the shape the sibling route suites use. */
function mockDb(opts: MockOpts = {}) {
  const calls: Array<[string, unknown[]]> = []
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql)
    calls.push([s, params ?? []])

    if (/FROM smart_accounts/.test(s) && /is_merchant_account/.test(s)) {
      return Promise.resolve({
        rows: opts.merchantAccount === null || opts.merchantAccount === undefined ? [] : [opts.merchantAccount],
      })
    }
    if (/INSERT INTO merchant_keys/.test(s)) {
      // Echo the row the INSERT would return: the prefix and creator come from
      // the statement's own parameters, so the test can compare them with the
      // secret the route minted.
      const values = (params ?? []) as string[]
      return Promise.resolve({
        rows: [
          {
            ...LIVE_KEY,
            key_prefix: values[3],
            created_by: values[4],
          },
        ],
        rowCount: 1,
      })
    }
    if (/FROM merchant_keys/.test(s) && /ORDER BY created_at DESC/.test(s)) {
      return Promise.resolve({ rows: opts.keys ?? [] })
    }
    if (/UPDATE merchant_keys/.test(s)) {
      return Promise.resolve({ rows: opts.revoked ? [opts.revoked] : [], rowCount: opts.revoked ? 1 : 0 })
    }
    if (/FROM merchant_keys/.test(s) && /WHERE id = \$1 AND user_id = \$2/.test(s)) {
      return Promise.resolve({ rows: opts.existing ? [opts.existing] : [] })
    }
    throw new Error(`unexpected SQL in merchant-keys route test: ${s}`)
  })
  return calls
}

describe('merchant keys routes (#4896)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // The root-scope install index.ts performs, and the module is enforced.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/merchant-keys.ts'] })
    await app.register(merchantKeyRoutes, { prefix: '/merchant-keys' })
    token = app.jwt.sign({ sub: USER_ID, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
  }

  describe('authentication', () => {
    for (const [method, url] of [
      ['POST', '/merchant-keys'],
      ['GET', '/merchant-keys'],
      ['DELETE', `/merchant-keys/${KEY_ID}`],
    ] as const) {
      it(`${method} ${url} rejects an unauthenticated request`, async () => {
        const res = await app.inject({ method, url })
        expect(res.statusCode).toBe(401)
      })
    }
  })

  describe('creating', () => {
    it('refuses with MERCHANT_ACCOUNT_REQUIRED when the caller has no merchant account', async () => {
      mockDb({ merchantAccount: null })
      const res = await call('POST', '/merchant-keys')

      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error_code).toBe('MERCHANT_ACCOUNT_REQUIRED')
      // Nothing was minted.
      expect(mockQuery.mock.calls.some(([s]) => /INSERT INTO merchant_keys/.test(String(s)))).toBe(false)
    })

    it('returns the secret once and stores only its hash and prefix', async () => {
      const calls = mockDb({
        merchantAccount: {
          id: ACCOUNT_ID,
          account_address: ACCOUNT_ADDRESS,
          chain_id: 84532,
          name: 'Sales',
          created_at: '2026-11-17T00:00:00Z',
        },
      })
      const res = await call('POST', '/merchant-keys')

      expect(res.statusCode, res.body).toBe(201)
      const body = res.json()
      expect(body.secret).toMatch(/^sk_merchant_[0-9a-f]{48}$/)
      expect(body.key_prefix).toBe(body.secret.slice(0, 'sk_merchant_'.length + 12))
      expect(body.created_by).toBe(USER_ID)
      expect(body.revoked_by).toBeNull()
      expect(body.revoked_at).toBeNull()
      expectMatchesSpec('POST', '/merchant-keys', body, '201')

      // The INSERT carries the hash and the prefix — never the secret.
      const insert = calls.find(([s]) => /INSERT INTO merchant_keys/.test(s))
      expect(insert).toBeDefined()
      const params = insert![1] as string[]
      expect(params).toContain(hashMerchantKey(body.secret))
      expect(params).toContain(body.key_prefix)
      expect(params).not.toContain(body.secret)
      // The account is the caller's merchant account, and the caller is the
      // creator.
      expect(params).toContain(ACCOUNT_ID)
      expect(params).toContain(USER_ID)
    })

    it('refuses a body naming an account to bind the key to — the schema, before the handler', async () => {
      mockDb({})
      const res = await call('POST', '/merchant-keys', { account_id: ACCOUNT_ID })

      expect(res.statusCode, res.body).toBe(400)
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })

  describe('listing', () => {
    it('returns prefixes only — no secret, no hash — with the who/when columns', async () => {
      mockDb({ keys: [LIVE_KEY, REVOKED_KEY] })
      const res = await call('GET', '/merchant-keys')

      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      expect(body.keys).toHaveLength(2)
      expect(body.keys[0]).toEqual({
        id: KEY_ID,
        key_prefix: LIVE_KEY.key_prefix,
        created_by: USER_ID,
        created_at: LIVE_KEY.created_at,
        revoked_by: null,
        revoked_at: null,
        last_used_at: null,
      })
      expect(body.keys[1].revoked_by).toBe(USER_ID)
      expect(body.keys[1].revoked_at).toBe(REVOKED_KEY.revoked_at)
      expect(JSON.stringify(body)).not.toMatch(/secret|key_hash/)
      expectMatchesSpec('GET', '/merchant-keys', body, '200')

      // The SELECT never asks for the hash.
      const select = mockQuery.mock.calls.map(([s]) => String(s)).find((s) => /FROM merchant_keys/.test(s))
      expect(select).toBeDefined()
      expect(select).not.toMatch(/key_hash/)
    })
  })

  describe('revoking', () => {
    it('records who revoked the key and when', async () => {
      mockDb({ revoked: REVOKED_KEY })
      const res = await call('DELETE', `/merchant-keys/${KEY_ID}`)

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().revoked_by).toBe(USER_ID)
      expect(res.json().revoked_at).toBe(REVOKED_KEY.revoked_at)
      expectMatchesSpec('DELETE', '/merchant-keys/{id}', res.json(), '200')

      const update = mockQuery.mock.calls
        .map(([s, p]) => ({ sql: String(s), params: (p ?? []) as unknown[] }))
        .find((c) => /UPDATE merchant_keys/.test(c.sql))
      expect(update).toBeDefined()
      // Scoped on the row id AND the caller, and only while it is not revoked.
      expect(update!.sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND revoked_at IS NULL/)
      expect(update!.params).toEqual([KEY_ID, USER_ID, USER_ID])
    })

    it('is idempotent: a second revoke answers the row unchanged', async () => {
      mockDb({ revoked: null, existing: REVOKED_KEY })
      const res = await call('DELETE', `/merchant-keys/${KEY_ID}`)

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().revoked_by).toBe(USER_ID)
      expect(res.json().revoked_at).toBe(REVOKED_KEY.revoked_at)
    })

    it('answers 404 — never 403 — for a key that is not the caller\'s', async () => {
      mockDb({ revoked: null, existing: null })
      const res = await call('DELETE', `/merchant-keys/${OTHER_KEY_ID}`)

      expect(res.statusCode, res.body).toBe(404)
      expect(res.json().error_code).toBe('MERCHANT_KEY_NOT_FOUND')
    })
  })
})
