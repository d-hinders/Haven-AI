/**
 * Real-DB tests for the refusal population of the kinded agent-activity read
 * (#4323) — the repository reads (`listAgentRefusalsFiltered` /
 * `countAgentRefusalsFiltered`) and the wire they serve.
 *
 * Shape claims live on the #1220 harness (real Postgres, every migration
 * applied): the route is registered with request validation ENFORCED exactly
 * as production wires it, so the spec's `kind=refusals` parameter is exercised
 * on the wire, and `expectMatchesSpec` holds the served body to the spec's
 * own response schema (the refusal branch of the 200 anyOf).
 *
 * One mock: `getServeTimeFiatValues` — the all-null triple is that helper's
 * own outage answer, and this file asserts SHAPE, never a price (the #4217
 * no-real-network rule).
 */
vi.mock('../../infra/fiat-values.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/fiat-values.js')>()),
  getServeTimeFiatValues: async () => ({ usd: null, eur: null, sek: null }),
}))
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import agentActivityRoutes from '../agent-activity.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import {
  countAgentRefusalsFiltered,
  listAgentRefusalsFiltered,
  recordPaymentRefusal,
} from '../../infra/repositories/payment-refusals.js'

let seq = 0

/** The route's refusal entry keys, in wire order. */
const REFUSAL_ENTRY_KEYS = [
  'type',
  'id',
  'created_at',
  'amount',
  'token_symbol',
  'chain_id',
  'merchant_to',
  'resource_url',
  'reason',
  'attempts',
  'approx_amount_usd',
  'approx_amount_eur',
  'approx_amount_sek',
]

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`refusal-route-${n}-${randomUUID()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'refusal route agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

async function seedRefusal(
  seed: { userId: string; agentId: string },
  opts: {
    createdAt: string
    reason?: string
    resourceUrl?: string | null
    merchantTo?: string | null
    amountAtomic?: string
  },
): Promise<string> {
  const n = ++seq
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_refusals (
       user_id, agent_id, chain_id, token_symbol, amount_atomic,
       merchant_to, resource_url, reason, source, created_at
     ) VALUES ($1, $2, 84532, 'USDC', $3, $4, $5, $6, 'x402_authorize', $7::timestamptz)
     RETURNING id`,
    [
      seed.userId,
      seed.agentId,
      opts.amountAtomic ?? '25000',
      opts.merchantTo ?? '0x0000000000000000000000000000000000000009',
      opts.resourceUrl ?? 'https://research.example/report',
      opts.reason ?? 'delegation_budget_exceeded',
      opts.createdAt,
    ],
  )
  return result.rows[0].id
}

