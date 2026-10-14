/**
 * #3802 — the agent-facing allowances read (`GET /machine-payments/allowances`,
 * delegation rail) and the validity window.
 *
 * CHARACTERIZATION FIRST (the #1698 precedent: `delegation-selection-
 * characterization.test.ts`): this file pins what an agent whose only budget
 * is out of its validity window is TOLD about its spend readiness, before
 * the window reaches this read. The chain reader is the only mock — the
 * remaining figure is an RPC concern, not the thing under test; the pool is
 * real (no mocked pool, per `docs/contributing/testing-strategy.md`).
 *
 * The commit that adds this file asserts the OLD behaviour: `status =
 * 'active'` is the only filter, so an expired grant is reported as a live
 * allowance and the SDK derives `ready` for an agent that cannot spend a
 * single cent. The #3802 fix inverts the EXPIRED assertion: an agent whose
 * only budget expired now reports NO budget — `allowances: []` — so
 * readiness derives `needs_approval` instead of an authority the chain
 * would refuse. Round 2 (owner predicate): the NOT-STARTED assertion flips
 * the OTHER way — `start_date` is NOT filtered, because a credential
 * rotation writes a dormant "steady" row with a future `start_date` beside
 * the live "carry" row, and filtering future starts would hide the whole
 * budget for the carry window.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { handleGetAllowances } from '../allowances.js'
import type { AgentContext } from '../../../middleware/agentAuth.js'

vi.mock('../../../infra/chain/delegation-budget-reader.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Constant, `fromChain: false` — the fallback figure. `fromChain` false
  // also keeps the #3731 balance read (`getChainClient`) untriggered, so the
  // chain client is never constructed in this suite.
  readRemainingBudget: vi.fn(async () => ({ remainingAtomic: '1000000', fromChain: false })),
}))

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

let seq = 0

async function seedAgentWithDelegation(over: {
  startDate?: number
  expiresAt?: number
} = {}): Promise<AgentContext> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ready${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, name, is_default, account_type)
     VALUES ($1, $2, 'Readiness account', true, 'delegator_hybrid') RETURNING id`,
    [user.rows[0].id, `0x${'b'.repeat(40)}`],
  )
  const agent = await db.query<{ id: string; delegate_address: string }>(
    `INSERT INTO agents (user_id, name, status, account_id, delegate_address)
     VALUES ($1, 'Readiness agent', 'active', $2, $3)
     RETURNING id, delegate_address`,
    [user.rows[0].id, account.rows[0].id, `0x${'d'.repeat(40)}`],
  )
  const nowSec = Math.floor(Date.now() / 1000)
  await db.query(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds,
        start_date, expires_at, created_at)
     VALUES ($1, 84532, $2, NULL, $3, '{}', 1, 'active', '1000000', 86400, $4, $5, NOW())`,
    [
      agent.rows[0].id,
      USDC,
      `0x${String(++seq).padStart(64, '0')}`,
      over.startDate ?? 0,
      over.expiresAt ?? 9_999_999_999,
    ],
  )
  return {
    id: agent.rows[0].id,
    user_id: user.rows[0].id,
    name: 'Readiness agent',
    delegate_address: agent.rows[0].delegate_address,
    account_address: `0x${'c'.repeat(40)}`,
    chain_id: 84532,
    status: 'active',
    execution_rail: 'delegation',
    account_type: 'delegator_hybrid',
  }
}

describeDb('#3802 — allowances read vs the validity window (characterization)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('#3802: an agent whose only budget EXPIRED now reports NO budget — readiness derives needs_approval', async () => {
    // The characterization commit this file began as asserted the OLD
    // behaviour (expired → 1 allowance, `ready`) and passed on `dev`; the
    // #3802 fix inverts it: an out-of-window grant is not live authority,
    // so the agent-facing read reports none.
    const agent = await seedAgentWithDelegation({ expiresAt: Math.floor(Date.now() / 1000) - 60 })

    const result = await handleGetAllowances(agent)

    expect(result.statusCode).toBe(200)
    const body = result.body as { allowances: unknown[] }
    expect(body.allowances).toHaveLength(0)
  })

  it('#3802 round 2: a NOT-STARTED budget is STILL reported — start_date is not filtered (the dormant steady row)', async () => {
    // Round 1 pinned "not started → no budget" under the start_date window;
    // the owner predicate is `expires_at` ONLY: a future `start_date` row is
    // the dormant "steady" grant a credential rotation writes beside the
    // live "carry" row, and hiding it would blind the allowances read for
    // the whole carry window. The expired assertion above stays inverted.
    const agent = await seedAgentWithDelegation({ startDate: Math.floor(Date.now() / 1000) + 3_600 })

    const result = await handleGetAllowances(agent)

    expect(result.statusCode).toBe(200)
    const body = result.body as { allowances: { configured_amount: string }[] }
    expect(body.allowances).toHaveLength(1)
    expect(body.allowances[0].configured_amount).toBe('1.00')
  })

  it('a LIVE budget keeps being reported (the window must never hide a real one)', async () => {
    const agent = await seedAgentWithDelegation()

    const result = await handleGetAllowances(agent)

    expect(result.statusCode).toBe(200)
    const body = result.body as { allowances: { configured_amount: string }[] }
    expect(body.allowances).toHaveLength(1)
    // '1000000' atomic / 6 decimals — the human shape `deriveDelegationBudgets` emits.
    expect(body.allowances[0].configured_amount).toBe('1.00')
  })
})
