// db-mock-exempt: no database behaviour is under test here. The pool is mocked
// at the repository seam and the address derivation at the chain seam, so this
// suite pins the ROUTE contract — the one-transaction turn-on, every refusal
// code, the repeat/second-tab answer, the closed request body and the read
// scoping. The database invariants (the partial unique index, the setting and
// marker committing with the account) are proven on the real-Postgres harness
// in `merchant-services.db.test.ts`.
/**
 * `POST/DELETE/GET /merchant-services` (#4895, epic #4885).
 *
 * What is pinned, in the order the route checks it:
 *
 * 1. The existing-merchant-account check runs BEFORE the creation logic, so
 *    turning merchant services back on answers the account with no network
 *    and no passkey in the request, and a network that is named and differs is
 *    refused with `MERCHANT_ACCOUNT_ON_OTHER_NETWORK` rather than reaching the
 *    idempotency key.
 * 2. With no merchant account yet, the three fields are required
 *    (`MERCHANT_SETUP_DETAILS_REQUIRED`) and the network must be served
 *    (`UNSUPPORTED_NETWORK` — the create-additional path answered that case
 *    with a sentence and no code). Neither refusal creates anything.
 * 3. The creation is the create-additional path, with the derived key in the
 *    reserved `merchant-service:` namespace, the server-side name "Sales", and
 *    `is_default` false.
 * 4. Every create-additional refusal code reaches the client unchanged.
 * 5. The request body is closed: a body naming an account to mark is refused
 *    by the schema, before the handler.
 * 6. Turning off records the setting and keeps the account; the read returns
 *    the setting and the account, scoped to the caller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const { mockQuery, mockCompute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
}))

vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeUserHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})

import merchantServiceRoutes from '../merchant-services.js'
import hybridAccountRoutes from '../hybrid-accounts.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

const SOURCE_ID = '5a2f8d31-6c04-4e97-b183-9e7d2c6a0f58'
const ACCOUNT_ID = '9b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40'
const HYBRID = '0x' + 'cd'.repeat(20)
const SALT_ONE = '0x' + '00'.repeat(31) + '01'
const PASSKEY = {
  key_id: 'cred-1',
  public_key_x: '0x' + '11'.repeat(32),
  public_key_y: '0x' + '22'.repeat(32),
}

interface MerchantRow {
  id: string
  account_address: string
  chain_id: number
  name: string
  created_at: string
}

const CREATED_ACCOUNT: MerchantRow = {
  id: ACCOUNT_ID,
  account_address: HYBRID,
  chain_id: 84532,
  name: 'Sales',
  created_at: '2026-11-17T00:00:00Z',
}

interface MockOpts {
  /** The caller's existing merchant account, or null. */
  merchantAccount?: MerchantRow | null
  /** The caller's setting row, or null when they never turned the feature on. */
  setting?: { enabled: boolean; enabled_at: string | null; disabled_at: string | null } | null
  source?: 'found' | 'missing'
  sourcePasskeys?: Array<{ key_id: string; public_key_x: string; public_key_y: string }>
  chainCount?: string
  replay?: { id: string; account_address: string; chain_id: number; created_at: string } | null
  insertConflicts?: boolean
  /** The derived address is already one of the caller's accounts. */
  addressTaken?: boolean
}

