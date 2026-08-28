/**
 * Characterization (#2145): what the status endpoint says about an x402
 * EIP-3009 payment whose funding leg confirmed but whose merchant leg never
 * completed — the crash shape from #2074's class: the agent died between the
 * funding confirmation and the merchant retry.
 *
 * ## Why a real database
 *
 * The claim under test is what `FIND_INTENT_STATUS_ROW_SQL` derives from the
 * `payment_intents` / `machine_payment_evidence` /
 * `machine_payment_reconciliation_events` join — a property of the SQL, which
 * `docs/contributing/testing-strategy.md` (epic #1219) puts on real Postgres
 * by rule. Zero mocks.
 *
 * ## The evidence model these tests encode
 *
 * - The BACKEND writes the evidence base row at funding-confirm time with
 *   `proof_status='payment_confirmed'` (best-effort — the row can be absent).
 * - The CLIENT upgrades `proof_status` to `merchant_response_observed` /
 *   `protocol_receipt_attached` when the merchant retry completes.
 * - The CLIENT writes the open `merchant_retry_rejected_after_payment`
 *   reconciliation event when the merchant retry is REJECTED.
 *
 * So "merchant leg completed" is exactly "an evidence row with an UPGRADED
 * proof_status exists" — the one signal a dead agent's absence cannot fake
 * into a false positive. Its absence (base row or no row at all) means the
 * merchant leg was never reported.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getAgentPaymentStatus } from '../agent-payment-status.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

let seq = 0

interface SeedOptions {
  /** `machine_metadata.settlement_scheme` — `'eip3009'`, `'erc7710'`, or absent. */
  settlementScheme?: string
  /** Minutes ago the funding leg confirmed. */
  confirmedMinutesAgo: number
  /** Insert a `machine_payment_evidence` row with this `proof_status`. */
  evidenceProofStatus?: 'payment_confirmed' | 'merchant_response_observed' | 'protocol_receipt_attached'
  /** Insert an open client-written `merchant_retry_rejected_after_payment` event. */
  merchantRejected?: boolean
}

/** Seed a CONFIRMED x402 intent in the given evidence state. */
async function seedConfirmedX402(opts: SeedOptions): Promise<{ agent: AgentContext; paymentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`funded-unsettled-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'funded unsettled agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const metadata = opts.settlementScheme ? { settlement_scheme: opts.settlementScheme } : {}
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
             0, '0xsign', 'confirmed', '0x' || repeat('ab', 32),
             NOW() - ($3 || ' minutes')::interval,
             NOW() + interval '10 minutes', 'x402', 'x402',
             'https://merchant.example/resource',
             '0x00000000000000000000000000000000000000c1', $4::jsonb)
     RETURNING id`,
    [agentId, userId, String(opts.confirmedMinutesAgo), JSON.stringify(metadata)],
  )
  const paymentId = intent.rows[0].id

  if (opts.evidenceProofStatus) {
    await db.query(
      `INSERT INTO machine_payment_evidence
         (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
          resource_url, payer_address, settlement_address, token_symbol, token_address,
          amount_raw, amount_human)
       VALUES ($1, $2, $3, 'x402', $4, '0x' || repeat('ab', 32), 84532,
               'https://merchant.example/resource',
               '0x00000000000000000000000000000000000000f1',
               '0x00000000000000000000000000000000000000d1',
               'USDC', '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
               '100000', '0.10')`,
      [paymentId, agentId, userId, opts.evidenceProofStatus],
    )
  }
  if (opts.merchantRejected) {
    await db.query(
      `INSERT INTO machine_payment_reconciliation_events
         (payment_intent_id, agent_id, user_id, rail, event_type, status, reason)
       VALUES ($1, $2, $3, 'x402', 'merchant_retry_rejected_after_payment', 'open', 'merchant said no')`,
      [paymentId, agentId, userId],
    )
  }

  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'funded unsettled agent',
      delegate_address: '0x00000000000000000000000000000000000000d1',
      safe_address: '0x00000000000000000000000000000000000000f1',
      chain_id: 84532,
      status: 'active',
    } as AgentContext,
    paymentId,
  }
}

describeDb('#2145 — x402 eip3009 funded-but-undelivered status', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  // ── The crash shape (#2074 class): funded, agent died, merchant never paid ──

  it('CHARACTERIZATION (pre-fix): the crash shape reports next_action none — "The payment is confirmed"', async () => {
    // Funding confirmed an hour ago; no evidence row at all (the best-effort
    // base write also failed), no reconciliation event. This is the exact
    // wrong answer #2145 exists to remove — pinned here so the fix's diff
    // shows the behavioural delta and nothing else.
    const { agent, paymentId } = await seedConfirmedX402({
      settlementScheme: 'eip3009',
      confirmedMinutesAgo: 60,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
    expect(status?.message).toBe('The payment is confirmed.')
  })

  it('CHARACTERIZATION (pre-fix): a base-only evidence row (server-written, never upgraded) also reports none', async () => {
    // The backend wrote the base row at funding confirm; the agent died before
    // the merchant retry, so proof_status was never upgraded.
    const { agent, paymentId } = await seedConfirmedX402({
      settlementScheme: 'eip3009',
      confirmedMinutesAgo: 60,
      evidenceProofStatus: 'payment_confirmed',
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })

  // ── Behaviour that must NOT change with the fix ────────────────────────────

  it('merchant-rejected (client-reported) keeps the sweep override', async () => {
    const { agent, paymentId } = await seedConfirmedX402({
      settlementScheme: 'eip3009',
      confirmedMinutesAgo: 60,
      merchantRejected: true,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('funded_but_unsettled')
    expect(status?.next_action).toBe('sweep_stranded_funds')
  })

  it('a delivered payment (upgraded proof_status) stays confirmed / none', async () => {
    for (const proof of ['merchant_response_observed', 'protocol_receipt_attached'] as const) {
      const { agent, paymentId } = await seedConfirmedX402({
        settlementScheme: 'eip3009',
        confirmedMinutesAgo: 60,
        evidenceProofStatus: proof,
      })
      const status = await getAgentPaymentStatus(agent, paymentId)
      expect(status?.phase).toBe('payment_confirmed')
      expect(status?.next_action).toBe('none')
    }
  })

  it('erc7710 stays confirmed / none — confirmed there IS merchant settlement', async () => {
    const { agent, paymentId } = await seedConfirmedX402({
      settlementScheme: 'erc7710',
      confirmedMinutesAgo: 60,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })

  it('an intent with no settlement_scheme metadata stays confirmed / none (fail closed to current behaviour)', async () => {
    const { agent, paymentId } = await seedConfirmedX402({ confirmedMinutesAgo: 60 })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })

  it('a freshly confirmed payment (inside the grace window) stays confirmed / none', async () => {
    // A live agent is between the funding confirmation and its own merchant
    // retry right now — the status must not instruct a concurrent retry.
    const { agent, paymentId } = await seedConfirmedX402({
      settlementScheme: 'eip3009',
      confirmedMinutesAgo: 1,
    })
    const status = await getAgentPaymentStatus(agent, paymentId)
    expect(status?.phase).toBe('payment_confirmed')
    expect(status?.next_action).toBe('none')
  })
})
