/**
 * #3619 — one settled-replay RULE, three readings, pinned in one table.
 *
 * Option (b) of the issue: the shared sentence — "a CONFIRMED row with a
 * tx_hash already moved its money; answering from the stored row must never
 * turn into a refusal" — is one rule, but each surface reads it with its own
 * MATCH around it. This file runs the SAME seeded `payment_intents` rows
 * through all three replay rules and asserts the documented difference cell
 * by cell, so a change to any side reddens here:
 *
 * | Cell | `delegationReplay` (modules/x402/replay.ts) | `isSettledX402Replay` (modules/mpp/budget-precheck.ts) | `findPaymentReplay` (routes/payments.ts, via POST /payments) |
 * |------|---------------------------------------------|---------------------------------------------------------|--------------------------------------------------------------|
 * | confirmed + tx_hash | 200 stored result | settled replay → `sufficient`, `replay: true` (never a 403) | 200 status replay |
 * | settlement scheme | no scheme condition (any value) | CLOSED SET `erc7710`/`eip3009`; anything else runs the compare (can 403) | no scheme condition |
 * | task/sub-budget pin | the request ids must EQUAL the row's (mismatch 409); pinned rows replay | row must carry NO pin; a pinned row runs the compare (can 403) | the request ids must EQUAL the row's (mismatch 409); pinned rows replay |
 * | payee/resource/token/amount | NOT compared on confirmed rows | must match the quote exactly; absent fields never match | compared as the key-collision pin (a mismatch 409s first) |
 * | confirmed, no tx_hash | falls through (null) | not settled → compare runs (can 403) | 200 status replay (no tx_hash condition) |
 * | submitted + tx_hash | null (not pending/confirmed) | not settled → compare runs (can 403) | 200 status replay (409 code for submitted) |
 *
 * The row-level invariants (ownership scoping, lazy expiry, the ledger row
 * the pre-check books) keep their own suites:
 * `routes/__tests__/budget-precheck.test.ts` (#3492/#3527/#3518),
 * `routes/__tests__/x402-task-budget-replay.test.ts` +
 * `modules/x402/__tests__/delegation-replay-lost-race.test.ts` (#3392), and
 * the direct-replay tests beside `payments.ts`. This file exists so a change
 * to EITHER settled-replay predicate cannot move the shared rule (or its
 * documented differences) without a red test naming the cell.
 */
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The two collaborators the pre-check's compare (and the route's period
// pre-check) would read from the chain — never a live chain here. The
// remaining figure these return is BELOW the seeded amounts, so a row the
// settled-replay rule does NOT accept is refused by the compare (403) —
// exactly the difference the cells assert.
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: async () => ({ remainingAtomic: '100', fromChain: true }),
}))
// The refusal ledger's write values the amount in fiat — pinned zero like
// `payments-period-budget.test.ts`; the ledger rows themselves are not this
// file's subject.
vi.mock('../../infra/fiat-values.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/fiat-values.js')>()
  return { ...actual, getFiatValuesForTokenAmount: async () => ({ usd: 0, eur: 0, sek: 0 }) }
})

import Fastify, { type FastifyInstance } from 'fastify'
import db from '../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../infra/__tests__/helpers/db-harness.js'
import machinePaymentRoutes from '../machine-payments.js'
import paymentRoutes from '../payments.js'
import { handleBudgetPrecheck } from '../../modules/mpp/budget-precheck.js'
import { delegationReplay } from '../../modules/x402/replay.js'
import type { AgentContext } from '../../middleware/agentAuth.js'

const CHAIN = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const MERCHANT = '0x' + 'ee'.repeat(20)
const RESOURCE_URL = 'https://merchant.example/3619-parity'

let seq = 0

/** A delegation-rail agent (real API key for the route cells, chain 84532). */
async function seedDelegationAgent(): Promise<{ userId: string; agentId: string; apiKey: string }> {
  const apiKey = `sk_agent_parity_${++seq}_${Date.now()}`
  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`parity-${seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = userRows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, '0x' + 'cd'.repeat(20), CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, 'parity agent', $2, $3, 'sk_agent_tst', $4, 'active') RETURNING id`,
    [userId, '0x' + 'ab'.repeat(20), createHash('sha256').update(apiKey).digest('hex'), account.rows[0].id],
  )
  return { userId, agentId: agent.rows[0].id, apiKey }
}

/**
 * A stored x402 delegation-rail intent, the shape all three readers get from
 * their lookups (`SELECT *`). Defaults: a CONFIRMED erc7710 row matching the
 * parity quote exactly; per-case overrides move exactly one thing off that
 * match. Both idempotency-key columns carry the key so the same row serves
 * the x402 lookup, the pre-check lookup and the /payments lookup.
 */
