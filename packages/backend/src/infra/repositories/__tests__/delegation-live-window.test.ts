/**
 * #3802: every budget-VIEWING read applies the #1698 live window —
 * `start_date <= now < expires_at` beside `status = 'active'`.
 *
 * Before this, only the payment path (`SELECT_DELEGATION_FOR_PAYMENT_SQL`,
 * `SELECT_ACTIVE_DELEGATION_BY_HASH_SQL`) filtered the window; every view of
 * a budget still presented a grant the on-chain TimestampEnforcer would
 * refuse — an expired one as "5.00 USDC/daily", a future-dated one as live
 * authority that can activate an agent. This pins the shared fragment's
 * reach: one agent seeded with an EXPIRED, a FUTURE and a LIVE delegation,
 * and each reader returning only the live one.
 *
 * Real-DB, per `docs/contributing/testing-strategy.md`: every assertion is
 * about which rows a SQL predicate returns, including comparisons against
 * the DATABASE clock. No mocked pool.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listActiveDelegations } from '../delegation-budgets.js'
import { listActiveDelegationsForUser } from '../analytics.js'
import {
  OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL,
  readOpsOverview,
  readOpsUserDetail,
  readOpsOnchainView,
} from '../ops-reads.js'
import { listActiveDelegations as listSetupsActiveDelegations } from '../agent-connection-setups.js'
import { deriveDelegationBudgets } from '../../../rails/delegation-budget-view.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

let seq = 0

async function seedDelegationRailAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`win${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  // The delegation-rail join (`DELEGATION_RAIL_JOIN`, the ops onchain view)
  // keys on `agents.account_id` → `smart_accounts.account_type`.
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, name, is_default, account_type)
     VALUES ($1, $2, 'Window account', true, 'delegator_hybrid') RETURNING id`,
    [user.rows[0].id, `0x${'a'.repeat(40)}`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, status, account_id) VALUES ($1, 'Window agent', 'active', $2) RETURNING id`,
    [user.rows[0].id, account.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

async function seedDelegation(
  agentId: string,
  over: { startDate?: number; expiresAt?: number; recipientAddress?: string | null } = {},
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds,
        start_date, expires_at, created_at)
     VALUES ($1, 84532, $2, $3, $4, '{}', 1, 'active', '1000000', 86400, $5, $6, NOW())
     RETURNING id`,
    [
      agentId,
      USDC,
      over.recipientAddress ?? null,
      `0x${String(++seq).padStart(64, '0')}`,
      over.startDate ?? 0,
      over.expiresAt ?? 9_999_999_999,
    ],
  )
  return result.rows[0].id
}

/** One agent, three grants: only the LIVE one is presented as a budget. */
async function seedExpiredFutureLive(agentId: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  await seedDelegation(agentId, { expiresAt: nowSec - 60 }) // expired
  await seedDelegation(agentId, { startDate: nowSec + 3_600 }) // future-dated
  return seedDelegation(agentId) // live
}

describeDb('#3802 — budget views apply the live window to active delegations', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('listActiveDelegations returns only the live grant', async () => {
    const { agentId } = await seedDelegationRailAgent()
    const live = await seedExpiredFutureLive(agentId)

    const rows = await listActiveDelegations([agentId])

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(live)
  })

  it('deriveDelegationBudgets (dashboard, agents routes, allowances read) derives only the live grant', async () => {
    const { agentId } = await seedDelegationRailAgent()
    const live = await seedExpiredFutureLive(agentId)

    const derived = (await deriveDelegationBudgets([agentId])).get(agentId) ?? []

    expect(derived).toHaveLength(1)
    expect(derived[0].id).toBe(live)
  })

  it('listActiveDelegationsForUser (analytics budget-remaining slice) returns only the live grant', async () => {
    const { userId, agentId } = await seedDelegationRailAgent()
    const live = await seedExpiredFutureLive(agentId)

    const rows = await listActiveDelegationsForUser(userId)

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(live)
  })

  it('ops overview counts only the live grant as active', async () => {
    await seedDelegationRailAgent()
    await seedExpiredFutureLive((await db.query<{ id: string }>(`SELECT id FROM agents LIMIT 1`)).rows[0].id)

    expect((await db.query<{ count: number }>(OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL, [])).rows[0].count).toBe(1)
    // The composed overview read agrees with the raw predicate.
    const overview = await readOpsOverview(db)
    expect(overview.activeDelegations).toBe(1)
  })

  it('ops user detail lists only the live grant', async () => {
    const { userId, agentId } = await seedDelegationRailAgent()
    const live = await seedExpiredFutureLive(agentId)

    const detail = await readOpsUserDetail(db, userId)

    expect(detail?.delegations).toHaveLength(1)
    expect(detail?.delegations[0].id).toBe(live)
  })

  it('ops onchain view reads only the live grant', async () => {
    const { userId, agentId } = await seedDelegationRailAgent()
    await seedExpiredFutureLive(agentId)

    const view = await readOpsOnchainView(db, userId)

    expect(view?.accounts).toHaveLength(1)
    expect(view?.accounts[0].delegations).toHaveLength(1)
  })

  it('the connect activation check sees only the live grant — an expired grant cannot activate an agent', async () => {
    const { agentId } = await seedDelegationRailAgent()
    await seedExpiredFutureLive(agentId)

    const rows = await listSetupsActiveDelegations(agentId)

    expect(rows).toHaveLength(1)
    expect(rows[0].budget_atomic).toBe('1000000')
  })
})
