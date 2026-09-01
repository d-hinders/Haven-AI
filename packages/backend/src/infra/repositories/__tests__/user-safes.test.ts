import { describe, expect, it, vi } from 'vitest'
import {
  FIND_OLDEST_SAFE_FOR_USER_SQL,
  HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL,
  HAS_OPEN_SWEEPS_FOR_SAFE_SQL,
  LOCK_AGENTS_FOR_SAFE_SQL,
  FIND_OWNED_SAFE_ADDRESS_SQL,
  FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
  CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
  LIST_SAFES_FOR_USER_SQL,
  RENAME_SAFE_FOR_USER_SQL,
  SET_LEGACY_USER_SAFE_ADDRESS_SQL,
  deleteSafeForUser,
  findOwnedSafeAddress,
  findOwnedSafeDefaultFlag,
  listSafesForUser,
  renameSafeForUser,
  setDefaultSafeForUser,
  type Executor,
} from '../user-safes.js'

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
      LIST_SAFES_FOR_USER_SQL,
      FIND_OWNED_SAFE_ADDRESS_SQL,
      FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
      RENAME_SAFE_FOR_USER_SQL,
      CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
      FIND_OLDEST_SAFE_FOR_USER_SQL,
    ]) {
      expect(sql).toMatch(/user_id = \$\d/)
    }
    // The legacy mirror UPDATE is scoped by the users PK, which IS the tenant.
    expect(SET_LEGACY_USER_SAFE_ADDRESS_SQL).toMatch(/WHERE id = \$2/)
  })

  it('listSafesForUser: another tenant sees an empty list', async () => {
    const db = tenantExecutor({ id: 'safe-1' })
    expect(await listSafesForUser(ATTACKER, db)).toEqual([])
    expect(await listSafesForUser(OWNER, db)).toHaveLength(1)
  })

  // `findSafeIdByAddressAndChain` (import duplicate detection),
  // `countSafesForUser` (first-Safe-becomes-default), `findOwnedSafe` (the
  // approver routes' ownership check), `setLegacyUserSafeAddress` and
  // `listKnownApproversForUser` had per-tenant cases here. All five functions
  // are deleted with their callers in #1988; a scoping test for a function
  // that does not exist is a guard over an empty set. The SQL constant
  // `SET_LEGACY_USER_SAFE_ADDRESS_SQL` survives — re-default and unlink still
  // issue it — and its parameter scoping is still pinned below, at the two
  // transaction functions that are its remaining callers.

  it.each([
    ['findOwnedSafeAddress', findOwnedSafeAddress],
    ['findOwnedSafeDefaultFlag', findOwnedSafeDefaultFlag],
  ] as const)('%s: another tenant gets null for an existing safe', async (_name, fn) => {
    const db = tenantExecutor({ id: 'safe-1', safe_address: '0xabc', chain_id: 8453, is_default: false })
    expect(await fn('safe-1', ATTACKER, db)).toBeNull()
    expect(await fn('safe-1', OWNER, db)).not.toBeNull()
  })

  it('renameSafeForUser: another tenant renames nothing and gets null', async () => {
    const db = tenantExecutor({ id: 'safe-1', name: 'X' })
    expect(await renameSafeForUser('X', 'safe-1', ATTACKER, db)).toBeNull()
    expect(await renameSafeForUser('X', 'safe-1', OWNER, db)).not.toBeNull()
  })

})

describe('transaction functions keep their statement order and scope', () => {
  // A plain executor (no `connect`) runs withTransaction inline — the
  // statements and their parameters are observable without BEGIN/COMMIT noise.

  it('setDefaultSafeForUser: clear is scoped to the user, set is by id, mirror is scoped to the user', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor
    await setDefaultSafeForUser('safe-1', '0xabc', OWNER, db)
    expect(calls.map(([sql]) => sql)).toEqual([
      CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
      expect.stringContaining('SET is_default = true'),
      SET_LEGACY_USER_SAFE_ADDRESS_SQL,
    ])
    expect(calls[0][1]).toEqual([OWNER])
    expect(calls[1][1]).toEqual(['safe-1'])
    expect(calls[2][1]).toEqual(['0xabc', OWNER])
  })

  it('deleteSafeForUser: promotion looks up the oldest safe of the CALLER, never another tenant', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        if (sql === FIND_OLDEST_SAFE_FOR_USER_SQL) {
          return { rows: [{ id: 'safe-2', safe_address: '0xnext' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor
    await deleteSafeForUser('safe-1', OWNER, true, db)
    const promote = calls.find(([sql]) => sql === FIND_OLDEST_SAFE_FOR_USER_SQL)
    expect(promote?.[1]).toEqual([OWNER])
    const mirror = calls.find(([sql]) => sql === SET_LEGACY_USER_SAFE_ADDRESS_SQL)
    expect(mirror?.[1]).toEqual(['0xnext', OWNER])
    // Self-sign orphan precedes the delete (RESTRICT FK) — same pin as the
    // route-level delete test, here at the unit that owns the order.
    const sqls = calls.map(([sql]) => sql)
    expect(sqls.findIndex((s) => s.includes('self_sign_agents'))).toBeLessThan(
      sqls.findIndex((s) => s.startsWith('DELETE FROM user_safes')),
    )
  })

  it('deleteSafeForUser: keeps a Safe linked when an agent still has live delegation authority', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const db = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push([sql, values])
        if (sql === HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL) {
          return { rows: [{ live: true }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor

    expect(await deleteSafeForUser('safe-1', OWNER, false, db)).toBe(false)
    expect(calls.map(([sql]) => sql)).toEqual([
      LOCK_AGENTS_FOR_SAFE_SQL,
      HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL,
    ])
  })

  it('deleteSafeForUser: keeps a Safe linked while recovery is prepared or submitting', async () => {
    const calls: string[] = []
    const db = {
      query: async (sql: string) => {
        calls.push(sql)
        if (sql === HAS_OPEN_SWEEPS_FOR_SAFE_SQL) return { rows: [{ open: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor

    expect(await deleteSafeForUser('safe-1', OWNER, false, db)).toBe(false)
    expect(calls).toEqual([
      LOCK_AGENTS_FOR_SAFE_SQL,
      HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL,
      HAS_OPEN_SWEEPS_FOR_SAFE_SQL,
    ])
  })
})
