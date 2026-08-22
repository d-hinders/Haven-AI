/**
 * The full chain: @fastify/rate-limit → SharedRateLimitStore → real Postgres
 * (#1680 follow-up).
 *
 * The unit suites prove each link — the repository against the real database,
 * the store's degraded paths against stubs — but nothing proved the WIRING:
 * that the plugin constructs the store, builds a per-route child with that
 * route's ceiling, and calls incr with the two-argument (key, callback) shape
 * the store must serve from its own config. That gap is exactly where a
 * plugin upgrade would break things silently, and it is where the dev
 * deployment's behaviour had to be diagnosed by probing instead of by a test.
 */
import { afterAll, beforeEach, expect, it } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { SharedRateLimitStore } from '../shared-rate-limit-store.js'

/**
 * The production store, with the degradation deadline widened for THIS suite.
 *
 * The 250 ms production deadline is a fail-open bound: under a slow database
 * the store deliberately falls back to per-replica counting rather than hang
 * a request. Under a full parallel test run the local Postgres is exactly
 * that slow, so the production constant made this suite assert monotonicity
 * against a store that was CORRECTLY degrading — interleaved remaining
 * series, ~1-in-3 full-suite runs. The degraded paths have their own unit
 * suite; what THIS suite pins is the wiring when the database answers, so it
 * gets a deadline the loaded harness cannot trip.
 */
class PatientStore extends SharedRateLimitStore {
  constructor(options: ConstructorParameters<typeof SharedRateLimitStore>[0] = {}) {
    super({ ...options, deadlineMs: 30_000 })
  }
}

describeDb('rate-limit plugin + SharedRateLimitStore + real Postgres (#1680)', () => {
  let subject = 0

  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
    subject += 1
  })

  async function probeApp(max: number) {
    const app = Fastify({ logger: false })
    await app.register(rateLimit, {
      global: false,
      // A fixed key per test: what is under test is the counting, not the
      // key derivation (rateLimitKeyFor has its own suite).
      keyGenerator: () => `integ:${subject}`,
      store: PatientStore as never,
    })
    app.post('/probe', { config: { rateLimit: { max, timeWindow: '1 minute' } } }, async () => ({ ok: true }))
    return app
  }

  it('MUTATION PROOF: remaining falls MONOTONICALLY through the real plugin — one counter, not several', async () => {
    // This is the #1680 defect's exact observable, asserted end to end. The
    // interleaved-series failure (9 9 8 8 …) reappears here if the plugin
    // stops handing the store its child config, if the child loses the
    // ceiling, or if the store silently degrades to local counting.
    const app = await probeApp(10)

    const remaining: string[] = []
    const codes: number[] = []
    for (let i = 0; i < 13; i++) {
      const res = await app.inject({ method: 'POST', url: '/probe' })
      remaining.push(String(res.headers['x-ratelimit-remaining']))
      codes.push(res.statusCode)
    }

    expect(remaining.slice(0, 10)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0'])
    expect(codes.filter((c) => c === 429)).toHaveLength(3)
    await app.close()
  })

  it('TWO app instances share one count — the replica scenario, in miniature', async () => {
    // Two Fastify instances with separate store objects against one database
    // are exactly two replicas. Ten requests alternating between them must
    // yield ONE descending series and refuse the eleventh wherever it lands.
    const a = await probeApp(10)
    const b = await probeApp(10)

    const remaining: string[] = []
    for (let i = 0; i < 10; i++) {
      const app = i % 2 === 0 ? a : b
      const res = await app.inject({ method: 'POST', url: '/probe' })
      remaining.push(String(res.headers['x-ratelimit-remaining']))
    }
    expect(remaining).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0'])

    const eleventh = await (subject % 2 === 0 ? a : b).inject({ method: 'POST', url: '/probe' })
    expect(eleventh.statusCode).toBe(429)

    await a.close()
    await b.close()
  })

  it('the 429 body carries the plugin standard shape and a retry-after', async () => {
    const app = await probeApp(1)
    await app.inject({ method: 'POST', url: '/probe' })
    const limited = await app.inject({ method: 'POST', url: '/probe' })

    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    expect(limited.json()).toMatchObject({ statusCode: 429 })
    await app.close()
  })

  afterAll(async () => {
    await db.query('DELETE FROM rate_limit_counters').catch(() => {})
  })
})
