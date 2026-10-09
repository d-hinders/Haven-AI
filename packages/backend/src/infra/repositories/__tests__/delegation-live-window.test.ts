/**
 * #3802 (round 2 — owner predicate): every budget-VIEWING read filters
 * `expires_at > EXTRACT(EPOCH FROM NOW())` ONLY, beside `status = 'active'`.
 * `start_date` is NOT filtered: a credential rotation writes a dormant
 * "steady" row with a FUTURE `start_date` beside the live "carry" row in the
 * same slot (`delegation-budgets.ts`, `rekey-carry.ts`) — filtering future
 * starts would hide the whole budget for the carry window.
 *
 * Before #3802 only the payment path (`SELECT_DELEGATION_FOR_PAYMENT_SQL`,
 * `SELECT_ACTIVE_DELEGATION_BY_HASH_SQL`) filtered expiry; every view of a
 * budget still presented a grant the on-chain TimestampEnforcer would refuse
 * — an expired one as "5.00 USDC/daily". This pins the shared fragment's
 * reach: one agent seeded with a LIVE, an EXPIRED, an EXPIRED-1-S-AGO and a
 * FUTURE-START delegation, and each reader returning exactly the live AND
 * the future-start rows.
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

/** One agent, four grants: exactly the LIVE and the FUTURE-START ones come back. */
async function seedFourWindowRows(
  agentId: string,
): Promise<{ live: string; future: string; liveHash: string; futureHash: string }> {
  const nowSec = Math.floor(Date.now() / 1000)
  await seedDelegation(agentId, { expiresAt: nowSec - 60 }) // expired a minute ago
  await seedDelegation(agentId, { expiresAt: nowSec - 1 }) // expired 1s ago — the exclusive bound
  const future = await seedDelegation(agentId, { startDate: nowSec + 3_600 }) // dormant steady row
  const live = await seedDelegation(agentId) // the live carry row
  const hashes = await db.query<{ id: string; delegation_hash: string }>(
    `SELECT id, delegation_hash FROM agent_delegations WHERE agent_id = $1 AND status = 'active'`,
    [agentId],
  )
  const byId = new Map(hashes.rows.map((r) => [r.id, r.delegation_hash]))
  return { live, future, liveHash: byId.get(live)!, futureHash: byId.get(future)! }
}

const windowReturn = (live: string, future: string) => [live, future].sort()

describeDb('#3802 — budget views apply the live window to active delegations', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('listActiveDelegations returns the live AND the future-start grant', async () => {
    const { agentId } = await seedDelegationRailAgent()
    const { live, future } = await seedFourWindowRows(agentId)

    const rows = await listActiveDelegations([agentId])

    expect(rows.map((r) => r.id).sort()).toEqual(windowReturn(live, future))
  })

  it('deriveDelegationBudgets (dashboard, agents routes, allowances read) derives the live AND the future-start grant', async () => {
    const { agentId } = await seedDelegationRailAgent()
    const { live, future } = await seedFourWindowRows(agentId)

    const derived = (await deriveDelegationBudgets([agentId])).get(agentId) ?? []

    expect(derived.map((r) => r.id).sort()).toEqual(windowReturn(live, future))
  })

  it('listActiveDelegationsForUser (analytics budget-remaining slice) returns the live AND the future-start grant', async () => {
    const { userId, agentId } = await seedDelegationRailAgent()
    const { live, future } = await seedFourWindowRows(agentId)

    const rows = await listActiveDelegationsForUser(userId)

    expect(rows.map((r) => r.id).sort()).toEqual(windowReturn(live, future))
  })

  it('ops overview counts the live and future-start grants as active (the two expired ones are not)', async () => {
    await seedDelegationRailAgent()
    await seedFourWindowRows((await db.query<{ id: string }>(`SELECT id FROM agents LIMIT 1`)).rows[0].id)

    expect((await db.query<{ count: number }>(OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL, [])).rows[0].count).toBe(2)
    // The composed overview read agrees with the raw predicate.
    const overview = await readOpsOverview(db)
    expect(overview.activeDelegations).toBe(2)
  })

  it('ops user detail lists the live AND the future-start grant', async () => {
    const { userId, agentId } = await seedDelegationRailAgent()
    const { live, future } = await seedFourWindowRows(agentId)

    const detail = await readOpsUserDetail(db, userId)

    expect(detail?.delegations.map((r) => r.id).sort()).toEqual(windowReturn(live, future))
  })

  it('ops onchain view reads the live AND the future-start grant', async () => {
    const { userId, agentId } = await seedDelegationRailAgent()
    const { liveHash, futureHash } = await seedFourWindowRows(agentId)

    const view = await readOpsOnchainView(db, userId)

    expect(view?.accounts).toHaveLength(1)
    // OpsOnchainDelegationRow projects delegation_hash, not id — the two
    // surviving grants are the live and future-start ones.
    expect(view?.accounts[0].delegations.map((r) => r.delegation_hash).sort()).toEqual(
      [liveHash, futureHash].sort(),
    )
  })

  it('the connect activation check sees the live AND the future-start grant — an EXPIRED grant cannot activate an agent', async () => {
    const { agentId } = await seedDelegationRailAgent()
    const { live, future } = await seedFourWindowRows(agentId)

    const rows = await listSetupsActiveDelegations(agentId)

    // The setup projection carries token/budget/period, not the row id — the
    // surviving grants are the live and future-start ones.
    expect(rows).toHaveLength(2)
  })
})
