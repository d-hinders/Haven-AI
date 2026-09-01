import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  FIND_AGENT_FOR_USER_ALL_STATUSES_SQL,
  FIND_AGENT_ID_FOR_USER_SQL,
  FIND_AGENT_ID_STATUS_FOR_USER_SQL,
  FIND_DEFAULT_USER_SAFE_ID_SQL,
  FIND_DELEGATE_AGENT_FOR_USER_SQL,
  FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL,
  FIND_USER_SAFE_ID_FOR_USER_SQL,
  LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL,
  UPDATE_AGENT_PROFILE_SQL,
  agentExistsForUser,
  agentHasLiveDelegations,
  archiveAgent,
  unarchiveAgent,
  findAgentForUserAllStatuses,
  findAgentIdStatusForUser,
  findDefaultUserSafeId,
  findDelegateAgentForUser,
  findNonRevokedAgentIdByDelegate,
  findUserSafeIdForUser,
  listAgentsForUserAllStatuses,
  loadOwnedDelegationAgent,
  insertPendingDelegationForOwnedNonRevokedAgent,
  pauseAgent,
  resumeAgent,
  revokeAgent,
  rotateAgentApiKey,
  updateAgentProfile,
  type Executor,
} from '../agents.js'

const OWNER = 'user-owner'
const ATTACKER = 'user-attacker'

