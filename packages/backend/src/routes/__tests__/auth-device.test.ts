/**
 * The device-authorization routes (`/auth/device/*`, the CLI login flow)
 * under request validation (#3030, epic #3028 slice 2).
 *
 * Round 1 of PR #3207 found these four routes enforced with no route test at
 * all — the one enforced surface whose instrument was missing — and two
 * client-observable changes hiding behind that gap: `/device/start` declared
 * an OPTIONAL body the plugin could not honour (an absent body is not an
 * object → 400), and `client_label` over 80 characters was refused where the
 * handler had always truncated it, which would have failed `haven login` on a
 * host with a long hostname (the CLI sends `Haven CLI on ${hostname}`). The
 * spec now requires the body (the CLI always sends one) and states the
 * truncation instead of a `maxLength`; this file pins both, plus the shapes
 * the other three routes refuse before their handlers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const repo = vi.hoisted(() => ({
  createDeviceAuthorization: vi.fn(),
  approveDeviceAuthorization: vi.fn(),
  denyDeviceAuthorization: vi.fn(),
  findByDeviceCode: vi.fn(),
  findPendingByUserCode: vi.fn(),
  redeemDeviceAuthorization: vi.fn(),
  purgeExpired: vi.fn(async () => 0),
}))

vi.mock('../../infra/repositories/device-authorizations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/device-authorizations.js')>()
  return { ...actual, ...repo }
})
vi.mock('../../db.js', () => ({ default: { query: vi.fn(async () => ({ rows: [] })) } }))

import authRoutes from '../auth.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

const ENVELOPE = { error: 'Request does not match the API spec', statusCode: 400, error_code: 'invalid_request' }
// Control characters the handler strips: NUL and unit separator, spelled as
// escapes so the source file carries none.
const NUL = String.fromCharCode(0)
const US = String.fromCharCode(31)

describe('/auth/device/* under request validation (#3030)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // The production wiring: root-scope install, the module enforced.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/auth.ts'] })
    await app.register(authRoutes, { prefix: '/auth', trustProxyHops: 0 })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    repo.purgeExpired.mockResolvedValue(0)
    repo.createDeviceAuthorization.mockResolvedValue(undefined)
  })

  describe('POST /auth/device/start', () => {
    it('accepts the CLI shape and answers 201 with the codes', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/device/start', payload: { client_label: 'Haven CLI on macbook' } })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ interval: 5 })
      expect(typeof res.json().device_code).toBe('string')
      expect(repo.createDeviceAuthorization).toHaveBeenCalledWith(expect.objectContaining({ clientLabel: 'Haven CLI on macbook' }))
    })

    it('TRUNCATES a long label to 80 characters instead of refusing it — a long hostname must not fail `haven login`', async () => {
      // Mutation: put `maxLength: 80` back on the spec → 400 here.
      const label = 'Haven CLI on ' + 'h'.repeat(120)
      const res = await app.inject({ method: 'POST', url: '/auth/device/start', payload: { client_label: label } })
      expect(res.statusCode).toBe(201)
      expect(repo.createDeviceAuthorization).toHaveBeenCalledWith(expect.objectContaining({ clientLabel: label.slice(0, 80) }))
    })

    it('strips control characters from the label, and stores null for a blank or absent one', async () => {
      await app.inject({ method: 'POST', url: '/auth/device/start', payload: { client_label: `CLI${NUL} on${US} box` } })
      expect(repo.createDeviceAuthorization).toHaveBeenLastCalledWith(expect.objectContaining({ clientLabel: 'CLI on box' }))
      await app.inject({ method: 'POST', url: '/auth/device/start', payload: { client_label: '   ' } })
      expect(repo.createDeviceAuthorization).toHaveBeenLastCalledWith(expect.objectContaining({ clientLabel: null }))
      await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} })
      expect(repo.createDeviceAuthorization).toHaveBeenLastCalledWith(expect.objectContaining({ clientLabel: null }))
    })

    it('refuses a missing body with the envelope (the spec requires one since #3030), before any write', async () => {
      // Mutation: drop the module from enforcedModules → the handler throws
      // on `request.body.client_label` of undefined (500).
      const res = await app.inject({ method: 'POST', url: '/auth/device/start' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject(ENVELOPE)
      expect(repo.createDeviceAuthorization).not.toHaveBeenCalled()
    })

    it('refuses a non-string label with the envelope', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/device/start', payload: { client_label: { nested: true } } })
      expect(res.statusCode).toBe(400)
      expect(res.json().details).toContain('body/client_label')
      expect(repo.createDeviceAuthorization).not.toHaveBeenCalled()
    })
  })

  describe('POST /auth/device/lookup and /approve', () => {
    it("refuse a missing user_code with the envelope, before the repository; a blank one stays the handler's 400", async () => {
      for (const url of ['/auth/device/lookup', '/auth/device/approve']) {
        const missing = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: {} })
        expect(missing.statusCode, url).toBe(400)
        expect(missing.json(), url).toMatchObject(ENVELOPE)
        expect(missing.json().details, url).toContain('user_code')
        const blank = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: { user_code: '   ' } })
        expect(blank.statusCode, url).toBe(400)
        expect(blank.json(), url).toEqual({ error: 'user_code is required' })
      }
      expect(repo.findPendingByUserCode).not.toHaveBeenCalled()
      expect(repo.approveDeviceAuthorization).not.toHaveBeenCalled()
    })

    it('still authenticate first — anonymous is 401 before any 400, on both routes', async () => {
      // Mutation: either route's authMiddleware back to `preHandler` → 400.
      for (const url of ['/auth/device/lookup', '/auth/device/approve']) {
        const res = await app.inject({ method: 'POST', url, payload: {} })
        expect(res.statusCode, url).toBe(401)
      }
    })

    it('approve refuses a non-boolean deny with the envelope', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/device/approve', headers: { authorization: `Bearer ${token}` }, payload: { user_code: 'ABCD-EFGH', deny: 'sideways' } })
      expect(res.statusCode).toBe(400)
      expect(res.json().details).toContain('body/deny')
    })
  })

  describe('POST /auth/device/token', () => {
    it('refuses a missing device_code with the envelope; the OAuth-style handler codes are unchanged for a well-shaped one', async () => {
      const missing = await app.inject({ method: 'POST', url: '/auth/device/token', payload: {} })
      expect(missing.statusCode).toBe(400)
      expect(missing.json()).toMatchObject(ENVELOPE)
      expect(repo.findByDeviceCode).not.toHaveBeenCalled()

      repo.findByDeviceCode.mockResolvedValue(null)
      const unknown = await app.inject({ method: 'POST', url: '/auth/device/token', payload: { device_code: 'nope' } })
      expect(unknown.statusCode).toBe(400)
      expect(unknown.json()).toEqual({ error: 'expired_token' })

      repo.findByDeviceCode.mockResolvedValue({ status: 'pending' })
      const pending = await app.inject({ method: 'POST', url: '/auth/device/token', payload: { device_code: 'abc' } })
      expect(pending.json()).toEqual({ error: 'authorization_pending' })
    })
  })
})