/** Pattern-matched DB mock (#775), the shape the sibling route suites use. */
function mockDb(opts: MockOpts = {}) {
  const calls: Array<[string, unknown[]]> = []
  let marked = false
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql)
    calls.push([s, params ?? []])
    // ── merchant-services repository ────────────────────────────────────────
    if (/INSERT INTO merchant_service_settings/.test(s)) {
      return Promise.resolve({
        rows: [
          {
            user_id: 'user-1',
            enabled: opts.setting?.enabled ?? false,
            enabled_at: opts.setting?.enabled_at ?? null,
            disabled_at: opts.setting?.disabled_at ?? null,
          },
        ],
      })
    }
    if (/SET enabled = true/.test(s)) {
      return Promise.resolve({
        rows: [
          {
            user_id: 'user-1',
            enabled: true,
            enabled_at: '2026-11-17T00:00:00Z',
            disabled_at: opts.setting?.disabled_at ?? null,
          },
        ],
      })
    }
    if (/SET enabled = false/.test(s)) {
      return Promise.resolve({
        rows: [
          {
            user_id: 'user-1',
            enabled: false,
            enabled_at: opts.setting?.enabled_at ?? null,
            disabled_at: '2026-11-17T00:00:00Z',
          },
        ],
      })
    }
    if (/FROM merchant_service_settings/.test(s)) {
      return Promise.resolve({
        rows: opts.setting ? [{ user_id: 'user-1', ...opts.setting }] : [],
      })
    }
    if (/SET is_merchant_account = true/.test(s)) {
      marked = true
      return Promise.resolve({ rows: [] })
    }
    if (/WHERE user_id = \$1 AND is_merchant_account/.test(s)) {
      if (marked) return Promise.resolve({ rows: [CREATED_ACCOUNT] })
      return Promise.resolve({ rows: opts.merchantAccount ? [opts.merchantAccount] : [] })
    }
    // ── create-additional repository ────────────────────────────────────────
    if (/create_idempotency_key = \$2/.test(s)) {
      return Promise.resolve({ rows: opts.replay ? [opts.replay] : [] })
    }
    if (/account_type = 'delegator_hybrid'/.test(s)) {
      return Promise.resolve({ rows: opts.source === 'missing' ? [] : [{ id: SOURCE_ID }] })
    }
    if (/FROM hybrid_account_passkeys/.test(s)) {
      return Promise.resolve({ rows: opts.sourcePasskeys ?? [PASSKEY] })
    }
    if (/COUNT\(\*\) AS count FROM smart_accounts WHERE user_id = \$1 AND chain_id = \$2/.test(s)) {
      return Promise.resolve({ rows: [{ count: opts.chainCount ?? '0' }] })
    }
    if (/INSERT INTO hybrid_deploy_salt_counters/.test(s)) {
      return Promise.resolve({ rows: [{ last_allocated: '1' }] })
    }
    if (/SELECT id FROM smart_accounts/.test(s)) {
      return Promise.resolve({ rows: opts.addressTaken ? [{ id: SOURCE_ID }] : [] })
    }
    if (/INSERT INTO smart_accounts/.test(s)) {
      return Promise.resolve({
        rows: opts.insertConflicts ? [] : [{ id: ACCOUNT_ID, created_at: '2026-11-17T00:00:00Z' }],
      })
    }
    return Promise.resolve({ rows: [] })
  })
  return calls
}

const TURN_ON = { chain_id: 84532, source_account_id: SOURCE_ID, key_id: 'cred-1' }

/** A refused turn-on: no derivation, no account row, no marker, setting never enabled. */
function expectNothingCreated(calls: Array<[string, unknown[]]>) {
  expect(mockCompute).not.toHaveBeenCalled()
  for (const fragment of [
    /INSERT INTO hybrid_deploy_salt_counters/,
    /INSERT INTO smart_accounts/,
    /SET is_merchant_account = true/,
    /SET enabled = true/,
  ]) {
    expect(calls.some(([s]) => fragment.test(s)), String(fragment)).toBe(false)
  }
}

