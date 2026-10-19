/**
 * Migration 114's data-layer guarantees, on the REAL Postgres harness (#4023).
 * The route test mocks the DB, so per the testing strategy this is where the
 * schema's behaviour is actually proven: the '0x' backfill, the explicit
 * UNIQUE rules, the never-reused counter that survives unlink's hard DELETE,
 * and concurrent allocation.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  ALLOCATE_HYBRID_DEPLOY_SALT_SQL,
  FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_REPLAY_SQL,
  findAccountByCreateIdempotencyKey,
} from '../smart-accounts.js'

let seq = 0

async function seedUser(): Promise<string> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`salt${n}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

async function seedHybridAccount(
  userId: string,
  address: string,
  chainId = 84532,
  extra: { deploySalt?: string; idempotencyKey?: string } = {},
): Promise<string> {
  const row = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, deploy_salt, create_idempotency_key)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', $4, $5) RETURNING id`,
    [userId, address, chainId, extra.deploySalt ?? '0x', extra.idempotencyKey ?? null],
  )
  return row.rows[0].id
}

describeDb('smart_accounts deploy salt (#4023, migration 114)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('backfills every pre-existing row to the salt-0 default — the address keeps deriving', async () => {
    // Inserted WITHOUT the new column: exactly what a pre-114 row looked like.
    const userId = await seedUser()
    const id = await db.query<{ id: string; deploy_salt: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id, deploy_salt`,
      [userId, '0x' + 'ab'.repeat(20)],
    )
    // The column default IS the backfill: the row derives at '0x', the same
    // salt it was provisioned with before #4023.
    expect(id.rows[0].deploy_salt).toBe('0x')
  })

  it('UNIQUE(user_id, chain_id, LOWER(account_address)) refuses a second claim on one derived address', async () => {
    const userId = await seedUser()
    await seedHybridAccount(userId, '0x' + 'cd'.repeat(20))
    // Same address, DIFFERENT case, same chain — the index is on the LOWER
    // form, so casing cannot smuggle a duplicate past the constraint. This is
    // the app-level duplicate check's rule, now carried by the database.
    await expect(seedHybridAccount(userId, '0x' + 'CD'.repeat(20))).rejects.toMatchObject({
      code: '23505',
    })
    // …and the same owner on ANOTHER chain is still fine: the same owner
    // config derives the same address on every chain, and each chain holds
    // its own registration.
    await expect(seedHybridAccount(userId, '0x' + 'cd'.repeat(20), 8453)).resolves.toBeDefined()
    // A DIFFERENT user holding the same derived address is out of scope for
    // this rule — owner configs are per-user keys, and the salt scheme is
    // what makes one address identify one account (migration 114 docblock).
    await expect(seedHybridAccount(await seedUser(), '0x' + 'cd'.repeat(20))).resolves.toBeDefined()
  })

  it('allocates DISTINCT salts to two concurrent creates — the row lock serialises them', async () => {
    const userId = await seedUser()
    const [a, b] = await Promise.all([
      db.query<{ last_allocated: string }>(ALLOCATE_HYBRID_DEPLOY_SALT_SQL, [userId, '0xcred1']),
      db.query<{ last_allocated: string }>(ALLOCATE_HYBRID_DEPLOY_SALT_SQL, [userId, '0xcred1']),
    ])
    const values = [BigInt(a.rows[0].last_allocated), BigInt(b.rows[0].last_allocated)].sort((x, y) => (x < y ? -1 : 1))
    // Distinct AND both starting from 1: counter 0 is never issued because
    // pad('0x', {size: 32}) is the same salt as '0x'.
    expect(values[0]).toBe(1n)
    expect(values[1]).toBe(2n)
  })

  it('the counter survives unlink: a hard-DELETEd account never reissues its salt', async () => {
    const userId = await seedUser()
    const first = await db.query<{ last_allocated: string }>(ALLOCATE_HYBRID_DEPLOY_SALT_SQL, [userId, '0xcred1'])
    expect(BigInt(first.rows[0].last_allocated)).toBe(1n)

    // Unlink is a HARD DELETE (routes/user-accounts.ts) — the account row and
    // its passkeys are gone; the counter table is deliberately not.
    await db.query(`DELETE FROM smart_accounts WHERE user_id = $1`, [userId])

    const second = await db.query<{ last_allocated: string }>(ALLOCATE_HYBRID_DEPLOY_SALT_SQL, [userId, '0xcred1'])
    // Counter value 1 — the deleted, possibly funded account's salt — is
    // never handed out again.
    expect(BigInt(second.rows[0].last_allocated)).toBe(2n)
  })

  it('UNIQUE(user_id, create_idempotency_key) makes a retried create answer the FIRST account', async () => {
    const userId = await seedUser()
    const address = '0x' + 'ef'.repeat(20)
    await seedHybridAccount(userId, address, 84532, { idempotencyKey: 'create-key-1' })
    // A concurrent/retried insert with the SAME key conflicts and (via the
    // route's ON CONFLICT DO NOTHING) resolves to the winner's row instead
    // of minting a second account.
    await expect(
      seedHybridAccount(userId, '0x' + 'ff'.repeat(20), 84532, { idempotencyKey: 'create-key-1' }),
    ).rejects.toMatchObject({ code: '23505' })
    // The replay read answers the first account, which is what the route returns.
    const replay = await db.query(FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_REPLAY_SQL, [userId, address, 84532])
    expect(replay.rows).toHaveLength(1)
  })

  it('the idempotency key is per-user: the same key under another user is independent', async () => {
    const [a, b] = [await seedUser(), await seedUser()]
    await seedHybridAccount(a, '0x' + '12'.repeat(20), 84532, { idempotencyKey: 'shared-key' })
    await expect(
      seedHybridAccount(b, '0x' + '34'.repeat(20), 84532, { idempotencyKey: 'shared-key' }),
    ).resolves.toBeDefined()
  })

  it('#4024: the create replay read returns the STORED chain, numeric, and only for the caller', async () => {
    const [a, b] = [await seedUser(), await seedUser()]
    const id = await seedHybridAccount(a, '0x' + '56'.repeat(20), 8453, { idempotencyKey: 'replay-key' })
    const replay = await findAccountByCreateIdempotencyKey(a, 'replay-key')
    expect(replay).toMatchObject({ id, chain_id: 8453 })
    expect(typeof replay!.chain_id).toBe('number')
    // Scoped by user: another user's identical key replays nothing.
    await expect(findAccountByCreateIdempotencyKey(b, 'replay-key')).resolves.toBeNull()
  })
})
