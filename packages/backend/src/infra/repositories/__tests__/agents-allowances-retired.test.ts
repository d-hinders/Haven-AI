/**
 * #2020 (epic #1440): the `agent_allowances` read/write surface is retired.
 *
 * The acceptance criterion this file exists for: "GET /agents no longer
 * touches the table on any code path, proven by a repository test on the
 * real-DB harness (#1219 — no mocks)". The proof is the strongest one the
 * harness allows: DROP the table inside the test, then run every repository
 * read the agent routes still perform. Before #2020, `GET /agents` called
 * `listAllowancesForAgents` for EVERY agent id before branching on
 * `account_type` — so this exact sequence 500'd for pure delegation-rail
 * users the moment the table went away (#2020's "sharpest fact"). Green here
 * means #1990's follow-through can drop the table without taking the agent
 * list down.
 *
 * The module-surface check at the bottom pins the deletion itself: the SQL
 * constants and functions are gone, not merely uncalled, so a revert-by-
 * convenience reintroducing a reader fails this file before it fails prod.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import * as agentsRepo from '../agents.js'
import * as setupsRepo from '../agent-connection-setups.js'
import * as dashboardRepo from '../dashboard.js'
import {
  createAgent,
  findAgentForUserAllStatuses,
  listAgentsForUserAllStatuses,
  updateAgentProfile,
} from '../agents.js'
import { deriveDelegationAllowances } from '../../../rails/delegation-budget-view.js'

async function seedUser(tag: string): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`${tag}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

async function seedSafe(
  userId: string,
  addr: string,
  rail: 'allowance_module' | 'delegation',
  accountType: 'safe' | 'delegator_hybrid',
): Promise<string> {
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 8453, $3, $4) RETURNING id`,
    [userId, addr, rail, accountType],
  )
  return safe.rows[0].id
}

async function seedAgent(userId: string, safeId: string, delegate: string): Promise<string> {
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, description, delegate_address, api_key_hash, api_key_prefix, safe_id)
     VALUES ($1, 'a', null, $2, 'h', 'sk_agent_tst', $3) RETURNING id`,
    [userId, delegate, safeId],
  )
  return agent.rows[0].id
}

/**
 * Restore the table after the destructive proof below. The harness schema is
 * shared by every test FILE scheduled onto this vitest worker for the whole
 * run (db-harness.ts keeps one schema per worker; resetDb only TRUNCATEs
 * surviving tables), so a leaked DROP would non-deterministically break
 * sibling real-DB tests — concretely 069's shrink guard, which asserts
 * `agent_allowances` still EXISTS precisely so the migration cannot over-drop
 * it (review finding on this PR). DDL copied verbatim from
 * `db/migrations/000_initial.ts` (post-004 shape — `approval_threshold` never
 * existed in this CREATE).
 */
