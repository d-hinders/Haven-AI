/**
 * #3778 — the optional `delivery_reference` on the evidence attach, on real
 * Postgres.
 *
 * The claim is end-to-end shaped: a value the agent reports with an ACCEPTED
 * x402 outcome lands on the `machine_payment_evidence` row (migration 107)
 * and comes back on the receipt read (`GET /machine-payments/receipts` /
 * `listReceipts`), while a value shaped like a credential — the acceptance
 * criterion's code-shaped case — is refused 400 with nothing written. Through
 * `attachEvidenceHandler` / `listReceipts` rather than raw INSERTs so the
 * entry points the hosted tools and the dashboard actually call are the
 * things under test, per `docs/contributing/testing-strategy.md` (epic #1219).
 *
 * The seed is the same confirmed-eip3009 shape the #2292 sibling file uses;
 * nothing here disturbs its pins.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { attachEvidenceHandler, listReceipts } from '../evidence.js'
import type { AgentContext } from '../../../middleware/agentAuth.js'

let seq = 0

const TX_HASH = '0x' + 'cd'.repeat(32)
const RESOURCE_URL = 'https://merchant.example/gift-card'

interface Seeded {
  agent: AgentContext
  paymentId: string
}

async function seedFundedX402(): Promise<Seeded> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`delivery-ref-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'delivery agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f2', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c2',
             '50000', '0.05', '0x00000000000000000000000000000000000000d2',
             0, '0xsign', 'confirmed', $3,
             NOW() - interval '1 minute',
             NOW() + interval '10 minutes', 'x402', 'x402',
             $4, '0x00000000000000000000000000000000000000c2',
             '{"settlement_scheme":"eip3009"}'::jsonb)
     RETURNING id`,
    [agentId, userId, TX_HASH, RESOURCE_URL],
  )
  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'delivery agent',
      delegate_address: '0x00000000000000000000000000000000000000d2',
      account_address: '0x00000000000000000000000000000000000000f2',
      chain_id: 84532,
      status: 'active',
    } as AgentContext,
    paymentId: intent.rows[0].id,
  }
}

describeDb('#3778 — delivery_reference on the evidence attach', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('an honest reference is recorded and echoed on the receipts read', async () => {
    const { agent, paymentId } = await seedFundedX402()

    const result = await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
      deliveryReference: 'Bik Bok 5 SEK, order 6ac7',
    })
    expect(result.statusCode).toBe(202)

    // The attach echo carries it…
    const echo = result.body as { evidence: { delivery_reference: string | null } }
    expect(echo.evidence.delivery_reference).toBe('Bik Bok 5 SEK, order 6ac7')

    // …and so does the receipt the agent (and the owner via the dashboard) reads.
    const page = await listReceipts(agent.id, 10)
    expect(page).not.toBeNull()
    expect(page!.receipts).toHaveLength(1)
    expect(page!.receipts[0]!.delivery_reference).toBe('Bik Bok 5 SEK, order 6ac7')

    // The column is bounded at 512 — migration 107 and the contracts agree.
    const column = await db.query<{ character_maximum_length: number }>(
      `SELECT character_maximum_length FROM information_schema.columns
        WHERE table_name = 'machine_payment_evidence' AND column_name = 'delivery_reference'`,
    )
    expect(column.rows[0]?.character_maximum_length).toBe(512)
  })

  it('a code-shaped value is refused 400 and nothing is written', async () => {
    const { agent, paymentId } = await seedFundedX402()

    const result = await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
      // The acceptance criterion's code-shaped case: dense mixed-case token
      // material — what a redemption code looks like, not a reference.
      deliveryReference: 'aB3xK9mQ2pL7vR4t',
    })
    expect(result.statusCode).toBe(400)
    expect((result.body as { error: string }).error).toMatch(/shaped like a credential/)

    const rows = await db.query<{ delivery_reference: string | null }>(
      `SELECT delivery_reference FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    // No evidence row at all — the refusal is pre-write, not a write that
    // omits the field.
    expect(rows.rows).toHaveLength(0)
  })

  it('a grouped uppercase gift-card code is refused the same way', async () => {
    const { agent, paymentId } = await seedFundedX402()

    const result = await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
      deliveryReference: 'GRBQ-KX4M-9P2T-7WZC',
    })
    expect(result.statusCode).toBe(400)

    const rows = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(Number(rows.rows[0].n)).toBe(0)
  })

  it('an over-length reference is refused before the write', async () => {
    const { agent, paymentId } = await seedFundedX402()

    const result = await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
      deliveryReference: 'x'.repeat(513),
    })
    expect(result.statusCode).toBe(400)
    expect((result.body as { error: string }).error).toMatch(/refused/)

    const rows = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(Number(rows.rows[0].n)).toBe(0)
  })

  it('an omitted reference is null — the normal case is unchanged', async () => {
    const { agent, paymentId } = await seedFundedX402()

    const result = await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
    })
    expect(result.statusCode).toBe(202)

    const page = await listReceipts(agent.id, 10)
    expect(page!.receipts[0]!.delivery_reference).toBeNull()
  })

  it('a re-attach without a reference never clears a recorded one', async () => {
    const { agent, paymentId } = await seedFundedX402()

    await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
      deliveryReference: 'Bik Bok 5 SEK, order 6ac7',
    })
    await attachEvidenceHandler(agent.id, {
      paymentId,
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
    })

    const page = await listReceipts(agent.id, 10)
    expect(page!.receipts[0]!.delivery_reference).toBe('Bik Bok 5 SEK, order 6ac7')
  })
})
