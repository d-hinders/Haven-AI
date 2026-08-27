/**
 * Real-DB tests for the payment-intents repository (#1223, epic #1219).
 *
 * The claim/release/confirm lifecycle IS the double-spend guard on the
 * legacy rail: every transition carries its guard in its WHERE clause, and
 * none of those guards is observable through a mock. The marquee test here
 * races N concurrent claims on one pending intent and asserts exactly one
 * wins — the property `POST /payments/:id/sign` stakes money on.
 *
 * On the #1220 harness; zero mocks; row builders local per the harness's
 * domain-free rule.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  claimIntentForSubmission,
  confirmSubmittedIntent,
  expireOverdueIntent,
  expireOverdueIntentsForAgent,
  expirePendingIntentReturningStatus,
  failSubmittedIntent,
  findIntentForAgent,
  findMachineIntentByKeyOrChallenge,
  findSendIntentByIdempotencyKey,
  getIntentStatus,
  insertDelegationIntent,
  insertLegacyIntent,
  insertMachineIntent,
  insertSendIntent,
  inTransaction,
  listIntentsForAgent,
  releaseSubmittedClaim,
} from '../payment-intents.js'

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`pi-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'intents agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

function legacyInput(agentId: string, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    userId,
    safeAddress: '0x00000000000000000000000000000000000000f1',
    chainId: 84532,
    tokenSymbol: 'USDC',
    tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    toAddress: '0x00000000000000000000000000000000000000aa',
    amountRaw: '100000',
    amountHuman: '0.10',
    delegateAddress: '0x00000000000000000000000000000000000000d1',
    allowanceNonce: 1,
    signHash: `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66),
    ...overrides,
  }
}

function machineInput(
  agent: { agentId: string; userId: string },
  overrides: Partial<Parameters<typeof insertMachineIntent>[0]> = {},
) {
  return {
    agent: {
      id: agent.agentId,
      user_id: agent.userId,
      safe_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 84532,
      delegate_address: '0x00000000000000000000000000000000000000d1',
    },
    rail: 'mpp',
    payTo: '0x00000000000000000000000000000000000000AA',
    tokenSymbol: 'USDC',
    tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    amountRaw: 100000n,
    amountHuman: '0.10',
    allowanceNonce: 1,
    signHash: `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
    resourceUrl: 'https://merchant.example/resource',
    category: null,
    merchantAddress: '0x00000000000000000000000000000000000000CC',
    challengeId: null,
    idempotencyKey: null,
    metadata: null,
    conflictTarget: 'machine_idempotency_key' as const,
    ...overrides,
  }
}

async function setExpired(intentId: string): Promise<void> {
  await db.query(`UPDATE payment_intents SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [
    intentId,
  ])
}

describeDb('payment-intents repository (#1223)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── The claim CAS under real concurrency ───────────────────────────────

  it('EXACTLY ONE of N concurrent claims wins — the double-spend guard', async () => {
    const { agentId, userId } = await seedAgent()
    const intent = await insertLegacyIntent(legacyInput(agentId, userId))

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimIntentForSubmission(`0xsig-racer-${i}`, intent.id, agentId),
      ),
    )
    expect(outcomes.filter(Boolean)).toHaveLength(1)

    // The committed row carries the winner's signature and nothing else's.
    const row = await findIntentForAgent(intent.id, agentId)
    expect(row!.status).toBe('submitted')
    const winner = outcomes.findIndex(Boolean)
    expect(row!.signature).toBe(`0xsig-racer-${winner}`)
  })

  it('a claim refuses an expired or already-progressed row', async () => {
    const { agentId, userId } = await seedAgent()
    const stale = await insertLegacyIntent(legacyInput(agentId, userId))
    await setExpired(stale.id)
    expect(await claimIntentForSubmission('0xsig', stale.id, agentId)).toBe(false)

    // …and the losing branch's tie-breaker: expireOverdueIntent says TRUE
    // here (the row was overdue), which is how the caller distinguishes
    // "expired" from "someone else claimed it".
    expect(await expireOverdueIntent(stale.id, agentId)).toBe(true)
    expect(await getIntentStatus(stale.id, agentId)).toBe('expired')
    expect(await expireOverdueIntent(stale.id, agentId)).toBe(false) // no longer pending

    const other = await seedAgent()
    const fresh = await insertLegacyIntent(legacyInput(agentId, userId))
    expect(await claimIntentForSubmission('0xsig', fresh.id, other.agentId)).toBe(false)
  })

  // ── Claim → confirm → release lifecycle ────────────────────────────────

  it('confirm requires a CLAIMED row, and a second confirm is refused', async () => {
    const { agentId, userId } = await seedAgent()
    const intent = await insertLegacyIntent(legacyInput(agentId, userId))

    // Confirm before claim: still pending_signature, must refuse.
    expect(
      await confirmSubmittedIntent({ txHash: `0x${'1'.repeat(64)}`, intentId: intent.id, usdValue: null, eurValue: null, agentId }),
    ).toBe(false)

    expect(await claimIntentForSubmission('0xsig', intent.id, agentId)).toBe(true)
    expect(
      await confirmSubmittedIntent({ txHash: `0x${'1'.repeat(64)}`, intentId: intent.id, usdValue: '0.10', eurValue: '0.09', agentId }),
    ).toBe(true)

    // Double-confirm: refused, first tx_hash survives.
    expect(
      await confirmSubmittedIntent({ txHash: `0x${'2'.repeat(64)}`, intentId: intent.id, usdValue: null, eurValue: null, agentId }),
    ).toBe(false)
    const row = await findIntentForAgent(intent.id, agentId)
    expect(row!.tx_hash).toBe(`0x${'1'.repeat(64)}`)
    expect(row!.status).toBe('confirmed')
  })

  it('releaseSubmittedClaim frees an unbroadcast claim — and can NEVER un-confirm a broadcast one (#717/#1119)', async () => {
    const { agentId, userId } = await seedAgent()
    const intent = await insertLegacyIntent(legacyInput(agentId, userId))
    await claimIntentForSubmission('0xsig', intent.id, agentId)

    // Relayer-budget refusal happens before any broadcast: release must
    // reopen the row, and the claim must be winnable again.
    await releaseSubmittedClaim(intent.id)
    expect(await getIntentStatus(intent.id, agentId)).toBe('pending_signature')
    expect(await claimIntentForSubmission('0xsig-2', intent.id, agentId)).toBe(true)

    // After broadcast (tx_hash set), release is a no-op — the guard that
    // keeps a rescue path from un-confirming real money movement.
    await db.query(`UPDATE payment_intents SET tx_hash = '0xbeef' WHERE id = $1`, [intent.id])
    await releaseSubmittedClaim(intent.id)
    expect(await getIntentStatus(intent.id, agentId)).toBe('submitted')
  })

  it('failSubmittedIntent records the failure only on a claimed row', async () => {
    const { agentId, userId } = await seedAgent()
    const intent = await insertLegacyIntent(legacyInput(agentId, userId))
    await failSubmittedIntent('too early', intent.id, agentId)
    expect(await getIntentStatus(intent.id, agentId)).toBe('pending_signature')

    await claimIntentForSubmission('0xsig', intent.id, agentId)
    await failSubmittedIntent('execution reverted', intent.id, agentId)
    const row = await findIntentForAgent(intent.id, agentId)
    expect(row!.status).toBe('failed')
    expect(row!.error_message).toBe('execution reverted')
  })

  // ── Expiry semantics at the boundary ───────────────────────────────────

  it('overdue expiry obeys the database clock on both sides of the boundary', async () => {
    const { agentId, userId } = await seedAgent()
    const fresh = await insertLegacyIntent(legacyInput(agentId, userId))
    const overdue = await insertLegacyIntent(legacyInput(agentId, userId))
    await setExpired(overdue.id)

    expect(await expireOverdueIntent(fresh.id, agentId)).toBe(false)
    expect(await getIntentStatus(fresh.id, agentId)).toBe('pending_signature')
    expect(await expireOverdueIntent(overdue.id, agentId)).toBe(true)

    // The per-agent sweep: only overdue+pending rows flip; confirmed rows
    // with a past expiry are untouched.
    const confirmed = await insertLegacyIntent(legacyInput(agentId, userId))
    await claimIntentForSubmission('0xsig', confirmed.id, agentId)
    await confirmSubmittedIntent({ txHash: `0x${'3'.repeat(64)}`, intentId: confirmed.id, usdValue: null, eurValue: null, agentId })
    await setExpired(confirmed.id)
    const sweepTarget = await insertLegacyIntent(legacyInput(agentId, userId))
    await setExpired(sweepTarget.id)

    await expireOverdueIntentsForAgent(agentId)
    expect(await getIntentStatus(sweepTarget.id, agentId)).toBe('expired')
    expect(await getIntentStatus(confirmed.id, agentId)).toBe('confirmed')
    expect(await getIntentStatus(fresh.id, agentId)).toBe('pending_signature')
  })

  it('expirePendingIntentReturningStatus reports the flip, or null when there was nothing to flip', async () => {
    const { agentId, userId } = await seedAgent()
    const intent = await insertLegacyIntent(legacyInput(agentId, userId))
    expect(await expirePendingIntentReturningStatus(intent.id, agentId)).toBe('expired')
    expect(await expirePendingIntentReturningStatus(intent.id, agentId)).toBeNull()
  })

  // ── Idempotency: real double-writes ────────────────────────────────────

  it('a duplicate ACTIVE send key throws 23505; failure frees the key (migration 020)', async () => {
    const { agentId, userId } = await seedAgent()
    const first = await insertSendIntent({ ...legacyInput(agentId, userId), sendIdempotencyKey: 'send-1' })
    expect(first.status).toBe('pending_signature')

    await expect(
      insertSendIntent({ ...legacyInput(agentId, userId), sendIdempotencyKey: 'send-1' }),
    ).rejects.toMatchObject({ code: '23505' })

    // The replay lookup finds the active winner…
    expect((await findSendIntentByIdempotencyKey(agentId, 'send-1'))?.id).toBe(first.id)

    // …and a failed row releases the key for a fresh attempt.
    await db.query(`UPDATE payment_intents SET status = 'failed' WHERE id = $1`, [first.id])
    await expect(
      insertSendIntent({ ...legacyInput(agentId, userId), sendIdempotencyKey: 'send-1' }),
    ).resolves.toBeTruthy()
    expect(await findSendIntentByIdempotencyKey(agentId, 'send-1')).not.toBeNull()
  })

  it('insertMachineIntent honours an EXPLICIT id — the erc7710 child is salted from it (#2094)', async () => {
    // The wiring the whole of #2094 rests on. The settlement child's salt is
    // derived from the intent id BEFORE the row exists, so the id the caller
    // salted with must be the id the row ends up with. If the insert quietly
    // ignored it and let gen_random_uuid() win, the child would name a row
    // that does not exist and no verifier or sweeper could ever recompute it.
    const agent = await seedAgent()
    const id = randomUUID()
    const row = await insertMachineIntent(machineInput(agent, { id, rail: 'x402' }))
    expect(row?.id).toBe(id)
    expect(
      (await db.query(`SELECT id FROM payment_intents WHERE id = $1`, [id])).rows,
    ).toHaveLength(1)
  })

  it('insertMachineIntent without an id still gets the column default — every other caller is untouched', async () => {
    const agent = await seedAgent()
    const row = await insertMachineIntent(machineInput(agent))
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('insertMachineIntent ON CONFLICT DO NOTHING: the replay returns null and the caller reloads the winner', async () => {
    const agent = await seedAgent()
    const first = await insertMachineIntent(machineInput(agent, { idempotencyKey: 'mkey-1' }))
    expect(first).not.toBeNull()

    const replay = await insertMachineIntent(machineInput(agent, { idempotencyKey: 'mkey-1' }))
    expect(replay).toBeNull() // DO NOTHING suppressed the insert

    const winner = await findMachineIntentByKeyOrChallenge(agent.agentId, 'mkey-1', null, 'mpp')
    expect(winner?.id).toBe(first!.id)

    // One row total for the key — the double-write really deduped.
    const count = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM payment_intents WHERE machine_idempotency_key = 'mkey-1'`,
    )
    expect(count.rows[0].n).toBe(1)
  })

  it('the mpp rail leaves the x402-only columns NULL — the column mapping is part of the write', async () => {
    const agent = await seedAgent()
    const mpp = await insertMachineIntent(machineInput(agent, { idempotencyKey: 'mkey-2' }))
    expect(mpp!.x402_resource_url).toBeNull()
    expect(mpp!.x402_idempotency_key).toBeNull()
    expect(mpp!.payment_resource_url).toBe('https://merchant.example/resource')
    expect(mpp!.to_address).toBe('0x00000000000000000000000000000000000000aa') // lower-cased

    const x402 = await insertMachineIntent(
      machineInput(agent, { rail: 'x402', idempotencyKey: 'xkey-1', conflictTarget: 'x402_idempotency_key' }),
    )
    expect(x402!.x402_resource_url).toBe('https://merchant.example/resource')
    expect(x402!.x402_idempotency_key).toBe('xkey-1')
  })

  it('challenge-id replay matches only its own rail', async () => {
    const agent = await seedAgent()
    await insertMachineIntent(machineInput(agent, { challengeId: 'chal-1' }))

    expect(await findMachineIntentByKeyOrChallenge(agent.agentId, null, 'chal-1', 'mpp')).not.toBeNull()
    expect(await findMachineIntentByKeyOrChallenge(agent.agentId, null, 'chal-1', 'x402')).toBeNull()
    // Null key + null challenge matches nothing rather than everything:
    expect(await findMachineIntentByKeyOrChallenge(agent.agentId, null, null, 'mpp')).toBeNull()
  })

  // ── Transactional integrity ────────────────────────────────────────────

  it('inTransaction rolls back the intent insert when the block throws', async () => {
    const { agentId, userId } = await seedAgent()
    await expect(
      inTransaction(async (tx) => {
        await insertLegacyIntent(legacyInput(agentId, userId), tx)
        throw new Error('abort after insert')
      }),
    ).rejects.toThrow('abort after insert')

    expect(await listIntentsForAgent(agentId)).toHaveLength(0)
  })

  // ── Reads ──────────────────────────────────────────────────────────────

  it('listIntentsForAgent is newest-first and tenant-scoped; findIntentForAgent refuses the wrong agent', async () => {
    const { agentId, userId } = await seedAgent()
    const other = await seedAgent()
    const a = await insertLegacyIntent(legacyInput(agentId, userId))
    await db.query(`UPDATE payment_intents SET created_at = NOW() - interval '1 hour' WHERE id = $1`, [a.id])
    const b = await insertDelegationIntent({
      ...legacyInput(agentId, userId),
      executionRail: 'delegation',
      delegationHash: `0x${'d'.repeat(64)}`,
      budgetDelegationHash: `0x${'d'.repeat(64)}`,
      preparedUserOp: '{"op":1}',
    } as Parameters<typeof insertDelegationIntent>[0])
    await insertLegacyIntent(legacyInput(other.agentId, other.userId))

    const list = await listIntentsForAgent(agentId)
    expect(list.map((r) => r.id)).toEqual([b.id, a.id])
    expect(b.execution_rail).toBe('delegation')
    expect(await findIntentForAgent(a.id, other.agentId)).toBeNull()
  })
})
