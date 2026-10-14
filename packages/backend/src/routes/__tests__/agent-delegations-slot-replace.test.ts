/**
 * #3933 — a plain grant into an occupied (token, recipient) slot.
 *
 * The activate route's slot sweep marks the slot's previous `active` grant
 * `replaced` in SQL only; the old delegation stays enabled on-chain until the
 * owner's Stop lands, and only the edit flow (grant + revoke) submits that
 * Stop. Real Postgres, mocked chain reads — the subject is the route's slot
 * rule and what it writes, not account derivation.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const DELEGATE = '0x00000000000000000000000000000000000000d1'
// What `computeHybridAccountAddress` derives from DELEGATE — mocked, fixed.
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)
const SIGNATURE = '0x' + 'ab'.repeat(65)
const FAR_FUTURE = 1_900_000_000

vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: async () => DELEGATE_ACCOUNT,
    ensureHybridDeployed: async () => ({ address: TREASURY, alreadyDeployed: true }),
  }
})

const agentDelegationRoutes = (await import('../agent-delegations.js')).default

let seq = 0
const nextHash = () => `0x${String(++seq).padStart(64, '7')}`

describeDb('a plain grant into an occupied budget slot (#3933)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await app.close()
  })

  function userHeaders(userId: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'u@test.dev' })}` }
  }

  async function seedAgent(): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`slot-replace-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, owner_address)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', $3) RETURNING id`,
      [userId, TREASURY, '0x' + 'ff'.repeat(20)],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Slot agent', $3, $4, 'sk_agnt_slt', 'active') RETURNING id`,
      [userId, account.rows[0].id, DELEGATE, `hash-slot-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  /** One `agent_delegations` row in the open USDC slot (recipient NULL). */
  async function seedDelegation(
    agentId: string,
    status: 'pending' | 'active',
    opts: { expiresAt?: number; version?: number } = {},
  ): Promise<string> {
    const hash = nextHash()
    await db.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at
       ) VALUES ($1, 84532, $2, NULL, $3, $4, $5, $6, '1000000', 86400, 0, $7)`,
      [
        agentId,
        USDC,
        hash,
        JSON.stringify({
          delegate: DELEGATE_ACCOUNT,
          delegator: TREASURY,
          authority: `0x${'0'.repeat(64)}`,
          caveats: [],
          salt: String(seq),
        }),
        opts.version ?? seq,
        status,
        opts.expiresAt ?? FAR_FUTURE,
      ],
    )
    return hash
  }

  async function statusOf(hash: string): Promise<string> {
    const r = await db.query<{ status: string }>(`SELECT status FROM agent_delegations WHERE delegation_hash = $1`, [hash])
    return r.rows[0].status
  }

  async function activate(agentId: string, userId: string, hash: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/agents/${agentId}/delegations/${hash}/activate`,
      headers: userHeaders(userId),
      payload: { signature: SIGNATURE, ...extra },
    })
  }

  it('was: a plain grant into an occupied slot activated and swept the old row to replaced in SQL only — now refused by name, nothing written', async () => {
    // The characterisation this file opened with (activate → 200, old →
    // `replaced`) flipped: the old grant would stay enabled on-chain with
    // nothing asking the owner to stop it.
    const { userId, agentId } = await seedAgent()
    const old = await seedDelegation(agentId, 'active')
    const fresh = await seedDelegation(agentId, 'pending')

    const res = await activate(agentId, userId, fresh)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'BUDGET_SLOT_OCCUPIED', existing_delegation_hash: old })
    expect(String(res.json().error)).toMatch(/Edit that budget/)
    expect(await statusOf(old)).toBe('active')
    expect(await statusOf(fresh)).toBe('pending')
  })

  it('a grant into an empty slot activates as before', async () => {
    const { userId, agentId } = await seedAgent()
    const fresh = await seedDelegation(agentId, 'pending')
    const res = await activate(agentId, userId, fresh)
    expect(res.statusCode).toBe(200)
    expect(await statusOf(fresh)).toBe('active')
  })

  it('the edit flow, naming the live grant it replaces, activates and sweeps it', async () => {
    const { userId, agentId } = await seedAgent()
    const old = await seedDelegation(agentId, 'active')
    const fresh = await seedDelegation(agentId, 'pending')

    const res = await activate(agentId, userId, fresh, { replaces: old.toUpperCase().replace('0X', '0x') })

    expect(res.statusCode).toBe(200)
    expect(await statusOf(fresh)).toBe('active')
    expect(await statusOf(old)).toBe('replaced')
  })

  it('a wrong or stale `replaces` is refused like a plain grant', async () => {
    const { userId, agentId } = await seedAgent()
    const old = await seedDelegation(agentId, 'active')
    const fresh = await seedDelegation(agentId, 'pending')
    // Stale: a grant this slot replaced earlier. Wrong: a hash nobody holds.
    const stale = await seedDelegation(agentId, 'active')
    await db.query(`UPDATE agent_delegations SET status = 'replaced' WHERE delegation_hash = $1`, [stale])

    for (const replaces of [stale, `0x${'9'.repeat(64)}`]) {
      const res = await activate(agentId, userId, fresh, { replaces })
      expect(res.statusCode, replaces).toBe(409)
      expect(res.json().error_code).toBe('BUDGET_SLOT_OCCUPIED')
    }
    expect(await statusOf(old)).toBe('active')
    expect(await statusOf(fresh)).toBe('pending')
  })

  it('an expired active row does not occupy the slot: a plain grant activates', async () => {
    const { userId, agentId } = await seedAgent()
    const expired = await seedDelegation(agentId, 'active', { expiresAt: Math.floor(Date.now() / 1000) - 60 })
    const fresh = await seedDelegation(agentId, 'pending')

    const res = await activate(agentId, userId, fresh)

    expect(res.statusCode).toBe(200)
    expect(await statusOf(fresh)).toBe('active')
    // Swept as before: an expired grant is dead on-chain, so this is bookkeeping.
    expect(await statusOf(expired)).toBe('replaced')
  })

  describe('build refuses first, so the owner is not asked to sign what activate would refuse', () => {
    async function build(agentId: string, userId: string, extra: Record<string, unknown> = {}) {
      return app.inject({
        method: 'POST',
        url: `/agents/${agentId}/delegations/build`,
        headers: userHeaders(userId),
        payload: { token_address: USDC, recipient_address: null, budget_atomic: '2000000', period_seconds: 86_400, ...extra },
      })
    }

    async function pendingCount(agentId: string): Promise<number> {
      const r = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM agent_delegations WHERE agent_id = $1 AND status = 'pending'`,
        [agentId],
      )
      return Number(r.rows[0].n)
    }

    it('a plain build into an occupied slot is refused, and nothing is built', async () => {
      const { userId, agentId } = await seedAgent()
      const old = await seedDelegation(agentId, 'active')

      const res = await build(agentId, userId)

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error_code: 'BUDGET_SLOT_OCCUPIED', existing_delegation_hash: old })
      expect(await pendingCount(agentId)).toBe(0)
    })

    it('an edit build naming the live grant builds; a plain build into an empty slot builds', async () => {
      const { userId, agentId } = await seedAgent()
      const old = await seedDelegation(agentId, 'active')
      expect((await build(agentId, userId, { replaces: old })).statusCode).toBe(201)

      const other = await seedAgent()
      expect((await build(other.agentId, other.userId)).statusCode).toBe(201)
    })
  })
})
