import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pool from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  FIND_OLDEST_ACCOUNT_FOR_USER_SQL,
  HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL,
  HAS_OPEN_SWEEPS_FOR_ACCOUNT_SQL,
  HAS_IN_FLIGHT_REKEYS_FOR_ACCOUNT_SQL,
  LOCK_AGENTS_FOR_ACCOUNT_SQL,
  FIND_OWNED_ACCOUNT_ADDRESS_SQL,
  FIND_OWNED_ACCOUNT_DEFAULT_FLAG_SQL,
  CLEAR_DEFAULT_ACCOUNTS_FOR_USER_SQL,
  DELETE_USER_ACCOUNT_SQL,
  LIST_ACCOUNTS_FOR_USER_SQL,
  ORPHAN_AGENTS_FOR_ACCOUNT_SQL,
  SET_ACCOUNT_DEFAULT_SQL,
  RENAME_ACCOUNT_FOR_USER_SQL,
  SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL,
  deleteAccountForUser,
  findOwnedAccountAddress,
  findOwnedAccountDefaultFlag,
  listAccountsForUser,
  renameAccountForUser,
  setDefaultAccountForUser,
  type Executor,
} from '../smart-accounts.js'

const OWNER = 'user-owner'
const ATTACKER = 'user-attacker'

/** See the twin helper in agents.test.ts — a tenant-scoped table stand-in. */
function tenantExecutor(row: Record<string, unknown>): Executor & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (_sql: string, values?: unknown[]) =>
    values?.includes(OWNER) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 },
  )
  return { query } as unknown as Executor & { query: typeof query }
}

describe('tenant scoping is required and effective — cross-tenant access returns empty', () => {
  it('every tenant-scoped statement filters on user_id in SQL', () => {
    for (const sql of [
      LIST_ACCOUNTS_FOR_USER_SQL,
      FIND_OWNED_ACCOUNT_ADDRESS_SQL,
      FIND_OWNED_ACCOUNT_DEFAULT_FLAG_SQL,
      RENAME_ACCOUNT_FOR_USER_SQL,
      CLEAR_DEFAULT_ACCOUNTS_FOR_USER_SQL,
      FIND_OLDEST_ACCOUNT_FOR_USER_SQL,
      // #3227: the three writes that used to scope by row id alone.
      SET_ACCOUNT_DEFAULT_SQL,
      ORPHAN_AGENTS_FOR_ACCOUNT_SQL,
      DELETE_USER_ACCOUNT_SQL,
    ]) {
      expect(sql).toMatch(/user_id = \$\d/)
    }
    // The legacy mirror UPDATE is scoped by the users PK, which IS the tenant.
    expect(SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL).toMatch(/WHERE id = \$2/)
  })

  it('listAccountsForUser: another tenant sees an empty list', async () => {
    const db = tenantExecutor({ id: 'safe-1' })
    expect(await listAccountsForUser(ATTACKER, db)).toEqual([])
    expect(await listAccountsForUser(OWNER, db)).toHaveLength(1)
  })

  // `findSafeIdByAddressAndChain` (import duplicate detection),
  // `countSafesForUser` (first-Safe-becomes-default), `findOwnedSafe` (the
  // approver routes' ownership check), the legacy-address setter and
  // `listKnownApproversForUser` had per-tenant cases here. All five functions
  // are deleted with their callers in #1988; a scoping test for a function
  // that does not exist is a guard over an empty set. The SQL constant
  // `SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL` survives — re-default and unlink still
  // issue it — and its parameter scoping is still pinned below, at the two
  // transaction functions that are its remaining callers.

  it.each([
    ['findOwnedAccountAddress', findOwnedAccountAddress],
    ['findOwnedAccountDefaultFlag', findOwnedAccountDefaultFlag],
  ] as const)('%s: another tenant gets null for an existing safe', async (_name, fn) => {
    const db = tenantExecutor({ id: 'safe-1', account_address: '0xabc', chain_id: 8453, is_default: false })
    expect(await fn('safe-1', ATTACKER, db)).toBeNull()
    expect(await fn('safe-1', OWNER, db)).not.toBeNull()
  })

  it('renameAccountForUser: another tenant renames nothing and gets null', async () => {
    const db = tenantExecutor({ id: 'safe-1', name: 'X' })
    expect(await renameAccountForUser('X', 'safe-1', ATTACKER, db)).toBeNull()
    expect(await renameAccountForUser('X', 'safe-1', OWNER, db)).not.toBeNull()
  })

})

