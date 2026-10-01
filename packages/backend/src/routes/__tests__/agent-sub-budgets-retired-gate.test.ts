/**
 * Real-Postgres route tests for the #3553 lifecycle gate on owner sub-budget
 * issuance (`POST /agents/:id/sub-budgets`) and the owner sign relay
 * (`POST /agents/:id/sub-budgets/:sub/sign`).
 *
 * The invariant: no new spend authority is created through or for an agent
 * that is revoked or archived. The claims are about what the database holds
 * after a refusal (row counts, row status), so nothing here is mocked. The
 * gate runs before body validation and before parent selection, so no
 * on-chain / SDK work is needed to prove a refusal — and a refusal writes
 * nothing.
 *
 * Authority-reducing and read routes (DELETE, GET list/tree) must stay open
 * for a revoked issuer: the gate lives in the two issuance-side routes, not in
 * `loadOwnedDelegationAgent`.
 */
import { randomUUID } from 'node:crypto'
import Fastify, { FastifyError, FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { insertPendingSubBudget } from '../../infra/repositories/sub-budgets.js'
import agentSubBudgetsOwnerRoutes from '../agent-sub-budgets.js'

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CHAIN_ID = 8453

let seq = 0

interface World {
  userId: string
  issuerId: string
  subAgentId: string
}

type AgentSeedStatus = 'active' | 'paused' | 'revoked' | 'pending_approval'

async function seedAgent(userId: string, accountId: string, name: string, fill: string): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, $3, $4, $5, 'sk_agent_gt', 'active') RETURNING id`,
    [userId, accountId, `${name} ${seq}`, `0x${String(seq).padStart(40, fill)}`, `hash-gate-${seq}-${Date.now()}`],
  )
  return rows[0].id
}

async function seedWorld(): Promise<World> {
  seq += 1
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sb-gate-${seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(seq).padStart(40, 'a')}`, CHAIN_ID],
  )
  const accountId = account.rows[0].id
  const issuerId = await seedAgent(userId, accountId, 'Issuer', 'b')
  const subAgentId = await seedAgent(userId, accountId, 'Sub agent', 'c')
  return { userId, issuerId, subAgentId }
}

async function setStatus(agentId: string, status: AgentSeedStatus): Promise<void> {
  await db.query(`UPDATE agents SET status = $2 WHERE id = $1`, [agentId, status])
}

async function archive(agentId: string): Promise<void> {
  await db.query(`UPDATE agents SET archived_at = NOW() WHERE id = $1`, [agentId])
}

/** An ACTIVE budget delegation — the half-revoked state when the agent is revoked. */
async function seedActiveBudget(agentId: string): Promise<void> {
  seq += 1
  await db.query(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, $2, $3, NULL, $4, '{"signed":"capability"}', 1, 'active', '1000000', 86400, 0, 9999999999)`,
    [agentId, CHAIN_ID, USDC_BASE, `0x${String(seq).padStart(64, '0')}`],
  )
}

/** A pending parent-child row for the issuer, as issuance would have written it. */
async function seedPendingRow(issuerId: string): Promise<string> {
  seq += 1
  const id = randomUUID()
  await insertPendingSubBudget({
    id,
    agentId: issuerId,
    parentAgentId: issuerId,
    parentSubBudgetId: null,
    chainId: CHAIN_ID,
    tokenAddress: USDC_BASE,
    recipientAddress: null,
    parentDelegationHash: `0x${'a'.repeat(64)}`,
    delegationHash: `0x${String(seq).padStart(64, '1')}`,
    delegationJson: JSON.stringify({ unsigned: true, seq }),
    label: 'gate test',
    periodAmountAtomic: '500000',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })
  return id
}

async function subBudgetCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM agent_sub_budgets`)
  return Number(rows[0].n)
}

