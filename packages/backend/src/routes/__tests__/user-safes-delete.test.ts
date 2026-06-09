import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPoolQuery, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    }),
  },
}))

// Avoid pulling chain/ethers deploy machinery into this route test.
vi.mock('../../lib/safe-deployer.js', () => ({ relaySafeDeploy: vi.fn() }))

import userSafesRoutes from '../user-safes.js'

const SAFE_ID = '11111111-1111-1111-1111-111111111111'

describe('DELETE /user/safes/:safeId', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockClientQuery.mockReset()
    mockRelease.mockReset()
  })

  it('orphans leftover self-sign agents so an old Safe with self-sign rows can be deleted', async () => {
    // Ownership check: a non-default Safe that belongs to the user.
    mockPoolQuery.mockResolvedValue({ rows: [{ id: SAFE_ID, is_default: false }] })
    // Every transactional statement succeeds.
    mockClientQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: 'DELETE',
      url: `/user/safes/${SAFE_ID}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true })

    const sqls = mockClientQuery.mock.calls.map(([sql]) => String(sql))
    const selfSignIdx = sqls.findIndex((s) => /UPDATE\s+self_sign_agents\s+SET\s+safe_id\s*=\s*NULL/i.test(s))
    const deleteIdx = sqls.findIndex((s) => /DELETE\s+FROM\s+user_safes/i.test(s))

    // The self-sign orphan must run, and must run before the Safe is deleted —
    // otherwise its RESTRICT foreign key would block the delete.
    expect(selfSignIdx).not.toBe(-1)
    expect(deleteIdx).not.toBe(-1)
    expect(selfSignIdx).toBeLessThan(deleteIdx)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('returns 404 when the Safe does not belong to the user', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: 'DELETE',
      url: `/user/safes/${SAFE_ID}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(404)
    // No transaction should have started.
    expect(mockClientQuery).not.toHaveBeenCalled()
  })
})
