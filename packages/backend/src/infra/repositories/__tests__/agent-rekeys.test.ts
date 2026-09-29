/**
 * Real-DB tests for the re-key ledger (#1698, epic #1694).
 *
 * Everything here is an assertion about what Postgres does — CHECK
 * constraints, a partial unique index, conditional stage advances, and which
 * rows an UPDATE touches — so it belongs on the real harness rather than on
 * mocks (epic #1219, `docs/contributing/testing-strategy.md`).
 *
 * The point of putting the ordering in the database as well as in
 * `modules/agents/rekey-stages.ts` is that the two are independent statements
 * of one invariant. A route bug can route around the module; it cannot route
 * around the constraint. These tests prove the constraint half.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db, { getPool } from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  activateRekeyDelegation,
  abandonRekey,
  adoptAbandonedCarry,
  completeRekey,
  findDelegationTerms,
  findInFlightRekey,
  findRekey,
  insertRekeyDelegation,
  invalidateOldPayerIntents,
  markCompleted,
  markIssued,
  markMetered,
  markRevoked,
  openRekey,
  rotateAgentCredentials,
  type CarrySnapshotEntry,
} from '../agent-rekeys.js'
import { findReusablePendingDelegation } from '../delegation-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'
const NEW_DELEGATE = '0x00000000000000000000000000000000000000d2'

let seq = 0

interface Seeded {
  userId: string
  agentId: string
  apiKeyHash: string
}

async function seedAgent(delegate = OLD_DELEGATE): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rk${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`],
  )
  const apiKeyHash = `hash-old-${n}-${Date.now()}`
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, 'Rekey agent', $3, $4, 'sk_agent_old', 'active') RETURNING id`,
    [userId, safe.rows[0].id, delegate, apiKeyHash],
  )
  return { userId, agentId: agent.rows[0].id, apiKeyHash }
}

async function open(seeded: Seeded, over: Partial<Parameters<typeof openRekey>[0]> = {}) {
  return openRekey({
    agentId: seeded.agentId,
    userId: seeded.userId,
    oldDelegateAddress: OLD_DELEGATE,
    newDelegateAddress: NEW_DELEGATE,
    residualAtomic: '0',
    residualTokenAddress: null,
    residualDisposition: 'none',
    ...over,
  })
}

function snapshot(over: Partial<CarrySnapshotEntry> = {}): CarrySnapshotEntry[] {
  return [
    {
      delegation_hash: `0x${String(++seq).padStart(64, '0')}`,
      token_address: USDC,
      recipient_address: null,
      budget_atomic: '1000000',
      period_seconds: 86_400,
      start_date: 1_760_000_000,
      expires_at: 1_760_000_000 + 90 * 86_400,
      remaining_atomic: '400000',
      from_chain: true,
      ...over,
    },
  ]
}

describeDb('agent_rekeys ledger (#1698)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('opens at preflight and is findable only within its own agent', async () => {
    const seeded = await seedAgent()
    const other = await seedAgent('0x00000000000000000000000000000000000000d9')
    const rekey = await open(seeded)

    expect(rekey.stage).toBe('preflight')
    expect(rekey.old_delegate_address).toBe(OLD_DELEGATE)
    expect(await findRekey(rekey.id, seeded.agentId)).not.toBeNull()
    // Scoped: a re-key id from another agent resolves to nothing rather than
    // to someone else's credential rotation.
    expect(await findRekey(rekey.id, other.agentId)).toBeNull()
  })

  it('allows at most ONE re-key in flight per agent', async () => {
    const seeded = await seedAgent()
    await open(seeded)
    // Two concurrent re-keys would race to revoke and issue against each
    // other's snapshot; the losing one could resurrect retired authority.
    await expect(open(seeded)).rejects.toThrow(/duplicate key|unique/i)
  })

  it('frees the in-flight slot once completed or abandoned', async () => {
    const seeded = await seedAgent()
    const first = await open(seeded)
    await abandonRekey(first.id, seeded.agentId, 'changed my mind')
    expect(await findInFlightRekey(seeded.agentId)).toBeNull()
    // History is kept, not deleted.
    await expect(open(seeded)).resolves.toBeTruthy()
    const rows = await db.query(`SELECT id FROM agent_rekeys WHERE agent_id = $1`, [seeded.agentId])
    expect(rows.rows).toHaveLength(2)
  })

  it('refuses a re-key to the SAME delegate address', async () => {
    const seeded = await seedAgent()
    await expect(open(seeded, { newDelegateAddress: OLD_DELEGATE })).rejects.toThrow(
      /agent_rekeys_delegate_changes_check/,
    )
  })

  // ── The ordering, in the database ──────────────────────────────────────

  it('MUTATION TARGET — refuses a carry snapshot written before the revoke', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)

    // The route's stage guard is one statement of the rule; this is the
    // other. Writing the snapshot straight onto a preflight row — the exact
    // shape of "read the meter before the revoke" — is refused by Postgres,
    // so no code path can reach it.
    await expect(
      db.query(
        `UPDATE agent_rekeys SET carry_snapshot = $1::jsonb, metered_at = NOW() WHERE id = $2`,
        [JSON.stringify(snapshot()), rekey.id],
      ),
    ).rejects.toThrow(/agent_rekeys_meter_after_revoke_check/)
  })

  it('refuses a metered_at that precedes revoked_at', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')

    await expect(
      db.query(
        `UPDATE agent_rekeys
            SET carry_snapshot = $1::jsonb, metered_at = revoked_at - interval '1 second'
          WHERE id = $2`,
        [JSON.stringify(snapshot()), rekey.id],
      ),
    ).rejects.toThrow(/agent_rekeys_meter_after_revoke_check/)
  })

  it('refuses a metered/issued/completed stage with no snapshot', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')

    await expect(
      db.query(`UPDATE agent_rekeys SET stage = 'issued' WHERE id = $1`, [rekey.id]),
    ).rejects.toThrow(/agent_rekeys_metered_stage_check/)
  })

  it('advances only from the expected stage — a stale caller loses', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)

    // markMetered before the revoke: refused, and reported as refused rather
    // than silently doing nothing under a success-shaped return.
    expect(await markMetered(rekey.id, seeded.agentId, snapshot())).toBeNull()
    // markIssued before metering: refused.
    expect(await markIssued(rekey.id, seeded.agentId)).toBeNull()
    // markCompleted before issuing: refused.
    expect(await markCompleted(rekey.id, seeded.agentId)).toBeNull()

    const still = await findRekey(rekey.id, seeded.agentId)
    expect(still?.stage).toBe('preflight')
  })

  it('walks the full path exactly once, and a replayed step flips nothing', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)

    expect((await markRevoked(rekey.id, seeded.agentId, '0xtx'))?.stage).toBe('revoked')
    // A retry of the same step is a no-op rather than a second advance —
    // this is what makes the client safe to retry after a dropped response.
    expect(await markRevoked(rekey.id, seeded.agentId, '0xtx2')).toBeNull()

    const metered = await markMetered(rekey.id, seeded.agentId, snapshot())
    expect(metered?.stage).toBe('metered')
    expect(metered?.carry_snapshot?.[0].remaining_atomic).toBe('400000')
    expect(await markMetered(rekey.id, seeded.agentId, snapshot({ remaining_atomic: '999999' }))).toBeNull()

    expect((await markIssued(rekey.id, seeded.agentId))?.stage).toBe('issued')
    expect((await markCompleted(rekey.id, seeded.agentId))?.stage).toBe('completed')
    // Terminal: no further advance, and no abandon after the fact.
    expect(await abandonRekey(rekey.id, seeded.agentId, 'too late')).toBeNull()
  })

  it('keeps the frozen measurement per delegation, not per agent', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')

    const two = [
      ...snapshot({ token_address: USDC, remaining_atomic: '400000' }),
      ...snapshot({ token_address: USDC, recipient_address: '0xmerchant', remaining_atomic: '25' }),
    ]
    const metered = await markMetered(rekey.id, seeded.agentId, two)
    // An agent may hold several budgets, each with its own remainder and its
    // own boundary. A column set would model exactly one.
    expect(metered?.carry_snapshot).toHaveLength(2)
    expect(metered?.carry_snapshot?.map((e) => e.remaining_atomic)).toEqual(['400000', '25'])
  })

  // ── Credential rotation ────────────────────────────────────────────────

  it('rotates BOTH halves of the credential set in one statement', async () => {
    const seeded = await seedAgent()

    const ok = await rotateAgentCredentials({
      agentId: seeded.agentId,
      userId: seeded.userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
    })
    expect(ok).toBe(true)

    const row = await db.query<{ delegate_address: string; api_key_hash: string }>(
      `SELECT delegate_address, api_key_hash FROM agents WHERE id = $1`,
      [seeded.agentId],
    )
    // #1694: one operation retires the whole old credential set. The
    // characterization test pins that rotate-key alone does NOT do this.
    expect(row.rows[0].delegate_address).toBe(NEW_DELEGATE)
    expect(row.rows[0].api_key_hash).toBe('hash-new')
    expect(row.rows[0].api_key_hash).not.toBe(seeded.apiKeyHash)
  })

  it('the old API key stops authenticating the moment the rotation lands', async () => {
    const seeded = await seedAgent()
    await rotateAgentCredentials({
      agentId: seeded.agentId,
      userId: seeded.userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
    })
    // agentAuth resolves an agent by api_key_hash; the old hash no longer
    // names any row, so a host still holding the old key 401s.
    const byOldHash = await db.query(`SELECT id FROM agents WHERE api_key_hash = $1`, [
      seeded.apiKeyHash,
    ])
    expect(byOldHash.rows).toHaveLength(0)
  })

  it('refuses to rotate when the delegate moved underneath it', async () => {
    const seeded = await seedAgent()
    await db.query(`UPDATE agents SET delegate_address = $1 WHERE id = $2`, [
      '0x00000000000000000000000000000000000000ee',
      seeded.agentId,
    ])
    const ok = await rotateAgentCredentials({
      agentId: seeded.agentId,
      userId: seeded.userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
    })
    expect(ok).toBe(false)
  })

  it('rotation is scoped to the owning user', async () => {
    const seeded = await seedAgent()
    const stranger = await seedAgent('0x00000000000000000000000000000000000000c7')
    const ok = await rotateAgentCredentials({
      agentId: seeded.agentId,
      userId: stranger.userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
    })
    expect(ok).toBe(false)
  })

  // ── In-flight intent invalidation ──────────────────────────────────────

  async function seedIntent(
    seeded: Seeded,
    delegateAddress: string,
    status = 'pending_signature',
  ): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO payment_intents
         (agent_id, user_id, account_address, token_symbol, token_address, to_address,
          amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
          status, expires_at)
       VALUES ($1, $2, '0xsafe', 'USDC', $3, '0xmerchant', '1000', '0.001', $4, 0, $5, $6,
               NOW() + interval '10 minutes')
       RETURNING id`,
      [
        seeded.agentId,
        seeded.userId,
        USDC,
        delegateAddress,
        `0x${String(++seq).padStart(64, 'f')}`,
        status,
      ],
    )
    return result.rows[0].id
  }

  it('invalidates unexecuted intents stamped with the old payer, and only those', async () => {
    const seeded = await seedAgent()
    const stale = await seedIntent(seeded, OLD_DELEGATE)
    const submitted = await seedIntent(seeded, OLD_DELEGATE, 'submitted')
    const confirmed = await seedIntent(seeded, OLD_DELEGATE, 'confirmed')
    const otherPayer = await seedIntent(seeded, '0x00000000000000000000000000000000000000b8')

    const invalidated = await invalidateOldPayerIntents(seeded.agentId, OLD_DELEGATE)
    expect(invalidated).toEqual([stale])

    const rows = await db.query<{ id: string; status: string; error_message: string | null }>(
      `SELECT id, status, error_message FROM payment_intents WHERE agent_id = $1`,
      [seeded.agentId],
    )
    const byId = new Map(rows.rows.map((r) => [r.id, r]))
    expect(byId.get(stale)?.status).toBe('expired')
    expect(byId.get(stale)?.error_message).toMatch(/re-key/i)
    // MUTATION TARGET — dropping `status = 'pending_signature'` from the
    // predicate rewrites settled payments. These three assertions are what
    // catches it.
    expect(byId.get(submitted)?.status).toBe('submitted')
    expect(byId.get(confirmed)?.status).toBe('confirmed')
    // MUTATION TARGET — dropping the delegate_address predicate cancels a
    // working payment on a multi-budget agent for no reason.
    expect(byId.get(otherPayer)?.status).toBe('pending_signature')
  })

  it('matches the payer stamp case-insensitively', async () => {
    const seeded = await seedAgent()
    const mixed = await seedIntent(seeded, OLD_DELEGATE.toUpperCase().replace('0X', '0x'))
    const invalidated = await invalidateOldPayerIntents(seeded.agentId, OLD_DELEGATE)
    expect(invalidated).toEqual([mixed])
  })

  it('does not reach another agent\'s intents', async () => {
    const seeded = await seedAgent()
    const other = await seedAgent()
    // Same payer address, different agent — scoping is by agent AND payer.
    const theirs = await seedIntent(other, OLD_DELEGATE)
    await invalidateOldPayerIntents(seeded.agentId, OLD_DELEGATE)
    const row = await db.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [theirs],
    )
    expect(row.rows[0].status).toBe('pending_signature')
  })

  // ── Completion, as one transaction ─────────────────────────────────────

  /** An ordinary owner grant, with no re-key parent. */
  async function seedPlainDelegation(agentId: string, status = 'active'): Promise<string> {
    const hash = `0x${String(++seq).padStart(64, '0')}`
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date, expires_at)
       VALUES ($1, 84532, $2, NULL, $3, '{"signed":"capability"}', 1, $4, '1000000', 86400, 0, 9999999999)`,
      [agentId, USDC, hash, status],
    )
    return hash
  }

  async function seedRekeyDelegation(
    seeded: Seeded,
    rekeyId: string,
    carryRole: 'carry' | 'steady' | 'reanchor',
    status = 'pending',
  ): Promise<{ id: string; hash: string }> {
    const hash = `0x${String(++seq).padStart(64, '0')}`
    const row = await db.query<{ id: string }>(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date,
          expires_at, rekey_id, carry_role)
       VALUES ($1, 84532, $2, NULL, $3, '{"d":1}', 1, $4, '400000', 86400, 0, 9999999999, $5, $6)
       RETURNING id`,
      [seeded.agentId, USDC, hash, status, rekeyId, carryRole],
    )
    return { id: row.rows[0].id, hash }
  }

  async function reachIssued(seeded: Seeded) {
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    await markIssued(rekey.id, seeded.agentId)
    return rekey
  }

  it('activates a re-key delegation only while it is still pending', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    const replacement = await seedRekeyDelegation(seeded, rekey.id, 'carry')

    expect(await activateRekeyDelegation(replacement.id, '{"signed":true}')).toBe(true)
    expect(await activateRekeyDelegation(replacement.id, '{"signed":false}')).toBe(false)

    const row = await db.query<{ status: string; delegation_json: string }>(
      `SELECT status, delegation_json FROM agent_delegations WHERE id = $1`,
      [replacement.id],
    )
    expect(row.rows[0].status).toBe('active')
    expect(JSON.parse(row.rows[0].delegation_json).signed).toBe(true)
  })

  it('MUTATION TARGET — a carry and its steady partner do NOT retire each other', async () => {
    // They share a (token, recipient) slot by construction. Dropping the
    // `rekey_id <> $2` exclusion from REPLACE_SUPERSEDED_SIBLINGS_SQL would
    // make the pair kill itself, and this is the test that catches it.
    const seeded = await seedAgent()
    const rekey = await reachIssued(seeded)
    const carry = await seedRekeyDelegation(seeded, rekey.id, 'carry')
    const steady = await seedRekeyDelegation(seeded, rekey.id, 'steady')

    const result = await completeRekey({
      agentId: seeded.agentId,
      userId: seeded.userId,
      rekeyId: rekey.id,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
      signedDelegations: [
        { id: carry.id, delegationJson: '{"d":1,"signature":"0xaa"}' },
        { id: steady.id, delegationJson: '{"d":1,"signature":"0xbb"}' },
      ],
    })

    expect(result.superseded).toEqual([])
    const rows = await db.query<{ delegation_hash: string; status: string; carry_role: string }>(
      `SELECT delegation_hash, status, carry_role FROM agent_delegations WHERE rekey_id = $1`,
      [rekey.id],
    )
    // BOTH live. This is the shape the whole carry design depends on.
    expect(rows.rows.map((r) => r.status).sort()).toEqual(['active', 'active'])
  })

  it('retires a grant made between the revoke and the completion', async () => {
    const seeded = await seedAgent()
    const rekey = await reachIssued(seeded)
    // An ordinary owner grant in the same slot, with no re-key parent.
    const strayHash = await seedPlainDelegation(seeded.agentId, 'active')
    const carry = await seedRekeyDelegation(seeded, rekey.id, 'carry')

    const result = await completeRekey({
      agentId: seeded.agentId,
      userId: seeded.userId,
      rekeyId: rekey.id,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
      signedDelegations: [{ id: carry.id, delegationJson: '{"d":1,"signature":"0xaa"}' }],
    })

    // Left active, it would sit alongside the carried grant in one slot —
    // two live authorities for the same budget.
    expect(result.superseded).toEqual([strayHash])
    const stray = await db.query<{ status: string }>(
      `SELECT status FROM agent_delegations WHERE delegation_hash = $1`,
      [strayHash],
    )
    expect(stray.rows[0].status).toBe('replaced')
  })

  it('rolls the WHOLE completion back when any part of it fails', async () => {
    const seeded = await seedAgent()
    const rekey = await reachIssued(seeded)
    const carry = await seedRekeyDelegation(seeded, rekey.id, 'carry')
    const stale = await seedIntent(seeded, OLD_DELEGATE)

    // Move the delegate underneath the re-key: `rotateAgentCredentials` is
    // predicated on the OLD address, so it flips nothing and completeRekey
    // throws mid-transaction.
    await db.query(`UPDATE agents SET delegate_address = $1 WHERE id = $2`, [
      '0x00000000000000000000000000000000000000ff',
      seeded.agentId,
    ])

    await expect(
      completeRekey({
        agentId: seeded.agentId,
        userId: seeded.userId,
        rekeyId: rekey.id,
        oldDelegateAddress: OLD_DELEGATE,
        newDelegateAddress: NEW_DELEGATE,
        apiKeyHash: 'hash-new',
        apiKeyPrefix: 'sk_agent_new',
        signedDelegations: [{ id: carry.id, delegationJson: '{"d":1,"signature":"0xaa"}' }],
      }),
    ).rejects.toThrow(/changed underneath/)

    // Nothing partial survives — the failure modes this guards against are a
    // rotated delegate with pending grants, and a live old API key against a
    // new delegate.
    const del = await db.query<{ status: string }>(
      `SELECT status FROM agent_delegations WHERE id = $1`,
      [carry.id],
    )
    expect(del.rows[0].status).toBe('pending')

    const agent = await db.query<{ api_key_hash: string }>(
      `SELECT api_key_hash FROM agents WHERE id = $1`,
      [seeded.agentId],
    )
    expect(agent.rows[0].api_key_hash).toBe(seeded.apiKeyHash)

    const intent = await db.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [stale],
    )
    expect(intent.rows[0].status).toBe('pending_signature')

    const still = await findRekey(rekey.id, seeded.agentId)
    // Still retryable with the signatures the owner already holds.
    expect(still?.stage).toBe('issued')
  })

  it('does the activation, rotation, invalidation and stage advance together', async () => {
    const seeded = await seedAgent()
    const rekey = await reachIssued(seeded)
    const carry = await seedRekeyDelegation(seeded, rekey.id, 'carry')
    const stale = await seedIntent(seeded, OLD_DELEGATE)
    const confirmed = await seedIntent(seeded, OLD_DELEGATE, 'confirmed')

    const result = await completeRekey({
      agentId: seeded.agentId,
      userId: seeded.userId,
      rekeyId: rekey.id,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
      signedDelegations: [{ id: carry.id, delegationJson: '{"d":1,"signature":"0xaa"}' }],
    })

    expect(result.invalidatedIntents).toEqual([stale])
    const del = await db.query<{ status: string; delegation_json: string }>(
      `SELECT status, delegation_json FROM agent_delegations WHERE id = $1`,
      [carry.id],
    )
    expect(del.rows[0].status).toBe('active')
    expect(JSON.parse(del.rows[0].delegation_json).signature).toBe('0xaa')

    const agent = await db.query<{ delegate_address: string; api_key_hash: string }>(
      `SELECT delegate_address, api_key_hash FROM agents WHERE id = $1`,
      [seeded.agentId],
    )
    expect(agent.rows[0].delegate_address).toBe(NEW_DELEGATE)
    expect(agent.rows[0].api_key_hash).toBe('hash-new')

    expect((await findRekey(rekey.id, seeded.agentId))?.stage).toBe('completed')

    const settled = await db.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [confirmed],
    )
    expect(settled.rows[0].status).toBe('confirmed')
  })

  it('an EMPTY carry snapshot is a valid measurement — the zero-delegation agent', async () => {
    // Found by the #1698 review: an agent with no delegations (connected but
    // never granted a budget, or previously revoked) must still be able to
    // complete a re-key. It is the population re-key most needs to serve — a
    // lost key with little history. `[]` is the honest measurement here,
    // not a placeholder, and the metered-stage CHECK accepts it because an
    // empty array is not NULL.
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, 'none')

    const metered = await markMetered(rekey.id, seeded.agentId, [])
    expect(metered?.stage).toBe('metered')
    expect(metered?.carry_snapshot).toEqual([])
    // And the rest of the path stays open — the wedge the review found was
    // that it did not.
    expect((await markIssued(rekey.id, seeded.agentId))?.stage).toBe('issued')
  })

  // ── Lineage ────────────────────────────────────────────────────────────

  it('records which re-key produced a delegation, and with what role', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date,
          expires_at, rekey_id, carry_role)
       VALUES ($1, 84532, $2, NULL, $3, '{}', 1, 'pending', '400000', 86400, 0, 9999999999, $4, 'carry')`,
      [seeded.agentId, USDC, `0x${String(++seq).padStart(64, '0')}`, rekey.id],
    )
    const row = await db.query<{ rekey_id: string; carry_role: string }>(
      `SELECT rekey_id, carry_role FROM agent_delegations WHERE rekey_id = $1`,
      [rekey.id],
    )
    expect(row.rows[0].carry_role).toBe('carry')
  })

  it('refuses an unknown carry role', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await expect(
      db.query(
        `INSERT INTO agent_delegations
           (agent_id, chain_id, token_address, recipient_address, delegation_hash,
            delegation_json, version, status, budget_atomic, period_seconds, start_date,
            expires_at, rekey_id, carry_role)
         VALUES ($1, 84532, $2, NULL, $3, '{}', 1, 'pending', '1', 86400, 0, 9999999999, $4, 'whatever')`,
        [seeded.agentId, USDC, `0x${String(++seq).padStart(64, '0')}`, rekey.id],
      ),
    ).rejects.toThrow(/agent_delegations_carry_role_check/)
  })

  it('leaves ordinary owner grants with no re-key parent', async () => {
    const seeded = await seedAgent()
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date, expires_at)
       VALUES ($1, 84532, $2, NULL, $3, '{}', 1, 'active', '1000000', 86400, 0, 9999999999)`,
      [seeded.agentId, USDC, `0x${String(++seq).padStart(64, '0')}`],
    )
    const row = await db.query<{ rekey_id: string | null; carry_role: string | null }>(
      `SELECT rekey_id, carry_role FROM agent_delegations WHERE agent_id = $1`,
      [seeded.agentId],
    )
    expect(row.rows[0].rekey_id).toBeNull()
    expect(row.rows[0].carry_role).toBeNull()
  })

  // ── #3386: the merchant label carries onto every replacement piece ─────

  async function seedMerchant(): Promise<string> {
    const n = ++seq
    const row = await db.query<{ id: string }>(
      `INSERT INTO merchants (slug, name, description, listing_status)
       VALUES ($1, $2, 'x', 'live') RETURNING id`,
      [`rekey-merchant-${n}`, `Rekey merchant ${n}`],
    )
    return row.rows[0].id
  }

  /** A merchant-locked ACTIVE grant — the old row a re-key replaces. */
  async function seedMerchantLockedDelegation(
    agentId: string,
    merchantId: string,
    recipient = '0x' + 'c0'.repeat(20),
  ): Promise<string> {
    const hash = `0x${String(++seq).padStart(64, '0')}`
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date,
          expires_at, merchant_id)
       VALUES ($1, 84532, $2, $3, $4, '{"signed":"capability"}', 1, 'active', '1000000',
               86400, 0, 9999999999, $5)`,
      [agentId, USDC, recipient, hash, merchantId],
    )
    return hash
  }

  it('findDelegationTerms reads the merchant_id off the old row', async () => {
    const seeded = await seedAgent()
    const merchantId = await seedMerchant()
    const hash = await seedMerchantLockedDelegation(seeded.agentId, merchantId)

    const terms = await findDelegationTerms(seeded.agentId, hash)
    expect(terms?.merchant_id).toBe(merchantId)

    // MUTATION TARGET — an ordinary (unlocked) delegation reads null, not the
    // column being silently dropped from the SELECT.
    const plainHash = await seedPlainDelegation(seeded.agentId)
    expect((await findDelegationTerms(seeded.agentId, plainHash))?.merchant_id).toBeNull()
  })

  it('insertRekeyDelegation writes the carried merchant_id, and the CHECK holds because the recipient survives', async () => {
    const seeded = await seedAgent()
    const merchantId = await seedMerchant()
    const rekey = await open(seeded)
    // #3439: insertRekeyDelegation now re-checks the re-key's OWN stage
    // under the lock — it must be `metered`, the stage the issue route
    // checks before building rows.
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    const recipient = '0x' + 'c0'.repeat(20)

    const inserted = await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: recipient,
      delegationHash: `0x${String(++seq).padStart(64, '0')}`,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: rekey.id,
      carryRole: 'carry',
      merchantId,
    })
    expect(inserted).toBe(true)

    const row = await db.query<{ merchant_id: string; recipient_address: string }>(
      `SELECT merchant_id, recipient_address FROM agent_delegations WHERE rekey_id = $1`,
      [rekey.id],
    )
    expect(row.rows[0].merchant_id).toBe(merchantId)
    expect(row.rows[0].recipient_address).toBe(recipient.toLowerCase())
  })

  it('MUTATION TARGET — insertRekeyDelegation with merchantId: null writes no label', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: null,
      delegationHash: `0x${String(++seq).padStart(64, '0')}`,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: rekey.id,
      carryRole: 'carry',
      merchantId: null,
    })
    const row = await db.query<{ merchant_id: string | null }>(
      `SELECT merchant_id FROM agent_delegations WHERE rekey_id = $1`,
      [rekey.id],
    )
    expect(row.rows[0].merchant_id).toBeNull()
  })

  it('a merchant deleted between metering and issue does not block issuance — the insert writes merchant_id: null', async () => {
    // #3386 review finding: the route resolves `merchant_id` by a by-hash
    // read of the old row moments before this insert, but the merchant can
    // be deleted in that window. The FK is `ON DELETE SET NULL`, so the OLD
    // row's read already comes back null once the merchant is gone — but
    // proving the INSERT itself survives a merchant id resolved a moment
    // earlier and since deleted (a race the by-hash read alone cannot rule
    // out under concurrency) is the point of this test: the subselect in
    // `INSERT_REKEY_DELEGATION_SQL` resolves any non-existent merchant id to
    // NULL rather than throwing 23503.
    const seeded = await seedAgent()
    const merchantId = await seedMerchant()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    const recipient = '0x' + 'c0'.repeat(20)

    await db.query(`DELETE FROM merchants WHERE id = $1`, [merchantId])

    const inserted = await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: recipient,
      delegationHash: `0x${String(++seq).padStart(64, '0')}`,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: rekey.id,
      carryRole: 'carry',
      // The value resolved a moment before the merchant vanished — exactly
      // what the route would still be holding.
      merchantId,
    })
    expect(inserted).toBe(true)

    const row = await db.query<{ merchant_id: string | null }>(
      `SELECT merchant_id FROM agent_delegations WHERE rekey_id = $1`,
      [rekey.id],
    )
    expect(row.rows[0].merchant_id).toBeNull()
  })

  it('MUTATION TARGET — a present merchant is still carried through the same subselect (the guard above is not a blanket null)', async () => {
    const seeded = await seedAgent()
    const merchantId = await seedMerchant()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    const recipient = '0x' + 'c0'.repeat(20)

    const inserted = await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: recipient,
      delegationHash: `0x${String(++seq).padStart(64, '0')}`,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: rekey.id,
      carryRole: 'carry',
      merchantId,
    })
    expect(inserted).toBe(true)

    const row = await db.query<{ merchant_id: string | null }>(
      `SELECT merchant_id FROM agent_delegations WHERE rekey_id = $1`,
      [rekey.id],
    )
    expect(row.rows[0].merchant_id).toBe(merchantId)
  })

  it('#3386 reuse decision — a re-key\'s own pending replacement is never handed out by build reuse', async () => {
    const seeded = await seedAgent()
    const merchantId = await seedMerchant()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    const recipient = '0x' + 'c0'.repeat(20)

    const inserted = await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: recipient,
      delegationHash: `0x${String(++seq).padStart(64, '0')}`,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: rekey.id,
      carryRole: 'carry',
      merchantId,
    })
    // The row must genuinely exist before "abandoned rows are never reused"
    // means anything — without this, the test would still pass on a row
    // that silently never got inserted.
    expect(inserted).toBe(true)
    // Abandon the re-key — the row stays `pending` forever (completion
    // requires `stage = 'issued'`, and `abandoned` is terminal).
    await abandonRekey(rekey.id, seeded.agentId, 'stopped')

    // MUTATION TARGET — without `rekey_id IS NULL`, carrying merchant_id onto
    // this dead row would make it eligible here: a later merchant-locked
    // build for the SAME (agent, token, recipient, budget, period, merchant)
    // slot must build a fresh row, not hand out the abandoned re-key's inert
    // pending one.
    const reusable = await findReusablePendingDelegation(
      seeded.agentId,
      USDC,
      recipient,
      '1000000',
      86_400,
      9_999_999_999,
      db,
      merchantId,
    )
    expect(reusable).toBeNull()
  })
})

/**
 * #3439 — the stalled-issue race. `lockOwnedAgentForRekeyDelegation` only
 * proves that SOME re-key of the agent is in flight, not that it is the one
 * calling `insertRekeyDelegation`. The interleaving from the (corrected)
 * issue body:
 *
 * 1. R1 reaches `metered`. Its issue request passes the (route-level) stage
 *    check and stalls before it inserts anything.
 * 2. The owner abandons R1 and opens R2 with a fresh candidate key.
 * 3. R2 moves past its own revoke step (`revoked` → `metered`, here) —
 *    R2 is now in flight.
 * 4. R1's stalled issue resumes. Before #3439, `insertRekeyDelegation`
 *    re-checked only that *some* re-key of the agent was in flight — R2
 *    satisfies that — so R1's rows were inserted for an abandoned re-key
 *    while a DIFFERENT re-key was the one actually in flight.
 *
 * This block calls `insertRekeyDelegation` directly with R1's id while R2 is
 * `metered`, which is exactly step 4 — the route-level stage check in step 1
 * is out of scope for a repository test and is exercised at the route level
 * (`agent-rekey-issue-clock.test.ts` et al.); what this proves is that the
 * REPOSITORY function itself refuses once R1 stops being R1's own `metered`.
 */
describeDb('insertRekeyDelegation refuses a stalled re-key while a successor is in flight (#3439)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it("R1's stalled insert is refused once R1 is abandoned, even though R2 (a different re-key) is in flight", async () => {
    const seeded = await seedAgent()

    // R1 reaches metered — the stage its issue request checked before
    // "stalling".
    const r1 = await open(seeded)
    await markRevoked(r1.id, seeded.agentId, '0xr1revoke')
    await markMetered(r1.id, seeded.agentId, snapshot())

    // Owner abandons R1 — frees the one-in-flight slot.
    const abandoned = await abandonRekey(r1.id, seeded.agentId, 'stalled, owner abandoned')
    expect(abandoned?.stage).toBe('abandoned')

    // R2 opens with a fresh candidate key and moves past its own revoke —
    // R2 is the re-key actually in flight when R1's stalled insert resumes.
    const r2NewDelegate = '0x00000000000000000000000000000000000000d3'
    const r2 = await open(seeded, { newDelegateAddress: r2NewDelegate })
    await markRevoked(r2.id, seeded.agentId, '0xr2revoke')
    await markMetered(r2.id, seeded.agentId, snapshot())
    expect((await findRekey(r2.id, seeded.agentId))?.stage).toBe('metered')

    // R1's stalled issue resumes and tries to insert. `lockOwnedAgentForRekeyDelegation`
    // alone would pass (R2 satisfies "some re-key in flight") — the guard
    // under test is the re-check of R1's OWN stage.
    const hash = `0x${String(++seq).padStart(64, '0')}`
    const inserted = await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: null,
      delegationHash: hash,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: r1.id,
      carryRole: 'steady',
      merchantId: null,
    })

    // MUTATION TARGET: without the stage re-check, this is `true` and the
    // row below exists under R1 while R2 is still in flight — surviving R2's
    // eventual completion as a `pending` row nothing else in the re-key
    // lifecycle ever revisits.
    expect(inserted).toBe(false)
    const row = await db.query(`SELECT 1 FROM agent_delegations WHERE delegation_hash = $1`, [hash])
    expect(row.rowCount).toBe(0)
  })

  it("control: R1's insert still succeeds while R1 ITSELF is the metered re-key in flight — the guard is scoped to R1, not a blanket refusal", async () => {
    const seeded = await seedAgent()
    const r1 = await open(seeded)
    await markRevoked(r1.id, seeded.agentId, '0xr1revoke')
    await markMetered(r1.id, seeded.agentId, snapshot())

    const hash = `0x${String(++seq).padStart(64, '0')}`
    const inserted = await insertRekeyDelegation({
      agentId: seeded.agentId,
      userId: seeded.userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: null,
      delegationHash: hash,
      delegationJson: '{"signed":"capability"}',
      version: 2,
      budgetAtomic: '1000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 9_999_999_999,
      rekeyId: r1.id,
      carryRole: 'steady',
      merchantId: null,
    })

    expect(inserted).toBe(true)
  })
})

/**
 * #3450 — `insertRekeyDelegation` called with a REAL checked-out `PoolClient`
 * as its executor, not a fake. This is the exact call the issue route's
 * transactional piece loop makes for every piece after the first: the route
 * opens ONE transaction (`withRekeyIssueTransaction`) and threads that same
 * `PoolClient` through every DB call inside the loop, including this one.
 *
 * Before #3450, `withTransaction` treated ANY executor with a `connect`
 * method as poolable and tried to check out a SECOND client from it. A real
 * `pg` `PoolClient` has `connect` (inherited from `Client.prototype`) as well
 * as `release`, so this rejected with "Client has already been connected. You
 * cannot reuse a client." The existing "runs inline on an executor that is
 * already a transaction client" test in `transaction.test.ts` uses a FAKE
 * executor with no `connect` method at all, so it could not, and did not,
 * catch this.
 */
describeDb('insertRekeyDelegation on a checked-out PoolClient (#3450)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('MUTATION TARGET — accepts a real PoolClient and runs INLINE on it, not on a second checkout', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const hash = `0x${String(++seq).padStart(64, '0')}`
      const inserted = await insertRekeyDelegation(
        {
          agentId: seeded.agentId,
          userId: seeded.userId,
          chainId: 84532,
          tokenAddress: USDC,
          recipientAddress: null,
          delegationHash: hash,
          delegationJson: '{"signed":"capability"}',
          version: 2,
          budgetAtomic: '1000000',
          periodSeconds: 86_400,
          startDate: 0,
          expiresAt: 9_999_999_999,
          rekeyId: rekey.id,
          carryRole: 'carry',
          merchantId: null,
        },
        // Before #3450 this line threw "Client has already been connected."
        client,
      )
      expect(inserted).toBe(true)

      // Visible on THIS client's own open transaction...
      const withinTx = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_delegations WHERE delegation_hash = $1`,
        [hash],
      )
      expect(withinTx.rows[0].n).toBe(1)

      // ...but NOT yet on a fresh connection — proving `withTransaction` ran
      // INLINE on `client` rather than silently opening (and committing) an
      // independent second transaction on a different connection, which
      // would make this row visible here before `client` ever commits.
      const outsideTx = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_delegations WHERE delegation_hash = $1`,
        [hash],
      )
      expect(outsideTx.rows[0].n).toBe(0)

      await client.query('COMMIT')
      const afterCommit = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_delegations WHERE delegation_hash = $1`,
        [hash],
      )
      expect(afterCommit.rows[0].n).toBe(1)
    } finally {
      client.release()
    }
  })
})

