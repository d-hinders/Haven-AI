/**
 * Real-DB tests for the session safes projection (#1205, harness #1220).
 *
 * The session payload now carries the raw signer-set inputs
 * (`owner_address`, `passkey_count`) that `sessionSafePayload` maps through
 * `needsBackupSignerRecommendation`. The passkey count is a JOIN against
 * `hybrid_account_passkeys` — exactly the "what does the query return" class
 * that belongs on the real database, not on a positional mock.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listSessionSafesForUser } from '../user-safes.js'

let n = 0

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`session-safes-${++n}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

async function seedSafe(
  userId: string,
  fields: { accountType?: string | null; ownerAddress?: string | null; chainId?: number } = {},
): Promise<string> {
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, name, chain_id, account_type, owner_address)
     VALUES ($1, $2, 'Test safe', $3, $4, $5) RETURNING id`,
    [
      userId,
      `0x${String(++n).padStart(40, '0')}`,
      fields.chainId ?? 8453,
      // #2413: the default is the DELEGATION rail, because the query now
      // filters retired-rail rows out. These cases are about the passkey-count
      // projection and tenant scoping, not the rail — seeding 'safe' here
      // would make them assert the filter rather than their own subject.
      fields.accountType ?? 'delegator_hybrid',
      fields.ownerAddress ?? null,
    ],
  )
  return safe.rows[0].id
}

async function seedPasskey(userSafeId: string, keyId: string): Promise<void> {
  await db.query(
    `INSERT INTO hybrid_account_passkeys (user_safe_id, key_id, public_key_x, public_key_y)
     VALUES ($1, $2, '0x1', '0x2')`,
    [userSafeId, keyId],
  )
}

describeDb('listSessionSafesForUser signer-set projection (#1205)', () => {
  // AWAITED in beforeAll (#1562 follow-up): a bare registration-time call
  // leaves the returned promise dangling and lets the first tests race the
  // worker's own migration DDL — the 42P01/40P01 CI flake. resetDb() now
  // also awaits init as a harness guarantee; this is the readable half.
  beforeAll(() => initDbHarness())
  beforeEach(async () => {
    await resetDb()
  })

  it('counts hybrid_account_passkeys per safe and carries owner_address', async () => {
    const userId = await seedUser()
    const hybridId = await seedSafe(userId, { accountType: 'delegator_hybrid' })
    await seedPasskey(hybridId, 'key-a')
    await seedPasskey(hybridId, 'key-b')
    const legacyId = await seedSafe(userId, { ownerAddress: '0x' + 'ab'.repeat(20) })

    const rows = await listSessionSafesForUser(userId)
    const hybrid = rows.find((r) => r.id === hybridId)
    const legacy = rows.find((r) => r.id === legacyId)

    expect(hybrid?.passkey_count).toBe(2)
    expect(hybrid?.owner_address).toBeNull()
    expect(hybrid?.account_type).toBe('delegator_hybrid')
    expect(legacy?.passkey_count).toBe(0)
    expect(legacy?.owner_address).toBe('0x' + 'ab'.repeat(20))
  })

  it('stays tenant-scoped: another user sees none of it', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    const safeId = await seedSafe(owner, { accountType: 'delegator_hybrid' })
    await seedPasskey(safeId, 'key-a')

    expect(await listSessionSafesForUser(other)).toEqual([])
  })
})
