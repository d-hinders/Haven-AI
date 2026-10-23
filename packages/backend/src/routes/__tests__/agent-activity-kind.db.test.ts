/**
 * Real-DB route tests for the kinded agent-activity read (#4229).
 *
 * The shape claims live here, on the #1220 harness, because they are claims
 * about what the route SERVES — the legacy merged window, the measured
 * single populations, and the refusals — not about rows in isolation. The
 * request-validation module is registered ENFORCED exactly as production
 * wires it (#3030), so the spec's new parameters are exercised on the wire.
 * One mock: the serve-time price read (below), so no test dials CoinGecko.
 *
 * The legacy-shape fixture below pins the EXACT key sets the route emitted
 * before #4229: omitting `kind` (with or without filters in the query) must
 * serve a body whose every key is `activity` and whose rows carry exactly
 * those keys — the byte-identical contract, asserted structurally because
 * approx pricing makes the VALUES environment-dependent, not the SHAPE.
 */
// #4217: `serveTimeAmount` prices each payment row through
// `getServeTimeFiatValues`, a CoinGecko fetch, and six of this file's tests
// reached it. The all-null triple is that helper's own outage answer, which
// the route already serves as an unknown amount, and this file asserts the
// SHAPE, never a price, so the stub changes no assertion. The test network
// net fails a test that dials (docs/contributing/testing-strategy.md
// § "No real network (#4217)").
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

let seq = 0

/** The route's pre-#4229 payment entry keys, in wire order. */
const LEGACY_PAYMENT_KEYS = [
  'type',
  'id',
  'token',
  'amount_raw',
  'amount',
  'approx_amount',
  'approx_currency',
  'to',
  'status',
  'tx_hash',
  'funding_tx_hash',
  'settlement_tx_hash',
  'settlement_scheme',
  // #4319: what Haven knows about the merchant settlement, snake_case here.
  'settlement_tracking',
  'settlement_proof',
  'payment_id',
  'payment_proof_status',
  'payment_flow_status',
  'payment_attention_reason',
  'source',
  'x402_resource_url',
  'x402_merchant_address',
  'delivery_reference',
  'chain_id',
  'token_address',
  'account_id',
  'account_address',
  'account_name',
  'explorer_url',
  'execution_rail',
  'delegation_hash',
  'confirmed_at',
  'created_at',
]

/** The route's pre-#4229 tool-call entry keys. */
const LEGACY_TOOL_CALL_KEYS = [
  'type',
  'id',
  'tool_name',
  'payment_id',
  'result_status',
  'next_action',
  'error_code',
  'status_code',
  'created_at',
]

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`kind-route-${n}-${randomUUID()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'kind route agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

async function seedIntent(
  seed: { userId: string; agentId: string },
  opts: { status: string; createdAt: string; paymentRail?: string | null; source?: string; tokenAddress?: string },
): Promise<string> {
  const n = ++seq
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, created_at, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail,
       usd_value, eur_value, sek_value
     ) VALUES (
       $1, $2, $3, 'USDC',
       $11,
       $4, $5, $6,
       '0x00000000000000000000000000000000000000d1', 1, $7,
       $8, $9::timestamptz, $10::timestamptz, NOW() + INTERVAL '10 minutes', 84532,
       $12, $13, 'delegation',
       '1', '0.9', '10.76'
     ) RETURNING id`,
    [
      seed.agentId, // $1
      seed.userId, // $2
      `0x${String(4e12 + n).padStart(40, '0').slice(-40)}`, // $3
      `0x${String(n).padStart(40, '2').slice(-40)}`, // $4
      `${3000000 + n}`, // $5
      String(n), // $6
      `0x${String(n).padStart(64, 'd')}`, // $7
      opts.status, // $8
      opts.createdAt, // $9
      opts.status === 'confirmed' ? opts.createdAt : null, // $10
      opts.tokenAddress ?? '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // $11
      opts.source ?? 'api', // $12
      opts.paymentRail ?? null, // $13
    ],
  )
  return result.rows[0].id
}

/** The attention derivation's rows: machine evidence + an open rejection event. */
async function seedAttention(
  seed: { userId: string; agentId: string },
  paymentId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
       resource_url, payer_address, settlement_address, token_symbol, token_address,
       amount_raw, amount_human
     ) VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 84532,
       'https://api.example.dev/reports', $5, $5, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e', '1000000', '1')`,
    [
      paymentId,
      seed.agentId,
      seed.userId,
      `0x${randomUUID().replaceAll('-', '')}`,
      `0x${String(5e12 + seq).padStart(40, '0').slice(-40)}`,
    ],
  )
  await db.query(
    `INSERT INTO machine_payment_reconciliation_events (agent_id, user_id, payment_intent_id, rail, event_type, status)
     VALUES ($1, $2, $3, 'x402', 'merchant_retry_rejected_after_payment', 'open')`,
    [seed.agentId, seed.userId, paymentId],
  )
}

