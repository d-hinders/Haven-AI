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
})
