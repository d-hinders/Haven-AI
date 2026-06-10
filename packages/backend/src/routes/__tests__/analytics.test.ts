import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

import analyticsRoutes from '../analytics.js'

describe('analytics routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(analyticsRoutes, { prefix: '/analytics' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/analytics/funnel' })
    expect(res.statusCode).toBe(401)
  })

  it('returns funnel steps and medianTtfpMs for a date range', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { event: 'signed_up', users: '100' },
          { event: 'safe_deployed', users: '80' },
          { event: 'agent_created', users: '60' },
          { event: 'allowance_granted', users: '55' },
          { event: 'safe_funded', users: '40' },
          { event: 'first_payment_settled', users: '20' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ median_ms: '120000' }] })

    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/funnel?from=2026-01-01&to=2026-07-01',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.steps).toHaveLength(7)
    expect(body.medianTtfpMs).toBe(120000)
    expect(body.from).toContain('2026-01-01')
    expect(body.to).toContain('2026-07-01')

    // signed_up step has no conversionFromPrev
    expect(body.steps[0]).toMatchObject({ event: 'signed_up', users: 100, conversionFromPrev: null })
    // safe_deployed: 80/100 = 80%
    expect(body.steps[1]).toMatchObject({ event: 'safe_deployed', users: 80, conversionFromPrev: 80 })
  })

  it('defaults to last 30 days when no dates provided', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ median_ms: null }] })

    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/funnel',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().medianTtfpMs).toBeNull()
  })

  it('returns 400 for invalid dates', async () => {
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const bad = await app.inject({
      method: 'GET',
      url: '/analytics/funnel?from=not-a-date',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('returns 400 when from >= to', async () => {
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const bad = await app.inject({
      method: 'GET',
      url: '/analytics/funnel?from=2026-07-01&to=2026-01-01',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bad.statusCode).toBe(400)
  })
})
