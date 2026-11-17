/**
 * The receive-only merchant key on the REAL Postgres harness (#4896, epic
 * #4885).
 *
 * The route suite mocks the database, so it can prove the route's decisions
 * but not the invariants they rest on. This file proves the invariants:
 *
 *   - the secret is returned once and only its hash and prefix are stored —
 *     no column of the row equals the secret;
 *   - a revoked key is refused on the next request;
 *   - while merchant services are off, every key of that account is refused;
 *   - `last_used_at` is written after an ACCEPTED request, at most once a
 *     minute per key (the throttle is the UPDATE's WHERE clause);
 *   - a key is bound to its own account: a key bound to another account of the
 *     same user is refused, and a row whose account belongs to another user
 *     resolves to nothing;
 *   - the create/list/revoke cycle works end to end, and a second revoke does
 *     not rewrite who revoked the key or when.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const merchantKeyRoutes = (await import('../merchant-keys.js')).default
const { merchantAuthMiddleware, registerMerchantLastUsedHook } = await import(
  '../../middleware/merchantAuth.js'
)
const { hashMerchantKey } = await import('../../domain/merchant-keys.js')

interface Seeded {
  userId: string
  accountId: string
  accountAddress: string
}

async function seedUserWithMerchantAccount(opts: { enabled?: boolean } = {}): Promise<Seeded> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`merchant-key-${randomUUID()}@test.example`],
  )
  const userId = user.rows[0].id
  const accountAddress = '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, is_merchant_account)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', false, true) RETURNING id`,
    [userId, accountAddress],
  )
  await db.query(
    `INSERT INTO merchant_service_settings (user_id, enabled, enabled_at)
     VALUES ($1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END)`,
    [userId, opts.enabled ?? true],
  )
  return { userId, accountId: account.rows[0].id, accountAddress }
}

async function seedPlainAccount(userId: string): Promise<string> {
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', true) RETURNING id`,
    [userId, '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)],
  )
  return account.rows[0].id
}

describeDb('merchant keys on the real database (#4896)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    registerMerchantLastUsedHook(app)
    await app.register(merchantKeyRoutes, { prefix: '/merchant-keys' })
    // The merchant route the key authenticates. A test route IS a merchant
    // route; #4897 wires the real ones to the same middleware.
    app.get('/merchant/sales', { preHandler: merchantAuthMiddleware }, async (request) => ({
      account_id: request.merchant!.account_id,
      account_address: request.merchant!.account_address,
      chain_id: request.merchant!.chain_id,
      key_id: request.merchant!.key_id,
    }))
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await resetDb()
  })

  function ownerToken(userId: string): string {
    return app.jwt.sign({ sub: userId, email: 'owner@example.com' })
  }

  async function createKey(userId: string): Promise<{ id: string; secret: string; key_prefix: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/merchant-keys',
      headers: { authorization: `Bearer ${ownerToken(userId)}` },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json()
  }

  function merchantCall(secret: string) {
    return app.inject({
      method: 'GET',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${secret}` },
    })
  }

  /**
   * The last-used write is an `onResponse` hook, so it runs AFTER the response
   * is sent and `inject` may resolve first. Poll for it rather than sleeping a
   * fixed time: the write is throttled, so a fixed sleep would be either flaky
   * or slow.
   */
  async function waitForLastUsed(keyId: string): Promise<number | null> {
    for (let i = 0; i < 40; i += 1) {
      const row = await db.query<{ last_used_at: string | Date | null }>(
        `SELECT last_used_at FROM merchant_keys WHERE id = $1`,
        [keyId],
      )
      const value = row.rows[0].last_used_at
      if (value !== null) return new Date(value).getTime()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return null
  }

  it('returns the secret once and stores only its hash and prefix', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)

    expect(created.secret).toMatch(/^sk_merchant_[0-9a-f]{48}$/)
    expect(created.key_prefix).toBe(created.secret.slice(0, 'sk_merchant_'.length + 12))

    const row = await db.query<Record<string, unknown>>(
      `SELECT * FROM merchant_keys WHERE id = $1`,
      [created.id],
    )
    expect(row.rows).toHaveLength(1)
    const stored = row.rows[0]
    expect(stored.key_hash).toBe(hashMerchantKey(created.secret))
    expect(stored.key_prefix).toBe(created.key_prefix)
    // No column of the row carries the secret.
    expect(Object.values(stored)).not.toContain(created.secret)
    expect(JSON.stringify(stored)).not.toContain(created.secret)

    // And the list returns the prefix only.
    const list = await app.inject({
      method: 'GET',
      url: '/merchant-keys',
      headers: { authorization: `Bearer ${ownerToken(userId)}` },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().keys).toHaveLength(1)
    expect(list.json().keys[0].key_prefix).toBe(created.key_prefix)
    expect(list.body).not.toContain(created.secret)
    expect(list.body).not.toContain(hashMerchantKey(created.secret))
  })

  it('authenticates the merchant route as the key\'s account', async () => {
    const { userId, accountId, accountAddress } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)

    const res = await merchantCall(created.secret)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({
      account_id: accountId,
      account_address: accountAddress,
      chain_id: 84532,
      key_id: created.id,
    })
  })

  it('refuses a revoked key on the next request', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)
    expect((await merchantCall(created.secret)).statusCode).toBe(200)

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/merchant-keys/${created.id}`,
      headers: { authorization: `Bearer ${ownerToken(userId)}` },
    })
    expect(revoke.statusCode, revoke.body).toBe(200)
    expect(revoke.json().revoked_by).toBe(userId)
    expect(revoke.json().revoked_at).not.toBeNull()

    const refused = await merchantCall(created.secret)
    expect(refused.statusCode).toBe(401)
    expect(refused.json().error_code).toBe('MERCHANT_KEY_INVALID')
  })

  it('a second revoke does not rewrite who revoked the key or when', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)

    const first = await app.inject({
      method: 'DELETE',
      url: `/merchant-keys/${created.id}`,
      headers: { authorization: `Bearer ${ownerToken(userId)}` },
    })
    const second = await app.inject({
      method: 'DELETE',
      url: `/merchant-keys/${created.id}`,
      headers: { authorization: `Bearer ${ownerToken(userId)}` },
    })

    expect(second.statusCode).toBe(200)
    expect(second.json().revoked_at).toBe(first.json().revoked_at)
    expect(second.json().revoked_by).toBe(first.json().revoked_by)
  })

  it('refuses every key of an account whose merchant services are off', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)
    expect((await merchantCall(created.secret)).statusCode).toBe(200)

    await db.query(`UPDATE merchant_service_settings SET enabled = false WHERE user_id = $1`, [userId])

    const refused = await merchantCall(created.secret)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error_code).toBe('MERCHANT_SERVICES_OFF')
  })

  it('writes last_used_at after an accepted request, at most once a minute', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)

    const before = await db.query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM merchant_keys WHERE id = $1`,
      [created.id],
    )
    expect(before.rows[0].last_used_at).toBeNull()

    expect((await merchantCall(created.secret)).statusCode).toBe(200)
    const firstUsed = await waitForLastUsed(created.id)
    expect(firstUsed).not.toBeNull()

    // A second accepted request inside the minute does NOT move it. Give the
    // hook time to run, then read: the throttle is what keeps the value still.
    expect((await merchantCall(created.secret)).statusCode).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const second = await db.query<{ last_used_at: string | Date }>(
      `SELECT last_used_at FROM merchant_keys WHERE id = $1`,
      [created.id],
    )
    expect(new Date(second.rows[0].last_used_at).getTime()).toBe(firstUsed)

    // Backdate past the throttle: the next accepted request DOES move it.
    await db.query(
      `UPDATE merchant_keys SET last_used_at = NOW() - INTERVAL '61 seconds' WHERE id = $1`,
      [created.id],
    )
    const backdated = await db.query<{ last_used_at: string | Date }>(
      `SELECT last_used_at FROM merchant_keys WHERE id = $1`,
      [created.id],
    )
    const backdatedMs = new Date(backdated.rows[0].last_used_at).getTime()
    expect((await merchantCall(created.secret)).statusCode).toBe(200)

    // Poll until the value MOVES past the backdated one — the hook runs after
    // the response, and the backdated value is already non-null.
    let thirdUsed: number | null = null
    for (let i = 0; i < 40; i += 1) {
      const row = await db.query<{ last_used_at: string | Date }>(
        `SELECT last_used_at FROM merchant_keys WHERE id = $1`,
        [created.id],
      )
      const value = new Date(row.rows[0].last_used_at).getTime()
      if (value > backdatedMs) {
        thirdUsed = value
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(thirdUsed).not.toBeNull()
    expect(thirdUsed!).toBeGreaterThan(firstUsed!)
  })

  it('a REFUSED request does not write last_used_at', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const created = await createKey(userId)
    await db.query(`UPDATE merchant_service_settings SET enabled = false WHERE user_id = $1`, [userId])

    expect((await merchantCall(created.secret)).statusCode).toBe(403)
    const row = await db.query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM merchant_keys WHERE id = $1`,
      [created.id],
    )
    expect(row.rows[0].last_used_at).toBeNull()
  })

  it('a key bound to another account of the SAME user is refused', async () => {
    const { userId } = await seedUserWithMerchantAccount()
    const plainAccountId = await seedPlainAccount(userId)
    const secret = 'sk_merchant_' + 'c3'.repeat(24)
    await db.query(
      `INSERT INTO merchant_keys (user_id, account_id, key_hash, key_prefix, created_by)
       VALUES ($1, $2, $3, $4, $1)`,
      [userId, plainAccountId, hashMerchantKey(secret), secret.slice(0, 'sk_merchant_'.length + 12)],
    )

    const refused = await merchantCall(secret)
    expect(refused.statusCode).toBe(401)
    expect(refused.json().error_code).toBe('MERCHANT_KEY_INVALID')
  })

  it('a row whose account belongs to ANOTHER user resolves to nothing', async () => {
    const owner = await seedUserWithMerchantAccount()
    const other = await seedUserWithMerchantAccount()
    const secret = 'sk_merchant_' + 'd4'.repeat(24)
    // The key row says owner, the account says other: the auth JOIN scopes the
    // account to the key's own user, so this resolves to no row at all.
    await db.query(
      `INSERT INTO merchant_keys (user_id, account_id, key_hash, key_prefix, created_by)
       VALUES ($1, $2, $3, $4, $1)`,
      [owner.userId, other.accountId, hashMerchantKey(secret), secret.slice(0, 'sk_merchant_'.length + 12)],
    )

    const refused = await merchantCall(secret)
    expect(refused.statusCode).toBe(401)
    expect(refused.json().error_code).toBe('MERCHANT_KEY_INVALID')
  })

  it('refuses to create a key before merchant services are on', async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`merchant-key-nokey-${randomUUID()}@test.example`],
    )
    const res = await app.inject({
      method: 'POST',
      url: '/merchant-keys',
      headers: { authorization: `Bearer ${ownerToken(user.rows[0].id)}` },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('MERCHANT_ACCOUNT_REQUIRED')
    const rows = await db.query(`SELECT id FROM merchant_keys WHERE user_id = $1`, [user.rows[0].id])
    expect(rows.rows).toHaveLength(0)
  })
})
