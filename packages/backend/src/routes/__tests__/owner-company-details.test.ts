/**
 * Real-Postgres route tests for owner company details (#3332).
 *
 *  - the flag: OFF answers 404 on every route in the module, on;
 *  - an agent API key is refused with a NAMED 403, never the generic 401;
 *  - the CRUD contract: GET 404 with nothing saved, PUT validates and
 *    upserts, DELETE is idempotent-looking (`{ ok: true }` whether or not a
 *    row existed);
 *  - the VIES transition: a fresh VAT number goes `pending`; the same VAT
 *    number on a later PUT does not re-flip an already-resolved status;
 *  - every 200 matches the OpenAPI spec.
 */
import Fastify, { FastifyError, FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { config } from '../../config.js'
import * as viesClient from '../../modules/owner-profile/vies-client.js'

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ocd-route-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

describeDb('owner company details routes (#3332)', () => {
  let app: FastifyInstance

  const originalFlag = config.ownerCompanyDetailsEnabled

  beforeAll(async () => {
    await initDbHarness()
    // Never let a route test call the real VIES endpoint.
    vi.spyOn(viesClient, 'checkVatWithVies').mockResolvedValue({ status: 'valid', reason: 'VALID' })

    app = Fastify({ logger: false })
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      void reply.status(error.statusCode ?? 500).send({ error: error.message })
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, {
      mode: 'off',
      enforcedModules: ['routes/owner-company-details.ts'],
    })
    const ownerCompanyDetailsRoutes = (await import('../owner-company-details.js')).default
    await app.register(ownerCompanyDetailsRoutes, { prefix: '/user' })
    await app.ready()
  })

  afterEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
    vi.restoreAllMocks()
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = originalFlag
  })

  function auth(userId: string): { headers: { authorization: string } } {
    const token = app.jwt.sign({ sub: userId, email: 'ocd@test.example' })
    return { headers: { authorization: `Bearer ${token}` } }
  }

  const VALID_BODY = { legal_name: 'Acme AB', country: 'SE', org_number: '556677-8899' }

  describe('the flag', () => {
    it('answers 404 on GET/PUT/POST when off, even for a signed-in owner — DELETE is the deliberate exception', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const userId = await seedUser()
      const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
      expect(get.statusCode).toBe(404)
      const put = await app.inject({ method: 'PUT', url: '/user/company-details', ...auth(userId), payload: VALID_BODY })
      expect(put.statusCode).toBe(404)
      const recheck = await app.inject({ method: 'POST', url: '/user/company-details/vies-check', ...auth(userId) })
      expect(recheck.statusCode).toBe(404)
      // DELETE (#3332 review, owner-privacy default): erasure works
      // regardless of the flag, so an owner is never trapped with saved
      // details behind a flag an operator later turned off.
      const del = await app.inject({ method: 'DELETE', url: '/user/company-details', ...auth(userId) })
      expect(del.statusCode).toBe(200)
      expect(del.json()).toEqual({ ok: true })
    })

    it('DELETE erases a row that was saved while the flag was on, even after the flag is turned off', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const userId = await seedUser()
      await app.inject({ method: 'PUT', url: '/user/company-details', ...auth(userId), payload: VALID_BODY })
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const del = await app.inject({ method: 'DELETE', url: '/user/company-details', ...auth(userId) })
      expect(del.statusCode).toBe(200)
      expect(del.json()).toEqual({ ok: true })
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
      expect(get.statusCode).toBe(404)
    })

    it('DELETE still refuses an agent API key even with the flag off', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const res = await app.inject({
        method: 'DELETE',
        url: '/user/company-details',
        headers: { authorization: 'Bearer sk_agent_whatever' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('serves the routes normally once on', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const userId = await seedUser()
      const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
      // Not 404-for-the-flag: 404 because nothing is saved yet.
      expect(get.statusCode).toBe(404)
      expect(get.json()).not.toEqual({ error: 'Not found' })
    })
  })

  describe('agent-key refusal', () => {
    it('names a 403 for an agent API key, not the generic 401', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const res = await app.inject({
        method: 'GET',
        url: '/user/company-details',
        headers: { authorization: 'Bearer sk_agent_whatever' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: expect.stringContaining('Agent API keys') })
    })

    it('also catches the X-API-Key header form', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const res = await app.inject({
        method: 'GET',
        url: '/user/company-details',
        headers: { 'x-api-key': 'sk_agent_whatever' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('an unauthenticated request still gets the generic 401', async () => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const res = await app.inject({ method: 'GET', url: '/user/company-details' })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('CRUD', () => {
    beforeEach(() => {
      (config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
    })

    it('PUT creates, GET reads it back, matching the spec', async () => {
      const userId = await seedUser()
      const put = await app.inject({ method: 'PUT', url: '/user/company-details', ...auth(userId), payload: VALID_BODY })
      expect(put.statusCode).toBe(200)
      expect(put.json()).toMatchObject({ legal_name: 'Acme AB', country: 'SE', org_number: '556677-8899', vat_number: null, vies_status: null })
      expectMatchesSpec('PUT', '/user/company-details', put.json())

      const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
      expect(get.statusCode).toBe(200)
      expect(get.json()).toMatchObject({ legal_name: 'Acme AB' })
      expectMatchesSpec('GET', '/user/company-details', get.json())
    })

    it('rejects a malformed body with 400 and writes nothing', async () => {
      const userId = await seedUser()
      const put = await app.inject({
        method: 'PUT',
        url: '/user/company-details',
        ...auth(userId),
        payload: { ...VALID_BODY, legal_name: '   ' },
      })
      expect(put.statusCode).toBe(400)
      const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
      expect(get.statusCode).toBe(404)
    })

    it('setting a VAT number moves vies_status to pending immediately, then resolves', async () => {
      const userId = await seedUser()
      const put = await app.inject({
        method: 'PUT',
        url: '/user/company-details',
        ...auth(userId),
        payload: { ...VALID_BODY, vat_number: 'se 556677889901' },
      })
      expect(put.statusCode).toBe(200)
      expect(put.json()).toMatchObject({ vat_number: 'SE556677889901', vies_status: 'pending' })

      // The async check is fire-and-forget; wait for it to land.
      await vi.waitFor(async () => {
        const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
        expect(get.json()).toMatchObject({ vies_status: 'valid' })
      })
    })

    it('re-submitting the SAME VAT number does not re-flip an already-resolved status', async () => {
      const userId = await seedUser()
      await app.inject({
        method: 'PUT',
        url: '/user/company-details',
        ...auth(userId),
        payload: { ...VALID_BODY, vat_number: 'SE556677889901' },
      })
      await vi.waitFor(async () => {
        const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
        expect(get.json()).toMatchObject({ vies_status: 'valid' })
      })

      const secondPut = await app.inject({
        method: 'PUT',
        url: '/user/company-details',
        ...auth(userId),
        payload: { ...VALID_BODY, legal_name: 'Acme AB Updated', vat_number: 'SE556677889901' },
      })
      expect(secondPut.statusCode).toBe(200)
      expect(secondPut.json()).toMatchObject({ legal_name: 'Acme AB Updated', vies_status: 'valid' })
    })

    it('DELETE is idempotent-looking: { ok: true } whether or not a row existed', async () => {
      const userId = await seedUser()
      const first = await app.inject({ method: 'DELETE', url: '/user/company-details', ...auth(userId) })
      expect(first.statusCode).toBe(200)
      expect(first.json()).toEqual({ ok: true })

      await app.inject({ method: 'PUT', url: '/user/company-details', ...auth(userId), payload: VALID_BODY })
      const second = await app.inject({ method: 'DELETE', url: '/user/company-details', ...auth(userId) })
      expect(second.statusCode).toBe(200)
      expect(second.json()).toEqual({ ok: true })
      const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
      expect(get.statusCode).toBe(404)
    })

    it('POST vies-check 404s when there is no VAT number saved', async () => {
      const userId = await seedUser()
      await app.inject({ method: 'PUT', url: '/user/company-details', ...auth(userId), payload: VALID_BODY })
      const recheck = await app.inject({ method: 'POST', url: '/user/company-details/vies-check', ...auth(userId) })
      expect(recheck.statusCode).toBe(404)
    })

    it('POST vies-check re-runs the check and reflects pending immediately', async () => {
      const userId = await seedUser()
      await app.inject({
        method: 'PUT',
        url: '/user/company-details',
        ...auth(userId),
        payload: { ...VALID_BODY, vat_number: 'SE556677889901' },
      })
      await vi.waitFor(async () => {
        const get = await app.inject({ method: 'GET', url: '/user/company-details', ...auth(userId) })
        expect(get.json()).toMatchObject({ vies_status: 'valid' })
      })

      const recheck = await app.inject({ method: 'POST', url: '/user/company-details/vies-check', ...auth(userId) })
      expect(recheck.statusCode).toBe(200)
      expect(recheck.json()).toMatchObject({ vies_status: 'pending' })
      expectMatchesSpec('POST', '/user/company-details/vies-check', recheck.json())
    })
  })
})
