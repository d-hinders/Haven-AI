import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

// Mock the db module
const mockQuery = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import { buildApp } from '../../__tests__/helpers.js'

describe('User routes', () => {
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

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  // --- PUT /user/profile ---
  describe('PUT /user/profile', () => {
    it('updates the user name for valid input + valid JWT', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'test@example.com',
          wallet_address: null,
          safe_address: null,
          currency_preference: 'USD',
          created_at: '2025-01-01T00:00:00.000Z',
        }],
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/profile',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: ' Ada   Lovelace ' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe('user-1')
      expect(body.name).toBe('Ada Lovelace')
    })

    it('returns 400 for invalid name', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/profile',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Bad\nName' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Enter a name using 80 characters or fewer')
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/profile',
        payload: { name: 'Ada Lovelace' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })
  })

  // --- PUT /user/wallet ---
  describe('PUT /user/wallet', () => {
    it('returns updated user for valid address + valid JWT', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const walletAddress = '0x1234567890abcdef1234567890abcdef12345678'

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'test@example.com',
          wallet_address: walletAddress,
          safe_address: null,
        }],
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/wallet',
        headers: { authorization: `Bearer ${token}` },
        payload: { wallet_address: walletAddress },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe('user-1')
      expect(body.wallet_address).toBe(walletAddress)
    })

    it('returns 400 for invalid address', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/wallet',
        headers: { authorization: `Bearer ${token}` },
        payload: { wallet_address: 'not-a-valid-address' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid Ethereum address')
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/wallet',
        payload: { wallet_address: '0x1234567890abcdef1234567890abcdef12345678' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })
  })

  // --- PUT /user/safe ---
  describe('PUT /user/safe', () => {
    it('returns updated user for valid address + valid JWT', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const safeAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'test@example.com',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: safeAddress,
        }],
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: { authorization: `Bearer ${token}` },
        payload: { safe_address: safeAddress },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe('user-1')
      expect(body.safe_address).toBe(safeAddress)
    })

    it('returns 400 for invalid address', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: { authorization: `Bearer ${token}` },
        payload: { safe_address: '0xinvalid' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid Ethereum address')
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        payload: { safe_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })
  })
})
