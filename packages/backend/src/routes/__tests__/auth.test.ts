import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
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
        rows: [{ id: 'user-1', name: 'Ada Lovelace', email: 'test@example.com', created_at: new Date().toISOString() }],
      })

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { name: ' Ada Lovelace ', email: ' Test@Example.com ', password: 'password123' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.token).toBeDefined()
      expect(body.user.id).toBe('user-1')
      expect(body.user.name).toBe('Ada Lovelace')
      expect(body.user.email).toBe('test@example.com')
      expect(body.user.safes).toEqual([])
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
          id: 'user-1',
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
      expect(body.user.id).toBe('user-1')
      expect(body.user.name).toBe('Ada Lovelace')
      expect(body.user.email).toBe('test@example.com')
      expect(body.user.wallet_address).toBe('0x1234567890abcdef1234567890abcdef12345678')
      expect(body.user.safes).toEqual([])
      // password_hash should NOT be in the response
      expect(body.user.password_hash).toBeUndefined()
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
          id: 'user-1',
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
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'test@example.com',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: null,
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
      expect(body.id).toBe('user-1')
      expect(body.name).toBe('Ada Lovelace')
      expect(body.email).toBe('test@example.com')
      expect(body.safes).toEqual([])
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
