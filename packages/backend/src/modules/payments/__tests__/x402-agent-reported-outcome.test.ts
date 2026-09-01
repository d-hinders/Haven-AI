/**
 * #2292 — the plain-HTTP merchant-outcome report, end to end on real Postgres.
 *
 * ## What was broken
 *
 * On the plain-HTTP x402 path Haven tells the agent to call the merchant
 * itself and never talks to that merchant. `intentStateFor` has two routes to
 * `funded_but_unsettled`, and on that flow BOTH were out of reach:
 *
 * 1. the merchant-rejected route needs an open
 *    `merchant_retry_rejected_after_payment` reconciliation event, which only
 *    the SDK's own retry path wrote — a manual retry could not produce one;
 * 2. the never-reported route waits out `MERCHANT_REPORT_GRACE_MIN` (15).
 *
 * So for fifteen minutes a demonstrably failed purchase read `confirmed` /
 * `payment_confirmed` / `none`. That is not a wrong status, it is one that
 * could not yet know — nothing could tell it.
 *
 * ## Why these tests go through the handlers on a real database
 *
 * The claim is what `FIND_INTENT_STATUS_ROW_SQL` derives from the
 * `payment_intents` / `machine_payment_evidence` /
 * `machine_payment_reconciliation_events` join once a report lands, so it is
 * a property of the SQL plus the two write paths — real Postgres by the rule
 * in `docs/contributing/testing-strategy.md` (epic #1219), and through
 * `handleReconciliationEvent` / `attachEvidenceHandler` rather than raw
 * INSERTs so that the entry point the new hosted tool calls is the thing
 * under test.
 *
 * The sibling file `x402-funded-unsettled-status.test.ts` pins the #2145
 * grace-window behaviour these must not disturb; the positive control below
 * re-asserts one of its cases so a report that "succeeds" by marking
 * everything reported cannot pass this file.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getAgentPaymentStatus } from '../agent-payment-status.js'
import { handleReconciliationEvent } from '../../mpp/reconciliation.js'
import { attachEvidenceHandler } from '../../mpp/evidence.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

let seq = 0

const TX_HASH = '0x' + 'ab'.repeat(32)
const RESOURCE_URL = 'https://merchant.example/resource'

interface Seeded {
  agent: AgentContext
  paymentId: string
}

/**
 * A CONFIRMED eip3009 x402 intent with no merchant report of any kind — the
 * state an agent is in the instant after `haven_submit` confirms funding and
 * it goes off to retry the merchant itself.
 */
async function seedFundedX402(confirmedMinutesAgo: number): Promise<Seeded> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`reported-outcome-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'reporting agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', 'confirmed', $4,
             NOW() - ($3 || ' minutes')::interval,
             NOW() + interval '10 minutes', 'x402', 'x402',
             $5, '0x00000000000000000000000000000000000000c1',
             '{"settlement_scheme":"eip3009"}'::jsonb)
     RETURNING id`,
    [agentId, userId, String(confirmedMinutesAgo), TX_HASH, RESOURCE_URL],
  )
  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'reporting agent',
      delegate_address: '0x00000000000000000000000000000000000000d1',
      safe_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 84532,
      status: 'active',
    } as AgentContext,
    paymentId: intent.rows[0].id,
  }
}

/** A second agent, with its own user — the "someone else's payment" probe. */
async function seedForeignAgent(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`hostile-${++seq}-${Date.now()}@test.example`],
  )
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'hostile agent') RETURNING id`,
    [user.rows[0].id],
  )
  return agentRow.rows[0].id
}

function reportRejected(agentId: string, paymentId: string, merchantStatus = 402) {
  return handleReconciliationEvent(
    agentId,
    paymentId,
    'x402',
    'merchant_retry_rejected_after_payment',
    TX_HASH,
    `Agent-reported: merchant returned HTTP ${merchantStatus} to a manual retry after Haven payment confirmation`,
    { resource_url: RESOURCE_URL, retry_status: merchantStatus, reported_by: 'agent_manual_retry' },
  )
}

function reportAccepted(agentId: string, paymentId: string, merchantStatus = 200) {
  return attachEvidenceHandler(agentId, {
    paymentId,
    rail: 'x402',
    txHash: TX_HASH,
    resourceUrl: RESOURCE_URL,
    merchantStatus,
  })
}

async function countEvents(paymentId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM machine_payment_reconciliation_events
      WHERE payment_intent_id = $1 AND event_type = 'merchant_retry_rejected_after_payment'`,
    [paymentId],
  )
  return Number(rows.rows[0].n)
}

