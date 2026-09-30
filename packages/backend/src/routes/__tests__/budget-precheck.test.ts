/**
 * Real-Postgres route tests for `POST /machine-payments/budget-precheck`
 * (#3054, slice 3 of epic #3056). No mocks — the issue's acceptance criteria
 * are claims about the LEDGER, not about mocks:
 *
 *  - an over-budget quote is refused 403 `delegation_budget_exceeded` and the
 *    `payment_refusals` row lands through the #3053 choke point (`refuse()`
 *    → `recordRefusalFireAndForget` → the real `recordPaymentRefusal` SQL),
 *    with `source = 'hosted_prepare'` — the row is server-decided, never
 *    agent-asserted (Daniel S1);
 *  - a sufficient quote answers 200 `{ sufficient: true, remaining_atomic }`
 *    and writes NO row;
 *  - the dedupe fold key is UNCHANGED (epic decision 4): a second refusal of
 *    the same `(agent_id, reason, resource_url)` inside the 60-second window
 *    folds into ONE row with `attempts = 2` and `source = 'hosted_prepare'`;
 *  - the taxonomy body (`phase`, `next_action`, remaining/shortfall atomic)
 *    is what the hosted tool's byte-identical relay is built from;
 *  - the retired rails answer 410 fail-closed like every rail-aware surface;
 *  - a malformed body is a 400 before any comparison runs.
 *
 * Stub surface is ONE module (`prices.js`), exactly as
 * `modules/payments/__tests__/refusal-ledger.test.ts` established: the fiat
 * booking rides the same `getFiatValuesForTokenAmount` path settled payments
 * use, and a known price pins the arithmetic without a network. Everything
 * between the HTTP call and the `payment_refusals` row is real — the auth
 * hook, the rail resolution, the #1090 derived-budget read, the #1145
 * enforcer reader, and the writer.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetTokenPrice } = vi.hoisted(() => ({ mockGetTokenPrice: vi.fn() }))
vi.mock('../../infra/prices.js', () => ({
  getTokenPrice: (...a: unknown[]) => mockGetTokenPrice(...a),
}))

import db from '../../db.js'
import machinePaymentRoutes from '../machine-payments.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const AGENT_KEY = 'sk_agent_3054_real_db_route_test'
const AGENT_KEY_HASH = createHash('sha256').update(AGENT_KEY).digest('hex')
const CHAIN = 84532 // Base Sepolia — the registry names USDC there
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'.toLowerCase() // the 84532 registry's USDC
const RESOURCE_URL = 'https://merchant.example/3054-coffee'

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`precheck-${++seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

/** A delegation-rail agent whose key is AGENT_KEY (same seed shape as merchants.test.ts). */
async function seedDelegationAgent(): Promise<{ userId: string; agentId: string; accountId: string }> {
  const userId = await seedUser()
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, '0x' + 'cd'.repeat(20), CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, 'precheck agent', $2, $3, 'sk_agent_tst', $4, 'active') RETURNING id`,
    [userId, '0x' + 'ab'.repeat(20), AGENT_KEY_HASH, account.rows[0].id],
  )
  return { userId, agentId: agent.rows[0].id, accountId: account.rows[0].id }
}

/**
 * #3492: a stored x402 delegation-rail intent, the shape
 * `findX402IntentByIdempotencyKey` (`SELECT *`) hands the pre-check — same
 * table, same columns as the replay guard's own fixture
 * (`routes/__tests__/x402-task-budget-replay.test.ts`). Defaults: a
 * SETTLED erc7710 row matching `precheckBody()`'s quote exactly; per-case
 * overrides move exactly one thing off that match.
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
    taskBudgetId: string | null
    subBudgetId: string | null
  }> = {},
): Promise<string> {
  const row = {
    status: 'confirmed',
    txHash: `0x${'99'.repeat(32)}` as string | null,
    settlementScheme: 'erc7710',
    merchantTo: '0x' + 'ee'.repeat(20),
    resourceUrl: RESOURCE_URL,
    tokenAddress: USDC,
    amountRaw: '1000000',
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
        x402_idempotency_key, machine_idempotency_key, task_budget_id, sub_budget_id)
     VALUES ($1, $2, $3, 'USDC', $4, $5,
             $6, '1.0', $7, 0, $8,
             $9, $10, NOW() + interval '10 minutes', 'delegation', $11, 'x402', 'x402',
             $12, $13, $14, $15, $15, $16, $17)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      '0x' + 'cd'.repeat(20),
      row.tokenAddress,
      row.merchantTo,
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

/**
 * The agent's ACTIVE delegation: a real `agent_delegations` row — the #1090
 * derivation's source. `delegation_json` stays null unless stated; the
 * remaining read then falls back to the configured full budget with
 * `fromChain: false` (#1145's optimistic fallback), which is exactly the
 * deterministic behaviour the assertions below pin.
 */
async function seedActiveDelegation(
  agentId: string,
  budgetAtomic: string,
  overrides: { delegationJson?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, delegation_hash, delegation_json, version, status,
        budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'active', $6, 604800, 0, 99999999999) RETURNING id`,
    [
      agentId,
      CHAIN,
      USDC,
      `0x${String(++seq).padStart(64, '3')}`,
      overrides.delegationJson ?? JSON.stringify({ kind: 'test-fixture' }),
      budgetAtomic,
    ],
  )
  return rows[0].id
}