async function seedX402Intent(
  owner: { userId: string; agentId: string },
  key: string,
  overrides: Partial<{
    status: string
    txHash: string | null
    settlementScheme: string
    merchantTo: string
    resourceUrl: string
    tokenAddress: string
    amountRaw: string
    toAddress: string
    taskBudgetId: string | null
    subBudgetId: string | null
  }> = {},
): Promise<string> {
  const row = {
    status: 'confirmed',
    txHash: `0x${'99'.repeat(32)}` as string | null,
    settlementScheme: 'erc7710',
    merchantTo: MERCHANT,
    resourceUrl: RESOURCE_URL,
    tokenAddress: USDC,
    amountRaw: '1000000',
    toAddress: MERCHANT,
    taskBudgetId: null as string | null,
    subBudgetId: null as string | null,
    ...overrides,
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, chain_id, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata,
        x402_idempotency_key, machine_idempotency_key, send_idempotency_key, task_budget_id, sub_budget_id)
     VALUES ($1, $2, $3, 'USDC', $4, $5,
             $6, '1.0', $7, 0, $8,
             $9, $10, NOW() + interval '10 minutes', 'delegation', $11, 'x402', 'x402',
             $12, $13, $14, $15, $15, $15, $16, $17)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      '0x' + 'cd'.repeat(20),
      row.tokenAddress,
      row.toAddress,
      row.amountRaw,
      '0x' + 'ab'.repeat(20),
      `0x${String(++seq).padStart(64, '7')}`,
      row.status,
      row.txHash,
      CHAIN,
      row.resourceUrl,
      row.merchantTo,
      JSON.stringify({ network: `eip155:${CHAIN}`, settlement_scheme: row.settlementScheme }),
      key,
      row.taskBudgetId,
      row.subBudgetId,
    ],
  )
  return rows[0].id
}

/** An OPEN task budget owned by the agent — the FK target for pin cells. */
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

/** An OPEN sub-budget owned by the agent — the FK target for the sub-budget pin cell. */
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

/** The AgentContext `handleBudgetPrecheck` and `delegationReplay` read. */
function mppAgent(seeded: { userId: string; agentId: string }): AgentContext {
  return {
    id: seeded.agentId,
    user_id: seeded.userId,
    name: 'parity agent',
    delegate_address: '0x' + 'ab'.repeat(20),
    account_address: '0x' + 'cd'.repeat(20),
    chain_id: CHAIN,
    status: 'active',
    execution_rail: 'delegation',
    account_type: 'delegator_hybrid',
  }
}

/** The parity quote: matches `seedX402Intent`'s defaults exactly. */
function precheckBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: CHAIN,
    token: USDC,
    amountAtomic: '1000000',
    merchantTo: MERCHANT,
    resourceUrl: RESOURCE_URL,
    ...overrides,
  }
}

/** The x402 replay request, matching the seeded row exactly by default. */
function x402Request(overrides: Record<string, unknown> = {}) {
  return {
    url: RESOURCE_URL,
    payTo: MERCHANT,
    merchantPayTo: MERCHANT,
    amountRaw: 1000000n,
    tokenAddress: USDC,
    tokenSymbol: 'USDC',
    network: 'eip155:84532',
    ...overrides,
  }
}

/** The POST /payments body, matching the seeded row exactly by default. */
function paymentsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'USDC',
    amount: '1.0',
    to: MERCHANT,
    idempotency_key: 'parity-key',
    ...overrides,
  }
}

