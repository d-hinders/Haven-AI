/**
 * The in-flight retry race on create-additional (#4024), on the REAL Postgres
 * harness — the route suite mocks the DB, and this claim is about what two
 * transactions do to each other.
 *
 * The client times out while its first create is still inside the
 * registration transaction, then retries with the SAME idempotency key. Both
 * requests pass the replay pre-check (no row exists yet). The retry blocks on
 * the salt-counter row the first holds, draws counter 2 once the first
 * commits, derives a different address, and its insert hits
 * UNIQUE(user_id, create_idempotency_key). Before #4024's conflict re-read it
 * then fell to the address lookup, found nothing, and answered a bare 409
 * "Account already registered". It must instead answer the FIRST account —
 * and roll back its own counter bump.
 *
 * The derivation is the one mock (it is a chain read): it maps each (passkey,
 * salt) pair to a distinct address, and the FIRST call waits, which holds the first
 * transaction open long enough for the retry to arrive.
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

const hybridAccountRoutes = (await import('../hybrid-accounts.js')).default

const KEY_A = '0x' + 'a1'.repeat(16)
const KEY_B = '0x' + 'b2'.repeat(16)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function seedUserWithSource(keyIds: string[]): Promise<{ userId: string; sourceId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`create-race-${randomUUID()}@test.example`],
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

describeDb('POST /accounts/hybrid — the in-flight retry race (#4024)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })
  })
  afterAll(async () => app?.close())
  beforeEach(async () => {
    await resetDb()
    mockCompute.mockReset()
    let calls = 0
    mockCompute.mockImplementation(
      async (_chainId: number, cfg: { deploySalt: string; passkeys: Array<{ keyId: string }> }) => {
        // Hold the FIRST registration transaction open (counter row locked).
        if (++calls === 1) await sleep(400)
        // Distinct per (passkey, salt), as the real derivation is.
        return '0x' + cfg.passkeys[0]!.keyId.slice(2, 10) + cfg.deploySalt.slice(-32)
      },
    )
  })

  function create(userId: string, body: Record<string, unknown>) {
    const token = app.jwt.sign({ sub: userId, email: 'u@example.com' }, { expiresIn: '1h' })
    return app.inject({
      method: 'POST',
      url: '/accounts/hybrid',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    })
  }

  it('a retry with the same key, sent while the first is in flight, answers the FIRST account', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A])
    const body = { chain_id: 84532, source_account_id: sourceId, key_id: KEY_A, name: 'Reserve', idempotency_key: 'race-1' }

    const first = create(userId, body)
    await sleep(100) // the first is now inside its transaction
    const retry = create(userId, body)
    const [a, b] = await Promise.all([first, retry])

    expect(a.statusCode).toBe(201)
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json().id).toBe(a.json().id)
    expect(b.json().account_address).toBe(a.json().account_address)

    const rows = await db.query(`SELECT id FROM smart_accounts WHERE user_id = $1 AND create_idempotency_key = 'race-1'`, [userId])
    expect(rows.rows).toHaveLength(1)
    // The retry drew counter 2 and threw it away with its transaction.
    const counter = await db.query<{ last_allocated: string }>(
      `SELECT last_allocated FROM hybrid_deploy_salt_counters WHERE user_id = $1 AND salt_key = $2`,
      [userId, KEY_A],
    )
    expect(counter.rows[0].last_allocated).toBe('1')
  })

  it('the same key raced with a DIFFERENT passkey is refused with IDEMPOTENCY_KEY_REUSED, not a bare 409', async () => {
    const { userId, sourceId } = await seedUserWithSource([KEY_A, KEY_B])
    const base = { chain_id: 84532, source_account_id: sourceId, name: 'Reserve', idempotency_key: 'race-2' }

    const first = create(userId, { ...base, key_id: KEY_A })
    await sleep(100)
    // Another passkey has its own counter row, so this one does not wait: it
    // commits first and the delayed request is the one that loses on the key.
    const second = create(userId, { ...base, key_id: KEY_B })
    const responses = await Promise.all([first, second])

    const won = responses.find((r) => r.statusCode === 201)
    const lost = responses.find((r) => r.statusCode !== 201)
    expect(won, responses.map((r) => r.body).join(' | ')).toBeDefined()
    expect(lost!.statusCode).toBe(409)
    expect(lost!.json()).toMatchObject({ error_code: 'IDEMPOTENCY_KEY_REUSED', id: won!.json().id })
    const rows = await db.query(`SELECT id FROM smart_accounts WHERE user_id = $1 AND create_idempotency_key = 'race-2'`, [userId])
    expect(rows.rows).toHaveLength(1)
  })
})