describe('merchant services routes (#4895)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // The production wiring: the plugin is registered by the test, the same
    // root-scope install index.ts performs, and the module is enforced.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/merchant-services.ts'] })
    await app.register(merchantServiceRoutes, { prefix: '/merchant-services' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(HYBRID)
  })

  function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
  }

  describe('authentication', () => {
    for (const [method, url] of [
      ['POST', '/merchant-services'],
      ['DELETE', '/merchant-services'],
      ['GET', '/merchant-services'],
    ] as const) {
      it(`${method} ${url} rejects an unauthenticated request`, async () => {
        const res = await app.inject({ method, url })
        expect(res.statusCode).toBe(401)
      })
    }
  })

  describe('turning on', () => {
    it('creates the account, marks it and enables the setting — 201, created true', async () => {
      const calls = mockDb({})
      const res = await call('POST', '/merchant-services', TURN_ON)

      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        enabled: true,
        created: true,
        merchant_account: {
          id: ACCOUNT_ID,
          account_address: HYBRID,
          chain_id: 84532,
          name: 'Sales',
        },
      })
      expectMatchesSpec('POST', '/merchant-services', res.json(), '201')

      // The setting row is locked FIRST — that lock is what serialises two
      // concurrent turn-ons.
      const lockAt = calls.findIndex(([s]) => /INSERT INTO merchant_service_settings/.test(s))
      const markAt = calls.findIndex(([s]) => /SET is_merchant_account = true/.test(s))
      const enableAt = calls.findIndex(([s]) => /SET enabled = true/.test(s))
      expect(lockAt).toBeGreaterThanOrEqual(0)
      expect(lockAt).toBeLessThan(markAt)
      expect(markAt).toBeLessThan(enableAt)

      // The account is created through the create-additional path, with the
      // derived key in the reserved namespace and the server-side name.
      const insert = calls.find(([s]) => /INSERT INTO smart_accounts/.test(s))!
      expect(insert[1][3]).toBe('Sales') // name
      expect(insert[1][4]).toBe(false) // is_default — never the default
      expect(insert[1][8]).toBe('merchant-service:84532') // idempotency key
    })

    it('answers the existing merchant account on the same network without creating anything — 200, created false', async () => {
      const calls = mockDb({ merchantAccount: CREATED_ACCOUNT })
      const res = await call('POST', '/merchant-services', { ...TURN_ON, key_id: 'some-other-passkey' })

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ enabled: true, created: false, merchant_account: { id: ACCOUNT_ID } })
      expectMatchesSpec('POST', '/merchant-services', res.json(), '200')
      // The creation logic never ran: no derivation, no salt, no insert.
      expect(mockCompute).not.toHaveBeenCalled()
      expect(calls.some(([s]) => /INSERT INTO hybrid_deploy_salt_counters/.test(s))).toBe(false)
      expect(calls.some(([s]) => /INSERT INTO smart_accounts/.test(s))).toBe(false)
    })

    it('refuses a different network with MERCHANT_ACCOUNT_ON_OTHER_NETWORK, never the key-reuse code', async () => {
      const calls = mockDb({ merchantAccount: { ...CREATED_ACCOUNT, chain_id: 8453 } })
      const res = await call('POST', '/merchant-services', TURN_ON)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        error_code: 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK',
        chain_id: 8453,
      })
      expect(res.json().error_code).not.toBe('IDEMPOTENCY_KEY_REUSED')
      expectMatchesSpec('POST', '/merchant-services', res.json(), '409')
      // The creation logic never ran, so no idempotency key was ever derived.
      expect(mockCompute).not.toHaveBeenCalled()
      expect(calls.some(([s]) => /create_idempotency_key = \$2/.test(s))).toBe(false)
    })

    it('refuses an unsupported network with UNSUPPORTED_NETWORK and creates nothing', async () => {
      const calls = mockDb({})
      const res = await call('POST', '/merchant-services', { ...TURN_ON, chain_id: 1 })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error_code: 'UNSUPPORTED_NETWORK' })
      expect(Array.isArray(res.json().supported)).toBe(true)
      expectMatchesSpec('POST', '/merchant-services', res.json(), '400')
      // The creation logic never ran and the setting was never enabled. That
      // the locked setting row rolls back is proven on the real database.
      expectNothingCreated(calls)
    })

    it.each([
      ['no body at all', undefined],
      ['an empty body', {}],
    ])('turning back on with %s answers the existing merchant account — 200, created false', async (_label, payload) => {
      const calls = mockDb({ merchantAccount: CREATED_ACCOUNT })
      const res = await call('POST', '/merchant-services', payload)

      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ enabled: true, created: false, merchant_account: CREATED_ACCOUNT })
      expectMatchesSpec('POST', '/merchant-services', res.json(), '200')
      expect(calls.some(([s]) => /SET enabled = true/.test(s))).toBe(true)
      expect(mockCompute).not.toHaveBeenCalled()
      expect(calls.some(([s]) => /INSERT INTO hybrid_deploy_salt_counters/.test(s))).toBe(false)
      expect(calls.some(([s]) => /INSERT INTO smart_accounts/.test(s))).toBe(false)
    })

    it('refuses a named network that differs from the merchant account\'s even when it is not a served one', async () => {
      const calls = mockDb({ merchantAccount: CREATED_ACCOUNT })
      const res = await call('POST', '/merchant-services', { chain_id: 1 })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK', chain_id: 84532 })
      expect(calls.some(([s]) => /SET enabled = true/.test(s))).toBe(false)
    })

    it.each([
      ['no body at all', undefined, ['chain_id', 'source_account_id', 'key_id']],
      ['an empty body', {}, ['chain_id', 'source_account_id', 'key_id']],
      ['no network', { source_account_id: SOURCE_ID, key_id: 'cred-1' }, ['chain_id']],
      ['no source account', { chain_id: 84532, key_id: 'cred-1' }, ['source_account_id']],
      ['no passkey id', { chain_id: 84532, source_account_id: SOURCE_ID }, ['key_id']],
    ])('the first turn-on with %s is refused with MERCHANT_SETUP_DETAILS_REQUIRED', async (_label, payload, missing) => {
      const calls = mockDb({})
      const res = await call('POST', '/merchant-services', payload)

      expect(res.statusCode, res.body).toBe(400)
      expect(res.json()).toMatchObject({ error_code: 'MERCHANT_SETUP_DETAILS_REQUIRED', missing })
      expectMatchesSpec('POST', '/merchant-services', res.json(), '400')
      expectNothingCreated(calls)
    })

    it('refuses a body that names an account to mark — the schema closes the body', async () => {
      const calls = mockDb({})
      const res = await call('POST', '/merchant-services', { ...TURN_ON, merchant_account_id: ACCOUNT_ID })

      expect(res.statusCode).toBe(400)
      expect(calls).toHaveLength(0)
    })

    it('refuses a body that names an account to mark under any other name', async () => {
      const calls = mockDb({})
      const res = await call('POST', '/merchant-services', { ...TURN_ON, account_id: ACCOUNT_ID })

      expect(res.statusCode).toBe(400)
      expect(calls).toHaveLength(0)
    })

    it('404s a source account the caller does not own, with SOURCE_ACCOUNT_NOT_FOUND', async () => {
      mockDb({ source: 'missing' })
      const res = await call('POST', '/merchant-services', TURN_ON)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ error_code: 'SOURCE_ACCOUNT_NOT_FOUND' })
      expectMatchesSpec('POST', '/merchant-services', res.json(), '404')
    })

    it('422s a source with no passkey, with SOURCE_HAS_NO_PASSKEY', async () => {
      mockDb({ sourcePasskeys: [] })
      const res = await call('POST', '/merchant-services', TURN_ON)
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error_code: 'SOURCE_HAS_NO_PASSKEY' })
      expectMatchesSpec('POST', '/merchant-services', res.json(), '422')
    })

    it('422s a key_id that is not on the source, with KEY_NOT_ON_SOURCE', async () => {
      mockDb({})
      const res = await call('POST', '/merchant-services', { ...TURN_ON, key_id: '0xother' })
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error_code: 'KEY_NOT_ON_SOURCE' })
    })

    it('422s at the per-network account cap, with ACCOUNT_CAP_REACHED', async () => {
      mockDb({ chainCount: '10' })
      const res = await call('POST', '/merchant-services', TURN_ON)
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error_code: 'ACCOUNT_CAP_REACHED', cap: 10, chain_id: 84532 })
    })

    it('names the two create-additional refusals that carry no code of their own', async () => {
      // 502: the address could not be derived.
      mockDb({})
      mockCompute.mockRejectedValue(new Error('rpc down'))
      const derive = await call('POST', '/merchant-services', TURN_ON)
      expect(derive.statusCode).toBe(502)
      expect(derive.json()).toMatchObject({
        error: 'Could not derive the account address',
        error_code: 'MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE',
      })
      expectMatchesSpec('POST', '/merchant-services', derive.json(), '502')

      // 409: the derived address is already one of the caller's accounts.
      mockCompute.mockResolvedValue(HYBRID)
      const calls = mockDb({ addressTaken: true })
      const taken = await call('POST', '/merchant-services', TURN_ON)
      expect(taken.statusCode).toBe(409)
      expect(taken.json()).toMatchObject({
        error: 'Account already registered',
        error_code: 'MERCHANT_ACCOUNT_ALREADY_REGISTERED',
      })
      expect(calls.some(([s]) => /SET is_merchant_account = true/.test(s))).toBe(false)
      expect(calls.some(([s]) => /SET enabled = true/.test(s))).toBe(false)
    })

    it('passes a create-additional refusal that HAS a code through unchanged', async () => {
      mockDb({ replay: { id: ACCOUNT_ID, account_address: HYBRID, chain_id: 8453, created_at: '2026-11-17T00:00:00Z' } })
      const res = await call('POST', '/merchant-services', TURN_ON)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'IDEMPOTENCY_KEY_REUSED' })
    })

    it('a retried turn-on answers the account the first attempt created — 200, created false', async () => {
      mockDb({
        replay: {
          id: ACCOUNT_ID,
          account_address: HYBRID,
          chain_id: 84532,
          created_at: '2026-11-17T00:00:00Z',
        },
      })
      const res = await call('POST', '/merchant-services', TURN_ON)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ enabled: true, created: false, merchant_account: { id: ACCOUNT_ID } })
      // The replay answered before the derivation ran.
      expect(mockCompute).not.toHaveBeenCalled()
    })
  })

  describe('turning off', () => {
    it('records the setting as off and keeps the account', async () => {
      const calls = mockDb({ merchantAccount: CREATED_ACCOUNT, setting: { enabled: true, enabled_at: '2026-11-17T00:00:00Z', disabled_at: null } })
      const res = await call('DELETE', '/merchant-services')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ enabled: false, merchant_account: { id: ACCOUNT_ID } })
      expectMatchesSpec('DELETE', '/merchant-services', res.json(), '200')
      // The account row is never deleted and the marker is never cleared.
      expect(calls.some(([s]) => /DELETE FROM smart_accounts/.test(s))).toBe(false)
      expect(calls.some(([s]) => /is_merchant_account = false/.test(s))).toBe(false)
    })

    it('is idempotent: turning off when it was never on answers the same body', async () => {
      mockDb({ merchantAccount: null, setting: null })
      const res = await call('DELETE', '/merchant-services')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ enabled: false, merchant_account: null })
    })
  })

  describe('the read', () => {
    it('returns the setting and the merchant account', async () => {
      mockDb({
        merchantAccount: CREATED_ACCOUNT,
        setting: { enabled: true, enabled_at: '2026-11-17T00:00:00Z', disabled_at: null },
      })
      const res = await call('GET', '/merchant-services')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        enabled: true,
        enabled_at: '2026-11-17T00:00:00Z',
        disabled_at: null,
        merchant_account: { id: ACCOUNT_ID, chain_id: 84532 },
      })
      expectMatchesSpec('GET', '/merchant-services', res.json(), '200')
    })

    it('answers enabled false and a null account for a user who never turned it on', async () => {
      mockDb({ merchantAccount: null, setting: null })
      const res = await call('GET', '/merchant-services')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        enabled: false,
        enabled_at: null,
        disabled_at: null,
        merchant_account: null,
      })
    })

    it('scopes both reads to the caller', async () => {
      const calls = mockDb({ merchantAccount: CREATED_ACCOUNT, setting: { enabled: true, enabled_at: null, disabled_at: null } })
      await call('GET', '/merchant-services')
      const scoped = calls.filter(([s]) => /merchant_service_settings|is_merchant_account/.test(s))
      expect(scoped.length).toBeGreaterThan(0)
      for (const [, params] of scoped) expect(params[0]).toBe('user-1')
    })
  })
})

