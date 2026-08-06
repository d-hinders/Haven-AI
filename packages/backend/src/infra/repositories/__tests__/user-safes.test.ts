import { describe, expect, it, vi } from 'vitest'
import {
  COUNT_SAFES_FOR_USER_SQL,
  FIND_OLDEST_SAFE_FOR_USER_SQL,
  FIND_OWNED_SAFE_ADDRESS_SQL,
  FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
  FIND_OWNED_SAFE_SQL,
  FIND_SAFE_ID_BY_ADDRESS_AND_CHAIN_SQL,
  CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
  LIST_KNOWN_APPROVERS_FOR_USER_SQL,
  LIST_SAFES_FOR_USER_SQL,
  RENAME_SAFE_FOR_USER_SQL,
  SET_LEGACY_USER_SAFE_ADDRESS_SQL,
  countSafesForUser,
  deleteSafeForUser,
  findOwnedSafe,
  findOwnedSafeAddress,
  findOwnedSafeDefaultFlag,
  findSafeIdByAddressAndChain,
  listKnownApproversForUser,
  listSafesForUser,
  renameSafeForUser,
  setDefaultSafeForUser,
  setLegacyUserSafeAddress,
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
      FIND_SAFE_ID_BY_ADDRESS_AND_CHAIN_SQL,
      COUNT_SAFES_FOR_USER_SQL,
      FIND_OWNED_SAFE_ADDRESS_SQL,
      FIND_OWNED_SAFE_DEFAULT_FLAG_SQL,
      FIND_OWNED_SAFE_SQL,
      RENAME_SAFE_FOR_USER_SQL,
      CLEAR_DEFAULT_SAFES_FOR_USER_SQL,
      FIND_OLDEST_SAFE_FOR_USER_SQL,
      LIST_KNOWN_APPROVERS_FOR_USER_SQL,
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

  it('findSafeIdByAddressAndChain: duplicate detection is per-tenant', async () => {
    const db = tenantExecutor({ id: 'safe-1' })
    expect(await findSafeIdByAddressAndChain(ATTACKER, '0xabc', 8453, db)).toBeNull()
    expect(await findSafeIdByAddressAndChain(OWNER, '0xabc', 8453, db)).toBe('safe-1')
  })

  it('countSafesForUser passes the tenant scope as its only parameter', async () => {
    const query = vi.fn(async () => ({ rows: [{ count: '2' }], rowCount: 1 }))
    const db = { query } as unknown as Executor
    expect(await countSafesForUser(OWNER, db)).toBe(2)
    expect(query).toHaveBeenCalledWith(COUNT_SAFES_FOR_USER_SQL, [OWNER])
  })

  it.each([
    ['findOwnedSafe', findOwnedSafe],
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

  it('setLegacyUserSafeAddress: the UPDATE is pinned to the caller’s users row', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const db = { query } as unknown as Executor
    await setLegacyUserSafeAddress('0xabc', OWNER, db)
    expect(query).toHaveBeenCalledWith(SET_LEGACY_USER_SAFE_ADDRESS_SQL, ['0xabc', OWNER])
  })

  it('listKnownApproversForUser: the registry is per-tenant', async () => {
    const db = tenantExecutor({ address: '0xabc', type: 'eoa', label: null, safe_ids: [] })
    expect(await listKnownApproversForUser(ATTACKER, db)).toEqual([])
    expect(await listKnownApproversForUser(OWNER, db)).toHaveLength(1)
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
})