async function rowStatus(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM agent_sub_budgets WHERE id = $1`, [id])
  return rows[0].status
}

interface ErrBody {
  error?: string
  error_code?: string
}

describeDb('sub-budget issuance + sign relay lifecycle gate (#3553)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      void reply.status(error.statusCode ?? 500).send({ error: error.message })
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // Born enforced in `src/index.ts` (#3330); run the suite as production does.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/agent-sub-budgets.ts'] })
    await app.register(agentSubBudgetsOwnerRoutes, { prefix: '/agents' })
    await app.ready()
  })

  afterEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await app.close()
  })

  function auth(userId: string): { headers: { authorization: string } } {
    const token = app.jwt.sign({ sub: userId, email: 'sb-gate@test.example' })
    return { headers: { authorization: `Bearer ${token}` } }
  }

  async function issue(w: World, overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${w.issuerId}/sub-budgets`,
      ...auth(w.userId),
      payload: {
        sub_agent_id: w.subAgentId,
        period_amount_atomic: '1000000',
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        ...overrides,
      },
    })
    return { status: res.statusCode, body: res.json() as ErrBody }
  }

  async function relay(w: World, rowId: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${w.issuerId}/sub-budgets/${rowId}/sign`,
      ...auth(w.userId),
      payload: { signature: `0x${'11'.repeat(65)}` },
    })
    return { status: res.statusCode, body: res.json() as ErrBody }
  }

  // ── issuance: the issuing agent ───────────────────────────────────────────

  it('refuses issuance for a revoked issuer with issuer_retired and writes nothing', async () => {
    const w = await seedWorld()
    await setStatus(w.issuerId, 'revoked')
    const res = await issue(w)
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('issuer_retired')
    expect(res.body.error).not.toMatch(/cannot receive/i)
    expect(await subBudgetCount()).toBe(0)
  })

  it('refuses a HALF-revoked issuer (credential revoked, budget delegation still active) and writes nothing', async () => {
    const w = await seedWorld()
    await seedActiveBudget(w.issuerId)
    await setStatus(w.issuerId, 'revoked')
    const res = await issue(w)
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('issuer_retired')
    expect(await subBudgetCount()).toBe(0)
  })

  it('refuses an archived issuer that still holds a live budget and writes nothing', async () => {
    const w = await seedWorld()
    await seedActiveBudget(w.issuerId)
    await archive(w.issuerId)
    const res = await issue(w)
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('issuer_retired')
    expect(await subBudgetCount()).toBe(0)
  })

  it('runs the issuer gate before body validation', async () => {
    const w = await seedWorld()
    await setStatus(w.issuerId, 'revoked')
    // Unknown sub-agent id: body-level problems must not mask the lifecycle refusal.
    const res = await issue(w, { sub_agent_id: randomUUID() })
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('issuer_retired')
  })

  it('a paused issuer passes the gate (it fails later, on having no budget)', async () => {
    const w = await seedWorld()
    await setStatus(w.issuerId, 'paused')
    const res = await issue(w)
    expect(res.body.error_code).not.toBe('issuer_retired')
    expect(res.body.error_code).not.toBe('sub_agent_retired')
    expect(res.body.error_code).toBe('no_delegation_for_target')
    expect(await subBudgetCount()).toBe(0)
  })

  // ── issuance: the receiving sub-agent ─────────────────────────────────────

  for (const status of ['revoked', 'pending_approval'] as const) {
    it(`refuses a ${status} sub-agent with sub_agent_retired and writes nothing`, async () => {
      const w = await seedWorld()
      await seedActiveBudget(w.issuerId)
      await setStatus(w.subAgentId, status)
      const res = await issue(w)
      expect(res.status).toBe(409)
      expect(res.body.error_code).toBe('sub_agent_retired')
      expect(await subBudgetCount()).toBe(0)
    })
  }

  it('refuses an archived sub-agent with sub_agent_retired and writes nothing', async () => {
    const w = await seedWorld()
    await seedActiveBudget(w.issuerId)
    await archive(w.subAgentId)
    const res = await issue(w)
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('sub_agent_retired')
    expect(await subBudgetCount()).toBe(0)
  })

  it('a paused sub-agent passes the gate (it fails later, on the issuer having no budget)', async () => {
    const w = await seedWorld()
    await setStatus(w.subAgentId, 'paused')
    const res = await issue(w)
    expect(res.body.error_code).not.toBe('sub_agent_retired')
    expect(res.body.error_code).not.toBe('issuer_retired')
    expect(res.body.error_code).toBe('no_delegation_for_target')
    expect(await subBudgetCount()).toBe(0)
  })

  it('an active sub-agent passes the gate', async () => {
    const w = await seedWorld()
    const res = await issue(w)
    expect(res.body.error_code).toBe('no_delegation_for_target')
  })

  // ── owner sign relay ──────────────────────────────────────────────────────

  it('refuses the relay after the issuer is revoked, leaving the pending row pending', async () => {
    const w = await seedWorld()
    const rowId = await seedPendingRow(w.issuerId) // seeded while ACTIVE
    await setStatus(w.issuerId, 'revoked')
    const res = await relay(w, rowId)
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('issuer_retired')
    expect(await rowStatus(rowId)).toBe('pending')
  })

  it('refuses the relay after the issuer is archived, leaving the pending row pending', async () => {
    const w = await seedWorld()
    const rowId = await seedPendingRow(w.issuerId)
    await archive(w.issuerId)
    const res = await relay(w, rowId)
    expect(res.status).toBe(409)
    expect(res.body.error_code).toBe('issuer_retired')
    expect(await rowStatus(rowId)).toBe('pending')
  })

  it('a paused issuer passes the relay gate (the signature check then rejects it)', async () => {
    const w = await seedWorld()
    const rowId = await seedPendingRow(w.issuerId)
    await setStatus(w.issuerId, 'paused')
    const res = await relay(w, rowId)
    expect(res.body.error_code).not.toBe('issuer_retired')
    expect(await rowStatus(rowId)).toBe('pending')
  })

  // ── authority-reducing and read routes stay open ──────────────────────────

  it('DELETE, GET list and GET tree still work for a revoked issuer', async () => {
    const w = await seedWorld()
    const rowId = await seedPendingRow(w.issuerId)
    await setStatus(w.issuerId, 'revoked')

    const list = await app.inject({ method: 'GET', url: `/agents/${w.issuerId}/sub-budgets`, ...auth(w.userId) })
    expect(list.statusCode).toBe(200)
    expect((list.json() as { sub_budgets: unknown[] }).sub_budgets).toHaveLength(1)

    const tree = await app.inject({ method: 'GET', url: `/agents/${w.issuerId}/sub-budgets/tree`, ...auth(w.userId) })
    expect(tree.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/agents/${w.issuerId}/sub-budgets/${rowId}`, ...auth(w.userId) })
    expect(del.statusCode).toBe(200)
    expect(await rowStatus(rowId)).toBe('closed')
  })

  it('DELETE, GET list and GET tree still work for an archived issuer', async () => {
    const w = await seedWorld()
    const rowId = await seedPendingRow(w.issuerId)
    await archive(w.issuerId)

    const list = await app.inject({ method: 'GET', url: `/agents/${w.issuerId}/sub-budgets`, ...auth(w.userId) })
    expect(list.statusCode).toBe(200)
    const tree = await app.inject({ method: 'GET', url: `/agents/${w.issuerId}/sub-budgets/tree`, ...auth(w.userId) })
    expect(tree.statusCode).toBe(200)
    const del = await app.inject({ method: 'DELETE', url: `/agents/${w.issuerId}/sub-budgets/${rowId}`, ...auth(w.userId) })
    expect(del.statusCode).toBe(200)
  })
})