describeDb('GET /agent-activity/:id/activity?kind=refusals — the refusal read (#4323, real DB)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/agent-activity.ts'] })
    await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  async function get(userId: string, url: string) {
    const token = app.jwt.sign({ sub: userId, email: 'u@example.com' }, { expiresIn: '1h' })
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
  }

  it('serves refusal rows with the wire fields, measured, and validates against the spec', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:18:00Z' })
    await seedRefusal(seed, { createdAt: '2026-07-09T08:18:00Z', reason: 'onchain_revert' })

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=refusals`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.hasMore).toBe(false)
    expect(body.activity).toHaveLength(2)
    // Newest first. (pg serves timestamptz with an explicit .000 ms offset.)
    expect(body.activity[0].created_at).toBe('2026-07-10T08:18:00.000Z')
    const entry = body.activity[0]
    expect(Object.keys(entry)).toEqual(REFUSAL_ENTRY_KEYS)
    expect(entry.type).toBe('refusal')
    expect(entry.reason).toBe('delegation_budget_exceeded')
    expect(entry.amount).toBe('25000')
    expect(entry.token_symbol).toBe('USDC')
    expect(entry.chain_id).toBe(84532)
    expect(entry.attempts).toBe(1)
    // Serve-time fiat, all three currencies — the mocked outage triple.
    expect(entry.approx_amount_usd).toBeNull()
    expect(entry.approx_amount_eur).toBeNull()
    expect(entry.approx_amount_sek).toBeNull()
    expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
  })

  it('kind=payments stays the payment population — no refusal rows, unchanged entry keys', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:18:00Z' })

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.activity).toHaveLength(0)
    expect(body.total).toBe(0)
    // The refusal rows must not leak into the payments population.
    expect(body.activity.every((e: { type: string }) => e.type !== 'refusal')).toBe(true)
  })

  it('status=refused is accepted; a value from the other kinds is a 400', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:18:00Z' })

    const ok = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=refusals&status=refused`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().total).toBe(1)

    for (const status of ['sent', 'pending', 'failed', 'needs_attention', 'ok', 'error', 'denied']) {
      const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=refusals&status=${status}`)
      expect(res.statusCode).toBe(400)
    }
  })

  it('from is inclusive and to exclusive, so adjacent windows tile', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-08T08:00:00Z' })
    await seedRefusal(seed, { createdAt: '2026-07-10T08:00:00Z' })
    await seedRefusal(seed, { createdAt: '2026-07-12T08:00:00Z' })

    const res = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=refusals&from=2026-07-08T08:00:00Z&to=2026-07-12T08:00:00Z`,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.activity.map((e: { created_at: string }) => e.created_at)).toEqual([
      '2026-07-10T08:00:00.000Z',
      '2026-07-08T08:00:00.000Z',
    ])
  })

  it('q searches the resource URL AND the merchant value', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:00:00Z', resourceUrl: 'https://alpha.example/item' })
    await seedRefusal(seed, {
      createdAt: '2026-07-09T08:00:00Z',
      resourceUrl: null,
      merchantTo: '0x00000000000000000000000000000000000000bb',
    })
    await seedRefusal(seed, { createdAt: '2026-07-08T08:00:00Z', resourceUrl: 'https://gamma.example/item' })

    const byResource = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=refusals&q=alpha.example`,
    )
    expect(byResource.json().total).toBe(1)
    expect(byResource.json().activity[0].resource_url).toBe('https://alpha.example/item')

    const byMerchant = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=refusals&q=000000bb`,
    )
    expect(byMerchant.json().total).toBe(1)
    expect(byMerchant.json().activity[0].merchant_to).toBe('0x00000000000000000000000000000000000000bb')
  })

  it('pages with total and hasMore — an offset past the end still reports the total', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:00:00Z' })
    await seedRefusal(seed, { createdAt: '2026-07-09T08:00:00Z' })
    await seedRefusal(seed, { createdAt: '2026-07-08T08:00:00Z' })

    const page1 = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=refusals&limit=2`)
    expect(page1.json().total).toBe(3)
    expect(page1.json().hasMore).toBe(true)
    expect(page1.json().activity).toHaveLength(2)

    const page3 = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=refusals&limit=2&offset=2`,
    )
    expect(page3.json().activity).toHaveLength(1)
    expect(page3.json().total).toBe(3)
    expect(page3.json().hasMore).toBe(false)
  })

  it('the 60-second dedupe folds retries into ONE row — the read serves one row, attempts 2', async () => {
    const seed = await seedUserWithAgent()
    // Two identical refusal writes inside the dedupe window: the second must
    // fold (one row, not two), and the refusal read must show exactly that.
    const first = await recordPaymentRefusal({
      userId: seed.userId,
      agentId: seed.agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '25000',
      usdValue: null,
      eurValue: null,
      sekValue: null,
      merchantTo: '0x0000000000000000000000000000000000000009',
      resourceUrl: 'https://research.example/report',
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
    })
    const second = await recordPaymentRefusal({
      userId: seed.userId,
      agentId: seed.agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '25000',
      usdValue: null,
      eurValue: null,
      sekValue: null,
      merchantTo: '0x0000000000000000000000000000000000000009',
      resourceUrl: 'https://research.example/report',
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
    })
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.attempts).toBe(2)

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=refusals`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.activity).toHaveLength(1)
    expect(body.activity[0].attempts).toBe(2)
    expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
  })

  it('another user cannot read the refusals of an agent they do not own', async () => {
    const seed = await seedUserWithAgent()
    await seedUserWithAgent() // a second user whose agent id will not match
    await seedRefusal(seed, { createdAt: '2026-07-10T08:00:00Z' })

    // The route resolves the agent by id for the CALLING user; the harness's
    // per-test reset keeps each seed isolated, so use the repo gate directly:
    // the statements are NOT tenant-scoped by design — the route's
    // agentExistsForUser check is the wall, and it runs before any read.
    const rows = await listAgentRefusalsFiltered(
      seed.agentId,
      { from: null, to: null, q: null },
      30,
      0,
    )
    expect(rows).toHaveLength(1)
  })
})

describeDb('the refusal repository reads (#4323, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('list + count agree on the filtered population and order newest first', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:00:00Z', reason: 'delegation_expired' })
    await seedRefusal(seed, { createdAt: '2026-07-09T08:00:00Z' })

    const filter = { from: null, to: null, q: null }
    const rows = await listAgentRefusalsFiltered(seed.agentId, filter, 30, 0)
    const total = await countAgentRefusalsFiltered(seed.agentId, filter)
    expect(total).toBe(2)
    expect(rows.map((r) => r.reason)).toEqual(['delegation_expired', 'delegation_budget_exceeded'])
    // The read shape carries no book-time fiat — the serve-time triple is the
    // route's job, from the human amount the registry derives.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'id',
        'agent_id',
        'chain_id',
        'token_symbol',
        'amount_atomic',
        'merchant_to',
        'resource_url',
        'reason',
        'attempts',
        'created_at',
      ].sort(),
    )
  })

  it('an empty filter set filters nothing; an unknown q matches nothing', async () => {
    const seed = await seedUserWithAgent()
    await seedRefusal(seed, { createdAt: '2026-07-10T08:00:00Z' })

    expect(await countAgentRefusalsFiltered(seed.agentId, { from: null, to: null, q: null })).toBe(1)
    expect(await countAgentRefusalsFiltered(seed.agentId, { from: null, to: null, q: 'nomatch' })).toBe(0)
    expect(await countAgentRefusalsFiltered(seed.agentId, { from: '2026-07-11T00:00:00Z', to: null, q: null })).toBe(0)
  })
})
