/**
 * #4351 — the build route's 365-day `expires_at` cap must stay OFF the re-key
 * path. Rotation carries the OLD row's `expires_at` (the meter snapshot, then
 * `planCarry`) and never passes through `POST /delegations/build`, so a
 * legacy row minted before the cap — or by any other means — must still be
 * rotatable: rotation is the response to a suspected key exposure, and
 * refusing it would leave the exposed key's budgets unrevokable-by-rotation.
 *
 * This is the pin the issue asks for against a later "centralise the
 * validation" refactor that would move the cap into a shared policy builder
 * `planCarry` also feeds: an issue of a row whose carried `expires_at` is
 * PAST the cap still issues, and the replacement rows carry that expiry.
 *
 * Real Postgres throughout (`describeDb`) — only `computeHybridAccountAddress`
 * is mocked, same seams as `agent-rekey-issue-partial-failure.test.ts`.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import type { CarrySnapshotEntry } from '../../infra/repositories/agent-rekeys.js'

const { mockComputeAddress } = vi.hoisted(() => ({ mockComputeAddress: vi.fn() }))

vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: (...a: unknown[]) => mockComputeAddress(...a),
  }
})

const agentRekeyRoutes = (await import('../agent-rekey.js')).default

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'
const NEW_DELEGATE = '0x00000000000000000000000000000000000000d2'
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const DAY = 86_400

let seq = 0

describeDb('a re-key of a row past the 365-day build cap still issues (#4351)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentRekeyRoutes, { prefix: '/agents' })
  })
  beforeEach(async () => {
    await resetDb()
    mockComputeAddress.mockReset()
    mockComputeAddress.mockResolvedValue(DELEGATE_ACCOUNT)
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function userHeaders(userId: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'u@test.dev' })}` }
  }

  async function seedAgent(): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`rk-pastcap-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const safe = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
      [userId, `0x${String(n).padStart(40, 'a')}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Rekey agent', $3, $4, 'sk_agent_old', 'active') RETURNING id`,
      [userId, safe.rows[0].id, OLD_DELEGATE, `hash-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  /** A live grant whose expiry is 35 days PAST the build route's 365-day cap. */
  function pastCapEntry(): CarrySnapshotEntry {
    const nowSec = Math.floor(Date.now() / 1000)
    return {
      delegation_hash: `0x${String(++seq).padStart(64, '0')}`,
      token_address: USDC,
      recipient_address: null,
      budget_atomic: '100000000',
      period_seconds: DAY,
      start_date: nowSec - 3_600,
      expires_at: nowSec + 400 * DAY,
      remaining_atomic: '40000000',
      from_chain: true,
    }
  }

  async function seedMeteredRekey(
    agentId: string,
    userId: string,
    snapshot: CarrySnapshotEntry[],
  ): Promise<{ rekeyId: string }> {
    const { openRekey, markRevoked, markMetered } = await import('../../infra/repositories/agent-rekeys.js')
    const rekey = await openRekey({
      agentId,
      userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      residualAtomic: '0',
      residualTokenAddress: null,
      residualDisposition: 'none',
    })
    await markRevoked(rekey.id, agentId, '0xrevoketx')
    await markMetered(rekey.id, agentId, snapshot)
    return { rekeyId: rekey.id }
  }

  it('issues the rotation and carries the past-cap expiry into the replacement rows', async () => {
    const { userId, agentId } = await seedAgent()
    const entry = pastCapEntry()
    const { rekeyId } = await seedMeteredRekey(agentId, userId, [entry])

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/rekey/${rekeyId}/issue`,
      headers: userHeaders(userId),
      payload: {},
    })

    // The build route would 400 this expiry; the rotation path must not.
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.stage).toBe('issued')
    expect(body.delegations.length).toBeGreaterThan(0)
    // The carried expiry — the old row's own end date — survives into the
    // built rows, past-cap and all. The steady piece carries it verbatim.
    const nowSec = Math.floor(Date.now() / 1000)
    const maxExpiry = Math.max(...body.delegations.map((d: { expires_at: number }) => d.expires_at))
    expect(maxExpiry).toBe(entry.expires_at)
    expect(maxExpiry).toBeGreaterThan(nowSec + 365 * DAY)
  })
})
