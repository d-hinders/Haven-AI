/**
 * Real-Postgres route tests for `GET /machine-payments/balance-coverage`
 * (#3126). No mocks for the derivation — the acceptance criteria are claims
 * about the RAIL-AWARE read and the sufficiency compare, not about mocks.
 * Only the CHAIN read is stubbed (`infra/chain/index.ts`'s ChainClient
 * port), because the question "does the account hold funds" is answered by
 * a chain the test database cannot host:
 *
 *  - covered=true/false is `balanceOf(account) >= amount_atomic` asked of
 *    the chain, never of Haven's bookkeeping;
 *  - a failed chain read answers `covered: null` + `coverage_error` —
 *    unverifiable, never fabricated into false;
 *  - the account balance itself is NEVER in the response body (the #3126
 *    posture: a sufficiency signal, not a balance);
 *  - `budget_remaining_atomic` is the authority context, from the SAME
 *    #1090/#1145 derivation GET /machine-payments/allowances runs;
 *  - both retired rails answer 410 fail-closed like every rail-aware read.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetTokenBalance } = vi.hoisted(() => ({ mockGetTokenBalance: vi.fn() }))
vi.mock('../../infra/chain/index.js', () => ({
  getChainClient: () => ({
    getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
  }),
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

const AGENT_KEY = 'sk_agent_test1234567890abcdefgh'
const AGENT_KEY_HASH = createHash('sha256').update(AGENT_KEY).digest('hex')
const CHAIN = 84532 // Base Sepolia — the registry names USDC there
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'.toLowerCase()
const headers = { authorization: `Bearer ${AGENT_KEY}` }

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`coverage-${++seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

/** A delegation-rail agent whose key is AGENT_KEY (same seed shape as budget-precheck.test.ts). */
async function seedDelegationAgent(): Promise<{ userId: string; agentId: string; accountAddress: string }> {
  const userId = await seedUser()
  const accountAddress = '0x' + 'cd'.repeat(20)
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, accountAddress, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, 'coverage agent', $2, $3, 'sk_agent_tst', $4, 'active') RETURNING id`,
    [userId, '0x' + 'ab'.repeat(20), AGENT_KEY_HASH, account.rows[0].id],
  )
  return { userId, agentId: agent.rows[0].id, accountAddress }
}

/**
 * The agent's ACTIVE delegation: a real `agent_delegations` row — the #1090
 * derivation's source. `delegation_json` stays null so the remaining read
 * falls back to the configured full budget with `fromChain: false` (#1145's
 * optimistic fallback) — the deterministic behaviour the assertions pin.
 */
async function seedActiveDelegation(
  agentId: string,
  budgetAtomic: string,
  tokenAddress: string = USDC,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, delegation_hash, delegation_json, version, status,
        budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'active', $6, 604800, 0, 99999999999) RETURNING id`,
    [
      agentId,
      CHAIN,
      tokenAddress,
      `0x${String(++seq).padStart(64, '3')}`,
      JSON.stringify({ kind: 'test-fixture' }),
      budgetAtomic,
    ],
  )
  return rows[0].id
}

function coverageUrl(token: string, amountAtomic: string): string {
  return `/machine-payments/balance-coverage?token=${encodeURIComponent(token)}&amount_atomic=${encodeURIComponent(amountAtomic)}`
}