async function seedInvocation(
  seed: { userId: string; agentId: string },
  opts: { toolName: string; paymentId: string | null; resultStatus: string; errorCode?: string | null; createdAt?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO agent_tool_invocations (agent_id, user_id, tool_name, payment_id, result_status, next_action, error_code, status_code, created_at)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, 200, COALESCE($7::timestamptz, NOW()))`,
    [seed.agentId, seed.userId, opts.toolName, opts.paymentId, opts.resultStatus, opts.errorCode ?? null, opts.createdAt ?? null],
  )
}

describeDb('GET /agent-activity/:id/activity — the kinded read (#4229, real DB)', () => {
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

  /**
   * The standing population: a confirmed x402 payment with an open
   * rejection event (the attention case), a confirmed plain payment, a
   * failed payment that never reached the chain, and three tool calls.
   */
  async function seedPopulation() {
    const seed = await seedUserWithAgent()
    const attended = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T08:18:00Z',
      paymentRail: 'x402',
    })
    await seedAttention(seed, attended)
    const plain = await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T07:18:00Z' })
    const failed = await seedIntent(seed, { status: 'failed', createdAt: '2026-07-09T07:45:00Z' })
    await seedInvocation(seed, {
      toolName: 'haven_pay_x402_quote',
      paymentId: attended,
      resultStatus: 'ok',
      createdAt: '2026-07-10T08:17:00Z',
    })
    await seedInvocation(seed, {
      toolName: 'haven_get_allowances',
      paymentId: null,
      resultStatus: 'ok',
      createdAt: '2026-07-09T11:30:00Z',
    })
    await seedInvocation(seed, {
      toolName: 'haven_pay_settle',
      paymentId: null,
      resultStatus: 'error',
      errorCode: 'budget_exhausted',
      createdAt: '2026-07-08T11:30:00Z',
    })
    return { seed, attended, plain, failed }
  }

  it('without kind the response is the legacy shape — one activity key, legacy row keys, filters ignored', async () => {
    const { seed } = await seedPopulation()

    for (const url of [
      `/agent-activity/${seed.agentId}/activity`,
      // Filters present but kind omitted: the legacy caller's shape is untouched.
      `/agent-activity/${seed.agentId}/activity?status=failed&from=2026-07-01`,
    ]) {
      const res = await get(seed.userId, url)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Object.keys(body)).toEqual(['activity'])
      // One of each population, merged and sorted newest first.
      expect(body.activity).toHaveLength(6)
      const payment = body.activity.find((e: { type: string }) => e.type === 'payment')
      const toolCall = body.activity.find((e: { type: string }) => e.type === 'mcp_tool_call')
      expect(Object.keys(payment)).toEqual(LEGACY_PAYMENT_KEYS)
      expect(Object.keys(toolCall)).toEqual(LEGACY_TOOL_CALL_KEYS)
      expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
    }
  })

  it('kind=payments serves only payments, with total and hasMore — and no counts', async () => {
    const { seed } = await seedPopulation()

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(3)
    expect(body.hasMore).toBe(false)
    expect(body.counts).toBeUndefined()
    expect(body.activity).toHaveLength(3)
    expect(body.activity.every((e: { type: string }) => e.type === 'payment')).toBe(true)
    expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
  })

  it('kind=payments pages over the FILTERED sequence and hasMore survives an offset past the end', async () => {
    const { seed } = await seedPopulation()

    const page = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&limit=2`)
    expect(page.json()).toMatchObject({ total: 3, hasMore: true })
    expect(page.json().activity).toHaveLength(2)

    const last = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&limit=2&offset=2`)
    expect(last.json()).toMatchObject({ total: 3, hasMore: false })
    expect(last.json().activity).toHaveLength(1)

    const past = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&offset=10`)
    expect(past.json()).toMatchObject({ total: 3, hasMore: false })
    expect(past.json().activity).toEqual([])
  })

  it('status=needs_attention returns exactly the payments with a derived attention reason; sent is confirmed', async () => {
    const { seed, attended } = await seedPopulation()

    const attention = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&status=needs_attention`,
    )
    expect(attention.json().total).toBe(1)
    expect(attention.json().activity[0]).toMatchObject({
      id: attended,
      status: 'confirmed',
      payment_attention_reason: 'merchant_retry_rejected_after_payment',
    })

    const sent = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&status=sent`)
    expect(sent.json().total).toBe(2)

    const failed = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&status=failed`)
    expect(failed.json().total).toBe(1)
    // The failed payment never reached the chain.
    expect(failed.json().activity[0]).toMatchObject({ status: 'failed', tx_hash: null, explorer_url: null })
  })

  it('status from the other kind is a 400 before any query', async () => {
    const { seed } = await seedPopulation()
    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&status=ok`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('does not apply')
  })

  it('kind=tool_calls serves calls with counts.error — which ignores the status filter', async () => {
    const { seed } = await seedPopulation()

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=tool_calls`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(3)
    expect(body.hasMore).toBe(false)
    expect(body.counts).toEqual({ error: 1 })
    expect(body.activity.every((e: { type: string }) => e.type === 'mcp_tool_call')).toBe(true)
    expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)

    // Filtering to ok: the PAGE narrows to 2, the summary count stays 1.
    const okOnly = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=tool_calls&status=ok`)
    expect(okOnly.json().total).toBe(2)
    expect(okOnly.json().counts).toEqual({ error: 1 })
    expect(okOnly.json().activity).toHaveLength(2)

    const errors = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=tool_calls&status=error`)
    expect(errors.json().total).toBe(1)
    expect(errors.json().activity[0]).toMatchObject({ result_status: 'error', error_code: 'budget_exhausted' })
  })

  it('token narrows the kinded payments read — case-insensitive, and a token nothing paid in matches nothing', async () => {
    const { seed } = await seedPopulation()
    const OTHER = '0x1111111111111111111111111111111111111111'
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T06:18:00Z', tokenAddress: OTHER })

    // The registry address: everything but the seeded other-token payment.
    const usdc = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&token=0x036cbd53842c5426634e7929541ec2318f3dcf7e`,
    )
    expect(usdc.json().total).toBe(3)
    // Rows leave canonicalized (checksummed) — compare case-insensitively.
    expect(usdc.json().activity.every((row: { token_address: string }) => row.token_address.toLowerCase() === '0x036cbd53842c5426634e7929541ec2318f3dcf7e')).toBe(true)

    // Case-insensitive on BOTH queries (#4249): the CHECKSUMMED form — a real
    // mixed-case one; `0x1111…` checksums to itself and proved nothing —
    // matches the lowercase rows. `total` comes from the count query, so the
    // LIST query is pinned by the rows it returns.
    const checksummed = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&token=0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
    )
    expect(checksummed.json().total).toBe(3)
    expect(checksummed.json().activity).toHaveLength(3)
    const upper = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&token=0X1111111111111111111111111111111111111111`,
    )
    expect(upper.json().total).toBe(1)
    expect(upper.json().activity).toHaveLength(1)

    // A token nobody paid in: an honest empty page, not an error.
    const none = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&token=0x${'ff'.repeat(20)}`,
    )
    expect(none.json().total).toBe(0)
    expect(none.json().activity).toEqual([])
  })

  it('paymentId narrows either population to that payment', async () => {
    const { seed, attended } = await seedPopulation()

    const payments = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&paymentId=${attended}`,
    )
    expect(payments.json().total).toBe(1)
    expect(payments.json().activity[0].id).toBe(attended)

    const calls = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=tool_calls&paymentId=${attended}`,
    )
    expect(calls.json().total).toBe(1)
    expect(calls.json().activity[0]).toMatchObject({ tool_name: 'haven_pay_x402_quote', payment_id: attended })
  })

  it('the period bounds cut created_at — from inclusive, to exclusive — and a non-ISO bound is a 400', async () => {
    const { seed } = await seedPopulation()

    const window = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity?kind=payments&from=2026-07-09T07:45:00Z&to=2026-07-10T08:00:00Z`,
    )
    expect(window.json().total).toBe(2)

    const bad = await get(seed.userId, `/agent-activity/${seed.agentId}/activity?kind=payments&from=nonsense`)
    expect(bad.statusCode).toBe(400)
  })

  it('an off-spec kind or status enum is refused by the request-validation module', async () => {
    const { seed } = await seedPopulation()
    for (const url of [
      `/agent-activity/${seed.agentId}/activity?kind=approvals`,
      `/agent-activity/${seed.agentId}/activity?kind=payments&status=unknown`,
    ]) {
      const res = await get(seed.userId, url)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'Request does not match the API spec', statusCode: 400 })
    }
  })

  it('another owner never reads the population — 404 before any row leaves', async () => {
    const { seed } = await seedPopulation()
    const stranger = await seedUserWithAgent()
    const res = await get(stranger.userId, `/agent-activity/${seed.agentId}/activity?kind=payments`)
    expect(res.statusCode).toBe(404)
  })
})