describeDb('delegation lifecycle owner read (#2025)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('keeps a revoked owner agent visible to recovery routes while exposing its terminal status', async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`revoked-delegation-${Date.now()}@test.example`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status) VALUES ($1, 'Revoked delegation', 'revoked') RETURNING id`,
      [user.rows[0].id],
    )

    const row = await loadOwnedDelegationAgent(agent.rows[0].id, user.rows[0].id)
    const otherUser = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`other-revoked-delegation-${Date.now()}@test.example`],
    )
    expect(row).toMatchObject({ agent_id: agent.rows[0].id, status: 'revoked' })
    expect(await loadOwnedDelegationAgent(agent.rows[0].id, otherUser.rows[0].id)).toBeNull()
  })

  it('cannot insert a fresh pending delegation for a revoked agent, while an active agent remains eligible', async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`grant-eligibility-${Date.now()}@test.example`],
    )
    const safe = await db.query<{ id: string }>(
      `INSERT INTO user_safes (user_id, safe_address, name, is_default, account_type)
       VALUES ($1, '0x1111111111111111111111111111111111111111', 'Delegation account', true, 'delegator_hybrid')
       RETURNING id`,
      [user.rows[0].id],
    )
    const [revoked, active] = await Promise.all(['revoked', 'active'].map(async (status) => {
      const result = await db.query<{ id: string }>(
        `INSERT INTO agents (user_id, safe_id, name, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.rows[0].id, safe.rows[0].id, `${status} grant`, status],
      )
      return result.rows[0].id
    }))
    const input = (agentId: string, hash: string) => ({
      agentId, userId: user.rows[0].id, chainId: 84532,
      tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', recipientAddress: null,
      delegationHash: hash, delegationJson: '{}', version: 1, budgetAtomic: '1',
      periodSeconds: 60, startDate: 0, expiresAt: 9999999999,
    })
    expect(await insertPendingDelegationForOwnedNonRevokedAgent(input(revoked, `0x${'1'.repeat(64)}`))).toBe(false)
    expect(await insertPendingDelegationForOwnedNonRevokedAgent(input(active, `0x${'2'.repeat(64)}`))).toBe(true)
    const rows = await db.query<{ agent_id: string }>('SELECT agent_id FROM agent_delegations')
    expect(rows.rows).toEqual([{ agent_id: active }])
  })
})

/**
 * An executor that behaves like a tenant-scoped table: it returns `row` only
 * when the parameter vector carries the OWNER's id. A repository function that
 * failed to pass its scope through would "find" the row for the attacker —
 * which is exactly what these tests refuse.
 */
function tenantExecutor(row: Record<string, unknown>): Executor & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (_sql: string, values?: unknown[]) =>
    values?.includes(OWNER) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 },
  )
  return { query } as unknown as Executor & { query: typeof query }
}

describe('the #1069 status-scoping asymmetry, pinned in SQL and in names', () => {
  it('list and single reads carry NO status filter — pending_approval agents are surfaced', () => {
    for (const sql of [LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL, FIND_AGENT_FOR_USER_ALL_STATUSES_SQL]) {
      expect(sql).not.toContain('pending_approval')
      // mpre.status belongs to the stranded-funds EXISTS subquery; the agent's
      // own status column must appear only in the projection, never filtered.
      expect(sql).not.toMatch(/a\.status\s*(!=|=|IN|<>)/)
    }
  })

  it('the delegate-balance read is status-AGNOSTIC (#1403) — sweep must work post-revoke', () => {
    // The old `a.status != 'revoked'` filter removed the sweep page exactly
    // when stranded delegate funds need recovering. Re-adding ANY status
    // filter here must be a conscious act that fails this test first.
    expect(FIND_DELEGATE_AGENT_FOR_USER_SQL).not.toContain('status')
  })

  it('the naming stays honest: AllStatuses reads + the narrow delegate read', () => {
    expect(listAgentsForUserAllStatuses.name).toBe('listAgentsForUserAllStatuses')
    expect(findAgentForUserAllStatuses.name).toBe('findAgentForUserAllStatuses')
    expect(findDelegateAgentForUser.name).toBe('findDelegateAgentForUser')
  })
})

describe('tenant scoping is required and effective — cross-tenant access returns empty', () => {
  it('every tenant-scoped statement filters on user_id in SQL', () => {
    for (const sql of [
      LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL,
      FIND_AGENT_FOR_USER_ALL_STATUSES_SQL,
      FIND_DELEGATE_AGENT_FOR_USER_SQL,
      FIND_USER_SAFE_ID_FOR_USER_SQL,
      FIND_DEFAULT_USER_SAFE_ID_SQL,
      FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL,
      FIND_AGENT_ID_FOR_USER_SQL,
      FIND_AGENT_ID_STATUS_FOR_USER_SQL,
      UPDATE_AGENT_PROFILE_SQL,
    ]) {
      expect(sql).toMatch(/user_id = \$\d/)
    }
  })

  it('listAgentsForUserAllStatuses: another tenant sees an empty list', async () => {
    const db = tenantExecutor({ id: 'agent-1' })
    expect(await listAgentsForUserAllStatuses(ATTACKER, db)).toEqual([])
    expect(await listAgentsForUserAllStatuses(OWNER, db)).toHaveLength(1)
  })

  it('findAgentForUserAllStatuses: another tenant gets null for an existing agent', async () => {
    const db = tenantExecutor({ id: 'agent-1' })
    expect(await findAgentForUserAllStatuses('agent-1', ATTACKER, db)).toBeNull()
    expect(await findAgentForUserAllStatuses('agent-1', OWNER, db)).not.toBeNull()
  })

  it('findDelegateAgentForUser: another tenant gets null', async () => {
    const db = tenantExecutor({ delegate_address: '0xdead' })
    expect(await findDelegateAgentForUser('agent-1', ATTACKER, db)).toBeNull()
    expect(await findDelegateAgentForUser('agent-1', OWNER, db)).not.toBeNull()
  })

  it('findUserSafeIdForUser: another tenant cannot claim the safe', async () => {
    const db = tenantExecutor({ id: 'safe-1' })
    expect(await findUserSafeIdForUser('safe-1', ATTACKER, db)).toBeNull()
    expect(await findUserSafeIdForUser('safe-1', OWNER, db)).toBe('safe-1')
  })

  it('findDefaultUserSafeId: scoped to the caller', async () => {
    const db = tenantExecutor({ id: 'safe-1' })
    expect(await findDefaultUserSafeId(ATTACKER, db)).toBeNull()
    expect(await findDefaultUserSafeId(OWNER, db)).toBe('safe-1')
  })

  it('findNonRevokedAgentIdByDelegate: the duplicate check is per-tenant', async () => {
    const db = tenantExecutor({ id: 'agent-1' })
    expect(await findNonRevokedAgentIdByDelegate(ATTACKER, '0xdead', db)).toBeNull()
    expect(await findNonRevokedAgentIdByDelegate(OWNER, '0xdead', db)).toBe('agent-1')
  })

  it('agentExistsForUser: existence is a per-tenant fact', async () => {
    const db = tenantExecutor({ id: 'agent-1' })
    expect(await agentExistsForUser('agent-1', ATTACKER, db)).toBe(false)
    expect(await agentExistsForUser('agent-1', OWNER, db)).toBe(true)
  })

  it('findAgentIdStatusForUser: another tenant gets null', async () => {
    const db = tenantExecutor({ id: 'agent-1', status: 'active' })
    expect(await findAgentIdStatusForUser('agent-1', ATTACKER, db)).toBeNull()
    expect(await findAgentIdStatusForUser('agent-1', OWNER, db)).toEqual({ id: 'agent-1', status: 'active' })
  })

  it('updateAgentProfile: another tenant updates nothing and gets null', async () => {
    const db = tenantExecutor({ id: 'agent-1', name: 'X' })
    expect(await updateAgentProfile('agent-1', ATTACKER, 'X', null, db)).toBeNull()
    expect(await updateAgentProfile('agent-1', OWNER, 'X', null, db)).not.toBeNull()
  })

  it('archiveAgent: another tenant archives nothing (null) — #1401', async () => {
    const db = tenantExecutor({ id: 'agent-1', archived_at: new Date() })
    expect(await archiveAgent('agent-1', ATTACKER, db)).toBeNull()
    expect(await archiveAgent('agent-1', OWNER, db)).not.toBeNull()
  })

  it.each([
    ['unarchiveAgent', unarchiveAgent],
    ['revokeAgent', revokeAgent],
    ['pauseAgent', pauseAgent],
    ['resumeAgent', resumeAgent],
  ] as const)('%s: another tenant flips nothing (false)', async (_name, fn) => {
    const db = tenantExecutor({ id: 'agent-1' })
    expect(await fn('agent-1', ATTACKER, db)).toBe(false)
    expect(await fn('agent-1', OWNER, db)).toBe(true)
  })

  it('rotateAgentApiKey: another tenant rotates nothing (false)', async () => {
    const db = tenantExecutor({ id: 'agent-1' })
    expect(await rotateAgentApiKey('hash', 'sk_agent_abcd', 'agent-1', ATTACKER, db)).toBe(false)
    expect(await rotateAgentApiKey('hash', 'sk_agent_abcd', 'agent-1', OWNER, db)).toBe(true)
  })
})

/**
 * #1401 real-DB proof: archive is a soft filing action. What Postgres must
 * guarantee — status gating, idempotency WITHOUT timestamp churn, unarchive
 * leaving status untouched, and the whole point: dependent audit rows
 * SURVIVE archiving (the old DELETE cascaded seven tables away).
 */
describeDb('agents archive (#1401, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  let seq = 0
  async function seedAgent(status: string): Promise<{ userId: string; agentId: string }> {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`archive-u${++seq}-${Date.now()}@test.example`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status) VALUES ($1, 'Archive test', $2) RETURNING id`,
      [user.rows[0].id, status],
    )
    return { userId: user.rows[0].id, agentId: agent.rows[0].id }
  }

  async function seedLegacyAgent(status: string): Promise<{ userId: string; agentId: string }> {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`archive-legacy-u${++seq}-${Date.now()}@test.example`],
    )
    const safe = await db.query<{ id: string }>(
      `INSERT INTO user_safes (user_id, safe_address, name, is_default, account_type)
       VALUES ($1, $2, 'Legacy account', true, 'safe') RETURNING id`,
      [user.rows[0].id, `0x${(++seq).toString(16).padStart(40, '0')}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, safe_id, name, status) VALUES ($1, $2, 'Legacy archive test', $3) RETURNING id`,
      [user.rows[0].id, safe.rows[0].id, status],
    )
    return { userId: user.rows[0].id, agentId: agent.rows[0].id }
  }

  it('refuses live-delegation agents regardless of status; archives revoked records without live authority', async () => {
    for (const status of ['active', 'paused', 'pending_approval']) {
      const { userId, agentId } = await seedAgent(status)
      await seedDelegation(agentId, 'active')
      expect(await archiveAgent(agentId, userId)).toBeNull()
    }
    const { userId, agentId } = await seedAgent('revoked')
    const archived = await archiveAgent(agentId, userId)
    expect(archived).not.toBeNull()
    expect(archived!.archived_at).toBeInstanceOf(Date)
  })

  it.each(['active', 'paused', 'pending_approval'])('archives a legacy Safe record while it is %s (#2258)', async (status) => {
    const { userId, agentId } = await seedLegacyAgent(status)
    const archived = await archiveAgent(agentId, userId)
    expect(archived).not.toBeNull()
    const row = await db.query<{ status: string; archived_at: Date | null }>(
      `SELECT status, archived_at FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(row.rows[0].status).toBe(status)
    expect(row.rows[0].archived_at).not.toBeNull()
  })

  it('archives a legacy record after its Safe was unlinked, without requiring revocation (#2258)', async () => {
    const { userId, agentId } = await seedLegacyAgent('active')
    await db.query(`UPDATE agents SET safe_id = NULL WHERE id = $1`, [agentId])

    const archived = await archiveAgent(agentId, userId)

    expect(archived).not.toBeNull()
    const row = await db.query<{ status: string; archived_at: Date | null }>(
      `SELECT status, archived_at FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(row.rows[0]).toMatchObject({ status: 'active' })
    expect(row.rows[0].archived_at).not.toBeNull()
  })

  // #1436: revoking flips only agents.status — it never touches
  // agent_delegations. So "revoked" alone was never proof that the agent had
  // stopped spending, and archiving on that basis filed an agent under
  // "Removed" while its budget stayed redeemable on-chain. The invariant lives
  // here now, not in the dashboard's call ordering.
  async function seedDelegation(agentId: string, status: string): Promise<void> {
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, delegation_hash, delegation_json, version, token_address,
          status, budget_atomic, period_seconds, start_date, expires_at)
       VALUES ($1, 84532, $2, '{}', 1, '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
               $3, '1000000', 86400, 0, 0)`,
      [agentId, `0x${(++seq).toString(16).padStart(2, '0').repeat(32)}`, status],
    )
  }

  it.each(['pending', 'active'])(
    'REFUSES to archive a revoked agent that still holds a %s delegation (#1436)',
    async (delegationStatus) => {
      const { userId, agentId } = await seedAgent('revoked')
      await seedDelegation(agentId, delegationStatus)

      expect(await archiveAgent(agentId, userId)).toBeNull()
      const row = await db.query<{ archived_at: Date | null }>(
        `SELECT archived_at FROM agents WHERE id = $1`,
        [agentId],
      )
      expect(row.rows[0].archived_at).toBeNull()
      expect(await agentHasLiveDelegations(agentId)).toBe(true)
    },
  )

  it('archives once the delegations are revoked — the documented remedy works (#1436)', async () => {
    const { userId, agentId } = await seedAgent('revoked')
    await seedDelegation(agentId, 'active')
    expect(await archiveAgent(agentId, userId)).toBeNull()

    // What revoke-all does to the rows:
    await db.query(`UPDATE agent_delegations SET status = 'revoked' WHERE agent_id = $1`, [agentId])

    expect(await agentHasLiveDelegations(agentId)).toBe(false)
    expect(await archiveAgent(agentId, userId)).not.toBeNull()
  })

  it('already-revoked delegations never block archiving (#1436)', async () => {
    const { userId, agentId } = await seedAgent('revoked')
    await seedDelegation(agentId, 'revoked')
    expect(await archiveAgent(agentId, userId)).not.toBeNull()
  })

  it('re-archiving is idempotent and keeps the ORIGINAL archived_at', async () => {
    const { userId, agentId } = await seedAgent('revoked')
    const first = await archiveAgent(agentId, userId)
    const second = await archiveAgent(agentId, userId)
    expect(second).not.toBeNull()
    expect(second!.archived_at.toISOString()).toBe(first!.archived_at.toISOString())
  })

  it('unarchive clears archived_at and leaves status = revoked untouched', async () => {
    const { userId, agentId } = await seedAgent('revoked')
    await archiveAgent(agentId, userId)
    expect(await unarchiveAgent(agentId, userId)).toBe(true)
    const row = await db.query<{ status: string; archived_at: Date | null }>(
      `SELECT status, archived_at FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(row.rows[0]).toEqual({ status: 'revoked', archived_at: null })
    // Unarchiving a non-archived agent matches nothing (idempotent no-op).
    expect(await unarchiveAgent(agentId, userId)).toBe(false)
  })

  // #2055 (epic #1440, #2021 readability waiver): was seeded with a
  // `payment_intents` row AND an `approval_requests` row, asserting both
  // survive archiving — `approval_requests` is dropped (migration 070), so
  // there is nothing left to seed or assert there. The point survives on
  // `payment_intents` alone.
  it('THE POINT: payment history and audit rows survive archiving', async () => {
    const { userId, agentId } = await seedAgent('revoked')
    await db.query(
      `INSERT INTO payment_intents
         (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
          amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, expires_at)
       VALUES ($1, $2, '0x00000000000000000000000000000000000000s1', 'USDC',
               '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
               '0x00000000000000000000000000000000000000aa',
               '1000', '0.001', '0x00000000000000000000000000000000000000de',
               0, '0x' || repeat('11', 32), 'confirmed', NOW() + interval '1 hour')`,
      [agentId, userId],
    )

    expect(await archiveAgent(agentId, userId)).not.toBeNull()

    const intents = await db.query(`SELECT id FROM payment_intents WHERE agent_id = $1`, [agentId])
    expect(intents.rows).toHaveLength(1)
    // And the agent row itself still exists, archived — not deleted.
    const agent = await db.query<{ archived_at: Date | null }>(
      `SELECT archived_at FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(agent.rows[0].archived_at).not.toBeNull()
  })

  it('list/by-id reads expose archived_at (no agent disappears)', async () => {
    const { userId, agentId } = await seedAgent('revoked')
    await archiveAgent(agentId, userId)
    const listed = await listAgentsForUserAllStatuses(userId)
    expect(listed).toHaveLength(1)
    expect(listed[0].archived_at).not.toBeNull()
    const single = await findAgentForUserAllStatuses(userId, agentId)
    expect(single?.archived_at).not.toBeNull()
  })
})
