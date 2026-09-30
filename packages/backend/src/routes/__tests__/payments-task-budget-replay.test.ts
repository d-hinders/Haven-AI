/**
 * #3392 — POST /payments idempotent replay refuses a `task_budget` mismatch.
 *
 * An idempotency key pins token, recipient, amount AND (since #3392) the task
 * budget the payment was charged to. Every case here is about what the route
 * reads from, or writes to, `payment_intents`, so it runs on real Postgres
 * through the real agent-auth lookup (`payments-direct-sign-context.test.ts`
 * pattern) — the one mock is `computeHybridAccountAddress`, the collaborator
 * this file does not own.
 *
 * The comparison runs BEFORE the task-budget lookup (the replay is step 4a),
 * so a replay naming a budget id the stored row does not carry gets the 409
 * even when the id is malformed — case 4 pins that it is NOT a 404.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
// #3500: the task-budget cap pre-check reads the enforcer's spentMap — never a live chain here.
vi.mock('../../infra/chain/task-budget-spent-reader.js', () => ({ readTaskBudgetSpent: async () => 0n }))
import Fastify, { type FastifyInstance } from 'fastify'
import { packedUserOperationHash } from '@haven_ai/sdk'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import paymentRoutes from '../payments.js'
import { userOpTypedData } from '../../rails/delegation-rail.js'

const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: async () => DELEGATE_ACCOUNT }
})

const CHAIN_ID = 8453
const DELEGATE = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1'
const RECIPIENT = '0x' + '22'.repeat(20)
/** The real Base USDC address (`packages/core/src/chains.ts`). */
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
/** '0.01' human USDC = the atomic amount the route computes for the request. */
const AMOUNT_RAW = '10000'

const PREPARED_USER_OP = {
  sender: DELEGATE_ACCOUNT,
  nonce: '9',
  callData: '0x' + 'ab'.repeat(64),
}

/** The typed data production builds for `PREPARED_USER_OP` and its v0.7 hash. */
function goldenSignData(): { typedData: unknown; hash: string } {
  const typedData = userOpTypedData(PREPARED_USER_OP, DELEGATE_ACCOUNT as `0x${string}`, CHAIN_ID)
  return { typedData, hash: packedUserOperationHash(typedData) }
}

let seq = 0

interface Seeded {
  userId: string
  agentId: string
  apiKey: string
}

/** A user + delegation-rail account + ACTIVE agent holding a real API key. */
async function seedAgent(): Promise<Seeded> {
  const n = ++seq
  const apiKey = `sk_agent_task_budget_replay_${n}_${Date.now()}`
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`task-budget-replay-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${n.toString(16).padStart(40, 'f')}`, CHAIN_ID],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, status, delegate_address, api_key_hash)
     VALUES ($1, $2, 'Task budget replay', 'active', $3, $4) RETURNING id`,
    [userId, account.rows[0].id, DELEGATE, createHash('sha256').update(apiKey).digest('hex')],
  )
  return { userId, agentId: agent.rows[0].id, apiKey }
}

/** An OPEN task budget (the only status a payment may name) owned by the agent. */
async function seedTaskBudget(owner: Seeded): Promise<string> {
  const n = ++seq
  const row = await db.query<{ id: string }>(
    `INSERT INTO agent_task_budgets
       (agent_id, chain_id, token_address, recipient_address, parent_delegation_hash,
        delegation_hash, delegation_json, max_atomic, status, expires_at)
     VALUES ($1, $2, $3, NULL, $4, $5, '{}', '1000000', 'open', 9999999999)
     RETURNING id`,
    [
      owner.agentId,
      CHAIN_ID,
      BASE_USDC,
      `0x${String(n).padStart(64, '0')}`,
      `0x${String(n + 1000).padStart(64, '0')}`,
    ],
  )
  return row.rows[0].id
}

/**
 * A signable delegation-rail intent holding the idempotency key, overridable
 * per case. Defaults name NO task budget (`task_budget_id: null`).
 */
async function seedIntent(
  owner: Seeded,
  key: string,
  overrides: Partial<{ taskBudgetId: string | null; status: string; expiresAt: string }> = {},
): Promise<string> {
  const row = {
    status: 'pending_signature',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    taskBudgetId: null as string | null,
    ...overrides,
  }
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, prepared_user_op, chain_id,
        send_idempotency_key, task_budget_id)
     VALUES ($1, $2, $3, 'USDC', $4, $5, $6, '0.01', $7, 1, $8,
             $9, NULL, $10, 'delegation', $11, $12, $13, $14)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      DELEGATE_ACCOUNT,
      BASE_USDC,
      RECIPIENT,
      AMOUNT_RAW,
      DELEGATE,
      goldenSignData().hash,
      row.status,
      row.expiresAt,
      JSON.stringify(PREPARED_USER_OP),
      CHAIN_ID,
      key,
      row.taskBudgetId,
    ],
  )
  return intent.rows[0].id
}

async function intentCountForKey(key: string): Promise<number> {
  const res = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM payment_intents WHERE send_idempotency_key = $1`,
    [key],
  )
  return Number(res.rows[0].cnt)
}

