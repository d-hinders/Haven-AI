/**
 * #3450 — a failure part-way through the issue route's piece loop must leave
 * NO partial rows: the whole transaction rolls back and the re-key's stage
 * stays `metered`. Before the fix, `insertRekeyDelegation` ran in its OWN
 * transaction per piece, so an earlier piece's insert had already committed
 * by the time a later piece's `carry_refused`, an insert refusal, or a raw
 * DB error ended the request — a retry then built fresh versions/hashes for
 * the already-committed rows, and completion answered `missing_signature`
 * forever (the "leftover partial rows" open question from the #3386 review).
 *
 * Three covered cases, per the corrected acceptance criterion:
 * 1. A thrown DB error from a later piece's insert.
 * 2. A sentinel-mapped `carry_refused` on a LATER snapshot entry, after an
 *    EARLIER entry already inserted successfully.
 * 3. A 502 build failure (`buildBudgetDelegation` throwing) on a LATER
 *    piece, after an EARLIER piece already inserted successfully.
 *
 * The carry_refused and 502 cases assert the WHOLE response body against
 * `origin/dev`'s exact reply shape, not just the status code (round-1 review
 * finding F1: the sentinel mapping for carry_refused sent the sentinel's own
 * class-tag message — the literal string `"carry_refused"` — as `detail`,
 * instead of the owner-facing explanation `planCarry` actually threw; a
 * partial assertion on `error`/`code` alone passed on both the broken and
 * the fixed mapping).
 *
 * Real Postgres throughout (`describeDb`) — only `computeHybridAccountAddress`
 * is mocked.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import type { AgentRekeyRow, CarrySnapshotEntry } from '../../infra/repositories/agent-rekeys.js'

const { mockComputeAddress } = vi.hoisted(() => ({
  mockComputeAddress: vi.fn(),
}))

/** Set to the 1-indexed insert call that should throw; 0 means never. */
let throwOnInsertCall = 0
let insertCallCount = 0
/** Set to the 1-indexed `buildBudgetDelegation` call that should throw; 0 means never. */
let buildFailOnCall = 0
let buildCallCount = 0

vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: (...a: unknown[]) => mockComputeAddress(...a),
  }
})

vi.mock('../../rails/delegation-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-policy.js')>()
  return {
    ...actual,
    buildBudgetDelegation: (
      ...args: Parameters<typeof actual.buildBudgetDelegation>
    ): ReturnType<typeof actual.buildBudgetDelegation> => {
      buildCallCount += 1
      if (buildFailOnCall !== 0 && buildCallCount === buildFailOnCall) {
        throw new Error('simulated policy build failure')
      }
      return actual.buildBudgetDelegation(...args)
    },
  }
})

vi.mock('../../infra/repositories/agent-rekeys.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../infra/repositories/agent-rekeys.js')>()
  return {
    ...actual,
    insertRekeyDelegation: async (
      ...args: Parameters<typeof actual.insertRekeyDelegation>
    ): ReturnType<typeof actual.insertRekeyDelegation> => {
      insertCallCount += 1
      const myIndex = insertCallCount
      if (throwOnInsertCall !== 0 && myIndex === throwOnInsertCall) {
        throw new Error('simulated transient DB failure')
      }
      return actual.insertRekeyDelegation(...args)
    },
  }
})

const agentRekeyRoutes = (await import('../agent-rekey.js')).default
const { findRekey } = await import('../../infra/repositories/agent-rekeys.js')

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'
const NEW_DELEGATE = '0x00000000000000000000000000000000000000d2'
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)

let seq = 0

