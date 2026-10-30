/**
 * #4534 on the REAL database: one Bitrefill purchase, three settled payments,
 * one correlation key.
 *
 * The measured production shape (#4497): a BikBok gift-card purchase through
 * Bitrefill's x402 route settled `invoice/create` (0.002 USDC), `invoice/pay`
 * (0.010) and `invoice/status` (0.001) — three payments, three documents, and
 * nothing that said they were one purchase. This suite drives the real
 * evidence rows and the real entry builder:
 *
 * - all three rows end up on ONE `purchase_group_id` (Bitrefill's `invoice_id`);
 * - `parent_payment_id` holds the purchase's receipt (evidence) id — the
 *   `machine_payment_evidence.id` of the `invoice/pay` leg — on both fee legs,
 *   and is null on the purchase itself. It is NOT a payment-intent id (#4577);
 *   the wire names the same value `parent_receipt_id`;
 * - the settlement ORDER does not matter — `invoice/create` settles first, so
 *   its parent is backfilled when `invoice/pay` lands;
 * - an orphan fee payment (no merchant correlation) is still fed, ungrouped,
 *   with both fields null — visible, never dropped;
 * - the feed payload and the receipt PDF carry both fields.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true) },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { recordPurchaseGroup, listReceipts, type MachinePaymentEvidenceSource } from '../../mpp/evidence.js'
import { buildAccountingEntryForPayment } from '../entry.js'
import { toFeedTransaction } from '../feed-transaction.js'
import { underlagFromData } from '../receipt-underlag.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const INVOICE_ID = 'inv_bikbok_4497'

let seq = 0

interface Seeded {
  intentId: string
  evidenceId: string
  source: MachinePaymentEvidenceSource
}

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`purchase-group-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'purchase-group agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/**
 * One settled payment of the purchase: a confirmed intent plus its evidence
 * row, exactly the shape `recordMachinePaymentEvidenceBase` writes.
 */
async function seedSettled(
  userId: string,
  agentId: string,
  resourceUrl: string,
  amountHuman: string,
  settledSecondsAgo: number,
): Promise<Seeded> {
  const intentId = randomUUID()
  const txHash = `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66)
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash,
        confirmed_at, expires_at, source, payment_rail, execution_rail,
        machine_metadata, x402_resource_url, payment_resource_url, merchant_address,
        x402_merchant_address, delegation_hash, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6,
             $7, $8, '0x00000000000000000000000000000000000000d1', 0, $9,
             'confirmed', $10, NOW() - ($11 * interval '1 second'),
             NOW() + interval '10 minutes', 'x402', 'x402', 'erc7710',
             '{"settlement_scheme":"erc7710"}'::jsonb, $12, $12, $6, $6, $13,
             NOW() - ($11 * interval '1 second'))`,
    [
      intentId, agentId, userId, PAYER, TOKEN, MERCHANT,
      String(Math.round(Number(amountHuman) * 1_000_000)), amountHuman,
      `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
      txHash, settledSecondsAgo, resourceUrl,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
    ],
  )
  const evidence = await db.query<{ id: string }>(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
        resource_url, payer_address, settlement_address, token_symbol, token_address,
        amount_raw, amount_human, confirmed_at, amount_sek, fx_rates)
     VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, ${CHAIN},
             $5, $6, $7, 'USDC', $8, $9, $10,
             NOW() - ($11 * interval '1 second'), '10.42', '{"SEK":10.42}'::jsonb)
     RETURNING id`,
    [
      intentId, agentId, userId, txHash, resourceUrl, PAYER, MERCHANT, TOKEN,
      String(Math.round(Number(amountHuman) * 1_000_000)), amountHuman, settledSecondsAgo,
    ],
  )
  return {
    intentId,
    evidenceId: evidence.rows[0].id,
    source: {
      id: intentId,
      kind: 'payment_intent',
      agent_id: agentId,
      user_id: userId,
      account_address: PAYER,
      chain_id: CHAIN,
      token_symbol: 'USDC',
      token_address: TOKEN,
      to_address: MERCHANT,
      amount_raw: String(Math.round(Number(amountHuman) * 1_000_000)),
      amount_human: amountHuman,
      tx_hash: txHash,
      status: 'confirmed',
      source: 'x402',
      payment_rail: 'x402',
      payment_resource_url: resourceUrl,
      x402_resource_url: null,
      merchant_address: MERCHANT,
      x402_merchant_address: null,
      machine_challenge_id: null,
      machine_idempotency_key: null,
      x402_idempotency_key: null,
      machine_metadata: null,
      confirmed_at: null,
    },
  }
}

