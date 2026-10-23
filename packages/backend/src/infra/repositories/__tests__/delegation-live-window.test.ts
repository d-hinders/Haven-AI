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
import {
  listActiveDelegations,
  listActiveMerchantBudgetsForUser,
  listNonRevokedDelegationsForAgent,
  selectActiveDelegationByHash,
  selectDelegationForPayment,
} from '../delegation-budgets.js'
import { listActiveDelegationsForUser } from '../analytics.js'
import {
  OPS_ONCHAIN_DELEGATIONS_SQL,
  OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL,
  OPS_USER_DELEGATIONS_SQL,
  readOpsOverview,
  readOpsUserDetail,
  readOpsOnchainView,
} from '../ops-reads.js'
import { listActiveDelegations as listSetupsActiveDelegations } from '../agent-connection-setups.js'
import {
  AGENT_HAS_LIVE_DELEGATIONS_SQL,
  ARCHIVE_AGENT_SQL,
  FIND_AGENT_FOR_USER_ALL_STATUSES_SQL,
  LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL,
} from '../agents.js'
import { HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL } from '../smart-accounts.js'
import { LIST_DASHBOARD_BUDGET_DELEGATIONS_SQL } from '../budget-remaining.js'
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

// ── #3919 S-A: the 4 × 17 liveness matrix ────────────────────────────────────
//
// One agent seeded with the four rows that separate the two named predicates —
// an EXPIRED `active`, a FUTURE-START `active`, a `replaced` and a live
// `active` row — and all 10 spendable call sites plus all 7 still-enabled call
// sites observed against that ONE seed. The MATRIX records, per row, whether
// each site's predicate sees it (returned, counted, or blocking a guard); the
// assertions pin each site's observed value — rows for the list reads, counts
// for the aggregates at ops-reads.ts:78 / agents.ts:320 / analytics.ts,
// EXISTS for the guards — to exactly that matrix, so the rename of the
// predicates cannot move a single site without a test failing.
//
// What the matrix makes visible: all four rows are STILL ENABLED (every
// status the chain has not confirmed dead, #3542/#3343); the view reads see
// the expired one is dead and the future-start one dormant-but-visible
// (#3802); and the payment selectors see ONLY the live row (#1698) — an
// expired `active` row is not spendable and still enabled at once.

type RowKey = 'expired' | 'future' | 'replaced' | 'live'

const SITES = [
  // the 10 spendable call sites
  'ops_overview_count', // ops-reads.ts:78
  'ops_user_rows', // ops-reads.ts:222
  'ops_onchain_rows', // ops-reads.ts:334
  'list_active_rows', // delegation-budgets.ts listActiveDelegations
  'dashboard_rows', // budget-remaining.ts:69
  'setup_rows', // agent-connection-setups.ts:183
  'analytics_rows', // analytics.ts:814
  'payment_row', // SELECT_DELEGATION_FOR_PAYMENT_SQL
  'by_hash_row', // SELECT_ACTIVE_DELEGATION_BY_HASH_SQL
  'merchant_rows', // LIST_ACTIVE_MERCHANT_BUDGETS_FOR_USER_SQL
  // the 7 still-enabled call sites
  'agents_list_count', // agents.ts:320
  'agents_detail_count', // agents.ts:356
  'archive_unlinked_guard', // agents.ts:733
  'archive_guard', // agents.ts:739
  'agent_has_live', // agents.ts:746
  'account_has_live', // smart-accounts.ts:310
  'revoke_all_rows', // delegation-budgets.ts:498
] as const

type SiteKey = (typeof SITES)[number]

