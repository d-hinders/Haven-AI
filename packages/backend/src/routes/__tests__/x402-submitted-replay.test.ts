/**
 * #4826 — an x402 authorize replay whose idempotency key belongs to a
 * `submitted` payment answers a TYPED 409 from the row, at the FIRST replay
 * call, before the hourly cap, scope resolution, the remaining-budget read and
 * the funding prepare / deploy check.
 *
 * Real Postgres, the real route and the real `delegationReplay`. Mocked are
 * only the seams that would leave the process: the period-budget reader (set
 * BELOW the amount, so a pre-check that ran would refuse 403), the delegate
 * account deploy and the funding prepare (both counted, both must stay at
 * zero), and the fiat price for the refusal ledger.
 *
 * The agent is seeded AT its hourly cap (`max_x402_per_hour = 1`, with the
 * submitted row itself inside the last hour), so a replay that reached the cap
 * read would answer 429 instead of the typed 409. Each typed-answer case also
 * proves the cap is genuinely exceeded by sending a FRESH key afterwards and
 * asserting the 429 — the typed answer can therefore only have come from the
 * replay-first path.
 */
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRemaining, mockEnsureDeployed, mockPrepareFunding } = vi.hoisted(() => ({
  mockRemaining: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockPrepareFunding: vi.fn(),
}))

vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({ readRemainingBudget: mockRemaining }))
vi.mock('../../infra/fiat-values.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/fiat-values.js')>()
  return { ...actual, getFiatValuesForTokenAmount: async () => ({ usd: 0, eur: 0, sek: 0 }) }
})
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: async () => '0x' + 'dd'.repeat(20),
    ensureHybridDeployed: (...a: unknown[]) => mockEnsureDeployed(...(a as [])),
    // #4023: the delegate-account deploy moved to its own entry point; this
    // file must not reach the real relayer through it.
    ensureDelegateHybridDeployed: (...a: unknown[]) => mockEnsureDeployed(...(a as [])),
  }
})
vi.mock('../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-authorization.js')>()
  return { ...actual, prepareDelegationPayment: (...a: unknown[]) => mockPrepareFunding(...(a as [])) }
})

import Fastify, { type FastifyInstance } from 'fastify'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import x402Routes from '../x402.js'

const CHAIN = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const MERCHANT = '0x' + 'ee'.repeat(20)
const DELEGATE = '0x' + 'ab'.repeat(20)
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const RESOURCE_URL = 'https://merchant.example/4826-submitted'
const AMOUNT = '1000000'

let seq = 0

/** A delegation-rail agent AT its hourly x402 cap (one row inside the hour). */
async function seedAgent(): Promise<{ userId: string; agentId: string; apiKey: string }> {
  const apiKey = `sk_agent_4826_${++seq}_${Date.now()}`
  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`submitted-${seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = userRows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, DELEGATE_ACCOUNT, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status, max_x402_per_hour)
     VALUES ($1, 'submitted agent', $2, $3, 'sk_agent_tst', $4, 'active', 1) RETURNING id`,
    [userId, DELEGATE, createHash('sha256').update(apiKey).digest('hex'), account.rows[0].id],
  )
  return { userId, agentId: agent.rows[0].id, apiKey }
}

/**
 * A stored `submitted` x402 intent — the agent settled and the outcome is not
 * booked yet. Defaults match the erc7710 request exactly; the funding-leg case
 * moves `toAddress` to the delegate EOA and keeps `merchantTo` the merchant.
 */
