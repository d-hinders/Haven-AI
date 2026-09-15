/**
 * Real-DB test for #2998: the receipts list names the two hashes a receipt
 * can carry (`funding_tx_hash` / `settlement_tx_hash`), additive alongside
 * the deprecated `tx_hash`. Exercises `listReceipts` end to end — the real
 * `LIST_EVIDENCE_RECEIPTS_SQL` join plus `mapEvidence`'s derivation — on the
 * #1220 harness, zero mocks.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  attachEvidenceProof,
  upsertEvidenceBase,
  type EvidenceBaseInput,
} from '../../../infra/repositories/machine-payments.js'
import { listReceipts } from '../evidence.js'

let seq = 0
const ADDR = (n: string) => `0x${n.repeat(40).slice(0, 40)}`

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rtxn-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'machine agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

async function seedIntent(
  agentId: string,
  userId: string,
  settlementScheme: 'eip3009' | 'erc7710',
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, payment_rail, machine_metadata)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '100000', '0.10', $6, 1, $7,
             'confirmed', NOW() + interval '10 minutes', 'mpp', $8::jsonb)
     RETURNING id`,
    [
      agentId,
      userId,
      ADDR('f1'),
      ADDR('0e'),
      ADDR('aa'),
      ADDR('d1'),
      `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66),
      JSON.stringify({ settlement_scheme: settlementScheme }),
    ],
  )
  return r.rows[0].id
}

function evidenceInput(
  agent: { agentId: string; userId: string },
  overrides: Partial<EvidenceBaseInput> = {},
): EvidenceBaseInput {
  return {
    paymentIntentId: null,
    approvalRequestId: null,
    agentId: agent.agentId,
    userId: agent.userId,
    rail: 'x402',
    txHash: `0x${'a'.repeat(64)}`,
    chainId: 8453,
    resourceUrl: 'https://merchant.example/r',
    merchantAddress: ADDR('cc'),
    payerAddress: ADDR('f1'),
    settlementAddress: ADDR('aa'),
    tokenSymbol: 'USDC',
    tokenAddress: ADDR('0e'),
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
    fxRates: null,
    ...overrides,
  }
}

describeDb('receipts name funding_tx_hash / settlement_tx_hash (#2998)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('eip3009 with a merchant settlement: funding is tx_hash, settlement is the payload transaction', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId, 'eip3009')
    const fundingHash = `0x${'11'.repeat(32)}`
    const settlementHash = `0x${'22'.repeat(32)}`

    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId, txHash: fundingHash }))
    await attachEvidenceProof({
      paymentId: intentId,
      agentId: agent.agentId,
      proofStatus: 'protocol_receipt_attached',
      challengePayload: null,
      selectedPayment: null,
      paymentProofHeaderName: 'X-PAYMENT',
      paymentProofHeader: 'proof-1',
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
      protocolReceiptHeader: 'receipt-1',
      protocolReceiptPayload: JSON.stringify({ transaction: settlementHash }),
      merchantStatus: 200,
    })

    const [receipt] = await listReceipts(agent.agentId, 10)
    expect(receipt.tx_hash).toBe(fundingHash)
    expect(receipt.funding_tx_hash).toBe(fundingHash)
    expect(receipt.settlement_tx_hash).toBe(settlementHash)
  })

  it('eip3009 without a merchant settlement: funding is tx_hash, settlement is null', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId, 'eip3009')
    const fundingHash = `0x${'33'.repeat(32)}`

    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId, txHash: fundingHash }))

    const [receipt] = await listReceipts(agent.agentId, 10)
    expect(receipt.tx_hash).toBe(fundingHash)
    expect(receipt.funding_tx_hash).toBe(fundingHash)
    expect(receipt.settlement_tx_hash).toBeNull()
  })

  it('eip3009 with the demo merchant\'s zero-hash marker: settlement stays null, not a fake hash', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId, 'eip3009')
    const fundingHash = `0x${'44'.repeat(32)}`
    const zeroHash = `0x${'0'.repeat(64)}`

    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId, txHash: fundingHash }))
    await attachEvidenceProof({
      paymentId: intentId,
      agentId: agent.agentId,
      proofStatus: 'protocol_receipt_attached',
      challengePayload: null,
      selectedPayment: null,
      paymentProofHeaderName: 'X-PAYMENT',
      paymentProofHeader: 'proof-1',
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
      protocolReceiptHeader: 'receipt-1',
      protocolReceiptPayload: JSON.stringify({ transaction: zeroHash }),
      merchantStatus: 200,
    })

    const [receipt] = await listReceipts(agent.agentId, 10)
    expect(receipt.funding_tx_hash).toBe(fundingHash)
    expect(receipt.settlement_tx_hash).toBeNull()
  })

  it('erc7710: one transaction, tx_hash IS the settlement, no funding leg', async () => {
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId, 'erc7710')
    const settleHash = `0x${'55'.repeat(32)}`

    await upsertEvidenceBase(evidenceInput(agent, { paymentIntentId: intentId, txHash: settleHash }))

    const [receipt] = await listReceipts(agent.agentId, 10)
    expect(receipt.tx_hash).toBe(settleHash)
    expect(receipt.funding_tx_hash).toBeNull()
    expect(receipt.settlement_tx_hash).toBe(settleHash)
  })
})
