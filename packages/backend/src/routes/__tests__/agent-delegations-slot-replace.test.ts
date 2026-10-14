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

  /**
   * One `agent_delegations` row — in the open USDC slot (recipient NULL)
   * unless `recipient` pins it. `startDate` in the future is a re-key's
   * dormant steady row; `createdAt` orders a pair deterministically.
   */
  async function seedDelegation(
    agentId: string,
    status: 'pending' | 'active',
    opts: { expiresAt?: number; version?: number; recipient?: string; startDate?: number; createdAt?: Date } = {},
  ): Promise<string> {
    const hash = nextHash()
    await db.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at, created_at
       ) VALUES ($1, 84532, $2, $8, $3, $4, $5, $6, '1000000', 86400, $9, $7, COALESCE($10, NOW()))`,
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
        opts.recipient ?? null,
        opts.startDate ?? 0,
        opts.createdAt ?? null,
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
  // ── Review findings 1, 2 and 4: which rows occupy a slot, and what an edit must name ──

  const RECIPIENT = '0x' + 'cc'.repeat(20)
  const OTHER_RECIPIENT = '0x' + 'ce'.repeat(20)

  it('(a) a recipient-pinned grant beside a live OPEN budget is a different slot: a plain grant activates, the open budget is untouched', async () => {
    const { userId, agentId } = await seedAgent()
    const open = await seedDelegation(agentId, 'active')
    const pinned = await seedDelegation(agentId, 'pending', { recipient: RECIPIENT })

    const res = await activate(agentId, userId, pinned)

    expect(res.statusCode).toBe(200)
    expect(await statusOf(pinned)).toBe('active')
    expect(await statusOf(open)).toBe('active')
  })

  it('(b) an active row whose period has not started (a re-key\'s dormant steady row) still occupies the slot', async () => {
    const { userId, agentId } = await seedAgent()
    const steady = await seedDelegation(agentId, 'active', { startDate: Math.floor(Date.now() / 1000) + 86_400 })
    const fresh = await seedDelegation(agentId, 'pending')

    const res = await activate(agentId, userId, fresh)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      error_code: 'BUDGET_SLOT_OCCUPIED',
      existing_delegation_hash: steady,
      occupying_delegation_hashes: [steady],
    })
    expect(await statusOf(steady)).toBe('active')
    expect(await statusOf(fresh)).toBe('pending')
  })

  it("(c) a `replaces` naming another agent's live budget is refused, alone or beside this slot's own", async () => {
    const { userId, agentId } = await seedAgent()
    const old = await seedDelegation(agentId, 'active')
    const fresh = await seedDelegation(agentId, 'pending')
    const other = await seedAgent()
    const foreign = await seedDelegation(other.agentId, 'active')

    for (const replaces of [foreign, [foreign], [old, foreign]]) {
      const res = await activate(agentId, userId, fresh, { replaces })
      expect(res.statusCode, JSON.stringify(replaces)).toBe(409)
      expect(res.json().error_code).toBe('BUDGET_SLOT_OCCUPIED')
    }
    expect(await statusOf(old)).toBe('active')
    expect(await statusOf(fresh)).toBe('pending')
    expect(await statusOf(foreign)).toBe('active')
  })

  describe('(d) a re-key carry/steady pair is two occupying rows, and an edit must name both', () => {
    async function seedPair(agentId: string): Promise<{ carry: string; steady: string }> {
      const now = Date.now()
      const carry = await seedDelegation(agentId, 'active', { createdAt: new Date(now - 2_000) })
      const steady = await seedDelegation(agentId, 'active', {
        startDate: Math.floor(now / 1000) + 86_400,
        createdAt: new Date(now - 1_000),
      })
      return { carry, steady }
    }

    it('naming only one half is refused at activate — the sweep would retire both and the edit stop one', async () => {
      const { userId, agentId } = await seedAgent()
      const { carry, steady } = await seedPair(agentId)
      const fresh = await seedDelegation(agentId, 'pending')

      for (const replaces of [carry, steady, [steady]]) {
        const res = await activate(agentId, userId, fresh, { replaces })
        expect(res.statusCode, JSON.stringify(replaces)).toBe(409)
        expect(res.json()).toMatchObject({
          error_code: 'BUDGET_SLOT_OCCUPIED',
          // Back-compat: the newest occupying row; the list is every one.
          existing_delegation_hash: steady,
          occupying_delegation_hashes: [steady, carry],
        })
      }
      expect(await statusOf(carry)).toBe('active')
      expect(await statusOf(steady)).toBe('active')
      expect(await statusOf(fresh)).toBe('pending')
    })

    it('naming both (any order, any case) activates, and both end up replaced', async () => {
      const { userId, agentId } = await seedAgent()
      const { carry, steady } = await seedPair(agentId)
      const fresh = await seedDelegation(agentId, 'pending')

      const res = await activate(agentId, userId, fresh, { replaces: [steady.toUpperCase().replace('0X', '0x'), carry] })

      expect(res.statusCode).toBe(200)
      expect(await statusOf(fresh)).toBe('active')
      expect(await statusOf(carry)).toBe('replaced')
      expect(await statusOf(steady)).toBe('replaced')
    })

    it('build applies the same rule: one half refused, both built', async () => {
      const { userId, agentId } = await seedAgent()
      const { carry, steady } = await seedPair(agentId)
      const build = (replaces: unknown) =>
        app.inject({
          method: 'POST',
          url: `/agents/${agentId}/delegations/build`,
          headers: userHeaders(userId),
          payload: { token_address: USDC, recipient_address: null, budget_atomic: '2000000', period_seconds: 86_400, replaces },
        })

      const half = await build(carry)
      expect(half.statusCode).toBe(409)
      expect(half.json().occupying_delegation_hashes).toEqual([steady, carry])
      expect((await build([carry, steady])).statusCode).toBe(201)
    })
  })

  describe("(e) an edit that changes the recipient: the rule reads the TARGET slot", () => {
    it('into an occupied slot: refused even when `replaces` names the edited budget — that budget is in another slot', async () => {
      const { userId, agentId } = await seedAgent()
      const edited = await seedDelegation(agentId, 'active')
      const target = await seedDelegation(agentId, 'active', { recipient: RECIPIENT })
      const fresh = await seedDelegation(agentId, 'pending', { recipient: RECIPIENT })

      for (const replaces of [undefined, edited]) {
        const res = await activate(agentId, userId, fresh, replaces ? { replaces } : {})
        expect(res.statusCode, String(replaces)).toBe(409)
        expect(res.json()).toMatchObject({
          error_code: 'BUDGET_SLOT_OCCUPIED',
          existing_delegation_hash: target,
          occupying_delegation_hashes: [target],
        })
      }
      expect(await statusOf(edited)).toBe('active')
      expect(await statusOf(target)).toBe('active')
      expect(await statusOf(fresh)).toBe('pending')
    })

    it('into an empty slot: activates, and the edited budget in the OLD slot stays active — the sweep is scoped to the new slot, so the edit flow must Stop it itself', async () => {
      const { userId, agentId } = await seedAgent()
      const edited = await seedDelegation(agentId, 'active')
      const elsewhere = await seedDelegation(agentId, 'active', { recipient: OTHER_RECIPIENT })
      const fresh = await seedDelegation(agentId, 'pending', { recipient: RECIPIENT })

      const res = await activate(agentId, userId, fresh)

      expect(res.statusCode).toBe(200)
      expect(await statusOf(fresh)).toBe('active')
      // Not `replaced`: nothing marks the edited budget retired until its
      // Stop lands, so the dashboard keeps showing it as a live budget.
      expect(await statusOf(edited)).toBe('active')
      expect(await statusOf(elsewhere)).toBe('active')
    })
  })
})
