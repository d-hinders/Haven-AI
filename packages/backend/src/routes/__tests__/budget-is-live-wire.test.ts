/**
 * #3922 (epic #3919 slice C): the wire `is_live` flag on every budget-shaped
 * response, proven on real Postgres.
 *
 * `is_live` is true exactly when the row passes its table's live filter:
 *  - delegation rows: `spendableDelegationSql({ requireStarted: false })` —
 *    SELECTED from SQL by the list route, so the flag cannot drift from the
 *    predicate (a dormant future-start re-key row is live, as the budget
 *    views show it);
 *  - task-budget rows: `liveTaskBudgetSql` (what `?status=live` returns);
 *  - sub-budget rows: `openSubBudgetSql`.
 * The task/sub wires are projected in JS from rows the route already holds
 * (RETURNING rows included), so the second half pins JS == SQL across the full
 * status x expiry matrix on the same app clock.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { isLiveTaskBudget, liveTaskBudgetSql } from '../../infra/repositories/task-budgets.js'
import { isOpenSubBudget, openSubBudgetSql } from '../../infra/repositories/sub-budgets.js'

// The owner task-budget list reads the chain for OPEN rows only; no RPC here.
vi.mock('../../modules/task-budgets/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/task-budgets/index.js')>()
  return {
    ...actual,
    readTaskBudgetSpentForReport: async () => ({ spentAtomic: '0', remainingAtomic: '1000000' }),
  }
})

const agentDelegationRoutes = (await import('../agent-delegations.js')).default
const agentTaskBudgetsOwnerRoutes = (await import('../agent-task-budgets.js')).default
const agentSubBudgetsOwnerRoutes = (await import('../agent-sub-budgets.js')).default

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PARENT_HASH = `0x${'a'.repeat(64)}`
const TASK_STATUSES = ['pending', 'open', 'closing', 'closed'] as const

let seq = 0

describeDb('is_live on every budget-shaped wire (#3922)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? 'test-secret' })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
    await app.register(agentTaskBudgetsOwnerRoutes, { prefix: '/agents' })
    await app.register(agentSubBudgetsOwnerRoutes, { prefix: '/agents' })
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await app.close()
  })

  function userHeaders(userId: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'u@test.dev' })}` }
  }

  async function seedAgent(): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`is-live-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, owner_address)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', $3) RETURNING id`,
      [userId, `0x${String(n).padStart(40, 'a')}`, `0x${'ff'.repeat(20)}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Is-live agent', $3, $4, 'sk_agnt_liv', 'active') RETURNING id`,
      [userId, account.rows[0].id, `0x${String(n).padStart(40, 'd')}`, `hash-live-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  async function seedDelegation(
    agentId: string,
    status: string,
    startOffset: number,
    expiresOffset: number,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const hash = `0x${String(++seq).padStart(64, '0')}`
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds,
          start_date, expires_at, created_at)
       VALUES ($1, 84532, $2, NULL, $3, '{}', 1, $4, '1000000', 86400, $5, $6, NOW())`,
      [agentId, USDC, hash, status, now + startOffset, now + expiresOffset],
    )
    return hash
  }

  it('GET /agents/:id/delegations — is_live is the budget-VIEW predicate (spendable, requireStarted false), per row', async () => {
    const { userId, agentId } = await seedAgent()
    const live = await seedDelegation(agentId, 'active', -3600, 86400)
    const expired = await seedDelegation(agentId, 'active', -86400, -10)
    // The dormant "steady" half of a re-key carry: active, START in the future.
    const futureStart = await seedDelegation(agentId, 'active', 3600, 86400 * 30)
    const replaced = await seedDelegation(agentId, 'replaced', -3600, 86400)
    const revoked = await seedDelegation(agentId, 'revoked', -3600, 86400)
    const pending = await seedDelegation(agentId, 'pending', -3600, 86400)

    const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/delegations`, headers: userHeaders(userId) })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/agents/{id}/delegations', res.json())
    const rows = res.json().delegations as Array<{ delegation_hash: string; is_live: boolean; status: string }>
    const flag = (hash: string) => rows.find((r) => r.delegation_hash === hash)?.is_live
    expect(rows).toHaveLength(6)
    expect(flag(live)).toBe(true)
    expect(flag(expired)).toBe(false)
    expect(flag(futureStart)).toBe(true)
    expect(flag(replaced)).toBe(false)
    expect(flag(revoked)).toBe(false)
    expect(flag(pending)).toBe(false)
    // Additive only: the pre-#3922 keys are all still there.
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['status', 'expires_at', 'start_date', 'delegation_hash']))
  })

  it('GET /agents/:id/delegations?include=remaining carries the same is_live (the spread keeps the derived field)', async () => {
    const { userId, agentId } = await seedAgent()
    const expired = await seedDelegation(agentId, 'active', -86400, -10)
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agentId}/delegations?include=remaining`,
      headers: userHeaders(userId),
    })
    expect(res.statusCode).toBe(200)
    const row = (res.json().delegations as Array<{ delegation_hash: string; is_live: boolean }>)
      .find((r) => r.delegation_hash === expired)
    expect(row?.is_live).toBe(false)
  })

  async function seedTaskBudget(agentId: string, status: string, expiresOffset: number): Promise<string> {
    const id = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await db.query(
      `INSERT INTO agent_task_budgets
         (id, agent_id, chain_id, token_address, recipient_address, parent_delegation_hash,
          delegation_hash, delegation_json, label, max_atomic, status, expires_at)
       VALUES ($1, $2, 84532, $3, NULL, $4, $5, '{}', 'task', '1000000', $6, $7)`,
      [id, agentId, USDC, PARENT_HASH, `0x${String(++seq).padStart(64, '2')}`, status, now + expiresOffset],
    )
    return id
  }

  it('GET /agents/:id/task-budgets — is_live is liveTaskBudgetSql: closing-unexpired true; closing-expired, closed-future, open-expired false', async () => {
    const { userId, agentId } = await seedAgent()
    const closingLive = await seedTaskBudget(agentId, 'closing', 3600)
    const closingExpired = await seedTaskBudget(agentId, 'closing', -10)
    const closedFuture = await seedTaskBudget(agentId, 'closed', 3600)
    const openExpired = await seedTaskBudget(agentId, 'open', -10)
    const openLive = await seedTaskBudget(agentId, 'open', 3600)
    const pendingLive = await seedTaskBudget(agentId, 'pending', 3600)

    const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/task-budgets`, headers: userHeaders(userId) })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/agents/{id}/task-budgets', res.json())
    const rows = res.json().task_budgets as Array<{ id: string; is_live: boolean; is_expired: boolean }>
    const by = (id: string) => rows.find((r) => r.id === id)!
    expect(by(closingLive).is_live).toBe(true)
    expect(by(closingExpired).is_live).toBe(false)
    expect(by(closedFuture).is_live).toBe(false)
    expect(by(openExpired).is_live).toBe(false)
    expect(by(openLive).is_live).toBe(true)
    expect(by(pendingLive).is_live).toBe(true)
    // is_expired is untouched (and independent: a closed row is not expired).
    expect(by(closedFuture).is_expired).toBe(false)
    expect(by(openExpired).is_expired).toBe(true)
  })

  async function seedSubBudget(agentId: string, status: string, expiresOffset: number): Promise<string> {
    const id = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await db.query(
      `INSERT INTO agent_sub_budgets
         (id, agent_id, parent_agent_id, parent_sub_budget_id, chain_id, token_address,
          recipient_address, parent_delegation_hash, delegation_hash, delegation_json,
          label, period_amount_atomic, status, expires_at)
       VALUES ($1, $2, $2, NULL, 84532, $3, NULL, $4, $5, '{}', 'sub', '500000', $6, $7)`,
      [id, agentId, USDC, PARENT_HASH, `0x${String(++seq).padStart(64, '3')}`, status, now + expiresOffset],
    )
    return id
  }

  it('GET /agents/:id/sub-budgets — is_live is openSubBudgetSql: open-expired false, open-live true, closing false', async () => {
    const { userId, agentId } = await seedAgent()
    const openLive = await seedSubBudget(agentId, 'open', 3600)
    const openExpired = await seedSubBudget(agentId, 'open', -10)
    const closingLive = await seedSubBudget(agentId, 'closing', 3600)
    const pendingLive = await seedSubBudget(agentId, 'pending', 3600)
    const closedFuture = await seedSubBudget(agentId, 'closed', 3600)

    const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/sub-budgets`, headers: userHeaders(userId) })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/agents/{id}/sub-budgets', res.json())
    const rows = res.json().sub_budgets as Array<{ id: string; is_live: boolean }>
    const by = (id: string) => rows.find((r) => r.id === id)!
    expect(by(openLive).is_live).toBe(true)
    expect(by(openExpired).is_live).toBe(false)
    expect(by(closingLive).is_live).toBe(false)
    expect(by(pendingLive).is_live).toBe(false)
    expect(by(closedFuture).is_live).toBe(false)
  })

  // The task/sub wires compute in JS; this pins JS == SQL on the same rows
  // and the SAME app clock, across the whole status x expiry matrix
  // (including the exact-boundary row, expires_at == now, which both refuse).
  it('JS == SQL: isLiveTaskBudget equals liveTaskBudgetSql, isOpenSubBudget equals openSubBudgetSql, on every status x expiry cell', async () => {
    const { agentId } = await seedAgent()
    const now = Math.floor(Date.now() / 1000)
    const offsets = [-3600, -1, 0, 1, 3600]
    for (const status of TASK_STATUSES) {
      for (const off of offsets) {
        await db.query(
          `INSERT INTO agent_task_budgets
             (id, agent_id, chain_id, token_address, parent_delegation_hash, delegation_hash,
              delegation_json, max_atomic, status, expires_at)
           VALUES ($1, $2, 84532, $3, $4, $5, '{}', '1', $6, $7)`,
          [randomUUID(), agentId, USDC, PARENT_HASH, `0x${String(++seq).padStart(64, '4')}`, status, now + off],
        )
        await db.query(
          `INSERT INTO agent_sub_budgets
             (id, agent_id, parent_agent_id, chain_id, token_address, parent_delegation_hash,
              delegation_hash, delegation_json, period_amount_atomic, status, expires_at)
           VALUES ($1, $2, $2, 84532, $3, $4, $5, '{}', '1', $6, $7)`,
          [randomUUID(), agentId, USDC, PARENT_HASH, `0x${String(++seq).padStart(64, '5')}`, status, now + off],
        )
      }
    }
    const tasks = await db.query<{ status: string; expires_at: string; live: boolean }>(
      `SELECT t.status, t.expires_at, (${liveTaskBudgetSql('t', '$1')}) AS live FROM agent_task_budgets t`,
      [now],
    )
    expect(tasks.rows).toHaveLength(TASK_STATUSES.length * offsets.length)
    for (const row of tasks.rows) expect(isLiveTaskBudget(row, now), `${row.status} @ ${row.expires_at}`).toBe(row.live)
    expect(tasks.rows.some((r) => r.live)).toBe(true)
    expect(tasks.rows.some((r) => !r.live)).toBe(true)

    const subs = await db.query<{ status: string; expires_at: string; live: boolean }>(
      `SELECT s.status, s.expires_at, (${openSubBudgetSql('s', '$1')}) AS live FROM agent_sub_budgets s`,
      [now],
    )
    expect(subs.rows).toHaveLength(TASK_STATUSES.length * offsets.length)
    for (const row of subs.rows) expect(isOpenSubBudget(row, now), `${row.status} @ ${row.expires_at}`).toBe(row.live)
    expect(subs.rows.some((r) => r.live)).toBe(true)
    expect(subs.rows.some((r) => !r.live)).toBe(true)
  })
})