describeDb('a failure part-way through the issue loop rolls back every piece (#3450)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentRekeyRoutes, { prefix: '/agents' })
  })
  beforeEach(async () => {
    await resetDb()
    insertCallCount = 0
    throwOnInsertCall = 0
    buildCallCount = 0
    buildFailOnCall = 0
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
      [`rk-partial-${n}-${Date.now()}@test.example`],
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

  /** A entry that inserts cleanly — `carry` only, to keep call counts small. */
  function goodEntry(): CarrySnapshotEntry {
    const nowSec = Math.floor(Date.now() / 1000)
    const DAY = 86_400
    return {
      delegation_hash: `0x${String(++seq).padStart(64, '0')}`,
      token_address: USDC,
      recipient_address: null,
      budget_atomic: '100000000',
      period_seconds: DAY,
      start_date: nowSec - 3_600,
      // Expires at the SAME instant the current period boundary would fall,
      // so `plannedSteady` is null (`old.expiresAt > boundary` is false) and
      // this entry produces exactly ONE piece — one call to
      // `insertRekeyDelegation`, which keeps `throwOnInsertCall`'s index
      // predictable across both tests below.
      expires_at: nowSec - 3_600 + DAY,
      remaining_atomic: '40000000',
      from_chain: true,
    }
  }

  /** An entry `planCarry` refuses outright — `remainder_exceeds_budget`. */
  function refusedEntry(): CarrySnapshotEntry {
    const nowSec = Math.floor(Date.now() / 1000)
    const DAY = 86_400
    return {
      delegation_hash: `0x${String(++seq).padStart(64, '0')}`,
      token_address: USDC,
      recipient_address: null,
      budget_atomic: '100000000',
      period_seconds: DAY,
      start_date: nowSec - 3_600,
      expires_at: nowSec + 365 * DAY,
      // Exceeds budget_atomic — planCarry throws CarryRefusedError
      // ('remainder_exceeds_budget') before this entry ever reaches
      // insertRekeyDelegation.
      remaining_atomic: '999999999999',
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

  async function assertNoPartialRows(rekeyId: string, agentId: string): Promise<void> {
    const rows = await db.query(`SELECT 1 FROM agent_delegations WHERE rekey_id = $1`, [rekeyId])
    expect(rows.rowCount).toBe(0)
    const rekey = (await findRekey(rekeyId, agentId)) as AgentRekeyRow
    expect(rekey.stage).toBe('metered')
  }

  it('a thrown DB error on a later piece rolls back the earlier piece already inserted', async () => {
    const { userId, agentId } = await seedAgent()
    // goodEntry (1 insert call) then goodEntry again (a 2nd, independent
    // entry — also 1 insert call): the SECOND call throws.
    const { rekeyId } = await seedMeteredRekey(agentId, userId, [goodEntry(), goodEntry()])
    throwOnInsertCall = 2

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/rekey/${rekeyId}/issue`,
      headers: userHeaders(userId),
      payload: {},
    })

    expect(res.statusCode).toBe(500)
    await assertNoPartialRows(rekeyId, agentId)
  })

  it('carry_refused on a LATER entry rolls back an EARLIER entry that already inserted', async () => {
    const { userId, agentId } = await seedAgent()
    const refused = refusedEntry()
    const { rekeyId } = await seedMeteredRekey(agentId, userId, [goodEntry(), refused])

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/rekey/${rekeyId}/issue`,
      headers: userHeaders(userId),
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    // F1 review finding: the route used to map `detail: err.message` against
    // the SENTINEL (whose `message` is the literal string "carry_refused",
    // from `super('carry_refused')`), not the sentinel's own `detail`
    // property — so the owner-facing explanation `planCarry` actually threw
    // was replaced with the sentinel's class tag. Asserting the WHOLE body
    // against the exact string `origin/dev` returns for this refusal is what
    // catches that: a field-by-field check that only reads `code` would have
    // passed on both the broken and the fixed mapping.
    expect(res.json()).toEqual({
      error: 'carry_refused',
      code: 'remainder_exceeds_budget',
      delegation_hash: refused.delegation_hash,
      detail:
        'remaining budget exceeds the granted budget — refusing to carry an impossible reading',
    })
    await assertNoPartialRows(rekeyId, agentId)
  })

  it('a 502 build failure on a LATER piece rolls back an EARLIER piece that already inserted', async () => {
    const { userId, agentId } = await seedAgent()
    const { rekeyId } = await seedMeteredRekey(agentId, userId, [goodEntry(), goodEntry()])
    buildFailOnCall = 2

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/rekey/${rekeyId}/issue`,
      headers: userHeaders(userId),
      payload: {},
    })

    expect(res.statusCode).toBe(502)
    // Byte-identical to `origin/dev`'s `buildBudgetDelegation` catch —
    // `{ error: 'Could not build the replacement delegation', details:
    // safeDetails(err) }` — proven the same way as the carry_refused case
    // above: the whole body, not just the status code.
    expect(res.json()).toEqual({
      error: 'Could not build the replacement delegation',
      details: 'simulated policy build failure',
    })
    await assertNoPartialRows(rekeyId, agentId)
  })
})