async function seedSubmittedIntent(
  owner: { userId: string; agentId: string },
  key: string,
  overrides: Partial<{
    toAddress: string
    merchantTo: string
    resourceUrl: string
    taskBudgetId: string | null
    subBudgetId: string | null
    settlementScheme: string
  }> = {},
): Promise<string> {
  const row = {
    toAddress: MERCHANT,
    merchantTo: MERCHANT,
    resourceUrl: RESOURCE_URL,
    taskBudgetId: null as string | null,
    subBudgetId: null as string | null,
    settlementScheme: 'erc7710',
    ...overrides,
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, chain_id, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata,
        x402_idempotency_key, machine_idempotency_key, send_idempotency_key,
        task_budget_id, sub_budget_id, prepared_user_op)
     VALUES ($1, $2, $3, 'USDC', $4, $5,
             $6, '1.0', $7, 0, $8,
             'submitted', NULL, NOW() + interval '10 minutes', 'delegation', $9, 'x402', 'x402',
             $10, $11, $12, $13, $13, $13, $14, $15, $16)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      DELEGATE_ACCOUNT,
      USDC,
      row.toAddress,
      AMOUNT,
      DELEGATE,
      `0x${String(++seq).padStart(64, '7')}`,
      CHAIN,
      row.resourceUrl,
      row.merchantTo,
      JSON.stringify({ network: `eip155:${CHAIN}`, settlement_scheme: row.settlementScheme }),
      key,
      row.taskBudgetId,
      row.subBudgetId,
      JSON.stringify({ sender: DELEGATE_ACCOUNT, nonce: '1', callData: '0x' }),
    ],
  )
  return rows[0].id
}

/** An OPEN task budget owned by the agent — the FK target for the pin case. */
async function seedTaskBudget(agentId: string, id: string): Promise<string> {
  await db.query(
    `INSERT INTO agent_task_budgets
       (id, agent_id, chain_id, token_address, recipient_address, parent_delegation_hash,
        delegation_hash, delegation_json, max_atomic, status, expires_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, '{}', '1000000', 'open', 9999999999)`,
    [id, agentId, CHAIN, USDC, `0x${String(++seq).padStart(64, '3')}`, `0x${String(++seq).padStart(64, '4')}`],
  )
  return id
}

/** An OPEN sub-budget owned by the agent — the FK target for the pin case. */
async function seedSubBudget(agentId: string, id: string): Promise<string> {
  await db.query(
    `INSERT INTO agent_sub_budgets
       (id, agent_id, parent_agent_id, chain_id, token_address, recipient_address,
        parent_delegation_hash, delegation_hash, delegation_json, period_amount_atomic, status, expires_at)
     VALUES ($1, $2, $2, $3, $4, NULL, $5, $6, '{}', '1000000', 'open', 9999999999)`,
    [id, agentId, CHAIN, USDC, `0x${String(++seq).padStart(64, '5')}`, `0x${String(++seq).padStart(64, '6')}`],
  )
  return id
}

function erc7710Body(key: string): Record<string, unknown> {
  return {
    url: RESOURCE_URL,
    payTo: MERCHANT,
    amount: AMOUNT,
    asset: USDC,
    network: `eip155:${CHAIN}`,
    idempotencyKey: key,
  }
}

function fundingBody(key: string): Record<string, unknown> {
  return {
    url: RESOURCE_URL,
    payTo: DELEGATE,
    merchantPayTo: MERCHANT,
    amount: AMOUNT,
    asset: USDC,
    network: `eip155:${CHAIN}`,
    settlementScheme: 'eip3009',
    idempotencyKey: key,
  }
}

