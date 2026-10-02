import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'

/**
 * `POST /feedback` wired behind the REAL `@fastify/rate-limit` plugin
 * (round 2 review, S-b).
 *
 * `routes/__tests__/feedback.test.ts` proves routing and refusal with the
 * rate-limit tier entirely absent (no plugin registered, so `config.rateLimit`
 * is inert decoration). This file proves the thing S-b is actually about: the
 * key generator in `feedbackSubmitRateLimit` is reached ONLY after
 * `authMiddleware` has already verified `request.user`, so it is never
 * called for an unauthenticated request and never sees an undefined `sub` —
 * the one path that, before this fix, silently collapsed into a single
 * `feedback_user:unknown` bucket shared by every caller.
 */

const { mockInsertFeedback, mockIsKeyBackedAddress } = vi.hoisted(() => ({
  mockInsertFeedback: vi.fn(),
  mockIsKeyBackedAddress: vi.fn(),
}))
vi.mock('../../infra/repositories/feedback.js', () => ({
  insertFeedback: mockInsertFeedback,
  isKeyBackedAddress: mockIsKeyBackedAddress,
}))

import feedbackRoutes from '../feedback.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import * as rateLimitModule from '../../middleware/rate-limit.js'

const FEEDBACK_ROW = {
  id: 'f1',
  user_id: 'user-1',
  text: 'hello',
  created_at: '2026-10-02T00:00:00.000Z',
  expires_at: '2026-10-09T00:00:00.000Z',
}

describe('POST /feedback behind the real rate-limit plugin (#3597 S-b)', () => {
  let app: FastifyInstance
  let userToken: string
  let ownerCliToken: string
  // Spies on the LIVE key-generator function the route's own config object
  // holds — patched in place via `vi.spyOn`, so the spread
  // `routes/feedback.ts` performs when it registers the route (`config: {
  // ...feedbackSubmitRateLimit }`) copies the SPIED reference, not a stale
  // one captured before this ran.
  let keyGeneratorSpy: MockInstance<typeof rateLimitModule.feedbackSubmitRateLimit.rateLimit.keyGenerator>

  beforeAll(async () => {
    keyGeneratorSpy = vi.spyOn(rateLimitModule.feedbackSubmitRateLimit.rateLimit, 'keyGenerator')

    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // Real plugin, non-global — the exact wiring `index.ts` uses, minus the
    // Postgres-backed shared store (the default in-memory LRU is suffient
    // for a key-generator/header assertion and needs no database).
    await app.register(rateLimit, { global: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/feedback.ts'] })
    await app.register(feedbackRoutes, { prefix: '/feedback' })

    userToken = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
    ownerCliToken = app.jwt.sign(
      { sub: 'user-2', email: 'bob@example.com', purpose: 'owner_cli' } as unknown as {
        sub: string
        email: string
      },
    )
  })

  afterAll(async () => {
    await app.close()
    keyGeneratorSpy.mockRestore()
  })

  beforeEach(() => {
    mockInsertFeedback.mockReset().mockResolvedValue(FEEDBACK_ROW)
    mockIsKeyBackedAddress.mockReset()
  })

  afterEach(() => {
    keyGeneratorSpy.mockClear()
  })

  function post(payload: object, token?: string) {
    return app.inject({
      method: 'POST',
      url: '/feedback',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    })
  }

  it('an anonymous caller is refused 401 WITHOUT the key generator ever running', async () => {
    const res = await post({ text: 'hello' })
    expect(res.statusCode).toBe(401)
    expect(keyGeneratorSpy).not.toHaveBeenCalled()
  })

  it('a malformed bearer token is refused 401 WITHOUT the key generator ever running', async () => {
    const res = await post({ text: 'hello' }, 'not-a-real-jwt')
    expect(res.statusCode).toBe(401)
    expect(keyGeneratorSpy).not.toHaveBeenCalled()
  })

  it('a dashboard session succeeds, the key generator runs exactly once, and x-ratelimit-limit is 10', async () => {
    const res = await post({ text: 'hello' }, userToken)
    expect(res.statusCode).toBe(201)
    expect(res.headers['x-ratelimit-limit']).toBe('10')
    expect(keyGeneratorSpy).toHaveBeenCalledTimes(1)
  })

  it('an owner_cli (device-flow haven login) session reaches the handler — 201 (#3597 B1)', async () => {
    const res = await post({ text: 'hello' }, ownerCliToken)
    expect(res.statusCode).toBe(201)
    expect(keyGeneratorSpy).toHaveBeenCalledTimes(1)
  })

  it('every call the generator actually makes sees a DEFINED sub, never throws, and never falls back to "unknown"', async () => {
    await post({ text: 'hello' }, userToken)
    await post({ text: 'hello' }, ownerCliToken)

    expect(keyGeneratorSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [request] of keyGeneratorSpy.mock.calls) {
      const sub = (request as { user?: { sub?: unknown } }).user?.sub
      expect(typeof sub).toBe('string')
      expect((sub as string).length).toBeGreaterThan(0)
    }
    // No result is a thrown error — the generator never had to fail closed
    // in this run, because it was never reached without a verified sub.
    for (const result of keyGeneratorSpy.mock.results) {
      expect(result.type).toBe('return')
      expect(String(result.value)).not.toContain('unknown')
    }
  })

  it('MUTATION PROOF: the generator itself still fails closed if it is ever reached with no sub', () => {
    expect(() =>
      rateLimitModule.feedbackSubmitRateLimit.rateLimit.keyGenerator({ user: undefined }),
    ).toThrow(/request\.user\.sub is missing/)
    expect(() =>
      rateLimitModule.feedbackSubmitRateLimit.rateLimit.keyGenerator({ user: { sub: '' } }),
    ).toThrow(/request\.user\.sub is missing/)
  })
})