// true = that row passes that site's predicate (is returned, counted, or
// blocks the guard). Read it per COLUMN: the requireStarted:false view
// columns see the live AND the future-start row (#3802 — the dormant steady
// row stays visible beside its carry row), the two requireStarted:true
// payment columns see ONLY the live row (#1698), and every still-enabled
// column sees all four rows (#3542/#3343).
const MATRIX: Record<RowKey, Record<SiteKey, boolean>> = {
  expired: {
    ops_overview_count: false,
    ops_user_rows: false,
    ops_onchain_rows: false,
    list_active_rows: false,
    dashboard_rows: false,
    setup_rows: false,
    analytics_rows: false,
    payment_row: false,
    by_hash_row: false,
    merchant_rows: false,
    agents_list_count: true,
    agents_detail_count: true,
    archive_unlinked_guard: true,
    archive_guard: true,
    agent_has_live: true,
    account_has_live: true,
    revoke_all_rows: true,
  },
  future: {
    ops_overview_count: true,
    ops_user_rows: true,
    ops_onchain_rows: true,
    list_active_rows: true,
    dashboard_rows: true,
    setup_rows: true,
    analytics_rows: true,
    payment_row: false,
    by_hash_row: false,
    merchant_rows: true,
    agents_list_count: true,
    agents_detail_count: true,
    archive_unlinked_guard: true,
    archive_guard: true,
    agent_has_live: true,
    account_has_live: true,
    revoke_all_rows: true,
  },
  replaced: {
    ops_overview_count: false,
    ops_user_rows: false,
    ops_onchain_rows: false,
    list_active_rows: false,
    dashboard_rows: false,
    setup_rows: false,
    analytics_rows: false,
    payment_row: false,
    by_hash_row: false,
    merchant_rows: false,
    agents_list_count: true,
    agents_detail_count: true,
    archive_unlinked_guard: true,
    archive_guard: true,
    agent_has_live: true,
    account_has_live: true,
    revoke_all_rows: true,
  },
  live: {
    ops_overview_count: true,
    ops_user_rows: true,
    ops_onchain_rows: true,
    list_active_rows: true,
    dashboard_rows: true,
    setup_rows: true,
    analytics_rows: true,
    payment_row: true,
    by_hash_row: true,
    merchant_rows: true,
    agents_list_count: true,
    agents_detail_count: true,
    archive_unlinked_guard: true,
    archive_guard: true,
    agent_has_live: true,
    account_has_live: true,
    revoke_all_rows: true,
  },
}

const ROW_KEYS: readonly RowKey[] = ['expired', 'future', 'replaced', 'live']
const colSum = (site: SiteKey): number => ROW_KEYS.filter((r) => MATRIX[r][site]).length

const RECIPIENT = '0x00000000000000000000000000000000000000cc'

