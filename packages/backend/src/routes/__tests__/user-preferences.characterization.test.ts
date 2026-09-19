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
      // The executed statement, not just its params (#1208): the read must be
      // the preference lookup scoped by id — a different SELECT with the same
      // bind shape would satisfy the params assertion alone.
      expect(String(mockQuery.mock.calls[0][0])).toMatch(
        /SELECT currency_preference FROM users WHERE id = \$1/,
      )
    })

    it('falls back to SEK when the user row has no preference', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ currency_preference: null }] })

      const response = await app.inject({
        method: 'GET',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      // #3127: the fallback MOVED from USD to SEK — deliberately. SEK is the
      // currency the transaction feed has always served and still serves by
      // default (domain/transaction-currency.ts), so the preference endpoint
      // and the feed must answer a no-preference user the same currency. The
      // characterization this test keeps is the fallback SHAPE: a null column
      // and a missing row fall back identically, never 500 and never null.
      expect(response.json()).toEqual({ currency_preference: 'SEK' })
    })

    it('falls back to SEK when no user row comes back at all', async () => {
      // The `?? 'SEK'` guard on an EMPTY result set — the case a repository
      // that returns null for "no rows" must keep answering identically.
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const response = await app.inject({
        method: 'GET',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ currency_preference: 'SEK' })
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
      // The write must be an UPDATE scoped to the authenticated user (#1208) —
      // without pinning the statement, echoing the mock back proves only that
      // the mock echoes.
      expect(String(mockQuery.mock.calls[0][0])).toMatch(/UPDATE users\b/)
      expect(String(mockQuery.mock.calls[0][0])).toMatch(/WHERE id = \$2/)
    })

    it('accepts each offered currency and writes it — EUR, USD, SEK (#3127)', async () => {
      // One row per offered currency, EUR first (the original pair), SEK last:
      // SEK was refused before #3127 while the feed served SEK to every user —
      // the one currency no one could select. Each iteration queues its own
      // single-row reply and indexes the call THIS inject produced.
      for (const currency of ['EUR', 'USD', 'SEK']) {
        const before = mockQuery.mock.calls.length
        mockQuery.mockResolvedValueOnce({ rows: [{ currency_preference: currency }] })

        const response = await app.inject({
          method: 'PUT',
          url: '/user/preferences',
          headers: { authorization: `Bearer ${token}` },
          payload: { currency_preference: currency },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ currency_preference: currency })
        // Was a pure echo (#1208): with no params assertion, a route that
        // hardcoded 'EUR' into the write — or wrote nothing the mock could
        // see — still returned whatever the mock said. Pin what was WRITTEN,
        // and that the write is a user-scoped UPDATE, for every offered
        // currency.
        expect(mockQuery.mock.calls[before][1]).toEqual([currency, 'user-1'])
        expect(String(mockQuery.mock.calls[before][0])).toMatch(/UPDATE users\b/)
      }
    })

    it('rejects an unsupported currency without touching the database', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/preferences',
        headers: { authorization: `Bearer ${token}` },
        // GBP is captured in the book-time rate map but deliberately NOT
        // offered as a preference (#3127) — widening the offered set is a
        // product decision, not a loop unroll over ledger currencies.
        payload: { currency_preference: 'GBP' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid currency. Must be SEK, USD, EUR.')
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
