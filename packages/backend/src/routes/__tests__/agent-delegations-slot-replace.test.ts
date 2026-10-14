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
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
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

  it('CHARACTERISATION (before #3933): a plain grant into an occupied slot activates and sweeps the old row to replaced', async () => {
    const { userId, agentId } = await seedAgent()
    const old = await seedDelegation(agentId, 'active')
    const fresh = await seedDelegation(agentId, 'pending')

    const res = await activate(agentId, userId, fresh)

    expect(res.statusCode).toBe(200)
    expect(await statusOf(fresh)).toBe('active')
    // SQL only: the old grant is still enabled on-chain, and nothing asked
    // the owner to stop it.
    expect(await statusOf(old)).toBe('replaced')
  })
})