async function countEvidence(paymentId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM machine_payment_evidence WHERE payment_intent_id = $1`,
    [paymentId],
  )
  return Number(rows.rows[0].n)
}

describeDb('#2292 — agent-reported plain-HTTP merchant outcome', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  // ── The gap itself ─────────────────────────────────────────────────────────

  it('inside the grace window an unreported failure still reads as done — the defect', async () => {
    // One minute after funding, with nothing reported, the status is exactly
    // what the bug reporter saw. This is the state the report has to change.
    const { agent, paymentId } = await seedFundedX402(1)
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.status).toBe('confirmed')
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })

  it('a reported rejection reaches sweep_stranded_funds on the NEXT call, not after 15 minutes', async () => {
    const { agent, paymentId } = await seedFundedX402(1)

    const result = await reportRejected(agent.id, paymentId)
    expect(result.statusCode).toBe(202)

    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('funded_but_unsettled')
    expect(status?.next_action).toBe('sweep_stranded_funds')
  })

  it('the reported rejection is the SAME open event the SDK retry path writes', async () => {
    // The acceptance criterion is identity, not similarity: the dashboard's
    // stranded-funds surfaces and `funded_but_unsettled` both key off this
    // exact (event_type, status) pair, so a report that produced a
    // differently-typed row would light nothing up.
    const { agent, paymentId } = await seedFundedX402(1)
    await reportRejected(agent.id, paymentId)

    const rows = await db.query<{ event_type: string; status: string; tx_hash: string }>(
      `SELECT event_type, status, tx_hash FROM machine_payment_reconciliation_events
        WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].event_type).toBe('merchant_retry_rejected_after_payment')
    expect(rows.rows[0].status).toBe('open')
    expect(rows.rows[0].tx_hash).toBe(TX_HASH)
  })

  it('a reported acceptance leaves the grace branch permanently, not just until it elapses', async () => {
    // The other half of the gap: without a success report a DELIVERED payment
    // enters retry_original_x402_request the moment the window passes and
    // tells the agent to retry a merchant that was already paid.
    const { agent, paymentId } = await seedFundedX402(1)
    expect((await reportAccepted(agent.id, paymentId)).statusCode).toBe(202)

    // Age the funding past the grace window — the report must survive it.
    await db.query(
      `UPDATE payment_intents SET confirmed_at = NOW() - interval '60 minutes' WHERE id = $1`,
      [paymentId],
    )
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })

  it('POSITIVE CONTROL: an UNREPORTED payment past the window still reports retry', async () => {
    // Without this, an implementation that marked every payment reported —
    // or every payment failed — would pass every assertion above.
    const { agent, paymentId } = await seedFundedX402(60)
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('funded_but_unsettled')
    expect(status?.next_action).toBe('retry_original_x402_request')
    expect(await countEvents(paymentId)).toBe(0)
  })

  // ── Idempotency and precedence ─────────────────────────────────────────────

  it('repeated rejections do not duplicate the event', async () => {
    const { agent, paymentId } = await seedFundedX402(1)
    await reportRejected(agent.id, paymentId)
    await reportRejected(agent.id, paymentId)
    await reportRejected(agent.id, paymentId)
    expect(await countEvents(paymentId)).toBe(1)
    expect((await getAgentPaymentStatus(agent, paymentId))?.next_action).toBe('sweep_stranded_funds')
  })

  it('repeated acceptances do not duplicate the evidence row or downgrade its proof', async () => {
    const { agent, paymentId } = await seedFundedX402(1)
    await reportAccepted(agent.id, paymentId)
    await reportAccepted(agent.id, paymentId)
    expect(await countEvidence(paymentId)).toBe(1)
    const rows = await db.query<{ proof_status: string }>(
      `SELECT proof_status FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(rows.rows[0].proof_status).toBe('merchant_response_observed')
  })

  it('PRECEDENCE: an acceptance after a rejection resolves it — the merchant was paid after all', async () => {
    const { agent, paymentId } = await seedFundedX402(1)
    await reportRejected(agent.id, paymentId)
    expect((await getAgentPaymentStatus(agent, paymentId))?.next_action).toBe('sweep_stranded_funds')

    await reportAccepted(agent.id, paymentId)
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })

  it('PRECEDENCE: a rejection after an acceptance is REFUSED, not recorded', async () => {
    // The mirror case, and deliberately asymmetric: an acceptance is terminal.
    // Before #2292 this INSERTed a fresh open event and a delivered payment
    // read as stranded — the direction a confused or hostile caller pushes.
    const { agent, paymentId } = await seedFundedX402(1)
    await reportAccepted(agent.id, paymentId)

    const result = await reportRejected(agent.id, paymentId)
    expect(result.statusCode).toBe(409)
    expect(await countEvents(paymentId)).toBe(0)
    expect((await getAgentPaymentStatus(agent, paymentId))?.next_action).toBe('none')
  })

  it('PRECEDENCE: reject → accept → reject stays accepted, matching accept → reject', async () => {
    // The third sequence, which used to give a third answer. All three now
    // agree: once a merchant response is recorded, it stands.
    const { agent, paymentId } = await seedFundedX402(1)
    await reportRejected(agent.id, paymentId)
    await reportAccepted(agent.id, paymentId)
    expect((await reportRejected(agent.id, paymentId)).statusCode).toBe(409)
    expect((await getAgentPaymentStatus(agent, paymentId))?.next_action).toBe('none')
  })

  it('the acceptance-is-terminal guard is scoped to the payment, not the agent', async () => {
    // A delivered payment must not make the agent's NEXT stranded payment
    // unreportable — the guard reads one payment's evidence, not the agent's.
    const { agent, paymentId } = await seedFundedX402(1)
    await reportAccepted(agent.id, paymentId)

    const second = await db.query<{ id: string }>(
      `INSERT INTO payment_intents
         (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
          amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
          status, tx_hash, confirmed_at, expires_at, source, payment_rail,
          x402_resource_url, x402_merchant_address, machine_metadata)
       VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
               '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
               '0x00000000000000000000000000000000000000c1',
               '100000', '0.10', '0x00000000000000000000000000000000000000d1',
               1, '0xsign2', 'confirmed', $3,
               NOW(), NOW() + interval '10 minutes', 'x402', 'x402',
               $4, '0x00000000000000000000000000000000000000c1',
               '{"settlement_scheme":"eip3009"}'::jsonb)
       RETURNING id`,
      [agent.id, agent.user_id, TX_HASH, RESOURCE_URL],
    )
    const result = await reportRejected(agent.id, second.rows[0].id)
    expect(result.statusCode).toBe(202)
    expect(await countEvents(second.rows[0].id)).toBe(1)
  })

  // ── Authorization: evidence, never authority ───────────────────────────────

  it('a foreign agent cannot mark someone else’s payment rejected', async () => {
    const { agent, paymentId } = await seedFundedX402(1)
    const hostileAgentId = await seedForeignAgent()

    const result = await reportRejected(hostileAgentId, paymentId)
    expect(result.statusCode).toBe(404)
    expect(await countEvents(paymentId)).toBe(0)
    expect((await getAgentPaymentStatus(agent, paymentId))?.next_action).toBe('none')
  })

  it('a foreign agent cannot mark someone else’s payment delivered', async () => {
    // The dangerous direction of the same hole: hiding a real stranding.
    const { agent, paymentId } = await seedFundedX402(60)
    const hostileAgentId = await seedForeignAgent()

    const result = await reportAccepted(hostileAgentId, paymentId)
    expect(result.statusCode).toBe(404)
    expect(await countEvidence(paymentId)).toBe(0)
    // The owner still sees the truth.
    expect((await getAgentPaymentStatus(agent, paymentId))?.next_action).toBe(
      'retry_original_x402_request',
    )
  })

  it('neither report changes the intent’s status, amount, recipient or tx', async () => {
    // The whole authorization claim in one assertion: a report is evidence.
    const before = await seedFundedX402(1)
    const snapshot = async () =>
      (
        await db.query(
          `SELECT status, amount_raw, amount_human, to_address, tx_hash, delegate_address
             FROM payment_intents WHERE id = $1`,
          [before.paymentId],
        )
      ).rows[0]
    const original = await snapshot()

    await reportRejected(before.agent.id, before.paymentId)
    expect(await snapshot()).toEqual(original)
    await reportAccepted(before.agent.id, before.paymentId)
    expect(await snapshot()).toEqual(original)
  })
})
