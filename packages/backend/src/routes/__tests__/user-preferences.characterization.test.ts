/**
 * Characterization tests for the two `/user/preferences` statements (#1167).
 *
 * `user.test.ts` covers profile / wallet / safe / owner-alias, but nothing
 * exercised the currency-preference read or write — the two `users` statements
 * about to move into `infra/repositories/users.ts`. These pin the behaviour
 * that the move must preserve, in particular the read's `?? 'USD'` fallback on
 * an empty result, which is exactly the shape a repository returning `null`
 * could silently change.
 *
 * Written against the UNCHANGED route and passing before the extraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../modules/accounts/index.js', () => ({
  getSafeDetails: vi.fn(),
}))

import { buildApp } from '../../__tests__/helpers.js'

describe('user preferences (characterization, #1167)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' }, { expiresIn: '1h' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  describe('GET /user/preferences', () => {
    it('returns the stored preference, scoped to the authenticated user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ currency_preference: 'EUR' }] })

      const response = await app.inject({
        method: 'GET',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ currency_preference: 'EUR' })
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-1'])
    })

    it('falls back to USD when the user row has no preference', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ currency_preference: null }] })

      const response = await app.inject({
        method: 'GET',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ currency_preference: 'USD' })
    })

    it('falls back to USD when no user row comes back at all', async () => {
      // The `?? 'USD'` guard on an EMPTY result set — the case a repository
      // that returns null for "no rows" must keep answering identically.
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const response = await app.inject({
        method: 'GET',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ currency_preference: 'USD' })
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/user/preferences' })

      expect(response.statusCode).toBe(401)
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })

  describe('PUT /user/preferences', () => {
    it('persists a valid currency and echoes the stored value', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ currency_preference: 'EUR' }] })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
        payload: { currency_preference: 'EUR' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ currency_preference: 'EUR' })
      expect(mockQuery.mock.calls[0][1]).toEqual(['EUR', 'user-1'])
    })

    it('accepts USD as well as EUR', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ currency_preference: 'USD' }] })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
        payload: { currency_preference: 'USD' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ currency_preference: 'USD' })
    })

    it('rejects an unsupported currency without touching the database', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
        payload: { currency_preference: 'SEK' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid currency. Must be USD or EUR.')
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('rejects a missing currency without touching the database', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })
})
