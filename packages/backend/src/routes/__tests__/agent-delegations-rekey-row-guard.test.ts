/**
 * #3439 — the ordinary activate route must refuse a re-key's own pending
 * replacement row, however its `delegate` field got a value that matches the
 * agent's CURRENT key.
 *
 * The spec-review correction on #3439 traced why the "obvious" path is
 * already closed: a successor re-key cannot complete without first revoking
 * every non-revoked row, which turns an abandoned predecessor's rows
 * `revoked` before the key ever matches. So this test does NOT drive the
 * scenario through a real successor re-key's revoke — a test built that way
 * would pass on unfixed `dev` too, because `status <> 'pending'` already
 * refuses it, for the WRONG reason. Instead it seeds the state the race in
 * #3439's body actually produces (a stalled `issue` request landing rows
 * for an abandoned re-key while a successor is in flight): a `pending` row
 * with `rekey_id` set to an abandoned re-key, `delegate` equal to the
 * account the agent's current key derives, and asserts the route's own
 * structured refusal — proven on real Postgres, not a mock, because it is a
 * claim about what the row read and the SQL do.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import {
  insertRekeyDelegation,
  markMetered,
  markRevoked,
  openRekey,
  abandonRekey,
  type CarrySnapshotEntry,
} from '../../infra/repositories/agent-rekeys.js'
import { revokeDelegationsByHashes } from '../../infra/repositories/delegation-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'
// The abandoned re-key's parked address — a later re-key reuses it, so this
// becomes the agent's CURRENT delegate key (#3439's traced "reuse" step).
const NEW_DELEGATE = '0x00000000000000000000000000000000000000d2'
// What `computeHybridAccountAddress` derives from NEW_DELEGATE. Mocked below
// — a fixed value, not a real derivation, because this test's subject is the
// route's `rekey_id` guard, not account derivation.
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)

// #3439: the route's rekey_id guard fires BEFORE any network read, so the
// FIXED handler never reaches these. They exist so the UNFIXED handler can
// run all the way to a genuine 200 — the strongest available proof that the
// row really is activatable today, not merely that some other guard happens
// to intervene first.
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

describeDb("the ordinary activate route refuses a re-key's own pending row (#3439)", () => {
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
      [`rekey-guard-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    // owner_address populated so `loadHybridOwnerConfig` resolves on the
    // (mocked-network, real-DB) unfixed path.
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, owner_address)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', $3) RETURNING id`,
      [userId, TREASURY, '0x' + 'ff'.repeat(20)],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Rekey guard agent', $3, $4, 'sk_agnt_grd', 'active') RETURNING id`,
      [userId, account.rows[0].id, OLD_DELEGATE, `hash-guard-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  /**
   * Seeds exactly the state #3439's traced race leaves behind: an abandoned
   * re-key R1's `pending` replacement row, `delegate` matching what the
   * agent's CURRENT key derives, `rekey_id` still pointing at R1.
   */
  async function seedAbandonedRekeyPendingRow(
    agentId: string,
    userId: string,
  ): Promise<{ hash: string }> {
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
    const snapshot: CarrySnapshotEntry[] = [
      {
        delegation_hash: `0x${String(++seq).padStart(64, '1')}`,
        token_address: USDC,
        recipient_address: RECIPIENT,
        budget_atomic: '1000000',
        period_seconds: 86_400,
        start_date: 0,
        expires_at: 1_900_000_000,
        remaining_atomic: '400000',
        from_chain: true,
      },
    ]
    await markMetered(rekey.id, agentId, snapshot)
    const hash = `0x${String(++seq).padStart(64, '2')}`
    const inserted = await insertRekeyDelegation({
      agentId,
      userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: RECIPIENT,
      delegationHash: hash,
      delegationJson: JSON.stringify({
        delegate: DELEGATE_ACCOUNT,
        delegator: TREASURY,
        authority: `0x${'0'.repeat(64)}`,
        caveats: [],
        salt: '1',
      }),
      version: 1,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 1_900_000_000,
      rekeyId: rekey.id,
      carryRole: 'steady',
      merchantId: null,
    })
    expect(inserted).toBe(true)
    // The owner abandons R1 (stage: metered → abandoned). This is what
    // leaves the row `pending`, un-revoked, forever — nothing else in the
    // re-key lifecycle ever touches an abandoned re-key's own rows again.
    const abandoned = await abandonRekey(rekey.id, agentId, 'stalled, owner abandoned')
    expect(abandoned?.stage).toBe('abandoned')
    // A later re-key reuses NEW_DELEGATE and completes — modelled directly
    // as the agent's current key, rather than by running a second full
    // re-key, because the mechanism under test is the ordinary activate
    // route's OWN guard, not re-key completion (covered elsewhere).
    await db.query(`UPDATE agents SET delegate_address = $1 WHERE id = $2`, [NEW_DELEGATE, agentId])
    return { hash }
  }

  it("refuses to activate an abandoned re-key's pending row, with a structured error, before the slot sweep", async () => {
    const { userId, agentId } = await seedAgent()
    const { hash } = await seedAbandonedRekeyPendingRow(agentId, userId)

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/delegations/${hash}/activate`,
      headers: userHeaders(userId),
      payload: { signature: '0x' + 'ab'.repeat(65) },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error_code).toBe('REKEY_DELEGATION_NOT_ACTIVATABLE')
    expect(String(body.error)).toMatch(/re-key/i)

    // Nothing moved: the row is exactly as seeded, and the slot sweep never
    // ran — proof the refusal really is BEFORE the sweep, not a rollback
    // after it (which would still read this way at rest, but the ROUTE
    // ordering is what the review asked to be pinned; see the SQL backstop
    // mutation test for the sweep-order half).
    const row = await db.query<{ status: string; rekey_id: string | null }>(
      `SELECT status, rekey_id FROM agent_delegations WHERE delegation_hash = $1`,
      [hash],
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].rekey_id).not.toBeNull()
  })

  it('the same abandoned row is REJECTED after a revoke-driven successor completes it (status barrier, not the rekey_id guard)', async () => {
    // Characterization: this is the ALREADY-CLOSED path the spec review
    // named — included so the two barriers are not confused with each
    // other. A successor re-key that goes through ITS OWN revoke marks
    // every non-revoked row (including R1's abandoned pending row)
    // `revoked` before the key can ever match, so this fails on `status`
    // alone, with or without the #3439 fix.
    const { userId, agentId } = await seedAgent()
    const rekey1 = await openRekey({
      agentId,
      userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      residualAtomic: '0',
      residualTokenAddress: null,
      residualDisposition: 'none',
    })
    await markRevoked(rekey1.id, agentId, '0xrevoketx1')
    await markMetered(rekey1.id, agentId, [])
    const hash = `0x${String(++seq).padStart(64, '3')}`
    const inserted = await insertRekeyDelegation({
      agentId,
      userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: RECIPIENT,
      delegationHash: hash,
      delegationJson: JSON.stringify({ delegate: DELEGATE_ACCOUNT }),
      version: 1,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 1_900_000_000,
      rekeyId: rekey1.id,
      carryRole: 'steady',
      merchantId: null,
    })
    expect(inserted).toBe(true)
    await abandonRekey(rekey1.id, agentId, 'abandoned before completion')

    // A fresh re-key R2 finds nothing left to revoke (R1's row is pending,
    // not active) — but its OWN revoke step still runs
    // `revokeDelegationsByHashes` over every non-revoked hash for the agent,
    // which includes R1's abandoned pending row.
    await revokeDelegationsByHashes(agentId, [hash])

    const row = await db.query<{ status: string }>(
      `SELECT status FROM agent_delegations WHERE delegation_hash = $1`,
      [hash],
    )
    expect(row.rows[0].status).toBe('revoked')

    await db.query(`UPDATE agents SET delegate_address = $1 WHERE id = $2`, [NEW_DELEGATE, agentId])
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/delegations/${hash}/activate`,
      headers: userHeaders(userId),
      payload: { signature: '0x' + 'ab'.repeat(65) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('Delegation is revoked, not pending')
  })
})
