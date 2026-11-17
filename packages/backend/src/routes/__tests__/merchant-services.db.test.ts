/**
 * Merchant services on the REAL Postgres harness (#4895, epic #4885).
 *
 * The route suite mocks the database, so it can prove the route's decisions
 * but not the invariants they rest on. This file proves the invariants:
 *
 *   - the partial unique index refuses a SECOND merchant account for one user,
 *     whoever writes it;
 *   - the setting, the account and the marker commit together — a refusal
 *     leaves none of the three behind;
 *   - turning off and on again reuses the same account;
 *   - two concurrent turn-ons create ONE account (the setting-row lock plus the
 *     derived idempotency key);
 *   - the created account is not the default and has no agents.
 *
 * The derivation is the one mock (it is a chain read): it maps each (passkey,
 * salt) pair to a distinct address, and the first call can be held open to keep
 * a transaction in flight.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const { mockCompute } = vi.hoisted(() => ({ mockCompute: vi.fn() }))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeUserHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})

const merchantServiceRoutes = (await import('../merchant-services.js')).default

const KEY_A = '0x' + 'a1'.repeat(16)
const KEY_B = '0x' + 'b2'.repeat(16)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function seedUserWithSource(keyIds: string[]): Promise<{ userId: string; sourceId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`merchant-${randomUUID()}@test.example`],
  )
  const userId = user.rows[0].id
  const source = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', true) RETURNING id`,
    [userId, '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)],
  )
  for (const keyId of keyIds) {
    await db.query(
      `INSERT INTO hybrid_account_passkeys (account_id, key_id, public_key_x, public_key_y) VALUES ($1, $2, $3, $4)`,
      [source.rows[0].id, keyId, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)],
    )
  }
  return { userId, sourceId: source.rows[0].id }
}

describeDb('merchant services on the real database (#4895)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(merchantServiceRoutes, { prefix: '/merchant-services' })
  })
  afterAll(async () => app?.close())
  beforeEach(async () => {
    await resetDb()
    mockCompute.mockReset()
    let calls = 0
    mockCompute.mockImplementation(
      async (_chainId: number, cfg: { deploySalt: string; passkeys: Array<{ keyId: string }> }) => {
        // Hold the FIRST registration transaction open when a test asks for it.
        if (++calls === 1 && (globalThis as { __holdFirst?: boolean }).__holdFirst) await sleep(400)
        return '0x' + cfg.passkeys[0]!.keyId.slice(2, 10) + cfg.deploySalt.slice(-32)
      },
    )
    ;(globalThis as { __holdFirst?: boolean }).__holdFirst = false
  })

  function call(userId: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>) {
    const token = app.jwt.sign({ sub: userId, email: 'u@example.com' }, { expiresIn: '1h' })
    return app.inject({
      method,
      url: '/merchant-services',
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    })
  }

  async function merchantRows(userId: string) {
    const { rows } = await db.query<{
      id: string
      chain_id: number
      is_default: boolean
      is_merchant_account: boolean
      name: string
    }>(
      `SELECT id, chain_id, is_default, is_merchant_account, name
         FROM smart_accounts WHERE user_id = $1 AND is_merchant_account`,
      [userId],
    )
    return rows
  }

  async function settingRows(userId: string) {
    const { rows } = await db.query<{ enabled: boolean }>(
      `SELECT enabled FROM merchant_service_settings WHERE user_id = $1`,
      [userId],
    )
    return rows
  }

  it('creates exactly one account on the chosen network, marks it and enables the setting', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])

    const res = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ enabled: true, created: true })

    const merchants = await merchantRows(userId)
    expect(merchants).toHaveLength(1)
    expect(merchants[0]).toMatchObject({
      chain_id: 84532,
      is_default: false,
      is_merchant_account: true,
      name: 'Merchant account',
    })
    expect(await settingRows(userId)).toEqual([{ enabled: true }])

    // The account has no agents.
    const agents = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agents WHERE account_id = $1`,
      [merchants[0].id],
    )
    expect(agents.rows[0].count).toBe('0')

    // Repeating the request creates no second account.
    const again = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ enabled: true, created: false })
    expect(again.json().merchant_account.id).toBe(res.json().merchant_account.id)
    expect(await merchantRows(userId)).toHaveLength(1)
    // The creation logic ran once: the repeat answered the existing account.
    expect(mockCompute).toHaveBeenCalledTimes(1)
  })

  it('the partial unique index refuses a SECOND merchant account for one user', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])
    const first = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A })
    expect(first.statusCode, first.body).toBe(201)

    // A second account row for the same user, marked directly — the route
    // would never do this, and the database refuses it anyway.
    const second = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', false) RETURNING id`,
      [userId, '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)],
    )
    await expect(
      db.query(`UPDATE smart_accounts SET is_merchant_account = true WHERE id = $1`, [second.rows[0].id]),
    ).rejects.toMatchObject({ code: '23505' })

    expect(await merchantRows(userId)).toHaveLength(1)
  })

  it('the setting, the account and the marker commit together — a refusal leaves none of them', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])

    // KEY_NOT_ON_SOURCE is refused AFTER the setting row is created and locked
    // inside the transaction, so a committed setting row would prove the
    // transaction was not atomic.
    const res = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_B })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error_code: 'KEY_NOT_ON_SOURCE' })

    expect(await settingRows(userId)).toEqual([])
    expect(await merchantRows(userId)).toEqual([])
    const accounts = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM smart_accounts WHERE user_id = $1`,
      [userId],
    )
    expect(accounts.rows[0].count).toBe('1') // the seeded source account only
  })

  it('turning off and on again reuses the same merchant account', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])
    const on = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A })
    expect(on.statusCode, on.body).toBe(201)
    const accountId = on.json().merchant_account.id

    const off = await call(userId, 'DELETE')
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ enabled: false, merchant_account: { id: accountId } })
    expect(await settingRows(userId)).toEqual([{ enabled: false }])
    // The account and its marker survive.
    expect(await merchantRows(userId)).toHaveLength(1)

    const backOn = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A })
    expect(backOn.statusCode, backOn.body).toBe(200)
    expect(backOn.json()).toMatchObject({ enabled: true, created: false })
    expect(backOn.json().merchant_account.id).toBe(accountId)
    expect(await merchantRows(userId)).toHaveLength(1)
    expect(mockCompute).toHaveBeenCalledTimes(1)
  })

  it('refuses a different network with MERCHANT_ACCOUNT_ON_OTHER_NETWORK, never the key-reuse code', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])
    const on = await call(userId, 'POST', { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A })
    expect(on.statusCode, on.body).toBe(201)

    const other = await call(userId, 'POST', { chain_id: 8453, source_account_id: sourceId, key_id: KEY_A })
    expect(other.statusCode).toBe(409)
    expect(other.json()).toMatchObject({ error_code: 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK', chain_id: 84532 })
    expect(other.json().error_code).not.toBe('IDEMPOTENCY_KEY_REUSED')
    expect(await merchantRows(userId)).toHaveLength(1)
  })

  it('two concurrent turn-ons create ONE account', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])
    ;(globalThis as { __holdFirst?: boolean }).__holdFirst = true
    const body = { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A }

    const first = call(userId, 'POST', body)
    await sleep(100) // the first is now inside its transaction, holding the setting row
    const second = call(userId, 'POST', body)
    const [a, b] = await Promise.all([first, second])

    expect(a.statusCode, a.body).toBe(201)
    expect(b.statusCode, b.body).toBe(200)
    expect(b.json().merchant_account.id).toBe(a.json().merchant_account.id)
    expect(await merchantRows(userId)).toHaveLength(1)
    // The second request answered the existing account; it never derived one.
    expect(mockCompute).toHaveBeenCalledTimes(1)
  })

  it('never returns another user\'s setting or merchant account', async () => {
    const one = await seedUserWithSource([KEY_A])
    const two = await seedUserWithSource([KEY_A])
    const on = await call(one.userId, 'POST', { chain_id: 84532, source_account_id: one.sourceId, key_id: KEY_A })
    expect(on.statusCode, on.body).toBe(201)

    const read = await call(two.userId, 'GET')
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({
      enabled: false,
      enabled_at: null,
      disabled_at: null,
      merchant_account: null,
    })
  })
})
