/**
 * Real-DB tests for the machine-payments repository (#1224, epic #1219).
 *
 * The bookkeeping evidence aggregate (#462/#491), reconciliation events and
 * the sweep claim — every ON CONFLICT clause exercised as a genuine
 * double-write, every guarded transition on both of its sides. On the #1220
 * harness; zero mocks.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  attachEvidenceProof,
  claimPreparedSweep,
  findEvidenceAnchorForAgent,
  insertMerchantReceiptOnce,
  listEvidenceReceiptsForAgent,
  markSweepSubmitted,
  releaseSweepClaim,
  resolveReconciliationForPayment,
  resolveStrandedEventsForAgent,
  upsertEvidenceBase,
  upsertReconciliationEvent,
  type EvidenceBaseInput,
} from '../machine-payments.js'

let seq = 0
const ADDR = (n: string) => `0x${n.repeat(40).slice(0, 40)}`

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`mp-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'machine agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

async function seedIntent(agentId: string, userId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, payment_rail)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '100000', '0.10', $6, 1, $7,
             'confirmed', NOW() + interval '10 minutes', 'mpp')
     RETURNING id`,
    [agentId, userId, ADDR('f1'), ADDR('0e'), ADDR('aa'), ADDR('d1'),
      `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66)],
  )
  return r.rows[0].id
}

// #2055: `approval_requests` is dropped (migration 070), and its DROP TABLE
// ... CASCADE took the FK on `machine_payment_evidence.approval_request_id`
// with it — the column survives as a plain, unconstrained UUID (the
// migration's own header: "columns they governed survive the drop as plain
// UUIDs"). The write path this column feeds is unreachable application code
// (#2055 instruction: still exists, on purpose, not to be asserted gone),
// but its ON CONFLICT behaviour is real DB behaviour worth proving, and
// proving it no longer needs a live `approval_requests` row to point at —
// any UUID satisfies the column now that nothing constrains it.
function fakeApprovalId(): string {
  seq += 1
  const hex = seq.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

function evidenceInput(
  agent: { agentId: string; userId: string },
  overrides: Partial<EvidenceBaseInput> = {},
): EvidenceBaseInput {
  return {
    referenceColumn: 'payment_intent_id',
    paymentIntentId: null,
    approvalRequestId: null,
    agentId: agent.agentId,
    userId: agent.userId,
    rail: 'mpp',
    txHash: `0x${'A'.repeat(64)}`,
    chainId: 84532,
    resourceUrl: 'https://merchant.example/r',
    merchantAddress: ADDR('CC'),
    payerAddress: ADDR('F1'),
    settlementAddress: ADDR('AA'),
    tokenSymbol: 'USDC',
    tokenAddress: ADDR('0E'),
    amountRaw: '100000',
    amountHuman: '0.10',
    challengeId: null,
    idempotencyKey: null,
    challengePayload: null,
    confirmedAt: null,
    amountSek: null,
    fxRateSek: null,
    fxSource: null,
    fxAt: null,
    ...overrides,
  }
}

async function readEvidence(intentId: string) {
  const r = await db.query(`SELECT * FROM machine_payment_evidence WHERE payment_intent_id = $1`, [
    intentId,
  ])
  return r.rows
}

describeDb('machine-payments repository (#1224)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── Evidence base upsert: the ON CONFLICT the issue names ──────────────

  it('a replayed evidence write UPDATES the one row — and freezes the book-time FX values', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)

    await upsertEvidenceBase(
      evidenceInput(agent, {
        paymentIntentId: intentId,
        amountSek: '1.05',
        fxRateSek: '10.5',
        fxSource: 'riksbanken',
        challengePayload: '{"first":true}',
      }),
    )
    await upsertEvidenceBase(
      evidenceInput(agent, {
        paymentIntentId: intentId,
        txHash: `0x${'B'.repeat(64)}`, // replaced on replay…
        amountSek: '9.99', // …but FX is COALESCE-frozen at first write
        fxRateSek: '99.9',
        fxSource: 'wrong-source',
        challengePayload: '{"second":true}',
      }),
    )

    const rows = await readEvidence(intentId)
    expect(rows).toHaveLength(1) // the double-write really deduped
    expect(rows[0].tx_hash).toBe(`0x${'b'.repeat(64)}`) // LOWER() applied
    expect(Number(rows[0].amount_sek)).toBeCloseTo(1.05)
    expect(rows[0].fx_source).toBe('riksbanken')
    expect(rows[0].challenge_payload).toEqual({ first: true })
  })

  it('the approval-anchored upsert dedupes on its own partial unique index', async () => {
    const agent = await seedAgent()
    const approvalId = fakeApprovalId()
    const input = evidenceInput(agent, {
      referenceColumn: 'approval_request_id',
      approvalRequestId: approvalId,
    })
    await upsertEvidenceBase(input)
    await upsertEvidenceBase({ ...input, txHash: `0x${'C'.repeat(64)}` })

    const rows = await db.query(
      `SELECT tx_hash FROM machine_payment_evidence WHERE approval_request_id = $1`,
      [approvalId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].tx_hash).toBe(`0x${'c'.repeat(64)}`)
  })

  // ── Proof attach: sticky terminal status ───────────────────────────────

  it('protocol_receipt_attached is STICKY — a later lesser proof cannot downgrade it', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId }))

    const attached = await attachEvidenceProof({
      referenceColumn: 'payment_intent_id',
      paymentId: intentId,
      agentId: agent.agentId,
      proofStatus: 'protocol_receipt_attached',
      challengePayload: null,
      selectedPayment: null,
      paymentProofHeaderName: 'X-PAYMENT',
      paymentProofHeader: 'proof-1',
      protocolReceiptHeaderName: 'X-RECEIPT-JSON',
      protocolReceiptHeader: 'receipt-1',
      protocolReceiptPayload: '{"invoice":1}',
      merchantStatus: 200,
    })
    expect(attached).not.toBeNull()

    const downgraded = await attachEvidenceProof({
      referenceColumn: 'payment_intent_id',
      paymentId: intentId,
      agentId: agent.agentId,
      proofStatus: 'payment_proof_attached', // lesser status must NOT win
      challengePayload: null,
      selectedPayment: null,
      paymentProofHeaderName: null,
      paymentProofHeader: null,
      protocolReceiptHeaderName: null,
      protocolReceiptHeader: null, // COALESCE keeps receipt-1
      protocolReceiptPayload: null,
      merchantStatus: null,
    })
    expect(downgraded!.proof_status).toBe('protocol_receipt_attached')
    expect(downgraded!.protocol_receipt_header).toBe('receipt-1')
    expect(downgraded!.merchant_status).toBe(200)
  })

  it('attachEvidenceProof is tenant-scoped: the wrong agent touches nothing', async () => {
    const agent = await seedAgent()
    const other = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId }))

    const result = await attachEvidenceProof({
      referenceColumn: 'payment_intent_id',
      paymentId: intentId,
      agentId: other.agentId,
      proofStatus: 'payment_proof_attached',
      challengePayload: null,
      selectedPayment: null,
      paymentProofHeaderName: null,
      paymentProofHeader: 'stolen',
      protocolReceiptHeaderName: null,
      protocolReceiptHeader: null,
      protocolReceiptPayload: null,
      merchantStatus: null,
    })
    expect(result).toBeNull()
    expect((await readEvidence(intentId))[0].payment_proof_header).toBeNull()
  })

  // ── Reconciliation events: ON CONFLICT (payment_intent_id, event_type) ─

  it('a replayed reconciliation event RE-OPENS the one row — unless it was resolved', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    const base = {
      conflictColumn: 'payment_intent_id' as const,
      agentId: agent.agentId,
      userId: agent.userId,
      paymentIntentId: intentId,
      approvalRequestId: null,
      rail: 'mpp',
      eventType: 'merchant_retry_rejected_after_payment',
      txHash: `0x${'1'.repeat(64)}`,
      resourceUrl: null,
      merchantAddress: null,
      machineChallengeId: null,
      machineIdempotencyKey: null,
      reason: 'first',
      details: null,
    }

    const first = await upsertReconciliationEvent(base)
    expect(first!.status).toBe('open')

    const replay = await upsertReconciliationEvent({ ...base, reason: 'second' })
    expect(replay!.id).toBe(first!.id) // same row, not a duplicate
    const count = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM machine_payment_reconciliation_events WHERE payment_intent_id = $1`,
      [intentId],
    )
    expect(count.rows[0].n).toBe(1)

    // Resolve it; a further replay must NOT re-open a resolved flag.
    await resolveReconciliationForPayment('payment_intent_id', intentId, agent.agentId)
    const afterResolve = await upsertReconciliationEvent({ ...base, reason: 'third' })
    expect(afterResolve).toBeNull()
    const status = await db.query<{ status: string; reason: string }>(
      `SELECT status, reason FROM machine_payment_reconciliation_events WHERE id = $1`,
      [first!.id],
    )
    expect(status.rows[0].status).toBe('resolved')
    expect(status.rows[0].reason).toBe('second') // the resolved row kept its state
  })

  it('resolveStrandedEventsForAgent closes only the stranded-funds event type', async () => {
    const agent = await seedAgent()
    const intentA = await seedIntent(agent.agentId, agent.userId)
    const intentB = await seedIntent(agent.agentId, agent.userId)
    const base = {
      conflictColumn: 'payment_intent_id' as const,
      agentId: agent.agentId,
      userId: agent.userId,
      approvalRequestId: null,
      rail: 'mpp',
      txHash: `0x${'2'.repeat(64)}`,
      resourceUrl: null,
      merchantAddress: null,
      machineChallengeId: null,
      machineIdempotencyKey: null,
      reason: null,
      details: null,
    }
    await upsertReconciliationEvent({
      ...base, paymentIntentId: intentA, eventType: 'merchant_retry_rejected_after_payment',
    })
    await upsertReconciliationEvent({
      ...base, paymentIntentId: intentB, eventType: 'delegate_residue_after_settlement',
    })

    await resolveStrandedEventsForAgent(agent.agentId)
    const rows = await db.query<{ event_type: string; status: string }>(
      `SELECT event_type, status FROM machine_payment_reconciliation_events ORDER BY event_type`,
    )
    expect(rows.rows).toEqual([
      { event_type: 'delegate_residue_after_settlement', status: 'open' },
      { event_type: 'merchant_retry_rejected_after_payment', status: 'resolved' },
    ])
  })

  // ── Sweep claim CAS (#717) ─────────────────────────────────────────────

  it('EXACTLY ONE of N concurrent sweep claims wins, and release makes it claimable again', async () => {
    const agent = await seedAgent()
    const sweep = await db.query<{ id: string }>(
      `INSERT INTO delegate_sweeps
         (agent_id, user_id, chain_id, token_address, from_address, to_address,
          value_atomic, valid_after, valid_before, nonce)
       VALUES ($1, $2, 84532, $3, $4, $5, 100000, 0, 9999999999, $6)
       RETURNING id`,
      [agent.agentId, agent.userId, ADDR('0e'), ADDR('d1'), ADDR('f1'), `0x${'9'.repeat(64)}`],
    )
    const sweepId = sweep.rows[0].id

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => claimPreparedSweep(sweepId)),
    )
    expect(outcomes.filter(Boolean)).toHaveLength(1)

    // Relayer-budget refusal path: release → prepared → claimable again.
    await releaseSweepClaim(sweepId)
    expect(await claimPreparedSweep(sweepId)).toBe(true)

    // Submitted is terminal for the claim: neither release nor re-claim.
    await markSweepSubmitted(`0x${'3'.repeat(64)}`, sweepId)
    await releaseSweepClaim(sweepId)
    const row = await db.query<{ status: string; tx_hash: string }>(
      `SELECT status, tx_hash FROM delegate_sweeps WHERE id = $1`,
      [sweepId],
    )
    expect(row.rows[0].status).toBe('submitted')
    expect(await claimPreparedSweep(sweepId)).toBe(false)
  })

  // ── Merchant receipts: first write wins ────────────────────────────────

  it('insertMerchantReceiptOnce stores the FIRST receipt and drops the duplicate', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId }))
    const anchor = await findEvidenceAnchorForAgent(intentId, agent.agentId)
    expect(anchor).not.toBeNull()

    expect(await insertMerchantReceiptOnce(anchor!.id, 'https://m.example/r1', null)).toBe(true)
    expect(await insertMerchantReceiptOnce(anchor!.id, 'https://m.example/r2', null)).toBe(false)

    const receipt = await db.query<{ url: string }>(
      `SELECT url FROM merchant_receipts WHERE evidence_id = $1`,
      [anchor!.id],
    )
    expect(receipt.rows).toHaveLength(1)
    expect(receipt.rows[0].url).toBe('https://m.example/r1') // immutable source material
  })

  it('the evidence anchor is tenant-scoped, and the receipts list joins settlement fields newest-first', async () => {
    const agent = await seedAgent()
    const other = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await db.query(
      `UPDATE payment_intents SET machine_metadata = '{"settlement_scheme":"erc7710"}'::jsonb WHERE id = $1`,
      [intentId],
    )
    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId }))

    expect(await findEvidenceAnchorForAgent(intentId, other.agentId)).toBeNull()

    const receipts = await listEvidenceReceiptsForAgent<{ settlement_scheme: string }>(
      agent.agentId,
      10,
    )
    expect(receipts).toHaveLength(1)
    expect(receipts[0].settlement_scheme).toBe('erc7710')
    expect(await listEvidenceReceiptsForAgent(other.agentId, 10)).toHaveLength(0)
  })
})
