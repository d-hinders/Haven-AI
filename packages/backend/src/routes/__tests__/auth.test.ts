import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'

/**
 * #1646: spy on the REAL bcrypt rather than replacing it. The property under
 * test is that the password comparison happens on both login paths; a stub
 * that never hashes could not distinguish a paid cost from a skipped one.
 */
const compareSpy = vi.fn()
vi.mock('bcrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcrypt')>()
  return {
    default: {
      ...actual,
      compare: (...args: Parameters<typeof actual.compare>) => {
        compareSpy(...args)
        return actual.compare(...args)
      },
    },
  }
})

// Mock the db module
const mockQuery = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import { buildApp } from '../../__tests__/helpers.js'

/** users.id is a UUID column; fixtures must look like one (#1446). */
const USER_UUID = '7a3c9e21-4b58-4d06-8f13-2e6a5c9d0b74'

describe('Auth routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  // --- POST /auth/signup ---
  describe('POST /auth/signup', () => {
    it('returns 201 with id and email on valid input', async () => {
      // First query: check existing user -> none found
      mockQuery.mockResolvedValueOnce({ rows: [] })
      // Second query: insert user
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: USER_UUID, name: 'Ada Lovelace', email: 'test@example.com', created_at: new Date().toISOString() }],
      })

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: ' Ada Lovelace ', email: ' Test@Example.com ', password: 'password123' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.token).toBeDefined()
      expect(body.user.id).toBe(USER_UUID)
      expect(body.user.name).toBe('Ada Lovelace')
      expect(body.user.email).toBe('test@example.com')
      expect(body.user.safes).toEqual([])
      expectMatchesSpec('POST', '/auth/signup', body, '201')
    })

    it('returns 400 for invalid name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Bad\nName', email: 'test@example.com', password: 'password123' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Enter a name using 80 characters or fewer')
    })

    it('returns 400 for missing email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada Lovelace', password: 'password123' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid email address')
    })

    it('returns 400 for invalid email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada Lovelace', email: 'not-an-email', password: 'password123' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid email address')
    })

    it('returns 400 for overlong email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          name: 'Ada Lovelace',
          email: `${'a'.repeat(245)}@example.com`,
          password: 'password123',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid email address')
    })

    it('returns 400 for short password (< 8 chars)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada Lovelace', email: 'test@example.com', password: 'short' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Password must be at least 8 characters')
    })

    it('returns 400 for overlong password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          name: 'Ada Lovelace',
          email: 'test@example.com',
          password: 'a'.repeat(129),
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Password must be 128 characters or fewer')
    })

    it('returns 409 when email already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] })

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada Lovelace', email: 'existing@example.com', password: 'password123' },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toBe('An account with this email already exists')
    })

    it('#1654: the 409 enumeration disclosure is ACCEPTED — and the reason is that 201 carries the token', async () => {
      // Signup answers 409 vs 201, so one unauthenticated request reveals
      // whether an address has an account. That is a documented, deliberate
      // tradeoff, not an oversight (#1654) — and this test pins the
      // structural fact the acceptance rests on: a successful signup returns
      // the SESSION TOKEN in the 201 body. Answering 201 for a taken address
      // would therefore either mint a token for someone else's account or
      // return a token-less 201 that is an equally strong oracle. If signup
      // ever stops returning the token (an email-verification flow), this
      // fails, which is the signal to revisit the acceptance in the same
      // change — the spec description says so too.
      mockQuery.mockImplementation(async (sql: string) => {
        if (/SELECT id FROM users/i.test(String(sql))) return { rows: [] }
        return {
          rows: [{ id: USER_UUID, name: 'Ada Lovelace', email: 'fresh@example.com' }],
        }
      })

      const created = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada Lovelace', email: 'fresh@example.com', password: 'password123' },
      })

      expect(created.statusCode).toBe(201)
      expect(typeof created.json().token).toBe('string')
      expect(created.json().token.length).toBeGreaterThan(0)
    })
  })

  // --- POST /auth/login ---
  describe('POST /auth/login', () => {
    const testPassword = 'password123'
    const testPasswordHash = bcrypt.hashSync(testPassword, 10)

    it('returns 200 with token and user on valid credentials', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: USER_UUID,
          name: 'Ada Lovelace',
          email: 'test@example.com',
          password_hash: testPasswordHash,
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: null,
        }],
      })
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'test@example.com', password: testPassword },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.token).toBeDefined()
      expect(typeof body.token).toBe('string')
      expect(body.user.id).toBe(USER_UUID)
      expect(body.user.name).toBe('Ada Lovelace')
      expect(body.user.email).toBe('test@example.com')
      expect(body.user.wallet_address).toBe('0x1234567890abcdef1234567890abcdef12345678')
      expect(body.user.safes).toEqual([])
      // password_hash should NOT be in the response
      expect(body.user.password_hash).toBeUndefined()
      expectMatchesSpec('POST', '/auth/login', body)
    })

    it('returns 401 for non-existent email', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.com', password: 'password123' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Invalid email or password')
    })

    it('#1646 MUTATION PROOF: an UNKNOWN email still runs the password comparison', async () => {
      // Login answers the same 401 for an unknown email and a wrong password
      // so it is not an account-enumeration oracle — true of the status and
      // body, and previously FALSE of the timing: bcrypt.compare at cost
      // factor 10 ran only when a row existed, so an unknown address returned
      // after one fast SELECT and latency alone disclosed what the identical
      // answer was hiding. Pinning the INVOCATION, not the clock: a latency
      // assertion tests the machine and flakes in CI.
      compareSpy.mockClear()
      // SQL-keyed, not a positional once-call (#1227's sanctioned form).
      mockQuery.mockImplementation(async () => ({ rows: [] }))

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.com', password: 'some-password' },
      })

      expect(response.statusCode).toBe(401)
      // Against the previous shape this is 0 — that IS the bug.
      expect(compareSpy).toHaveBeenCalledTimes(1)
      // And it must be a REAL hash at the SAME cost factor: a call count alone
      // would still pass if the absent-user hash were swapped for something
      // cheap, which would reopen a smaller version of the same gap.
      expect(compareSpy.mock.calls[0][1]).toMatch(/^\$2[aby]\$10\$/)
    })

    it('#1646: the absent-user hash can never match — it costs time, not security', async () => {
      // Whatever is presented against a missing account, the comparison fails:
      // the hash is of unguessable random bytes that are never stored.
      mockQuery.mockImplementation(async () => ({ rows: [] }))
      // (An EMPTY password never reaches the comparison — the shape check
      // answers 400 before the lookup, on both paths alike.)
      for (const attempt of ['admin', 'correct horse battery staple', 'x'.repeat(64)]) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'nobody@example.com', password: attempt },
        })
        expect(res.statusCode).toBe(401)
      }
    })

    it('returns 401 for wrong password', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: USER_UUID,
          name: null,
          email: 'test@example.com',
          password_hash: testPasswordHash,
          wallet_address: null,
          safe_address: null,
        }],
      })

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'test@example.com', password: 'wrongpassword' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Invalid email or password')
    })
  })

  // --- GET /auth/me ---
  describe('GET /auth/me', () => {
    function signToken(payload: { sub: string; email: string }): string {
      return app.jwt.sign(payload, { expiresIn: '1h' })
    }

    it('returns user data with valid JWT', async () => {
      const token = signToken({ sub: USER_UUID, email: 'test@example.com' })

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: USER_UUID,
          name: 'Ada Lovelace',
          email: 'test@example.com',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: null,
          // FIND_USER_PROFILE_BY_ID_SQL selects currency_preference too, so a
          // real row always carries it (#1446).
          currency_preference: 'USD',
          created_at: '2025-01-01T00:00:00.000Z',
        }],
      })
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe(USER_UUID)
      expect(body.name).toBe('Ada Lovelace')
      expect(body.email).toBe('test@example.com')
      expect(body.safes).toEqual([])
      expectMatchesSpec('GET', '/auth/me', body)
    })

    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })

    it('returns 401 with invalid token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: 'Bearer invalid.token.here' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })
  })
})