describeDb('#4826 — a submitted x402 replay answers a typed 409 at the first replay call', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })
  beforeEach(async () => {
    await resetDb()
    vi.clearAllMocks()
    // Every link is SHORT: a pre-check that ran would refuse 403.
    mockRemaining.mockResolvedValue({ remainingAtomic: '100', fromChain: true })
    mockEnsureDeployed.mockResolvedValue({ address: DELEGATE_ACCOUNT, alreadyDeployed: true })
    mockPrepareFunding.mockResolvedValue({
      delegationHash: `0x${'12'.repeat(32)}`,
      prepared: {
        userOpHash: `0x${'34'.repeat(32)}`,
        userOperation: { sender: DELEGATE_ACCOUNT, nonce: '1', callData: '0x' },
        delegateAccountAddress: DELEGATE_ACCOUNT,
      },
    })
  })

  async function refusalCount(): Promise<number> {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM payment_refusals`)
    return Number(rows[0].n)
  }

  async function authorize(apiKey: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/x402/authorize',
      headers: { authorization: `Bearer ${apiKey}` },
      payload,
    })
  }

  it('erc7710: answers the typed 409 with the id and status, before the cap, the budget read and the deploy check', async () => {
    const seeded = await seedAgent()
    const key = 'submitted-erc7710'
    const id = await seedSubmittedIntent(seeded, key)
    const refusalsBefore = await refusalCount()

    const res = await authorize(seeded.apiKey, erc7710Body(key))

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      error_code: 'payment_already_submitted',
      payment_id: id,
      status: 'submitted',
    })
    expect(typeof res.json().error).toBe('string')
    expect(res.json().error).toContain('do not authorize again')
    // The answer came from the FIRST replay call: no pre-check ran.
    expect(mockRemaining).not.toHaveBeenCalled()
    expect(mockEnsureDeployed).not.toHaveBeenCalled()
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    expect(await refusalCount()).toBe(refusalsBefore)

    // Control: the agent really IS at its hourly cap — a FRESH key answers
    // 429, so the typed answer above could only have come from the replay.
    const fresh = await authorize(seeded.apiKey, erc7710Body('submitted-erc7710-fresh'))
    expect(fresh.statusCode).toBe(429)
  })

  it('eip3009 funding leg: the same typed 409, before the funding prepare', async () => {
    const seeded = await seedAgent()
    const key = 'submitted-funding'
    const id = await seedSubmittedIntent(seeded, key, {
      toAddress: DELEGATE,
      settlementScheme: 'eip3009',
    })
    const refusalsBefore = await refusalCount()

    const res = await authorize(seeded.apiKey, fundingBody(key))

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      error_code: 'payment_already_submitted',
      payment_id: id,
      status: 'submitted',
    })
    expect(mockRemaining).not.toHaveBeenCalled()
    expect(mockEnsureDeployed).not.toHaveBeenCalled()
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    expect(await refusalCount()).toBe(refusalsBefore)

    const fresh = await authorize(seeded.apiKey, fundingBody('submitted-funding-fresh'))
    expect(fresh.statusCode).toBe(429)
  })

  it('a different task budget is the existing mismatch 409, not the typed replay', async () => {
    const seeded = await seedAgent()
    const key = 'submitted-task-budget'
    const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await seedTaskBudget(seeded.agentId, taskId)
    const id = await seedSubmittedIntent(seeded, key, { taskBudgetId: taskId })

    const res = await authorize(seeded.apiKey, erc7710Body(key))

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      payment_id: id,
      status: 'submitted',
      error: 'idempotencyKey already belongs to a different x402 task_budget',
    })
    expect(res.json().error_code).toBeUndefined()
    expect(mockRemaining).not.toHaveBeenCalled()
  })

  it('a different sub-budget is the existing mismatch 409, not the typed replay', async () => {
    const seeded = await seedAgent()
    const key = 'submitted-sub-budget'
    const subId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedSubBudget(seeded.agentId, subId)
    const id = await seedSubmittedIntent(seeded, key, { subBudgetId: subId })

    const res = await authorize(seeded.apiKey, erc7710Body(key))

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      payment_id: id,
      status: 'submitted',
      error: 'idempotencyKey already belongs to a different x402 sub_budget',
    })
    expect(res.json().error_code).toBeUndefined()
    expect(mockRemaining).not.toHaveBeenCalled()
  })

  it('a different resource URL is the existing mismatch 409, not the typed replay', async () => {
    const seeded = await seedAgent()
    const key = 'submitted-resource'
    const id = await seedSubmittedIntent(seeded, key, { resourceUrl: 'https://merchant.example/other' })

    const res = await authorize(seeded.apiKey, erc7710Body(key))

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      payment_id: id,
      status: 'submitted',
      error: 'idempotencyKey already belongs to a different x402 resource_url',
    })
    expect(res.json().error_code).toBeUndefined()
    expect(mockRemaining).not.toHaveBeenCalled()
  })
})