/**
 * The idempotency namespace (#4895): the turn-on route derives its keys in
 * `merchant-service:`, and the PUBLIC create-additional route refuses a
 * client-supplied key in that namespace. Without that refusal a user could
 * pre-create an account under the derived key and have the merchant marker
 * land on an account they chose.
 */
describe('the reserved merchant-service idempotency namespace (#4895)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/hybrid-accounts.ts'] })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(HYBRID)
  })

  it('refuses a client-supplied key in the reserved namespace, before the handler', async () => {
    const calls = mockDb({})
    const res = await app.inject({
      method: 'POST',
      url: '/accounts/hybrid',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        chain_id: 84532,
        source_account_id: SOURCE_ID,
        key_id: 'cred-1',
        idempotency_key: 'merchant-service:84532',
      },
    })
    expect(res.statusCode).toBe(400)
    // The SCHEMA's refusal, not the handler's: the handler answers
    // RESERVED_IDEMPOTENCY_KEY, and is proven separately below.
    expect(res.json()).toMatchObject({ error_code: 'invalid_request' })
    expect(calls).toHaveLength(0)
  })

  it('the handler refuses the reserved namespace too, with request validation off', async () => {
    // `HAVEN_REQUEST_VALIDATION=off|shadow` is a documented kill switch; the
    // schema refuses nothing there, so the namespace must not depend on it.
    const bare = Fastify({ logger: false })
    await bare.register(fastifyJwt, { secret: 'test-secret' })
    await bare.register(hybridAccountRoutes, { prefix: '/accounts' })
    try {
      const calls = mockDb({})
      for (const payload of [
        { chain_id: 84532, source_account_id: SOURCE_ID, key_id: 'cred-1', idempotency_key: 'merchant-service:84532' },
        // The signup shape stores the key too.
        {
          chain_id: 84532,
          passkeys: [{ key_id: 'cred-1', x: PASSKEY.public_key_x, y: PASSKEY.public_key_y }],
          idempotency_key: 'merchant-service:anything',
        },
      ]) {
        const res = await bare.inject({
          method: 'POST',
          url: '/accounts/hybrid',
          headers: { authorization: `Bearer ${bare.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })}` },
          payload,
        })
        expect(res.statusCode, res.body).toBe(400)
        expect(res.json()).toMatchObject({ error_code: 'RESERVED_IDEMPOTENCY_KEY' })
      }
      expect(calls.some(([s]) => /INSERT INTO smart_accounts/.test(s))).toBe(false)
      expect(mockCompute).not.toHaveBeenCalled()
    } finally {
      await bare.close()
    }
  })

  it('an empty key is still refused by the handler, with the sentence it always had', async () => {
    // The check moved into `idempotencyKeyRefusal` with the namespace check
    // (#4895); this pins that the move kept it.
    const bare = Fastify({ logger: false })
    await bare.register(fastifyJwt, { secret: 'test-secret' })
    await bare.register(hybridAccountRoutes, { prefix: '/accounts' })
    try {
      const calls = mockDb({})
      const res = await bare.inject({
        method: 'POST',
        url: '/accounts/hybrid',
        headers: { authorization: `Bearer ${bare.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })}` },
        payload: { chain_id: 84532, source_account_id: SOURCE_ID, key_id: 'cred-1', idempotency_key: '' },
      })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json()).toEqual({ error: 'idempotency_key must be a non-empty string' })
      expect(calls.some(([q]) => /INSERT INTO smart_accounts/.test(q))).toBe(false)
    } finally {
      await bare.close()
    }
  })

  it('still accepts an ordinary key — the refusal is the namespace, not idempotency keys', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST',
      url: '/accounts/hybrid',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        chain_id: 84532,
        source_account_id: SOURCE_ID,
        key_id: 'cred-1',
        idempotency_key: 'create-1',
      },
    })
    expect(res.statusCode, res.body).toBe(201)
  })
})
