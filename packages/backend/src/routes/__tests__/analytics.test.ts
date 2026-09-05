import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

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
    expectMatchesSpec('GET', '/analytics/funnel', body)

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

  // ── #2529: the segmented read ────────────────────────────────────────────
  // Route-level wiring and refusal only. Every claim about what the SQL
  // RETURNS lives in the real-DB suite
  // (infra/repositories/__tests__/funnel-segments.test.ts), per the #1219 rule.
  //
  // These stub by DISPATCHING ON THE STATEMENT rather than with a positional
  // once-per-call chain. A positional chain encodes how many queries the
  // handler runs and in what order, so adding one re-shuffles every later arm
  // — the #775 failure mode the db-mock ratchet exists to stop, and the one
  // this PR's sibling (#2528) actually hit when a new SQL assignment shifted
  // two bind positions.
  //
  // (The literal name of that chained helper is deliberately not written
  // above: `scripts/db-mock-ratchet.mjs` counts occurrences with a regex over
  // the file, so even a mention of it in a comment reads as one more mock.)
  function stubFunnelQueries(segmentRows: Record<string, string>[] = []) {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes('attribution AS')) return Promise.resolve({ rows: segmentRows })
      if (text.includes('PERCENTILE_CONT')) return Promise.resolve({ rows: [{ median_ms: null }] })
      return Promise.resolve({ rows: [{ event: 'signed_up', users: '10' }] })
    })
  }

  it('refuses an unrecognised segment before it queries anything', async () => {
    stubFunnelQueries()
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/funnel?segment=handoff_via',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('via, run_mode')
    // The refusal has to precede the work, not follow it: a 400 that still ran
    // two aggregate scans is a free denial-of-service on a dashboard route.
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('omits segment and segments entirely when none was asked for', async () => {
    stubFunnelQueries()
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    const res = await app.inject({
      method: 'GET',
      url: '/analytics/funnel?from=2026-01-01&to=2026-07-01',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Absent keys, not null ones — an unsegmented body is byte-compatible with
    // every consumer that predates #2529.
    expect(body).not.toHaveProperty('segment')
    expect(body).not.toHaveProperty('segments')
    // And it never pays for the segment query it did not ask for.
    const ranSegmentQuery = mockQuery.mock.calls.some((c: unknown[]) =>
      String(c[0]).includes('attribution AS'),
    )
    expect(ranSegmentQuery).toBe(false)
  })

  it.each(['via', 'run_mode'] as const)(
    'returns grouped steps for segment=%s and echoes the dimension',
    async (segment) => {
      stubFunnelQueries([
        { value: 'agent', event: 'signed_up', users: '4' },
        { value: 'unattributed', event: 'signed_up', users: '6' },
      ])

      const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
      const res = await app.inject({
        method: 'GET',
        url: `/analytics/funnel?from=2026-01-01&to=2026-07-01&segment=${segment}`,
        headers: { authorization: `Bearer ${token}` },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.segment).toBe(segment)
      expect(body.segments.map((g: { value: string }) => g.value)).toEqual(['agent', 'unattributed'])
      // Each group carries the full funnel, not just the steps that had rows.
      expect(body.segments[0].steps).toHaveLength(7)
      // The groups still sum to the unsegmented count for the step.
      const total = body.segments.reduce(
        (n: number, g: { steps: { event: string; users: number }[] }) =>
          n + (g.steps.find((s) => s.event === 'signed_up')?.users ?? 0),
        0,
      )
      expect(total).toBe(body.steps.find((s: { event: string }) => s.event === 'signed_up').users)
      expectMatchesSpec('GET', '/analytics/funnel', body)
    },
  )

  it('binds the metadata key as a value, never interpolating it into the SQL', async () => {
    stubFunnelQueries()
    const token = app.jwt.sign({ sub: 'usr-1', email: 'u@test.dev' })
    await app.inject({
      method: 'GET',
      url: '/analytics/funnel?from=2026-01-01&to=2026-07-01&segment=via',
      headers: { authorization: `Bearer ${token}` },
    })

    const call = mockQuery.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('attribution AS'),
    )
    expect(call).toBeDefined()
    // `handoff_via` reaches Postgres as a bound parameter. If it ever appears
    // in the statement text instead, the key is being interpolated — which is
    // the shape that would let a future non-enum segment become an injection.
    expect(call![1]).toContain('handoff_via')
    expect(String(call![0])).not.toContain('handoff_via')
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