interface RefusalRow {
  reason: string
  source: string
  attempts: number
  resource_url: string | null
  merchant_to: string | null
  token_symbol: string
  amount_atomic: string
  detail: Record<string, string> | null
}

async function refusalRows(agentId: string): Promise<RefusalRow[]> {
  const { rows } = await db.query<RefusalRow>(
    `SELECT reason, source, attempts, resource_url, merchant_to, token_symbol, amount_atomic, detail
       FROM payment_refusals WHERE agent_id = $1 ORDER BY created_at, id`,
    [agentId],
  )
  return rows
}

describeDb('POST /machine-payments/budget-precheck (#3054)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    // The route file registers the plugin-wide agent auth hook itself
    // (`app.addHook('onRequest', agentAuthMiddleware)`), so the REAL
    // credential path — sha256 key hash → agents/smart_accounts JOIN — runs.
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  beforeEach(async () => {
    await resetDb()
    mockGetTokenPrice.mockReset()
    mockGetTokenPrice.mockResolvedValue({ usd: 1, eur: 0.92 })
  })

  const headers = { authorization: `Bearer ${AGENT_KEY}` }

  function precheckBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      chainId: CHAIN,
      token: USDC,
      amountAtomic: '1000000',
      merchantTo: '0x' + 'ee'.repeat(20),
      resourceUrl: RESOURCE_URL,
      ...overrides,
    }
  }

  // ── Over budget: 403 + ONE ledger row through refuse() ───────────────────

  it('an over-budget quote refuses 403 delegation_budget_exceeded and lands exactly one hosted_prepare row', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '500000') // 0.50 USDC remaining

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(403)

    const body = res.json()
    expect(body.error_code).toBe('delegation_budget_exceeded')
    expect(body.phase).toBe('insufficient_funds')
    expect(body.next_action).toBe('fund_account_or_raise_allowance')
    expect(body.remaining_atomic).toBe('500000')
    expect(body.amount_atomic).toBe('1000000')
    expect(body.shortfall_atomic).toBe('500000')
    expect(body.resource_url).toBe(RESOURCE_URL)
    expect(body.merchant_address).toBe('0x' + 'ee'.repeat(20))

    // The refusal response is decided before the fire-and-forget write lands;
    // wait for it, then prove the row the choke point recorded.
    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
    const rows = await refusalRows(agentId)
    expect(rows[0]).toMatchObject({
      reason: 'delegation_budget_exceeded',
      source: 'hosted_prepare',
      attempts: 1,
      resource_url: RESOURCE_URL,
      merchant_to: '0x' + 'ee'.repeat(20),
      token_symbol: 'USDC',
      amount_atomic: '1000000',
    })
    // The 086 detail allowlist keeps the taxonomy fields the hosted tool's
    // relay is built from — and nothing else.
    expect(rows[0].detail).toMatchObject({
      error_code: 'delegation_budget_exceeded',
      phase: 'insufficient_funds',
      next_action: 'fund_account_or_raise_allowance',
      remaining_atomic: '500000',
    })

    // The price path is the ledger's own contract — the row books through the
    // SAME getFiatValuesForTokenAmount path settled payments use.
    expect(mockGetTokenPrice).toHaveBeenCalledWith('USDC')

    // The row must satisfy the auth-failure mode of a self-report endpoint:
    // it exists ONLY because Haven's compare decided it — the same request
    // without the over-budget fact writes nothing (proven below).
    expect(rows[0].amount_atomic).toBe('1000000')
    expect(userId).toBeTruthy()
  })

  // ── Sufficient: 200, no row ──────────────────────────────────────────────

  it('a sufficient quote answers 200 sufficient:true with the remaining figure and writes no row', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '5000000') // 5.00 USDC remaining

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('POST', '/machine-payments/budget-precheck', res.json())
    expect(res.json()).toEqual({ sufficient: true, remaining_atomic: '5000000', remaining_is_from_chain: false })
    // `remaining_is_from_chain: false` = the #1145 OPTIMISTIC fallback (no
    // delegation json to read): a real sufficient answer, warning-grade
    // provenance only — never a refusal.

    await new Promise((r) => setTimeout(r, 50))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  it('an amount exactly equal to the remaining budget is sufficient (the hosted compare is >=)', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '1000000')

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(200)
    expect(res.json().sufficient).toBe(true)
  })

  it('no budget row for the token means remaining 0 — insufficient, exactly as the hosted tool answered', async () => {
    const { agentId } = await seedDelegationAgent()
    // A delegation on ANOTHER token: the USDC quote matches nothing.
    await seedActiveDelegation(agentId, '5000000')
    await db.query(`UPDATE agent_delegations SET token_address = $1 WHERE agent_id = $2`, ['0x' + '11'.repeat(20), agentId])

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(403)
    expect(res.json().error_code).toBe('delegation_budget_exceeded')
    expect(res.json().remaining_atomic).toBe('0')

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  // ── The dedupe fold key is UNCHANGED (epic decision 4) ───────────────────

  it('a second over-budget pre-check on the same URL within 60s folds into one row with attempts = 2', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '500000')

    const first = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(first.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })

    const second = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(second.statusCode).toBe(403)

    await vi.waitFor(async () => {
      const rows = await refusalRows(agentId)
      expect(rows).toHaveLength(1)
      expect(rows[0].attempts).toBe(2)
      expect(rows[0].source).toBe('hosted_prepare')
    })
  })

  it('a pre-check on a DIFFERENT resource URL is its own row (the URL is the discriminating column)', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '500000')

    const first = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody(),
    })
    expect(first.statusCode).toBe(403)

    const second = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ resourceUrl: 'https://merchant.example/3054-other' }),
    })
    expect(second.statusCode).toBe(403)

    await vi.waitFor(async () => {
      const rows = await refusalRows(agentId)
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.attempts)).toEqual([1, 1])
    })
  })

  // ── Rail posture: retired rails fail closed before anything is derived ────

  it('a retired session-rail account answers 410 and writes nothing', async () => {
    const { agentId } = await seedDelegationAgent()
    await db.query(`UPDATE smart_accounts SET execution_rail = 'session_key' WHERE id = (SELECT account_id FROM agents WHERE id = $1)`, [agentId])
    await seedActiveDelegation(agentId, '5000000')

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(410)

    await new Promise((r) => setTimeout(r, 50))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  it('a retired allowance-module account answers 410 and writes nothing', async () => {
    const { agentId } = await seedDelegationAgent()
    await db.query(`UPDATE smart_accounts SET execution_rail = 'allowance_module' WHERE id = (SELECT account_id FROM agents WHERE id = $1)`, [agentId])
    await seedActiveDelegation(agentId, '5000000')

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(410)

    await new Promise((r) => setTimeout(r, 50))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  // ── Input validation: 400 before any comparison ──────────────────────────

  it('a malformed body is a 400 before the budget compare runs', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '5000000')

    const badToken = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ token: 'not-an-address' }),
    })
    expect(badToken.statusCode).toBe(400)

    const badAmount = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ amountAtomic: '-5' }),
    })
    expect(badAmount.statusCode).toBe(400)

    const missingAmount = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ amountAtomic: undefined }),
    })
    expect(missingAmount.statusCode).toBe(400)

    await new Promise((r) => setTimeout(r, 50))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  // ── #3492: a settled erc7710 replay is sufficient — no refusal, no row ──

  it('a confirmed keyed erc7710 row with LOW remaining budget answers sufficient (no 403, no refusal row)', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100') // far below the quote's 1000000
    await seedX402Intent({ userId, agentId }, 'catalog-settled-key-1')

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-settled-key-1' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expectMatchesSpec('POST', '/machine-payments/budget-precheck', body)
    expect(body.sufficient).toBe(true)
    expect(body.replay).toBe(true)
    // The remaining figure is still the TRUE (now-spent) figure — the
    // replay branch never fabricates headroom, it only skips the refusal.
    expect(body.remaining_atomic).toBe('100')

    await new Promise((r) => setTimeout(r, 50))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  it('a pending_signature child (unexpired) is still refused — only a SETTLED row bypasses the compare', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-pending-key-1', {
      status: 'pending_signature',
      txHash: null,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-pending-key-1' }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error_code).toBe('delegation_budget_exceeded')

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a key collision on a DIFFERENT payee is still refused — the settled row does not match this quote', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-mismatch-key-1', {
      merchantTo: '0x' + 'ff'.repeat(20), // different payee than precheckBody()'s merchantTo
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-mismatch-key-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a key collision on a DIFFERENT resource is still refused', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-mismatch-key-2', {
      resourceUrl: 'https://merchant.example/some-other-resource',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-mismatch-key-2' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a settled EIP-3009 row (settlement_scheme eip3009) is still refused — this fix is erc7710-only', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-eip3009-key-1', {
      settlementScheme: 'eip3009',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-eip3009-key-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a row scoped to a task budget is still refused — the catalog preflight never authorizes against one', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO agent_task_budgets
         (agent_id, chain_id, token_address, parent_delegation_hash, delegation_hash,
          delegation_json, max_atomic, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, '{}', '5000000', 'open', $6) RETURNING id`,
      [agentId, CHAIN, USDC, `0x${String(++seq).padStart(64, '5')}`, `0x${String(++seq).padStart(64, '6')}`, Date.now() + 600_000],
    )
    await seedX402Intent({ userId, agentId }, 'catalog-taskbudget-key-1', {
      taskBudgetId: rows[0].id,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-taskbudget-key-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('no idempotencyKey in the body means the existing compare runs unchanged (still refused)', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    // A settled row EXISTS under a key, but this request never names it.
    await seedX402Intent({ userId, agentId }, 'catalog-unused-key-1')

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: precheckBody() })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('an idempotencyKey with no matching row runs the existing compare unchanged (still refused)', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-nonexistent-key' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a settled erc7710 replay with SUFFICIENT budget still answers sufficient (replay never blocks a fit)', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '5000000')
    await seedX402Intent({ userId, agentId }, 'catalog-settled-key-2')

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-settled-key-2' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expectMatchesSpec('POST', '/machine-payments/budget-precheck', body)
    expect(body).toMatchObject({ sufficient: true, replay: true })

    await new Promise((r) => setTimeout(r, 50))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  // ── #3492 review round 1: S1 keyed-row twins for the remaining guards ────

  it('a key collision on a DIFFERENT amount is still refused', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-mismatch-amount-1', {
      amountRaw: '2000000', // precheckBody()'s amountAtomic is '1000000'
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-mismatch-amount-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a key collision on a DIFFERENT token is still refused', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-mismatch-token-1', {
      tokenAddress: '0x' + '22'.repeat(20), // precheckBody()'s token is USDC
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-mismatch-token-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a row scoped to a SUB-budget is still refused — the catalog preflight never authorizes against one', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO agent_sub_budgets
         (agent_id, parent_agent_id, chain_id, token_address, parent_delegation_hash,
          delegation_hash, delegation_json, period_amount_atomic, status, expires_at)
       VALUES ($1, $1, $2, $3, $4, $5, '{}', '5000000', 'open', $6) RETURNING id`,
      [agentId, CHAIN, USDC, `0x${String(++seq).padStart(64, '5')}`, `0x${String(++seq).padStart(64, '6')}`, Date.now() + 600_000],
    )
    await seedX402Intent({ userId, agentId }, 'catalog-subbudget-key-1', {
      subBudgetId: rows[0].id,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-subbudget-key-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a confirmed row with a NULL tx_hash is still refused — confirmed alone is not settled', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-confirmed-no-txhash-1', {
      status: 'confirmed',
      txHash: null,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers,
      payload: precheckBody({ idempotencyKey: 'catalog-confirmed-no-txhash-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  // ── #3492 review round 1: N1 — resourceUrl/merchantTo are REQUIRED ───────

  it('a key that would otherwise replay is still refused when the request omits resourceUrl', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-no-resourceurl-1')

    const body = precheckBody({ idempotencyKey: 'catalog-no-resourceurl-1' })
    delete (body as Record<string, unknown>).resourceUrl

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: body })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  it('a key that would otherwise replay is still refused when the request omits merchantTo', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    await seedX402Intent({ userId, agentId }, 'catalog-no-merchantto-1')

    const body = precheckBody({ idempotencyKey: 'catalog-no-merchantto-1' })
    delete (body as Record<string, unknown>).merchantTo

    const res = await app.inject({ method: 'POST', url: '/machine-payments/budget-precheck', headers, payload: body })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
  })

  // ── #3492 review round 1: N4 — the lookup is scoped to the caller's OWN agent ─

  it('a settled row under the same key but a DIFFERENT agent never replays for this agent', async () => {
    const { userId, agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '100')
    // Agent B's settled row, same idempotency key text — but a fresh agent
    // (its own user/account), so `findX402IntentByIdempotencyKey` (scoped by
    // agent_id) must never find it for agent A's request below.
    const other = await seedDelegationAgent()
    await seedX402Intent({ userId: other.userId, agentId: other.agentId }, 'catalog-cross-agent-key-1')

    const res = await app.inject({
      method: 'POST',
      url: '/machine-payments/budget-precheck',
      headers, // agent A's key
      payload: precheckBody({ idempotencyKey: 'catalog-cross-agent-key-1' }),
    })
    expect(res.statusCode).toBe(403)

    await vi.waitFor(async () => {
      expect(await refusalRows(agentId)).toHaveLength(1)
    })
    expect(userId).toBeTruthy()
  })
})
