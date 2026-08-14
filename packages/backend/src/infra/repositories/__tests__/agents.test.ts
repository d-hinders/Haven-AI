import { describe, expect, it, vi } from 'vitest'
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
  deleteRevokedAgent,
  findAgentForUserAllStatuses,
  findAgentIdStatusForUser,
  findDefaultUserSafeId,
  findDelegateAgentForUser,
  findNonRevokedAgentIdByDelegate,
  findUserSafeIdForUser,
  listAgentsForUserAllStatuses,
  pauseAgent,
  resumeAgent,
  revokeAgent,
  rotateAgentApiKey,
  updateAgentProfile,
  type Executor,
} from '../agents.js'

const OWNER = 'user-owner'
const ATTACKER = 'user-attacker'

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

  it.each([
    ['deleteRevokedAgent', deleteRevokedAgent],
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
