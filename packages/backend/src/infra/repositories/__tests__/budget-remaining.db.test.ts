/**
 * Real-DB tests for the budget-remaining repository (#3804).
 *
 * Two statements are pinned against Postgres:
 *
 * 1. `listDashboardBudgetDelegations` — the user-scoped, fresh-every-request
 *    budget set. Isolation is the point of the user-B test: A's rows warm in
 *    the route's cache, and B's request must not return a single one of A's
 *    delegations. (The cache itself is keyed by (chain_id, delegation_hash)
 *    and the SET is read fresh per request — this query is what guarantees
 *    the response only ever names rows the requesting user owns.)
 *
 * 2. `listSubBudgetSpend` — confirmed payment_intents through a parent
 *    budget's sub-budget tree (parent-child + grants, migration 100),
 *    attributed per agent, inside the parent's CURRENT period. The helper
 *    agent pays through a sub-budget and the spend is found attributed to
 *    the parent budget; pending/refused intents and other periods never
 *    count; a CLOSED sub-budget's already-confirmed payments still do.
 *
 * Row builders are local per #1220's domain-free-harness rule.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  listDashboardBudgetDelegations,
  listSubBudgetSpend,
} from '../budget-remaining.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

let seq = 0

interface Seeded {
  userId: string
  agentId: string
}

async function seedAgent(nameSuffix: string): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`br${n}-${Date.now()}-${nameSuffix}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, $3, $4, $5, 'sk_agent_br', 'active') RETURNING id`,
    [userId, account.rows[0].id, `Budget Agent ${n} ${nameSuffix}`, `0x${String(n).padStart(40, 'b')}`, `hash-br-${n}-${Date.now()}`],
  )
  return { userId, agentId: agent.rows[0].id }
}

async function seedBudgetDelegation(seed: {
  agentId: string
  delegationHash?: string
  status?: string
  budgetAtomic?: string
  periodSeconds?: number
  startDate?: number
  expiresAt?: number
}): Promise<{ id: string; delegation_hash: string }> {
  const delegationHash =
    seed.delegationHash ?? `0x${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '').slice(0, 2)}`
  const result = await db.query<{ id: string; delegation_hash: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, delegation_hash, delegation_json, version,
        status, budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, 84532, $2, $3, $4, 1, $5, $6, $7, $8, $9)
     RETURNING id, delegation_hash`,
    [
      seed.agentId,
      USDC,
      delegationHash,
      '{"signed":"capability"}',
      seed.status ?? 'active',
      seed.budgetAtomic ?? '1000000',
      seed.periodSeconds ?? 86400,
      seed.startDate ?? Math.floor(Date.now() / 1000) - 60,
      seed.expiresAt ?? Math.floor(Date.now() / 1000) + 30 * 86400,
    ],
  )
  return result.rows[0]
}

async function seedSubBudget(seed: {
  agentId: string
  parentAgentId: string
  parentSubBudgetId: string | null
  parentDelegationHash: string
  status?: string
}): Promise<{ id: string; delegation_hash: string }> {
  const result = await db.query<{ id: string; delegation_hash: string }>(
    `INSERT INTO agent_sub_budgets
       (agent_id, parent_agent_id, parent_sub_budget_id, chain_id, token_address,
        parent_delegation_hash, delegation_hash, delegation_json, period_amount_atomic, status, expires_at)
     VALUES ($1, $2, $3, 84532, $4, $5, $6, $7, '500000', $8,
             floor(extract(epoch from now()) + 3600))
     RETURNING id, delegation_hash`,
    [
      seed.agentId,
      seed.parentAgentId,
      seed.parentSubBudgetId,
      USDC,
      seed.parentDelegationHash,
      `0x${randomUUID().replaceAll('-', '')}`,
      JSON.stringify({ unsigned: true }),
      seed.status ?? 'open',
    ],
  )
  return result.rows[0]
}

async function seedConfirmedPayment(seed: {
  agentId: string
  userId: string
  subBudgetId: string | null
  amountRaw: string
  confirmedAt?: string
  status?: string
}): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, confirmed_at, sub_budget_id)
     VALUES ($1, $2, '0x00000000000000000000000000000000000001', 'USDC',
             $3, '0x00000000000000000000000000000000000003', $4, '0.10',
             '0x00000000000000000000000000000000000004', 1, $5,
             $6, NOW() + interval '10 minutes',
             COALESCE($7::timestamptz, NOW()), $8)
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      USDC,
      seed.amountRaw,
      `0x${randomUUID().replaceAll('-', '')}`.slice(0, 66),
      seed.status ?? 'confirmed',
      seed.confirmedAt ?? null,
      seed.subBudgetId,
    ],
  )
  return result.rows[0].id
}

describeDb('budget-remaining repository (#3804)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── The user-scoped budget set ─────────────────────────────────────────────

  it('returns only the requesting user\u2019s active, unexpired budget delegations — B never sees A\u2019s', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    await seedBudgetDelegation({ agentId: a.agentId })
    await seedBudgetDelegation({ agentId: a.agentId, status: 'revoked' })
    await seedBudgetDelegation({ agentId: a.agentId, status: 'pending' })

    const rowsA = await listDashboardBudgetDelegations(a.userId)
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0].agent_id).toBe(a.agentId)
    expect(rowsA[0].token_symbol).toBe('USDC')

    // With A's entries warm (the route's cache), B's request returns NONE of
    // A's delegations — the set is read fresh per request, scoped to B.
    const rowsB = await listDashboardBudgetDelegations(b.userId)
    expect(rowsB).toHaveLength(0)
    expect(rowsB.some((r) => r.agent_id === a.agentId)).toBe(false)
  })

  it('applies #3802\u2019s expiry predicate: an expired grant is not a budget to show', async () => {
    const a = await seedAgent('a')
    await seedBudgetDelegation({ agentId: a.agentId, expiresAt: Math.floor(Date.now() / 1000) - 10 })
    const rows = await listDashboardBudgetDelegations(a.userId)
    expect(rows).toHaveLength(0)
  })

  it('keeps the future-dated steady row visible (start_date is NOT filtered, #3802 owner decision)', async () => {
    const a = await seedAgent('a')
    await seedBudgetDelegation({
      agentId: a.agentId,
      startDate: Math.floor(Date.now() / 1000) + 3600,
    })
    const rows = await listDashboardBudgetDelegations(a.userId)
    expect(rows).toHaveLength(1)
  })

  // ── Sub-budget attribution ─────────────────────────────────────────────────

  it('attributes a helper agent\u2019s confirmed sub-budget payment to the parent budget, per spending agent', async () => {
    const owner = await seedAgent('owner')
    const helper = await seedAgent('helper')
    const budget = await seedBudgetDelegation({ agentId: owner.agentId })
    const parentChild = await seedSubBudget({
      agentId: owner.agentId,
      parentAgentId: owner.agentId,
      parentSubBudgetId: null,
      parentDelegationHash: budget.delegation_hash,
    })
    const grant = await seedSubBudget({
      agentId: helper.agentId,
      parentAgentId: owner.agentId,
      parentSubBudgetId: parentChild.id,
      parentDelegationHash: parentChild.delegation_hash,
    })

    // The helper agent pays through its sub-budget grant…
    await seedConfirmedPayment({
      agentId: helper.agentId,
      userId: owner.userId,
      subBudgetId: grant.id,
      amountRaw: '300000',
    })
    // …and the parent-child carries the owner's own carve too.
    await seedConfirmedPayment({
      agentId: owner.agentId,
      userId: owner.userId,
      subBudgetId: parentChild.id,
      amountRaw: '150000',
    })

    const spend = await listSubBudgetSpend(budget.delegation_hash, 0, Math.floor(Date.now() / 1000) + 60)
    expect(spend).toHaveLength(2)
    const byAgent = new Map(spend.map((s) => [s.agent_id, s.spent_atomic]))
    expect(byAgent.get(helper.agentId)).toBe('300000')
    expect(byAgent.get(owner.agentId)).toBe('150000')
  })

  it('counts only CONFIRMED payments inside the window — pending, refused and other-period rows never count', async () => {
    const owner = await seedAgent('owner')
    const helper = await seedAgent('helper')
    const budget = await seedBudgetDelegation({ agentId: owner.agentId })
    const parentChild = await seedSubBudget({
      agentId: owner.agentId,
      parentAgentId: owner.agentId,
      parentSubBudgetId: null,
      parentDelegationHash: budget.delegation_hash,
    })
    const grant = await seedSubBudget({
      agentId: helper.agentId,
      parentAgentId: owner.agentId,
      parentSubBudgetId: parentChild.id,
      parentDelegationHash: parentChild.delegation_hash,
    })

    await seedConfirmedPayment({
      agentId: helper.agentId,
      userId: owner.userId,
      subBudgetId: grant.id,
      amountRaw: '111111',
      status: 'pending_signature',
    })
    // Confirmed but in a PREVIOUS period (window is half-open [start, end)).
    await seedConfirmedPayment({
      agentId: helper.agentId,
      userId: owner.userId,
      subBudgetId: grant.id,
      amountRaw: '222222',
      confirmedAt: '2000-01-01T00:00:00Z',
    })

    const nowSec = Math.floor(Date.now() / 1000)
    const spend = await listSubBudgetSpend(budget.delegation_hash, nowSec - 3600, nowSec + 60)
    expect(spend).toHaveLength(0)
  })

  it('includes a CLOSED sub-budget\u2019s already-confirmed payments', async () => {
    const owner = await seedAgent('owner')
    const budget = await seedBudgetDelegation({ agentId: owner.agentId })
    const parentChild = await seedSubBudget({
      agentId: owner.agentId,
      parentAgentId: owner.agentId,
      parentSubBudgetId: null,
      parentDelegationHash: budget.delegation_hash,
      status: 'closed',
    })
    await seedConfirmedPayment({
      agentId: owner.agentId,
      userId: owner.userId,
      subBudgetId: parentChild.id,
      amountRaw: '700000',
    })

    const spend = await listSubBudgetSpend(budget.delegation_hash, 0, Math.floor(Date.now() / 1000) + 60)
    expect(spend).toHaveLength(1)
    expect(spend[0].spent_atomic).toBe('700000')
  })

  it('a budget with no sub-budgets attributes nothing (empty, not an error)', async () => {
    const owner = await seedAgent('owner')
    const budget = await seedBudgetDelegation({ agentId: owner.agentId })
    const spend = await listSubBudgetSpend(budget.delegation_hash, 0, Math.floor(Date.now() / 1000) + 60)
    expect(spend).toEqual([])
  })

  it('an inverted window (end <= start) returns nothing without touching the database', async () => {
    const spend = await listSubBudgetSpend(`0x${'e'.repeat(64)}`, 100, 100)
    expect(spend).toEqual([])
  })
})