/**
 * #1868 — a re-key abandoned after the revoke must not forfeit the frozen
 * carry, and nothing may reclaim a re-key the owner has not abandoned.
 *
 * The wedge: the abandoned re-key already revoked the delegations ON-CHAIN,
 * so a fresh re-key finds nothing to revoke and used to walk to `metered`
 * with an empty snapshot — the frozen measurement sat unread on the
 * abandoned row and the agent's authority was gone until a manual re-grant.
 * `adoptAbandonedCarry` is the exit: the fresh row inherits the abandoned
 * row's snapshot AND its clocks. Everything here is Postgres behaviour —
 * which predecessor qualifies, the over-grant guard, the timestamp
 * inheritance, idempotency — so it lives on the real harness (#1219).
 */
describeDb('adoptAbandonedCarry (#1868)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  /** Walk a re-key to `metered` with a frozen snapshot, then abandon it. */
  async function abandonAtMetered(seeded: Seeded, snap = snapshot()) {
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xrevoketx')
    await markMetered(rekey.id, seeded.agentId, snap)
    const abandoned = await abandonRekey(rekey.id, seeded.agentId, 'interrupted')
    expect(abandoned?.stage).toBe('abandoned')
    return (await findRekey(rekey.id, seeded.agentId))!
  }

  /** A fresh re-key opened after the predecessor released the slot. */
  async function openSuccessor(seeded: Seeded) {
    return open(seeded, { newDelegateAddress: '0x00000000000000000000000000000000000000d3' })
  }

  async function grantAfter(seeded: Seeded, status: string, rekeyId: string | null = null) {
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date,
          expires_at, rekey_id, carry_role)
       VALUES ($1, 84532, $2, NULL, $3, '{}', 1, $4, '1000000', 86400, 0, 9999999999, $5,
               CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'carry' END)`,
      [seeded.agentId, USDC, `0x${String(++seq).padStart(64, '0')}`, status, rekeyId],
    )
  }

  it('MUTATION TARGET — the fresh re-key inherits the abandoned carry, clocks and revoke tx wholesale', async () => {
    const seeded = await seedAgent()
    const prior = await abandonAtMetered(seeded)
    const successor = await openSuccessor(seeded)

    const adopted = await adoptAbandonedCarry(successor.id, seeded.agentId)

    expect(adopted).not.toBeNull()
    expect(adopted!.stage).toBe('metered')
    expect(adopted!.inherited_from_rekey_id).toBe(prior.id)
    expect(adopted!.carry_snapshot).toEqual(prior.carry_snapshot)
    // The measurement clock is INHERITED, never re-stamped: `metered_at`
    // anchors the carry arithmetic to the period the remainder was measured
    // in (#1849). Stamping adoption time here would re-create that
    // under-grant through a side door — this is the assertion that kills the
    // `metered_at = NOW()` mutation.
    expect(new Date(adopted!.metered_at as string).getTime()).toBe(
      new Date(prior.metered_at as string).getTime(),
    )
    expect(new Date(adopted!.revoked_at as string).getTime()).toBe(
      new Date(prior.revoked_at as string).getTime(),
    )
    expect(adopted!.revoke_tx_hash).toBe('0xrevoketx')
  })

  it('MUTATION TARGET — refuses adoption when ANY grant was made after the abandoned revoke', async () => {
    // The over-grant this guards: abandon at metered with remainder R, owner
    // manually re-grants a full budget, agent spends it, owner revokes it,
    // owner re-keys. Adopting R on top of that spent budget would exceed the
    // period's original grant. The guard refuses on any post-revoke grant,
    // whatever its current status — a revoked grant still spent.
    const seeded = await seedAgent()
    await abandonAtMetered(seeded)
    await grantAfter(seeded, 'revoked')
    const successor = await openSuccessor(seeded)

    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).toBeNull()
    // Fail closed: the successor is untouched, still at preflight, and walks
    // the empty path exactly as before this fix.
    const after = await findRekey(successor.id, seeded.agentId)
    expect(after!.stage).toBe('preflight')
    expect(after!.carry_snapshot).toBeNull()
  })

  it("MUTATION TARGET — a COMPLETED re-key's snapshot is never adopted", async () => {
    // A completed re-key's carry was already issued and possibly spent;
    // adopting it would be the same over-grant with a different history.
    // This is what pins the predecessor predicate to stage='abandoned'.
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xtx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    await markIssued(rekey.id, seeded.agentId)
    await markCompleted(rekey.id, seeded.agentId)
    const successor = await openSuccessor(seeded)

    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).toBeNull()
  })

  it("the abandoned re-key's own pending issue rows do not block adoption", async () => {
    // A re-key abandoned at `issued` left `pending` delegation rows behind.
    // They are permanently inert — completion requires stage `issued` and
    // `abandoned` is terminal — so they must not trip the over-grant guard:
    // the exact population this fix serves is an owner who got FAR and then
    // lost the key.
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await markRevoked(rekey.id, seeded.agentId, '0xrevoketx')
    await markMetered(rekey.id, seeded.agentId, snapshot())
    await markIssued(rekey.id, seeded.agentId)
    await grantAfter(seeded, 'pending', rekey.id)
    await abandonRekey(rekey.id, seeded.agentId, 'lost the new key too')
    const successor = await openSuccessor(seeded)

    const adopted = await adoptAbandonedCarry(successor.id, seeded.agentId)
    expect(adopted).not.toBeNull()
    expect(adopted!.inherited_from_rekey_id).toBe(rekey.id)
  })

  it('an ordinary PENDING grant made after the revoke still blocks adoption', async () => {
    // Only a re-key's own pending rows are inert. An ordinary grant's signing
    // flow is still live — it can activate later — so it blocks, fail closed.
    const seeded = await seedAgent()
    await abandonAtMetered(seeded)
    await grantAfter(seeded, 'pending', null)
    const successor = await openSuccessor(seeded)

    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).toBeNull()
  })

  it('an abandonment that never froze a carry (preflight/revoked) offers nothing to adopt', async () => {
    const seeded = await seedAgent()
    const rekey = await open(seeded)
    await abandonRekey(rekey.id, seeded.agentId, 'changed my mind at preflight')
    const successor = await openSuccessor(seeded)

    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).toBeNull()
  })

  it('an empty frozen snapshot is not "a carry" — nothing is adopted from it', async () => {
    // The empty-walk short-circuit writes []. Adopting [] would be a no-op
    // wearing an inherited tx hash; refuse instead so the response stays
    // truthful about what happened.
    const seeded = await seedAgent()
    await abandonAtMetered(seeded, [])
    const successor = await openSuccessor(seeded)

    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).toBeNull()
  })

  it('POSITIVE CONTROL — a live, slow re-key is structurally unreachable: the slot refuses a successor', async () => {
    // The abandonment signal is the owner's explicit abandon, never elapsed
    // time. A merely slow re-key still holds the one-in-flight slot, so a
    // successor cannot even OPEN — there is no row for adoption to act on,
    // and the live re-key is untouched.
    const seeded = await seedAgent()
    const slow = await open(seeded)
    await markRevoked(slow.id, seeded.agentId, '0xslowtx')
    await markMetered(slow.id, seeded.agentId, snapshot())
    // Age it: hours old, exactly the shape a timeout-based reclaim would eat.
    await db.query(
      `UPDATE agent_rekeys SET created_at = NOW() - interval '48 hours',
              updated_at = NOW() - interval '48 hours' WHERE id = $1`,
      [slow.id],
    )

    await expect(openSuccessor(seeded)).rejects.toThrow(/idx_agent_rekeys_one_in_flight/)

    const untouched = await findRekey(slow.id, seeded.agentId)
    expect(untouched!.stage).toBe('metered')
    expect(untouched!.carry_snapshot).toEqual(slow.carry_snapshot ?? untouched!.carry_snapshot)
  })

  it('is idempotent — the second call finds the row past preflight and does nothing', async () => {
    const seeded = await seedAgent()
    await abandonAtMetered(seeded)
    const successor = await openSuccessor(seeded)

    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).not.toBeNull()
    expect(await adoptAbandonedCarry(successor.id, seeded.agentId)).toBeNull()

    const row = await findRekey(successor.id, seeded.agentId)
    expect(row!.stage).toBe('metered')
  })

  it('a chain of abandonments keeps carrying the ORIGINAL measurement clock', async () => {
    // Abandon at metered, start again, adopt, abandon AGAIN, start a third
    // time: the third re-key must still see the first re-key's metered_at —
    // the only clock the remainder means anything in (#1849).
    const seeded = await seedAgent()
    const first = await abandonAtMetered(seeded)

    const second = await openSuccessor(seeded)
    const secondAdopted = await adoptAbandonedCarry(second.id, seeded.agentId)
    expect(secondAdopted).not.toBeNull()
    await abandonRekey(second.id, seeded.agentId, 'interrupted again')

    const third = await open(seeded, {
      newDelegateAddress: '0x00000000000000000000000000000000000000d4',
    })
    const thirdAdopted = await adoptAbandonedCarry(third.id, seeded.agentId)

    expect(thirdAdopted).not.toBeNull()
    expect(thirdAdopted!.carry_snapshot).toEqual(first.carry_snapshot)
    expect(new Date(thirdAdopted!.metered_at as string).getTime()).toBe(
      new Date(first.metered_at as string).getTime(),
    )
  })
})