describe('transaction functions keep their statement order and scope', () => {
  // A plain executor (no `connect`) runs withTransaction inline — the
  // statements and their parameters are observable without BEGIN/COMMIT noise.

  it('setDefaultAccountForUser: clear, set and mirror are all scoped to the user (#3227)', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        return sql === SET_ACCOUNT_DEFAULT_SQL ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }
      },
    } as unknown as Executor
    await setDefaultAccountForUser('safe-1', '0xabc', OWNER, db)
    expect(calls.map(([sql]) => sql)).toEqual([
      CLEAR_DEFAULT_ACCOUNTS_FOR_USER_SQL,
      SET_ACCOUNT_DEFAULT_SQL,
      SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL,
    ])
    expect(calls[0][1]).toEqual([OWNER, 'safe-1'])
    expect(calls[1][1]).toEqual(['safe-1', OWNER])
    expect(calls[2][1]).toEqual(['0xabc', OWNER])
  })

  it('setDefaultAccountForUser: when the set matches no row, the legacy mirror is not written (#3227)', async () => {
    const sqls: string[] = []
    const db = {
      query: async (sql: string) => {
        sqls.push(sql)
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor
    await setDefaultAccountForUser('safe-1', '0xabc', ATTACKER, db)
    expect(sqls).toEqual([CLEAR_DEFAULT_ACCOUNTS_FOR_USER_SQL, SET_ACCOUNT_DEFAULT_SQL])
  })

  it('deleteAccountForUser: promotion looks up the oldest safe of the CALLER, never another tenant', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        if (sql === FIND_OLDEST_ACCOUNT_FOR_USER_SQL) {
          return { rows: [{ id: 'safe-2', account_address: '0xnext' }], rowCount: 1 }
        }
        if (sql === DELETE_USER_ACCOUNT_SQL) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor
    expect(await deleteAccountForUser('safe-1', OWNER, true, db)).toBe(true)
    // #3227: the orphan and the delete carry the caller, not just the row id.
    expect(calls.find(([sql]) => sql === ORPHAN_AGENTS_FOR_ACCOUNT_SQL)?.[1]).toEqual(['safe-1', OWNER])
    expect(calls.find(([sql]) => sql === DELETE_USER_ACCOUNT_SQL)?.[1]).toEqual(['safe-1', OWNER])
    const promote = calls.find(([sql]) => sql === FIND_OLDEST_ACCOUNT_FOR_USER_SQL)
    expect(promote?.[1]).toEqual([OWNER])
    const mirror = calls.find(([sql]) => sql === SET_LEGACY_USER_ACCOUNT_ADDRESS_SQL)
    expect(mirror?.[1]).toEqual(['0xnext', OWNER])
    // The self-sign orphan statement is GONE (#2851): self_sign_agents no
    // longer exists as of migration 083_drop_dead_safe_rail_tables.ts, so
    // there is nothing left to orphan and no such statement should ever run
    // again — not merely reordered, absent.
    const sqls = calls.map(([sql]) => sql)
    expect(sqls.some((s) => s.includes('self_sign_agents'))).toBe(false)
  })

  it('deleteAccountForUser: when the delete matches no row it returns false and promotes nothing (#3227)', async () => {
    const sqls: string[] = []
    const db = {
      query: async (sql: string) => {
        sqls.push(sql)
        if (sql === FIND_OLDEST_ACCOUNT_FOR_USER_SQL) return { rows: [{ id: 'safe-2', account_address: '0xnext' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor
    expect(await deleteAccountForUser('safe-1', ATTACKER, true, db)).toBe(false)
    expect(sqls.at(-1)).toBe(DELETE_USER_ACCOUNT_SQL)
    expect(sqls).not.toContain(FIND_OLDEST_ACCOUNT_FOR_USER_SQL)
  })

  it('deleteAccountForUser: keeps a Safe linked when an agent still has live delegation authority', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        if (sql === HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL) {
          return { rows: [{ live: true }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor

    expect(await deleteAccountForUser('safe-1', OWNER, false, db)).toBe(false)
    expect(calls.map(([sql]) => sql)).toEqual([
      LOCK_AGENTS_FOR_ACCOUNT_SQL,
      HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL,
    ])
  })

  it('deleteAccountForUser: keeps a Safe linked while recovery is prepared or submitting', async () => {
    const calls: string[] = []
    const db = {
      query: async (sql: string) => {
        calls.push(sql)
        if (sql === HAS_OPEN_SWEEPS_FOR_ACCOUNT_SQL) return { rows: [{ open: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor

    expect(await deleteAccountForUser('safe-1', OWNER, false, db)).toBe(false)
    expect(calls).toEqual([
      LOCK_AGENTS_FOR_ACCOUNT_SQL,
      HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL,
      HAS_OPEN_SWEEPS_FOR_ACCOUNT_SQL,
    ])
  })

  it('deleteAccountForUser: keeps a Safe linked while a re-key is in flight', async () => {
    const calls: string[] = []
    const db = {
      query: async (sql: string) => {
        calls.push(sql)
        if (sql === HAS_IN_FLIGHT_REKEYS_FOR_ACCOUNT_SQL) return { rows: [{ in_flight: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor

    expect(await deleteAccountForUser('safe-1', OWNER, false, db)).toBe(false)
    expect(calls).toEqual([
      LOCK_AGENTS_FOR_ACCOUNT_SQL,
      HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL,
      HAS_OPEN_SWEEPS_FOR_ACCOUNT_SQL,
      HAS_IN_FLIGHT_REKEYS_FOR_ACCOUNT_SQL,
    ])
  })
})

/**
 * #3542 real-DB proof: the account-delete guard refuses on the SAME live set
 * revoke-all targets — pending, active AND replaced. A `replaced` row is still
 * enabled on-chain until its Stop userop lands (#3343), so deleting the account
 * under it would orphan an agent whose old key can still redeem.
 */
describeDb('deleteAccountForUser live-delegation guard (#3542, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  let seq = 0
  async function seedAccountWithAgent(): Promise<{ userId: string; accountId: string; agentId: string }> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`acct-guard-u${++seq}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const account = await pool.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, name, is_default, account_type)
       VALUES ($1, $2, 'Delegation account', false, 'delegator_hybrid') RETURNING id`,
      [userId, `0x${(++seq).toString(16).padStart(40, '0')}`],
    )
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, status) VALUES ($1, $2, 'Guarded', 'revoked') RETURNING id`,
      [userId, account.rows[0].id],
    )
    return { userId, accountId: account.rows[0].id, agentId: agent.rows[0].id }
  }

  async function seedDelegation(agentId: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, delegation_hash, delegation_json, version, token_address,
          status, budget_atomic, period_seconds, start_date, expires_at)
       VALUES ($1, 84532, $2, '{}', 1, '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
               $3, '1000000', 86400, 0, 0)`,
      [agentId, `0x${(++seq).toString(16).padStart(2, '0').repeat(32)}`, status],
    )
  }

  it.each(['pending', 'active', 'replaced'])(
    'refuses to delete an account whose agent holds a %s delegation',
    async (status) => {
      const { userId, accountId, agentId } = await seedAccountWithAgent()
      await seedDelegation(agentId, status)

      expect(await deleteAccountForUser(accountId, userId, false)).toBe(false)
      const kept = await pool.query(`SELECT id FROM smart_accounts WHERE id = $1`, [accountId])
      expect(kept.rows).toHaveLength(1)
    },
  )

  it('deletes the account once the replaced delegation is revoked', async () => {
    const { userId, accountId, agentId } = await seedAccountWithAgent()
    await seedDelegation(agentId, 'replaced')
    expect(await deleteAccountForUser(accountId, userId, false)).toBe(false)

    await pool.query(`UPDATE agent_delegations SET status = 'revoked' WHERE agent_id = $1`, [agentId])

    expect(await deleteAccountForUser(accountId, userId, false)).toBe(true)
    const gone = await pool.query(`SELECT id FROM smart_accounts WHERE id = $1`, [accountId])
    expect(gone.rows).toHaveLength(0)
  })
})