async function groupRow(evidenceId: string): Promise<{ purchase_group_id: string | null; parent_payment_id: string | null }> {
  const r = await db.query<{ purchase_group_id: string | null; parent_payment_id: string | null }>(
    `SELECT purchase_group_id, parent_payment_id FROM machine_payment_evidence WHERE id = $1`,
    [evidenceId],
  )
  return r.rows[0]
}

describeDb('purchase correlation key (#4534)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pins the three Bitrefill routes to one group, with the fee legs pointing at invoice/pay', async () => {
    const { userId, agentId } = await seedUser()
    // Settlement order is the production order: create, then pay, then status.
    const create = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/create', '0.002', 300)
    const pay = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/pay', '0.010', 240)
    const status = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/status', '0.001', 180)

    // Each report carries the merchant's own paid response body.
    await recordPurchaseGroup(create.source, {
      agentId,
      merchantResponse: { invoice_id: INVOICE_ID, status: 'unpaid' },
    })
    await recordPurchaseGroup(pay.source, {
      agentId,
      merchantResponse: { invoice_id: INVOICE_ID, status: 'paid' },
    })
    await recordPurchaseGroup(status.source, {
      agentId,
      merchantResponse: { invoice_id: INVOICE_ID, status: 'paid' },
    })

    // One group id across all three documents.
    for (const seeded of [create, pay, status]) {
      expect((await groupRow(seeded.evidenceId)).purchase_group_id).toBe(INVOICE_ID)
    }

    // The purchase leg has no parent; both fee legs point at it — including
    // `invoice/create`, which settled BEFORE the purchase and was backfilled.
    expect((await groupRow(pay.evidenceId)).parent_payment_id).toBeNull()
    expect((await groupRow(create.evidenceId)).parent_payment_id).toBe(pay.evidenceId)
    expect((await groupRow(status.evidenceId)).parent_payment_id).toBe(pay.evidenceId)

    // The feed payload carries both fields, and the receipt renders the group
    // id so a human can match the documents by eye.
    const createEntry = await buildAccountingEntryForPayment(userId, create.intentId)
    expect(createEntry).not.toBeNull()
    expect(createEntry!.purchaseGroupId).toBe(INVOICE_ID)
    expect(createEntry!.parentReceiptRef).toBe(pay.evidenceId)

    const tx = toFeedTransaction(createEntry!, { ledgerCurrency: 'SEK' })
    expect(tx.purchaseGroupId).toBe(INVOICE_ID)
    expect(tx.parentReceiptRef).toBe(pay.evidenceId)

    const pdf = underlagFromData({
      paymentId: tx.paymentId,
      settledAt: tx.settledAt,
      token: tx.token,
      amountAtomic: tx.amountAtomic,
      amount: tx.amount,
      amountSek: tx.amountSek,
      fxRate: tx.fxRate,
      fxSource: tx.fxSource,
      fxAt: tx.fxAt,
      amountLedger: tx.amountLedger,
      ledgerCurrency: tx.ledgerCurrency,
      fxRateLedger: tx.fxRateLedger,
      merchantName: tx.counterparty.name,
      merchantAddress: tx.counterparty.address,
      merchantCountry: tx.counterparty.country,
      merchantVatNo: null,
      merchantOrgNo: null,
      resourceUrl: tx.resourceUrl,
      // #4532 (dev): the kind and its line, carried by the same feed payload.
      transactionKind: tx.transactionKind,
      description: tx.description,
      purchaseGroupId: tx.purchaseGroupId,
      parentReceiptRef: tx.parentReceiptRef,
      // #4577: this document's own evidence id, printed as `Receipt ref`.
      receiptRef: tx.receiptRef,
      chainId: createEntry!.chainId,
      txHash: tx.txHash,
      txHashIsFunding: tx.txHashIsFunding,
      fundingTxHash: tx.fundingTxHash,
      delegate: null,
      signHash: null,
      signature: null,
    }).pdf.toString('latin1')
    expect(pdf).toContain(`Purchase group ${INVOICE_ID}`)
    // #4577: the parent is named for what it holds — a receipt id — and the
    // document prints its OWN evidence id so the two documents join by eye.
    expect(pdf).toContain(`Parent receipt ${pay.evidenceId}`)
    expect(pdf).toContain(`Receipt ref    ${create.evidenceId}`)
    expect(pdf).not.toContain('Parent payment')
  })

  /**
   * #4577: the correlation value is a RECEIPT id, so it must JOIN — on the feed
   * payload and on the receipts wire alike. Before this the field was named
   * `parentPaymentId` beside a `paymentId` that is a payment-intent id, so a
   * join on the two names found nothing. This test goes red if
   * `parent_receipt_id` is removed from `mapEvidence`, or if the internal
   * `parentReceiptRef` stops carrying the purchase leg's `receiptRef`.
   */
  it('joins a fee leg to its purchase leg by receipt id, on the feed and on the receipts wire (#4577)', async () => {
    const { userId, agentId } = await seedUser()
    const create = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/create', '0.002', 300)
    const pay = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/pay', '0.010', 240)
    const status = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/status', '0.001', 180)

    for (const seeded of [create, pay, status]) {
      await recordPurchaseGroup(seeded.source, {
        agentId,
        merchantResponse: { invoice_id: INVOICE_ID, status: 'paid' },
      })
    }

    // The purchase leg's own receipt id — what every fee leg must point at.
    const payEntry = await buildAccountingEntryForPayment(userId, pay.intentId)
    expect(payEntry).not.toBeNull()
    const purchaseReceiptRef = payEntry!.receiptRef
    expect(purchaseReceiptRef).toBe(pay.evidenceId)

    // Feed payload: each fee leg's `parentReceiptRef` IS the purchase leg's
    // `receiptRef` — the join the field exists for.
    for (const fee of [create, status]) {
      const entry = await buildAccountingEntryForPayment(userId, fee.intentId)
      expect(entry).not.toBeNull()
      const tx = toFeedTransaction(entry!, { ledgerCurrency: 'SEK' })
      expect(tx.parentReceiptRef).toBe(purchaseReceiptRef)
      // And the fee's own ref is its own evidence row, not the parent's.
      expect(tx.receiptRef).toBe(fee.evidenceId)
    }

    // Receipts wire: `parent_receipt_id` equals the purchase receipt's `id`,
    // and the deprecated alias carries the same value.
    const page = await listReceipts(agentId, 10)
    expect(page).not.toBeNull()
    const byId = new Map(page!.receipts.map((r) => [r.id, r]))
    const purchaseReceipt = byId.get(pay.evidenceId)
    expect(purchaseReceipt).toBeDefined()
    expect(purchaseReceipt!.parent_receipt_id).toBeNull()

    for (const fee of [create, status]) {
      const receipt = byId.get(fee.evidenceId)
      expect(receipt).toBeDefined()
      expect(receipt!.parent_receipt_id).toBe(purchaseReceipt!.id)
      expect(receipt!.parent_payment_id).toBe(receipt!.parent_receipt_id)
    }
  })

  it('feeds an orphan fee payment ungrouped — visible, never dropped', async () => {
    const { userId, agentId } = await seedUser()
    const orphan = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/status', '0.001', 120)

    // No merchant response, no agent-supplied key: nothing to correlate.
    await recordPurchaseGroup(orphan.source, { agentId })

    const row = await groupRow(orphan.evidenceId)
    expect(row.purchase_group_id).toBeNull()
    expect(row.parent_payment_id).toBeNull()

    // Still fed: one document per settled payment, exactly as before.
    const entry = await buildAccountingEntryForPayment(userId, orphan.intentId)
    expect(entry).not.toBeNull()
    expect(entry!.purchaseGroupId).toBeNull()
    expect(entry!.parentReceiptRef).toBeNull()

    const tx = toFeedTransaction(entry!, { ledgerCurrency: 'SEK' })
    expect(tx.purchaseGroupId).toBeNull()
    expect(tx.parentReceiptRef).toBeNull()

    const pdf = underlagFromData({
      paymentId: tx.paymentId,
      settledAt: tx.settledAt,
      token: tx.token,
      amountAtomic: tx.amountAtomic,
      amount: tx.amount,
      amountSek: tx.amountSek,
      fxRate: tx.fxRate,
      fxSource: tx.fxSource,
      fxAt: tx.fxAt,
      amountLedger: tx.amountLedger,
      ledgerCurrency: tx.ledgerCurrency,
      fxRateLedger: tx.fxRateLedger,
      merchantName: tx.counterparty.name,
      merchantAddress: tx.counterparty.address,
      merchantCountry: tx.counterparty.country,
      merchantVatNo: null,
      merchantOrgNo: null,
      resourceUrl: tx.resourceUrl,
      // #4532 (dev): the kind and its line, carried by the same feed payload.
      transactionKind: tx.transactionKind,
      description: tx.description,
      purchaseGroupId: tx.purchaseGroupId,
      parentReceiptRef: tx.parentReceiptRef,
      // #4577: this document's own evidence id, printed as `Receipt ref`.
      receiptRef: tx.receiptRef,
      chainId: entry!.chainId,
      txHash: tx.txHash,
      txHashIsFunding: tx.txHashIsFunding,
      fundingTxHash: tx.fundingTxHash,
      delegate: null,
      signHash: null,
      signature: null,
    }).pdf.toString('latin1')
    expect(pdf).toContain('Purchase group ungrouped')
    expect(pdf).toContain('Parent receipt n/a')
    expect(pdf).not.toContain('Parent payment')
  })

  it('uses an agent-supplied group key when the merchant supplies none', async () => {
    const { userId, agentId } = await seedUser()
    const a = await seedSettled(userId, agentId, 'https://api.other-merchant.com/x402/order/pay', '0.5', 200)
    const b = await seedSettled(userId, agentId, 'https://api.other-merchant.com/x402/order/status', '0.01', 150)

    await recordPurchaseGroup(a.source, { agentId, purchaseGroupId: 'agent-purchase-1' })
    await recordPurchaseGroup(b.source, { agentId, purchaseGroupId: 'agent-purchase-1' })

    expect((await groupRow(a.evidenceId)).purchase_group_id).toBe('agent-purchase-1')
    expect((await groupRow(b.evidenceId)).purchase_group_id).toBe('agent-purchase-1')
    // The merchant's route is not in the map, so the purchase leg cannot be
    // named — the parent stays null rather than guessed.
    expect((await groupRow(a.evidenceId)).parent_payment_id).toBeNull()
    expect((await groupRow(b.evidenceId)).parent_payment_id).toBeNull()
  })

  it('never rewrites a recorded group on a later report (first write wins)', async () => {
    const { userId, agentId } = await seedUser()
    const pay = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/pay', '0.010', 100)

    await recordPurchaseGroup(pay.source, { agentId, merchantResponse: { invoice_id: INVOICE_ID } })
    await recordPurchaseGroup(pay.source, { agentId, purchaseGroupId: 'a-different-key' })

    expect((await groupRow(pay.evidenceId)).purchase_group_id).toBe(INVOICE_ID)
  })

  it('leaves a member whose route the map does not recognise unlinked', async () => {
    const { userId, agentId } = await seedUser()
    const create = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/create', '0.002', 300)
    const pay = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/pay', '0.010', 240)
    // A route the merchant map does not classify: it groups (the merchant's own
    // id is on the body) but its leg is unknown, so it is never guessed a fee.
    const refund = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/refund', '0.001', 180)

    for (const seeded of [create, pay, refund]) {
      await recordPurchaseGroup(seeded.source, { agentId, merchantResponse: { invoice_id: INVOICE_ID } })
    }

    expect((await groupRow(refund.evidenceId)).purchase_group_id).toBe(INVOICE_ID)
    expect((await groupRow(refund.evidenceId)).parent_payment_id).toBeNull()
    // The recognised fee leg is still linked.
    expect((await groupRow(create.evidenceId)).parent_payment_id).toBe(pay.evidenceId)
  })

  it('never makes a second purchase leg a child of the first', async () => {
    const { userId, agentId } = await seedUser()
    const create = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/create', '0.002', 300)
    const payFirst = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/pay', '0.010', 240)
    // A retried `invoice/pay` for the same invoice: a second purchase leg.
    const payRetry = await seedSettled(userId, agentId, 'https://api.bitrefill.com/x402/invoice/pay', '0.010', 180)

    for (const seeded of [create, payFirst, payRetry]) {
      await recordPurchaseGroup(seeded.source, { agentId, merchantResponse: { invoice_id: INVOICE_ID } })
    }

    // A purchase's parent is null by definition — neither pay leg is a child.
    expect((await groupRow(payFirst.evidenceId)).parent_payment_id).toBeNull()
    expect((await groupRow(payRetry.evidenceId)).parent_payment_id).toBeNull()
    // The fee leg keeps the FIRST purchase leg it was linked to.
    expect((await groupRow(create.evidenceId)).parent_payment_id).toBe(payFirst.evidenceId)
  })
})
