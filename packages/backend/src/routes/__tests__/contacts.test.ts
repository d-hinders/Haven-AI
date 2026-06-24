import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Route-level invariants for the contacts address book.
 *
 * Pins the contract that matters for an address book wired into the send flow:
 * every endpoint is authenticated; reads and writes are scoped to the calling
 * user (a contact owned by someone else is a 404, never a cross-user mutation);
 * addresses are validated with the shared guard before any write; and the
 * documented status codes (201 / 400 / 404 / 409) hold. The real
 * `lib/address.ts` guard is used (not mocked) so address validation is
 * genuinely exercised.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

import contactRoutes from '../contacts.js'

const USER = 'user-1'
const VALID_ADDRESS = '0x' + 'ab'.repeat(20)
const CONTACT = {
  id: 'contact-1',
  name: 'Acme Vendor',
  address: VALID_ADDRESS,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
}

describe('contacts routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(contactRoutes, { prefix: '/contacts' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  function auth(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload })
  }

  describe('authentication', () => {
    const endpoints: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
      ['GET', '/contacts'],
      ['POST', '/contacts'],
      ['PUT', '/contacts/contact-1'],
      ['DELETE', '/contacts/contact-1'],
    ]

    for (const [method, url] of endpoints) {
      it(`${method} ${url} rejects unauthenticated requests`, async () => {
        const res = await app.inject({ method, url })
        expect(res.statusCode).toBe(401)
        // The auth hook short-circuits before any DB work.
        expect(mockQuery).not.toHaveBeenCalled()
      })
    }
  })

  describe('GET /contacts', () => {
    it('returns the caller\'s contacts scoped to their user id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [CONTACT] })

      const res = await auth('GET', '/contacts')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ contacts: [CONTACT] })
      const [sql, params] = mockQuery.mock.calls[0]
      expect(String(sql)).toMatch(/WHERE user_id = \$1/)
      expect(params).toEqual([USER])
    })
  })

  describe('POST /contacts', () => {
    it('creates a contact scoped to the caller and returns 201', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [CONTACT] })

      const res = await auth('POST', '/contacts', { name: '  Acme Vendor  ', address: VALID_ADDRESS })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual(CONTACT)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(String(sql)).toMatch(/INSERT INTO contacts/)
      // user id from the token, name trimmed, address as given.
      expect(params).toEqual([USER, 'Acme Vendor', VALID_ADDRESS])
    })

    it('rejects a blank name with 400 before any write', async () => {
      const res = await auth('POST', '/contacts', { name: '   ', address: VALID_ADDRESS })
      expect(res.statusCode).toBe(400)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('rejects an invalid address with 400 before any write', async () => {
      const res = await auth('POST', '/contacts', { name: 'Acme', address: '0xnope' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'Invalid Ethereum address' })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('maps a unique-violation to 409', async () => {
      mockQuery.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))

      const res = await auth('POST', '/contacts', { name: 'Acme', address: VALID_ADDRESS })

      expect(res.statusCode).toBe(409)
    })
  })

  describe('PUT /contacts/:id', () => {
    it('rejects a blank name with 400 before any write', async () => {
      const res = await auth('PUT', '/contacts/contact-1', { name: '  ' })
      expect(res.statusCode).toBe(400)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('returns 404 (not a cross-user write) when the row is not owned by the caller', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await auth('PUT', '/contacts/contact-1', { name: 'Renamed' })

      expect(res.statusCode).toBe(404)
      const [sql, params] = mockQuery.mock.calls[0]
      // The UPDATE is constrained by both id AND the caller's user id.
      expect(String(sql)).toMatch(/WHERE id = \$1 AND user_id = \$2/)
      expect(params).toEqual(['contact-1', USER, 'Renamed'])
    })

    it('updates an owned contact and returns the new row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...CONTACT, name: 'Renamed' }] })

      const res = await auth('PUT', '/contacts/contact-1', { name: 'Renamed' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: 'contact-1', name: 'Renamed' })
    })
  })

  describe('DELETE /contacts/:id', () => {
    it('returns 404 when the row is not owned by the caller', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await auth('DELETE', '/contacts/contact-1')

      expect(res.statusCode).toBe(404)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(String(sql)).toMatch(/DELETE FROM contacts WHERE id = \$1 AND user_id = \$2/)
      expect(params).toEqual(['contact-1', USER])
    })

    it('deletes an owned contact and returns success', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'contact-1' }] })

      const res = await auth('DELETE', '/contacts/contact-1')

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true })
    })
  })
})
