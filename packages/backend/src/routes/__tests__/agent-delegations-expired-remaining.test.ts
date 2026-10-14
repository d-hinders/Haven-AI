/**
 * #3923 (epic #3919 slice D, P1): an expired `active` delegation stays in
 * `GET /agents/:id/delegations` (history) but is not spendable — under
 * `?include=remaining` it carries `remaining_atomic: null` (and the two
 * companions null) and costs NO chain read; a live row still gets its read.
 * Real Postgres; only the chain reader is a spy (a collaborator the test does
 * not own).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const { mockReadRemaining } = vi.hoisted(() => ({ mockReadRemaining: vi.fn() }))
vi.mock('../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/delegation-budget-reader.js')>()
  return { ...actual, readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a) }
})

const agentDelegationRoutes = (await import('../agent-delegations.js')).default

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
let seq = 0

describeDb('GET /agents/:id/delegations?include=remaining — expired active rows (#3923 P1)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? 'test-secret' })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
  })
  beforeEach(async () => {
    await resetDb()
    mockReadRemaining.mockReset()
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '123', fromChain: true })
  })
  afterAll(async () => {
    await app.close()
  })

  async function seedAgent(): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`p1-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, owner_address)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', $3) RETURNING id`,
      [userId, `0x${String(n).padStart(40, 'a')}`, `0x${'ff'.repeat(20)}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'P1 agent', $3, $4, 'sk_agnt_p1', 'active') RETURNING id`,
      [userId, account.rows[0].id, `0x${String(n).padStart(40, 'd')}`, `hash-p1-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  async function seedActive(agentId: string, marker: string, expiresOffset: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const hash = `0x${String(++seq).padStart(64, '0')}`
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds,
          start_date, expires_at, created_at)
       VALUES ($1, 84532, $2, NULL, $3, $4, 1, 'active', '1000000', 86400, $5, $6, NOW())`,
      [agentId, USDC, hash, JSON.stringify({ marker }), now - 86400, now + expiresOffset],
    )
    return hash
  }

  it('expired active row: kept, remaining_atomic null, NO chain read; the live row is still read', async () => {
    const { userId, agentId } = await seedAgent()
    const expired = await seedActive(agentId, 'expired-row', -10)
    const live = await seedActive(agentId, 'live-row', 86400)

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/delegations?include=remaining`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'u@test.dev' })}` },
    })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/agents/{id}/delegations', res.json())
    const rows = res.json().delegations as Array<Record<string, unknown>>
    const by = (h: string) => rows.find((r) => r.delegation_hash === h)!

    // History kept.
    expect(rows).toHaveLength(2)
    expect(by(expired)).toMatchObject({
      status: 'active',
      is_live: false,
      remaining_atomic: null,
      remaining_from_chain: null,
      period_end: null,
    })
    expect(by(live)).toMatchObject({ is_live: true, remaining_atomic: '123', remaining_from_chain: true })

    // The chain reader ran for the live row only.
    expect(mockReadRemaining).toHaveBeenCalledTimes(1)
    expect(String(mockReadRemaining.mock.calls[0][1])).toContain('live-row')
    expect(mockReadRemaining.mock.calls.map((c) => String(c[1])).join()).not.toContain('expired-row')
  })
})