async function restoreAgentAllowancesTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_allowances (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      token_address    VARCHAR(42) NOT NULL,
      token_symbol     VARCHAR(20) NOT NULL,
      allowance_amount VARCHAR(78) NOT NULL,
      reset_period_min INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent_id, token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_allowances_agent_id ON agent_allowances(agent_id);
  `)
}

describeDb('agent reads survive the agent_allowances drop (#2020)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Self-heal from a previous run's leak in a long-lived local DB.
    await restoreAgentAllowancesTable()
  })

  afterAll(async () => {
    await restoreAgentAllowancesTable()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('every repository read behind GET/PUT /agents works with the table GONE', async () => {
    const userId = await seedUser('retired-allowances')
    const legacySafeId = await seedSafe(
      userId,
      '0x' + 'a'.repeat(40),
      'allowance_module',
      'safe',
    )
    const hybridSafeId = await seedSafe(
      userId,
      '0x' + 'b'.repeat(40),
      'delegation',
      'delegator_hybrid',
    )
    const legacyAgentId = await seedAgent(userId, legacySafeId, '0x' + '1'.repeat(40))
    const hybridAgentId = await seedAgent(userId, hybridSafeId, '0x' + '2'.repeat(40))

    // An ACTIVE delegation so the hybrid agent's derived view is non-empty —
    // proving the delegation path never needed the mirror table.
    await db.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at
       ) VALUES ($1, 8453, LOWER($2), NULL, $3, '{}', 1, 'active', '1000000', 86400, 0, 4102444800)`,
      [hybridAgentId, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x' + 'c'.repeat(64)],
    )

    // The point of the whole test: the table does not exist from here on.
    // (IF EXISTS is belt-and-braces; afterAll restores the table so the drop
    // never leaks past this file into the shared worker schema.)
    await db.query('DROP TABLE IF EXISTS agent_allowances CASCADE')

    // GET /agents' data path: list, then derive for the hybrid subset.
    //
    // #2413: the list filters to `delegator_hybrid`, so the legacy agent this
    // case seeds is no longer returned. That does not weaken the subject —
    // which is that these reads work with `agent_allowances` DROPPED, not that
    // they return both rails — and the legacy row is still asserted below by
    // the direct-SQL check, so "the read path survives the drop" is still
    // proven for a legacy row, just not through the filtered list.
    const agents = await listAgentsForUserAllStatuses(userId)
    expect(agents.map((a) => a.id)).toEqual([hybridAgentId])

    const legacyRow = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE id = $1`,
      [legacyAgentId],
    )
    expect(legacyRow.rows).toHaveLength(1)

    const derived = await deriveDelegationAllowances([hybridAgentId])
    const hybridRows = derived.get(hybridAgentId) ?? []
    expect(hybridRows).toHaveLength(1)
    expect(hybridRows[0]).toMatchObject({ reset_period_min: 1440 })

    // GET /agents/:id and PUT /agents/:id read paths. #2413 filters the single
    // read too, so the LEGACY agent is null there; the hybrid one proves the
    // path works with the table gone. `updateAgentProfile` is NOT filtered —
    // it targets `agents` directly — so the legacy rename still succeeds, which
    // is what this case cares about.
    expect(await findAgentForUserAllStatuses(legacyAgentId, userId)).toBeNull()
    const singleHybrid = await findAgentForUserAllStatuses(hybridAgentId, userId)
    expect(singleHybrid?.id).toBe(hybridAgentId)
    const updated = await updateAgentProfile(legacyAgentId, userId, 'renamed', null)
    expect(updated?.name).toBe('renamed')

    // POST /agents' transaction no longer inserts mirror rows, so creation
    // succeeds with the table gone too.
    const created = await createAgent({
      userId,
      name: 'post-drop agent',
      description: null,
      delegateAddress: '0x' + '3'.repeat(40),
      apiKeyHash: 'h2',
      apiKeyPrefix: 'sk_agent_ts2',
      safeId: hybridSafeId,
    })
    expect(created.agent.name).toBe('post-drop agent')
  })

  it('the retired SQL surface is deleted, not merely uncalled', () => {
    // Readers.
    expect((agentsRepo as Record<string, unknown>).LIST_ALLOWANCES_FOR_AGENTS_SQL).toBeUndefined()
    expect((agentsRepo as Record<string, unknown>).LIST_ALLOWANCES_FOR_AGENT_SQL).toBeUndefined()
    expect(
      (agentsRepo as Record<string, unknown>).LIST_ALLOWANCES_FOR_AGENT_UNORDERED_SQL,
    ).toBeUndefined()
    expect(
      (agentsRepo as Record<string, unknown>).LIST_ALLOWANCE_CONFIG_FOR_AGENT_SQL,
    ).toBeUndefined()
    expect((dashboardRepo as Record<string, unknown>).LIST_DASHBOARD_ALLOWANCES_SQL).toBeUndefined()
    // Writers.
    expect((agentsRepo as Record<string, unknown>).INSERT_AGENT_ALLOWANCE_SQL).toBeUndefined()
    expect((agentsRepo as Record<string, unknown>).UPSERT_AGENT_ALLOWANCE_SQL).toBeUndefined()
    expect((agentsRepo as Record<string, unknown>).DELETE_AGENT_ALLOWANCE_SQL).toBeUndefined()
    expect((setupsRepo as Record<string, unknown>).COPY_SETUP_ALLOWANCES_SQL).toBeUndefined()
  })
})