describe('safes payload carries the rail (#1069)', () => {
  it('the session safes SELECT includes account_type — the modal branches on it', async () => {
    // The #1069 fix originally landed in /user's SELECT — but AuthContext
    // reads /auth/me, so the Connect modal never saw account_type and
    // delegation accounts still dead-ended at the wallet approval. Pin the
    // field at the SOURCE the frontend actually consumes.
    //
    // This guard used to scan `auth.ts` for `SELECT … FROM user_safes`. #1180
    // moved that statement into the repository, which would have left the
    // scan matching NOTHING — a guard that silently policed an empty set. It
    // follows the SQL instead, and now asserts the constant directly rather
    // than a regex over a file's text.
    const { LIST_SESSION_SAFES_FOR_USER_SQL } = await import(
      '../../infra/repositories/user-safes.js'
    )
    expect(LIST_SESSION_SAFES_FOR_USER_SQL).toContain('account_type')
    expect(LIST_SESSION_SAFES_FOR_USER_SQL).toMatch(/FROM user_safes/)
  })

  it('both session endpoints use that one statement — neither can drift alone', async () => {
    // The original bug was two SELECTs disagreeing about one column. Rather
    // than re-check each call site's text, assert there is only one statement
    // left to get wrong: `auth.ts` holds no inline user_safes SQL at all.
    //
    // COUNTING, not `toContain` — the promotion-batch review proved the old
    // form was satisfied by the IMPORT LINE alone. Switching only /auth/me to
    // `listSafesForUser` (which omits account_type) reintroduced #1069 with
    // the whole suite green: login still mentioned the right function, so the
    // grep passed. Both endpoints must CALL it.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../auth.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/FROM user_safes/)

    const calls = src.match(/listSessionSafesForUser\(/g) ?? []
    expect(calls.length, 'both /auth/login and /auth/me must call it').toBe(2)

    // And no sibling projection may be reached from here: every other
    // user_safes list omits account_type, which is the field #1069 is about.
    expect(src).not.toMatch(/listSafesForUser\(|listSafesWithAccountTypeForUser\(/)
  })

  it('the session SELECT carries the signer-set inputs and both endpoints map them through the predicate (#1205)', async () => {
    // The recommendation's production origin: raw facts in the SQL, the
    // ANSWER computed by sessionSafePayload — chain classification stays in
    // exactly one place (modules/accounts/mainnet-gate.ts). Same #1069-class
    // guard shape: assert the statement, then count the mapping call sites.
    const { LIST_SESSION_SAFES_FOR_USER_SQL } = await import(
      '../../infra/repositories/user-safes.js'
    )
    expect(LIST_SESSION_SAFES_FOR_USER_SQL).toContain('owner_address')
    expect(LIST_SESSION_SAFES_FOR_USER_SQL).toContain('passkey_count')
    expect(LIST_SESSION_SAFES_FOR_USER_SQL).toMatch(/hybrid_account_passkeys/)

    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../auth.ts', import.meta.url), 'utf8')
    const mapped = src.match(/\.map\(sessionSafePayload\)/g) ?? []
    expect(mapped.length, 'both /auth/login and /auth/me must map through sessionSafePayload').toBe(2)
  })
})

/**
 * #1670: the auth rate-limit tier, in both of its states. Separate app
 * instances because the tier is decided at ROUTE REGISTRATION from the
 * trust-proxy setting — the property under test is precisely that the two
 * configurations register different routes.
 */
describe('auth rate limiting (#1670)', () => {
  async function buildRateLimitedApp(trustProxyHops: number): Promise<FastifyInstance> {
    const { default: Fastify } = await import('fastify')
    const { default: fastifyJwt } = await import('@fastify/jwt')
    const { default: rateLimitPlugin } = await import('@fastify/rate-limit')
    const { rateLimitKeyFor } = await import('../../middleware/rate-limit.js')
    const { default: routes } = await import('../auth.js')

    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // Mirrors index.ts: non-global, shared key generator.
    await app.register(rateLimitPlugin, {
      global: false,
      keyGenerator: (request: { headers: Record<string, string | string[] | undefined>; ip: string }) => rateLimitKeyFor(request),
    })
    await app.register(routes, { prefix: '/auth', trustProxyHops })
    return app
  }

  it('MUTATION PROOF: with a trusted proxy, the 11th signup from one address is 429', async () => {
    const app = await buildRateLimitedApp(1)
    // Free email on every probe — the enumeration shape the limit throttles.
    mockQuery.mockImplementation(async () => ({ rows: [] }))

    let limited = 0
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada', email: `probe-${i}@example.com`, password: 'password123' },
      })
      if (res.statusCode === 429) limited++
    }
    // 10/min for signup: requests 11 and 12 must be refused. Against a build
    // where the route never spreads the tier, this is 0 — that IS the bug.
    expect(limited).toBe(2)
    await app.close()
  })

  it('login has its own, looser ceiling (30/min)', async () => {
    const app = await buildRateLimitedApp(1)
    mockQuery.mockImplementation(async () => ({ rows: [] }))

    let limited = 0
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `probe-${i}@example.com`, password: 'x'.repeat(12) },
      })
      if (res.statusCode === 429) limited++
    }
    expect(limited).toBe(1)
    await app.close()
  })

  it('SELF-DISARMING: with no trusted proxy there is NO limit — a shared bucket would be a DoS, not a protection', async () => {
    // The property that makes shipping this safe before the operator flips
    // TRUST_PROXY_HOPS: ungated, every external caller behind the proxy is
    // one "IP", and a 10/min ceiling on that bucket lets a single attacker
    // lock every real user out of signup. So untrusted → unlimited, exactly
    // as before this tier existed.
    const app = await buildRateLimitedApp(0)
    mockQuery.mockImplementation(async () => ({ rows: [] }))

    for (let i = 0; i < 15; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: 'Ada', email: `probe-${i}@example.com`, password: 'password123' },
      })
      expect(res.statusCode).not.toBe(429)
    }
    await app.close()
  })
})
