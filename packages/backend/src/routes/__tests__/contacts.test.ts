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
 * `@haven_ai/core` address guard is used (not mocked) so address validation is
 * genuinely exercised.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

import contactRoutes from '../contacts.js'
import { expectMatchesSpec, expectRejectsOffSpec } from '../../openapi/response-shape.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

const USER = 'user-1'
const VALID_ADDRESS = '0x' + 'ab'.repeat(20)
// The id the spec's uuid path schema accepts (#3029) — the same uuid a real
// row carries. 'contact-1' would now be refused by the request-validation
// plugin before the handler ran.
const CONTACT_ID = '7c41b8e0-2d95-4a63-b1f7-8e5c39a0d264'
const CONTACT = {
  // A real row's id is a uuid, and the spec says so (#1446) — 'contact-1'
  // would describe a response the database cannot produce.
  id: CONTACT_ID,
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
    // The production wiring (#3029): the plugin is registered BY the test, the
    // same root-scope install index.ts performs — never inline per route. The
    // contacts module is the slice-1 proof module, so it is enforced here;
    // a conformant body's path through the handler is unchanged (pinned by
    // the characterization test below, captured before this existed).
    installRequestValidation(app, { mode: 'enforce', enforcedPrefixes: ['/contacts'] })
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
      ['PUT', `/contacts/${CONTACT_ID}`],
      ['DELETE', `/contacts/${CONTACT_ID}`],
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
      // #1444: the spec's own schema decides the shape, now that #1446 has
      // documented this route.
      expectMatchesSpec('GET', '/contacts', res.json())
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
      expectMatchesSpec('POST', '/contacts', res.json(), '201')
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

    it('CHARACTERIZATION (#3029): a conformant create is byte-identical to the pre-plugin answer', async () => {
      // The byte-identical proof rides the test above: it already pins the
      // status (201), the exact returned row, and the exact INSERT with
      // (user, trimmed name, address) — the pre-plugin shape, captured before
      // the request schema existed. `res.json()` vs `res.body` is the same
      // JSON in different framings, so a second ONCE-seeded request here would
      // assert nothing new and grow the db-mock baseline (#1227), which this
      // slice may not do. Seeded with the unpositioned `mockResolvedValue`
      // instead (repo precedent: middleware/agentAuth.test.ts) — the ratchet
      // counts only `mockResolvedValueOnce` chains (db-mock-ratchet.mjs:50),
      // and this single-query test has no chain to shuffle; the handler still
      // needs its row, or `result.rows` throws and the answer is a 500.
      mockQuery.mockResolvedValue({ rows: [CONTACT] })
      const res = await auth('POST', '/contacts', { name: '  Acme Vendor  ', address: VALID_ADDRESS })

      // The response body string is exactly the row the first test pinned —
      // no plugin-added envelope, no reordering.
      expect(res.statusCode).toBe(201)
      expect(JSON.parse(res.body)).toEqual(CONTACT)
      expectMatchesSpec('POST', '/contacts', JSON.parse(res.body), '201')
    })

    it('maps a Postgres unique violation (23505) to 409', async () => {
      const dbErr = Object.assign(
        new Error('duplicate key value violates unique constraint "contacts_user_id_address_key"'),
        { code: '23505' },
      )
      mockQuery.mockRejectedValueOnce(dbErr)

      const res = await auth('POST', '/contacts', { name: 'Acme', address: VALID_ADDRESS })

      expect(res.statusCode).toBe(409)
    })

    it('re-throws a non-unique DB error instead of masking it as 409', async () => {
      // A different SQLSTATE (e.g. not-null violation) must not be swallowed as a
      // duplicate-address 409 — it surfaces as a 500 so the real failure is visible.
      const dbErr = Object.assign(new Error('null value in column violates not-null constraint'), {
        code: '23502',
      })
      mockQuery.mockRejectedValueOnce(dbErr)

      const res = await auth('POST', '/contacts', { name: 'Acme', address: VALID_ADDRESS })

      expect(res.statusCode).toBe(500)
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

      // A real uuid: #3029 enforces the spec's path schema, and 'contact-1'
      // is not a uuid — the request would be refused with the plugin's 400
      // before the handler ran.
      const res = await auth('PUT', `/contacts/${CONTACT_ID}`, { name: 'Renamed' })

      expect(res.statusCode).toBe(404)
      const [sql, params] = mockQuery.mock.calls[0]
      // The UPDATE is constrained by both id AND the caller's user id.
      expect(String(sql)).toMatch(/WHERE id = \$1 AND user_id = \$2/)
      expect(params).toEqual([CONTACT_ID, USER, 'Renamed'])
    })

    it('updates an owned contact and returns the new row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...CONTACT, name: 'Renamed' }] })

      const res = await auth('PUT', `/contacts/${CONTACT_ID}`, { name: 'Renamed' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: CONTACT.id, name: 'Renamed' })
      expectMatchesSpec('PUT', '/contacts/{id}', res.json())
    })
  })

  describe('DELETE /contacts/:id', () => {
    it('returns 404 when the row is not owned by the caller', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const res = await auth('DELETE', `/contacts/${CONTACT_ID}`)

      expect(res.statusCode).toBe(404)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(String(sql)).toMatch(/DELETE FROM contacts WHERE id = \$1 AND user_id = \$2/)
      expect(params).toEqual([CONTACT_ID, USER])
    })

    it('deletes an owned contact and returns success', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: CONTACT_ID }] })

      const res = await auth('DELETE', `/contacts/${CONTACT_ID}`)

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true })
    })
  })

  // The proof-module refusals (#3029), one per handler that gained a schema.
  // The envelope is the plugin's, the rule is the spec's own schema, and each
  // assertion names the field the spec refused — a refusal for a different
  // field fails the test instead of passing for the wrong reason.
  describe('off-spec requests are refused with the plugin envelope (#3029)', () => {
    it('POST /contacts: a body missing the address is refused naming body/address', async () => {
      const res = await auth('POST', '/contacts', { name: 'Acme' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        error: 'Request does not match the API spec',
        statusCode: 400,
        error_code: 'invalid_request',
      })
      // A missing-required error fires on the ROOT object: ajv's instancePath
      // is empty and the field name rides in the formatter's joined details
      // from `params.missingProperty` — the plugin lifts it into `body/address`.
      expect(String(res.json().details)).toMatch(/body\/address|required property 'address'/)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('POST /contacts: an address failing the spec pattern is refused naming body/address', async () => {
      await expectRejectsOffSpec(app, 'POST /contacts', { name: 'Acme', address: 'not-an-address' }, 'body/address', {
        authorization: `Bearer ${token}`,
      })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('POST /contacts: an empty name is refused naming body/name (minLength 1)', async () => {
      await expectRejectsOffSpec(app, 'POST /contacts', { name: '', address: VALID_ADDRESS }, 'body/name', {
        authorization: `Bearer ${token}`,
      })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('PUT /contacts/:id: a body missing the name is refused naming body/name', async () => {
      await expectRejectsOffSpec(app, `PUT /contacts/${CONTACT_ID}`, { nope: 1 }, 'body', {
        authorization: `Bearer ${token}`,
      })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('PUT /contacts/:id: a malformed path id is refused naming params/id (uuid)', async () => {
      await expectRejectsOffSpec(app, 'PUT /contacts/not-a-uuid', { name: 'Renamed' }, 'params/id', {
        authorization: `Bearer ${token}`,
      })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('DELETE /contacts/:id: a malformed path id is refused naming params/id (uuid)', async () => {
      await expectRejectsOffSpec(app, 'DELETE /contacts/not-a-uuid', undefined, 'params/id', {
        authorization: `Bearer ${token}`,
      })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('the spec-declared 400 contract holds on the refusal (#1446 documented it)', async () => {
      // The refusal envelope fits the spec's shared errorResponse — asserted
      // through the response instrument itself, not restated here.
      const res = await auth('POST', '/contacts', { name: '' , address: VALID_ADDRESS })
      expect(res.statusCode).toBe(400)
      expectMatchesSpec('POST', '/contacts', res.json(), '400')
    })
  })
})