describeDb('GET /machine-payments/balance-coverage (#3126)', () => {
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
    mockGetTokenBalance.mockReset()
  })

  it('covered=true: a funded account behind a funded budget answers true, with no balance field anywhere', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '5000000') // 5.00 USDC permitted
    // The account holds 2.00 USDC — enough for the checked 1.00.
    mockGetTokenBalance.mockResolvedValue(2_000_000n)

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000'), headers })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/machine-payments/balance-coverage', res.json())
    expect(res.json()).toEqual({
      covered: true,
      chain_id: CHAIN,
      token_address: USDC,
      token_symbol: 'USDC',
      checked_amount_atomic: '1000000',
      budget_remaining_atomic: '5000000',
      budget_remaining_is_from_chain: false,
    })
    // The read asked the chain for the AGENT'S OWN ACCOUNT balance.
    expect(mockGetTokenBalance).toHaveBeenCalledWith(CHAIN, USDC, '0x' + 'cd'.repeat(20))

    // #3126's posture, enforced over the wire: no field in the response
    // carries the account's balance.
    const body = res.json() as Record<string, unknown>
    expect(Object.keys(body)).not.toContain('balance')
    expect(JSON.stringify(body)).not.toContain('2000000')
  })

  it('covered=false: an empty account behind a funded budget — the #3126 gap the tool exists to close', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '2000000') // 2.00 USDC permitted
    mockGetTokenBalance.mockResolvedValue(0n) // nothing held

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000'), headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      covered: false,
      checked_amount_atomic: '1000000',
      budget_remaining_atomic: '2000000',
    })
    // The authority figure stays visible as AUTHORITY, never as holdings.
    expect(res.json()).not.toHaveProperty('remaining_atomic')
    expect(res.json()).not.toHaveProperty('balance')
  })

  it('covered=null on a failed chain read, with coverage_error — never a fabricated false', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '2000000')
    mockGetTokenBalance.mockRejectedValue(new Error('rpc unreachable'))

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000'), headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.covered).toBeNull()
    expect(body.coverage_error).toBe('rpc unreachable')
    // Unverifiable still reports the authority context.
    expect(body.budget_remaining_atomic).toBe('2000000')
  })

  it('the amount the chain is compared against is the checked amount (>=, boundary included)', async () => {
    const { agentId } = await seedDelegationAgent()
    await seedActiveDelegation(agentId, '1000000')
    mockGetTokenBalance.mockResolvedValue(1_000_000n) // exactly the checked amount

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000'), headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().covered).toBe(true)
  })

  it('a token with no budget row answers budget_remaining_atomic "0" and no provenance flag', async () => {
    const { agentId } = await seedDelegationAgent()
    // A delegation on ANOTHER token: the USDC question matches nothing.
    await seedActiveDelegation(agentId, '5000000', '0x' + '11'.repeat(20))
    mockGetTokenBalance.mockResolvedValue(3_000_000n)

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000'), headers })
    expect(res.statusCode).toBe(200)
    expect(res.json().budget_remaining_atomic).toBe('0')
    expect(res.json()).not.toHaveProperty('budget_remaining_is_from_chain')
    expect(res.json().covered).toBe(true)
  })

  it('a malformed amount_atomic is a 400 before any read', async () => {
    await seedDelegationAgent()

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '-5'), headers })
    expect(res.statusCode).toBe(400)
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it('a missing token is a 400', async () => {
    await seedDelegationAgent()

    const res = await app.inject({
      method: 'GET',
      url: '/machine-payments/balance-coverage?amount_atomic=1000000',
      headers,
    })
    expect(res.statusCode).toBe(400)
  })

  it('both retired rails answer 410 fail-closed — nothing is derived and no chain read happens', async () => {
    const userId = await seedUser()
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, $3, 'session_key', 'legacy_safe') RETURNING id`,
      [userId, '0x' + 'ee'.repeat(20), CHAIN],
    )
    await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
       VALUES ($1, 'retired agent', $2, $3, 'sk_agent_tst', $4, 'active') RETURNING id`,
      [userId, '0x' + 'ab'.repeat(20), AGENT_KEY_HASH, account.rows[0].id],
    )

    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000'), headers })
    expect(res.statusCode).toBe(410)
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })

  it('an unauthenticated call is a 401 — the agent key is the only door', async () => {
    const res = await app.inject({ method: 'GET', url: coverageUrl(USDC, '1000000') })
    expect(res.statusCode).toBe(401)
  })
})