describeDb('#3919 S-A — the 4 × 17 liveness matrix over the named predicates', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  const nowSec = () => Math.floor(Date.now() / 1000)

  async function seedRailAgentWithAccount(): Promise<{ userId: string; agentId: string; accountId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`matrix${n}-${Date.now()}-${Math.random()}@test.example`],
    )
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, name, is_default, account_type)
       VALUES ($1, $2, 'Matrix account', true, 'delegator_hybrid') RETURNING id`,
      [user.rows[0].id, `0x${'b'.repeat(40)}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status, account_id) VALUES ($1, 'Matrix agent', 'active', $2) RETURNING id`,
      [user.rows[0].id, account.rows[0].id],
    )
    return { userId: user.rows[0].id, agentId: agent.rows[0].id, accountId: account.rows[0].id }
  }

  async function seedMerchant(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO merchants (slug, name) VALUES ($1, $1) RETURNING id`,
      [`matrix-merchant-${Date.now()}-${Math.random()}`],
    )
    return rows[0].id
  }

  /** One row of the matrix seed — merchant-locked and recipient-pinned (the CHECK requires the pin). */
  async function seedMatrixRow(
    agentId: string,
    merchantId: string,
    over: { status: string; startDate?: number; expiresAt?: number },
  ): Promise<{ id: string; hash: string }> {
    const hash = `0x${String(++seq).padStart(64, '0')}`
    const result = await db.query<{ id: string }>(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, merchant_id, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds,
          start_date, expires_at, created_at)
       VALUES ($1, 84532, $2, $3, $4, $5, '{}', 1, $6, '1000000', 86400, $7, $8, NOW())
       RETURNING id`,
      [
        agentId,
        USDC,
        RECIPIENT,
        merchantId,
        hash,
        over.status,
        over.startDate ?? 0,
        over.expiresAt ?? 9_999_999_999,
      ],
    )
    return { id: result.rows[0].id, hash }
  }

  /** ARCHIVE_AGENT_SQL is an UPDATE: probe it inside a ROLLBACK-wrapped transaction. */
  async function archiveRefused(agentId: string, userId: string): Promise<boolean> {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(ARCHIVE_AGENT_SQL, [agentId, userId])
      await client.query('ROLLBACK')
      return result.rows.length === 0
    } finally {
      client.release()
    }
  }

  it('every spendable and still-enabled call site sees exactly its matrix rows', async () => {
    const { userId, agentId, accountId } = await seedRailAgentWithAccount()
    const merchantId = await seedMerchant()
    const now = nowSec()
    const rows = {
      expired: await seedMatrixRow(agentId, merchantId, { status: 'active', expiresAt: now - 60 }),
      future: await seedMatrixRow(agentId, merchantId, { status: 'active', startDate: now + 3600 }),
      replaced: await seedMatrixRow(agentId, merchantId, { status: 'replaced' }),
      live: await seedMatrixRow(agentId, merchantId, { status: 'active' }),
    }
    const idOf = (r: RowKey) => rows[r].id
    const hashOf = (r: RowKey) => rows[r].hash
    const idsPassing = (site: SiteKey) => ROW_KEYS.filter((r) => MATRIX[r][site]).map(idOf).sort()
    const hashesPassing = (site: SiteKey) => ROW_KEYS.filter((r) => MATRIX[r][site]).map(hashOf).sort()

    // ── the 10 spendable call sites: ONLY the live row passes ──
    expect(
      (await db.query<{ count: number }>(OPS_OVERVIEW_ACTIVE_DELEGATIONS_SQL, [])).rows[0].count,
    ).toBe(colSum('ops_overview_count'))
    expect(
      (await db.query<{ id: string }>(OPS_USER_DELEGATIONS_SQL, [userId])).rows.map((r) => r.id).sort(),
    ).toEqual(idsPassing('ops_user_rows'))
    expect(
      (await db.query<{ delegation_hash: string }>(OPS_ONCHAIN_DELEGATIONS_SQL, [userId]))
        .rows.map((r) => r.delegation_hash)
        .sort(),
    ).toEqual(hashesPassing('ops_onchain_rows'))
    expect((await listActiveDelegations([agentId])).map((r) => r.id).sort()).toEqual(
      idsPassing('list_active_rows'),
    )
    expect(
      (await db.query<{ id: string }>(LIST_DASHBOARD_BUDGET_DELEGATIONS_SQL, [userId])).rows
        .map((r) => r.id)
        .sort(),
    ).toEqual(idsPassing('dashboard_rows'))
    expect(await listSetupsActiveDelegations(agentId)).toHaveLength(colSum('setup_rows'))
    expect((await listActiveDelegationsForUser(userId)).map((r) => r.id).sort()).toEqual(
      idsPassing('analytics_rows'),
    )
    // Top-1 selector: the single passing row is the one it must return.
    const payment = await selectDelegationForPayment(agentId, USDC, RECIPIENT)
    expect(payment?.delegation_hash ?? null).toBe(hashesPassing('payment_row')[0])
    // The by-hash selector reads each row by ITS identity — a direct per-row cell.
    for (const row of ROW_KEYS) {
      const found = await selectActiveDelegationByHash(agentId, hashOf(row))
      expect(found !== null).toBe(MATRIX[row].by_hash_row)
    }
    expect((await listActiveMerchantBudgetsForUser(userId, merchantId)).map((r) => r.id).sort()).toEqual(
      idsPassing('merchant_rows'),
    )

    // ── the 7 still-enabled call sites: ALL FOUR rows pass ──
    expect(
      (await db.query<{ live_delegation_count: number }>(LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL, [userId]))
        .rows[0].live_delegation_count,
    ).toBe(colSum('agents_list_count'))
    expect(
      (await db.query<{ live_delegation_count: number }>(FIND_AGENT_FOR_USER_ALL_STATUSES_SQL, [userId, agentId]))
        .rows[0].live_delegation_count,
    ).toBe(colSum('agents_detail_count'))
    // ARCHIVE_AGENT_SQL carries TWO still-enabled guards — the unlinked-slot
    // NOT EXISTS (agents.ts:733) and the main one (agents.ts:739) — in one
    // statement. Every row passes both or neither (same predicate, same
    // agent's rows), so one observed result pins both cells: with four
    // still-enabled rows present, archiving MUST be refused.
    expect(await archiveRefused(agentId, userId)).toBe(true)
    expect(
      (await db.query<{ live: boolean }>(AGENT_HAS_LIVE_DELEGATIONS_SQL, [agentId])).rows[0].live,
    ).toBe(true)
    expect(
      (await db.query<{ live: boolean }>(HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL, [accountId, userId]))
        .rows[0].live,
    ).toBe(true)
    expect(
      (await listNonRevokedDelegationsForAgent(agentId)).map((r) => r.delegation_hash).sort(),
    ).toEqual(hashesPassing('revoke_all_rows'))
  })
})
