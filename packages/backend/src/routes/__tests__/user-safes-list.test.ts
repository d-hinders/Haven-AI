import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Route-level invariants for `GET /user/safes` (the Safe list).
 *
 * The existing user-safes suites cover approvers and delete; the list endpoint
 * had no coverage. This pins the two things that matter for it: it requires
 * auth, and it returns only the *calling* user's Safes (the query is scoped to
 * the JWT subject, never a client-supplied id).
 */

const { mockPoolQuery } = vi.hoisted(() => ({ mockPoolQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

// Avoid pulling chain/ethers deploy machinery into this route test.
vi.mock('../../lib/safe-deployer.js', () => ({ relaySafeDeploy: vi.fn() }))

import userSafesRoutes from '../user-safes.js'

const USER = 'user-1'

describe('GET /user/safes — list invariants', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] })
  })

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/safes' })
    expect(res.statusCode).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns the caller-scoped Safes under a { safes } envelope', async () => {
    const rows = [
      { id: 's1', safe_address: '0xabc', chain_id: 8453, name: 'Main', is_default: true, created_at: '2026-01-01T00:00:00.000Z' },
    ]
    mockPoolQuery.mockResolvedValueOnce({ rows })

    const res = await app.inject({
      method: 'GET',
      url: '/user/safes',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ safes: rows })
    // Scoped by the JWT subject — never a client-supplied id.
    const [, params] = mockPoolQuery.mock.calls[0]
    expect(params).toEqual([USER])
  })

  it('scopes the query to the *calling* user, so one user cannot list another’s Safes', async () => {
    const otherToken = app.jwt.sign({ sub: 'user-2', email: 'grace@example.com' })
    const res = await app.inject({
      method: 'GET',
      url: '/user/safes',
      headers: { authorization: `Bearer ${otherToken}` },
    })

    expect(res.statusCode).toBe(200)
    const [, params] = mockPoolQuery.mock.calls[0]
    expect(params).toEqual(['user-2'])
  })
})