describeDb('POST /payments replay refuses a task_budget mismatch (#3392)', () => {
  let app: FastifyInstance
  let agent: Seeded

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => app.close())
  beforeEach(async () => {
    await resetDb()
    agent = await seedAgent()
  })

  function post(body: Record<string, unknown>, apiKey = agent.apiKey) {
    return app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT, ...body },
    })
  }

  it('A→B: 409 with the task_budget error, and no new intent is created', async () => {
    const budgetA = await seedTaskBudget(agent)
    const key = `tb-replay-${Date.now()}-ab`
    const paymentId = await seedIntent(agent, key, { taskBudgetId: budgetA })

    const res = await post({ idempotency_key: key, task_budget_id: '00000000-0000-4000-8000-00000000000b' })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe('idempotency_key already belongs to a payment with a different task_budget')
    expect(body.payment_id).toBe(paymentId)
    expect(await intentCountForKey(key)).toBe(1)
  })

  it('A→none: naming no budget against a row that has one is a 409', async () => {
    const budgetA = await seedTaskBudget(agent)
    const key = `tb-replay-${Date.now()}-an`
    await seedIntent(agent, key, { taskBudgetId: budgetA })

    const res = await post({ idempotency_key: key })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('idempotency_key already belongs to a payment with a different task_budget')
    expect(await intentCountForKey(key)).toBe(1)
  })

  it('none→A: naming a budget against a row that has none is a 409', async () => {
    const budgetA = await seedTaskBudget(agent)
    const key = `tb-replay-${Date.now()}-na`
    const paymentId = await seedIntent(agent, key)

    const res = await post({ idempotency_key: key, task_budget_id: budgetA })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('idempotency_key already belongs to a payment with a different task_budget')
    expect(res.json().payment_id).toBe(paymentId)
    expect(await intentCountForKey(key)).toBe(1)
  })

  it('a malformed budget id still gets the replay 409, not the lookup 404', async () => {
    // The replay comparison runs before any task-budget lookup, so the
    // malformed id never reaches `findTaskBudgetForAgent` — "absent vs named"
    // is decided on the pin alone.
    const budgetA = await seedTaskBudget(agent)
    const key = `tb-replay-${Date.now()}-mal`
    await seedIntent(agent, key, { taskBudgetId: budgetA })

    const res = await post({ idempotency_key: key, task_budget_id: 'not-a-uuid' })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('idempotency_key already belongs to a payment with a different task_budget')
  })

  it('A→A: matching values replay as today (201 idempotent_replay)', async () => {
    const budgetA = await seedTaskBudget(agent)
    const key = `tb-replay-${Date.now()}-aa`
    const paymentId = await seedIntent(agent, key, { taskBudgetId: budgetA })

    const res = await post({ idempotency_key: key, task_budget_id: budgetA })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.idempotent_replay).toBe(true)
    expect(body.payment_id).toBe(paymentId)
    expect(body.status).toBe('pending_signature')
    expect(await intentCountForKey(key)).toBe(1)
  })

  it('none→none: both absent replay as today (201 idempotent_replay)', async () => {
    const key = `tb-replay-${Date.now()}-nn`
    const paymentId = await seedIntent(agent, key)

    const res = await post({ idempotency_key: key })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.idempotent_replay).toBe(true)
    expect(body.payment_id).toBe(paymentId)
    expect(await intentCountForKey(key)).toBe(1)
  })
})