describeDb('#3619 — one settled-replay rule, three readings (parity table)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })
  beforeEach(async () => {
    await resetDb()
  })

  /** Rule 2, through its public handler: the MPP pre-check's decision. */
  async function precheckDecision(
    seeded: { userId: string; agentId: string },
    bodyOverrides: Record<string, unknown> = {},
  ): Promise<{ code: number; body: Record<string, unknown> }> {
    const result = await handleBudgetPrecheck(
      mppAgent(seeded),
      precheckBody(bodyOverrides) as unknown as Parameters<typeof handleBudgetPrecheck>[1],
    )
    return { code: result.statusCode, body: result.body as Record<string, unknown> }
  }

  /** Rule 1: the x402 replay's decision. */
  async function x402ReplayDecision(
    seeded: { userId: string; agentId: string },
    rowId: string,
    requestOverrides: Record<string, unknown> = {},
  ): Promise<{ code: number | null; body: Record<string, unknown> | null }> {
    const existing = ((await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [rowId])).rows[0] ??
      {}) as Record<string, unknown>
    const result = await delegationReplay(existing, mppAgent(seeded), x402Request(requestOverrides))
    return { code: result ? result.code : null, body: result ? (result.body as Record<string, unknown>) : null }
  }

  /** Rule 3, through the route: POST /payments with the row's key. */
  async function paymentsReplayDecision(
    apiKey: string,
    bodyOverrides: Record<string, unknown> = {},
  ): Promise<{ code: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: paymentsBody(bodyOverrides),
    })
    return { code: res.statusCode, body: res.json() as Record<string, unknown> }
  }

  it('CELL 1 — confirmed erc7710 + tx_hash: x402 200s, pre-check answers sufficient (never 403), /payments 200s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-1'
    const rowId = await seedX402Intent(seeded, key)

    // Rule 1 (x402): the confirmed branch answers the stored result.
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(200)
    expect(x402.body).toMatchObject({ success: true, payment_id: rowId })

    // Rule 2 (MPP pre-check): sufficient by construction — the compare (which
    // would refuse against the mocked '100' remaining) never runs a 403.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(200)
    expect(mpp.body).toMatchObject({ sufficient: true, replay: true })

    // Rule 3 (/payments): a confirmed row is no longer pending_signature —
    // the stored status replays (200 for confirmed).
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(200)
    expect(payments.body).toMatchObject({ idempotent_replay: true, payment_id: rowId, status: 'confirmed' })
  })

  it('CELL 2 — UNKNOWN scheme: x402 still 200s (no scheme condition), pre-check runs the compare and refuses 403, /payments 200s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-2'
    const rowId = await seedX402Intent(seeded, key, { settlementScheme: 'some_future_scheme' })

    // Rule 1: no scheme condition on the confirmed branch.
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(200)

    // Rule 2: the scheme gate is a CLOSED set — an unknown scheme is not a
    // settled replay, so the compare runs and (remaining 100 < 1000000) refuses.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)
    expect(mpp.body).toMatchObject({ error_code: 'delegation_budget_exceeded' })

    // Rule 3: no scheme condition on the status replay.
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(200)
  })

  it('CELL 3 — settled EIP-3009: same reading as erc7710 on every rule', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-3'
    const rowId = await seedX402Intent(seeded, key, { settlementScheme: 'eip3009' })

    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(200)

    // #3527: a settled EIP-3009 funding leg is sufficient by construction.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(200)
    expect(mpp.body).toMatchObject({ sufficient: true, replay: true })

    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(200)
  })

  it('CELL 4 — task-budget pin: x402 409s an id-less retry, pre-check runs the compare and refuses 403, /payments 409s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-4'
    const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await seedTaskBudget(seeded.agentId, taskId) // the FK target the row pins
    const rowId = await seedX402Intent(seeded, key, { taskBudgetId: taskId })

    // Rule 1: the pin runs the OTHER way here — the row IS pinned and the
    // request names no id, so the pin MISMATCHES: a 409, never a replay.
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(409)
    expect(x402.body).toMatchObject({ error: 'idempotencyKey already belongs to a different x402 task_budget' })

    // Rule 2: the pre-check EXCLUDES pinned rows (the catalog preflight never
    // authorizes against one) — the compare runs and refuses.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)
    expect(mpp.body).toMatchObject({ error_code: 'delegation_budget_exceeded' })

    // Rule 3: the same pin-as-collision as x402 — a 409, not a replay.
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(409)
    expect(payments.body).toMatchObject({
      error: 'idempotency_key already belongs to a payment with a different task_budget',
    })
  })

  it('CELL 5 — sub-budget pin: the same three readings as the task-budget pin', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-5'
    const subId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedSubBudget(seeded.agentId, subId) // the FK target the row pins
    const rowId = await seedX402Intent(seeded, key, { subBudgetId: subId })

    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(409)
    expect(x402.body).toMatchObject({ error: 'idempotencyKey already belongs to a different x402 sub_budget' })

    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)
    expect(mpp.body).toMatchObject({ error_code: 'delegation_budget_exceeded' })

    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(409)
    expect(payments.body).toMatchObject({
      error: 'idempotency_key already belongs to a payment with a different sub_budget',
    })
  })

  it('CELL 6 — different payee: x402 still 200s (no payee compare on confirmed), pre-check refuses 403, /payments 409s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-6'
    const rowId = await seedX402Intent(seeded, key, { merchantTo: '0x' + 'dd'.repeat(20) })

    // Rule 1: confirmed rows compare NOTHING but the pin — a different payee
    // still replays 200 (existingX402IntentMismatch is pending-only).
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(200)

    // Rule 2: the quote names THIS payee, the row settled to another — not a
    // replay of this quote; the compare runs and refuses.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)
    expect(mpp.body).toMatchObject({ error_code: 'delegation_budget_exceeded' })

    // Rule 3: the direct rule pins token/recipient/amount — NOT the x402
    // merchant field — and the request's recipient IS the stored to_address,
    // so the same transfer replays its status even though the payee column
    // differs. THE CELL: rule 2 reads the payee, rules 1 and 3 do not.
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(200)
    expect(payments.body).toMatchObject({ idempotent_replay: true, payment_id: rowId, status: 'confirmed' })
  })

  it('CELL 7 — different resource: x402 200s, pre-check refuses 403, /payments 409s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-7'
    const rowId = await seedX402Intent(seeded, key, { resourceUrl: 'https://merchant.example/other' })

    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBe(200)

    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)

    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    // The direct rule pins token/recipient/amount — not the resource — so a
    // resource-only difference is NOT a 409 there: the status replay runs.
    expect(payments.code).toBe(200)
    expect(rowId).toBeTruthy()
  })

  it('CELL 8 — different amount: x402 200s, pre-check refuses 403, /payments 409s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-8'
    await seedX402Intent(seeded, key, { amountRaw: '2000000' })

    const x402 = await x402ReplayDecision(seeded, await db
      .query(`SELECT id FROM payment_intents WHERE x402_idempotency_key = $1`, [key])
      .then((r) => (r.rows[0] as { id: string }).id))
    expect(x402.code).toBe(200)

    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)

    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(409)
    expect(payments.body).toMatchObject({
      error: 'idempotency_key already belongs to a payment with a different amount',
    })
  })

  it('CELL 9 — confirmed, NO tx_hash: x402 falls through (null), pre-check refuses 403, /payments 200s', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-9'
    const rowId = await seedX402Intent(seeded, key, { txHash: null })

    // Rule 1: confirmed without a tx_hash misses the 200 branch and falls
    // through to null (the caller dead-ends on the replay-in-progress 409).
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBeNull()

    // Rule 2: `confirmed` alone is not settled — the compare runs and refuses
    // (the #3492 review twin pins the same cell on the pre-check suite).
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)
    expect(mpp.body).toMatchObject({ error_code: 'delegation_budget_exceeded' })

    // Rule 3: no tx_hash condition at all — the stored status replays.
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(200)
    expect(payments.body).toMatchObject({ idempotent_replay: true, status: 'confirmed' })
  })

  it('CELL 10 — SUBMITTED with tx_hash: x402 null, pre-check refuses 403, /payments 409 (status replay)', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-10'
    const rowId = await seedX402Intent(seeded, key, { status: 'submitted' })

    // Rule 1: neither pending_signature nor confirmed — null.
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBeNull()

    // Rule 2: only `confirmed` is settled — the compare refuses.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)

    // Rule 3: ANY non-pending status replays its stored status — submitted is
    // a 409 (in progress), not a 200.
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(409)
    expect(payments.body).toMatchObject({ idempotent_replay: true, payment_id: rowId, status: 'submitted' })
  })

  it('CELL 11 — pending_signature, ids matching, unexpired: x402 falls through to null, pre-check refuses, /payments replays sign_data (201)', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-11'
    const rowId = await seedX402Intent(seeded, key, { status: 'pending_signature' })

    // Rule 1: a pending row is not settled — with the pin matching and no
    // prepared_user_op, the replay falls through (the caller re-409s).
    const x402 = await x402ReplayDecision(seeded, rowId)
    expect(x402.code).toBeNull()

    // Rule 2: a pending row is never a settled replay — the compare refuses.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)

    // Rule 3: the direct rule REPLAYS a still-signable pending row with its
    // original 201 shape — the #961 discipline.
    const payments = await paymentsReplayDecision(seeded.apiKey, { idempotency_key: key })
    expect(payments.code).toBe(201)
    expect(payments.body).toMatchObject({ payment_id: rowId, idempotent_replay: true })
  })

  it('CELL 12 — the pin matching BOTH ids replays on rules 1 and 3, and still refuses on rule 2', async () => {
    const seeded = await seedDelegationAgent()
    const key = 'parity-key-12'
    const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await seedTaskBudget(seeded.agentId, taskId) // the FK target the row pins
    const rowId = await seedX402Intent(seeded, key, { taskBudgetId: taskId })

    // Rule 1: the request names the SAME task budget — the pin matches and
    // the confirmed row replays.
    const x402 = await x402ReplayDecision(seeded, rowId, { taskBudgetId: taskId })
    expect(x402.code).toBe(200)
    expect(x402.body).toMatchObject({ success: true, payment_id: rowId })

    // Rule 2: the pin on the ROW (not the request) excludes it regardless of
    // what the quote names — the compare refuses.
    const mpp = await precheckDecision(seeded, { idempotencyKey: key })
    expect(mpp.code).toBe(403)

    // Rule 3: same-as-x402 — the matching id replays the stored status.
    const payments = await paymentsReplayDecision(seeded.apiKey, {
      idempotency_key: key,
      task_budget_id: taskId,
    })
    expect(payments.code).toBe(200)
    expect(payments.body).toMatchObject({ idempotent_replay: true, payment_id: rowId })
  })
})
