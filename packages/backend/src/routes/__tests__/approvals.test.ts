import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import approvalRoutes from '../approvals.js'

describe('approval routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(approvalRoutes, { prefix: '/approvals' })
    token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('marks an approved request as proposed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'approval-1' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-1/proposed',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: 'approval-1', status: 'proposed' })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'approved' AND expires_at > NOW()"),
      ['approval-1', 'user-1'],
    )
  })

  it('does not mark pending or expired requests as proposed', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-1/proposed',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: 'Approval request not found or no longer actionable',
    })
  })
})
