import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'

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
