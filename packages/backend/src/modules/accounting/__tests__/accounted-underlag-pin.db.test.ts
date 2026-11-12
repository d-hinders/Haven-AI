/**
 * #4824 on the REAL database: a retry of the same payment, after a lost
 * answer, ends `pushed` with ONE underlag at the provider — whichever of the
 * four mutable render sources was written in between.
 *
 * The measured shape: the first upload succeeds, its answer is lost, something
 * the underlag is rendered from changes, and the retry is refused by the
 * provider as a reuse of the idempotency key with different bytes. The four
 * sources that can move after a payment's first render are:
 *
 *   1. the merchant receipt — the seller block AND the transaction kind;
 *   2. the delivery reference;
 *   3. the purchase group and parent receipt;
 *   4. the catalog country.
 *
 * The remedy (owner decision 2026-11-12) pins the INPUTS at the payment's
 * first render, in `payment_intents.machine_metadata`, and renders every retry
 * from the pin. This suite drives the real orchestrator, the real entry
 * builder, the real renderer and the real connector; only `fetch` (the shared
 * `accounted-test-router`) and the entitlement gate are stubbed.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true) },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { SECRETS_KEY_ENV } from '../../../infra/secrets.js'
import {
  getMerchantInvoiceSyncRef,
  getSyncState,
} from '../../../infra/repositories/accounting-feed-syncs.js'
import { AccountedConnector } from '../accounted-connector.js'
import { accountedIdempotencyKey } from '../accounted-client.js'
import { connectWithApiKey } from '../api-key-flow.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { feedSettledPayment } from '../feed-orchestrator.js'
import { ACCOUNTED } from '../registry.js'
import { accountedRouter, ACCOUNTED_DOCUMENT_ID, ACCOUNTED_MERCHANT_DOCUMENT_ID } from './accounted-test-router.js'

const KEY = randomBytes(32).toString('base64')
const DOC_REF = `accounted:document:${ACCOUNTED_DOCUMENT_ID}`
const INVOICE_REF = `accounted:document:${ACCOUNTED_MERCHANT_DOCUMENT_ID}`
const RESOURCE_URL = 'https://merchant.example/vpn'
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'

/** The merchant's own invoice, in the Swedish bookkeeping shape #3918 reads. */
const RECEIPT = {
  fakturanummer: 'FAK-2026-1791972466377',
  saljare: { name: 'Haven Demo AB', org_nr: '559412-3456', moms_nr: 'SE559412345601' },
}

let seq = 0

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`underlag-pin-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'underlag-pin agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

interface Seeded {
  intentId: string
  evidenceId: string
}

/**
 * One settled payment: a confirmed `erc7710` intent plus its evidence row —
 * the shape `recordMachinePaymentEvidenceBase` writes. `erc7710` settles in
 * one transaction, so the #3767 grace deferral never applies and the push is
 * immediate.
 */
async function seedSettled(userId: string, agentId: string): Promise<Seeded> {
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
             '1000', '0.001', '0x00000000000000000000000000000000000000d1', 0, $7,
             'confirmed', $8, NOW() - interval '5 minutes',
             NOW() + interval '10 minutes', 'x402', 'x402', 'erc7710',
             '{"settlement_scheme":"erc7710"}'::jsonb, $9, $9, $6, $6, $10,
             NOW() - interval '5 minutes')`,
    [
      intentId, agentId, userId, PAYER, TOKEN, MERCHANT,
      `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
      txHash, RESOURCE_URL,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
    ],
  )
  const evidence = await db.query<{ id: string }>(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
        resource_url, payer_address, settlement_address, token_symbol, token_address,
        amount_raw, amount_human, confirmed_at, amount_sek, fx_rates)
     VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, ${CHAIN},
             $5, $6, $7, 'USDC', $8, '1000', '0.001',
             NOW() - interval '5 minutes', '10.42', '{"SEK":10.42}'::jsonb)
     RETURNING id`,
    [intentId, agentId, userId, txHash, RESOURCE_URL, PAYER, MERCHANT, TOKEN],
  )
  return { intentId, evidenceId: evidence.rows[0].id }
}

/** A user with a REAL api-key connection, and the router state its pushes write to. */
async function connectedUser(): Promise<{ userId: string; agentId: string; state: ReturnType<typeof accountedRouter>['state'] }> {
  const { userId, agentId } = await seedUser()
  const { impl, state } = accountedRouter()
  const connector = new AccountedConnector(impl)
  registerConnector(connector)
  await connectWithApiKey({ provider: ACCOUNTED, connector, userId, apiKey: 'gnubo..._pin' })
  // A first connect stamps feed_from = now; the seeded payment settles five
  // minutes ago, so clear the floor exactly as the conformance runner does.
  await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
  return { userId, agentId, state }
}

async function captureReceipt(evidenceId: string, inlineJson: unknown = RECEIPT): Promise<void> {
  await db.query(`INSERT INTO merchant_receipts (evidence_id, inline_json) VALUES ($1, $2::jsonb)`, [
    evidenceId,
    JSON.stringify(inlineJson),
  ])
}

/** A catalog row for the payment's resource URL — the feed's supplier-country source. */
async function seedCatalogCountry(country: string): Promise<void> {
  const merchant = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name) VALUES ($1, 'NordShield VPN') RETURNING id`,
    [`nordshield-${++seq}`],
  )
  await db.query(
    `INSERT INTO merchant_catalog (name, description, category, resource_url, rail, protocol, country, merchant_id)
     VALUES ('NordShield VPN', 'A VPN subscription', 'software', $1, 'x402', 'http', $2, $3)`,
    [RESOURCE_URL, country, merchant.rows[0].id],
  )
}

async function pinOf(intentId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<{ pin: Record<string, unknown> | null }>(
    `SELECT machine_metadata->'accounting_underlag_inputs' AS pin FROM payment_intents WHERE id = $1`,
    [intentId],
  )
  return rows[0]?.pin ?? null
}

/** The underlag uploads only — the merchant invoice has its own key. */
function underlagAttempts(state: ReturnType<typeof accountedRouter>['state'], paymentId: string) {
  const key = accountedIdempotencyKey(paymentId)
  return state.attempts.filter((a) => a.idempotencyKey === key)
}

function underlagCreates(state: ReturnType<typeof accountedRouter>['state'], paymentId: string) {
  const key = accountedIdempotencyKey(paymentId)
  return state.uploads.filter((u) => u.idempotencyKey === key)
}

describeDb('Accounted underlag-input pin (#4824)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    clearConnectors()
    process.env[SECRETS_KEY_ENV] = KEY
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  /**
   * The shared shape of every source case: attempt 1 stores the document and
   * loses the answer, the source is written, attempt 2 must replay the first
   * attempt's bytes and end `pushed`.
   */
  async function lostAnswerThenRetry(
    writeSource: (seeded: Seeded) => Promise<void>,
  ): Promise<{
    userId: string
    seeded: Seeded
    state: ReturnType<typeof accountedRouter>['state']
    paymentId: string
  }> {
    const { userId, agentId, state } = await connectedUser()
    const seeded = await seedSettled(userId, agentId)
    const paymentId = seeded.intentId

    state.loseAnswer = true
    expect(await feedSettledPayment(userId, paymentId)).toMatchObject({ outcome: 'failed' })
    expect((await getSyncState(userId, 'accounted', paymentId))?.status).toBe('failed')
    // The pin was written BEFORE the upload request, so the first attempt's
    // render is reproducible.
    expect(await pinOf(paymentId)).not.toBeNull()

    await writeSource(seeded)
    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })
    return { userId, seeded, state, paymentId }
  }

  it('source 1 — a merchant receipt captured between attempts: the retry replays the first bytes and the invoice follows', async () => {
    const { userId, state, paymentId } = await lostAnswerThenRetry(async (seeded) => {
      await captureReceipt(seeded.evidenceId)
    })

    const row = await getSyncState(userId, 'accounted', paymentId)
    expect(row?.status).toBe('pushed')
    expect(row?.external_ref).toBe(DOC_REF)

    // Exactly one document was created under the underlag key, and the retry
    // uploaded the FIRST attempt's bytes.
    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].sha256).toBe(attempts[0].sha256)
    expect(underlagCreates(state, paymentId)).toHaveLength(1)
    // The pinned render predates the receipt: the seller block is NOT on it.
    expect(attempts[0].bytes.toString('latin1')).not.toContain('Haven Demo AB')

    // The merchant's own invoice is delivered in order, as the second
    // document of the same sync.
    expect(await getMerchantInvoiceSyncRef(userId, 'accounted', paymentId)).toBe(INVOICE_REF)
    const invoiceUploads = state.uploads.filter(
      (u) => u.idempotencyKey === accountedIdempotencyKey(paymentId, 'merchant-invoice'),
    )
    expect(invoiceUploads).toHaveLength(1)
    expect(invoiceUploads[0].bytes.toString('latin1')).toContain('Haven Demo AB')
    // Two documents for the payment: the underlag and the merchant's invoice.
    expect(state.uploads).toHaveLength(2)
  })

  it('source 2 — a delivery reference written between attempts: the retry replays the first bytes', async () => {
    const { userId, state, paymentId } = await lostAnswerThenRetry(async (seeded) => {
      await db.query(`UPDATE machine_payment_evidence SET delivery_reference = $2 WHERE id = $1`, [
        seeded.evidenceId,
        'Bik Bok 5 SEK, order 6ac7',
      ])
    })

    expect((await getSyncState(userId, 'accounted', paymentId))?.status).toBe('pushed')
    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].sha256).toBe(attempts[0].sha256)
    expect(underlagCreates(state, paymentId)).toHaveLength(1)
    // The pin holds the first render's kind, not the delivery-reference one.
    expect((await pinOf(paymentId))?.transactionKind).toBe('unknown')
  })

  it('source 3 — a purchase group and parent receipt written between attempts: the retry replays the first bytes', async () => {
    const { userId, state, paymentId } = await lostAnswerThenRetry(async (seeded) => {
      await db.query(
        `UPDATE machine_payment_evidence SET purchase_group_id = $2, parent_payment_id = $3 WHERE id = $1`,
        [seeded.evidenceId, 'inv_bikbok_4824', randomUUID()],
      )
    })

    expect((await getSyncState(userId, 'accounted', paymentId))?.status).toBe('pushed')
    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].sha256).toBe(attempts[0].sha256)
    expect(underlagCreates(state, paymentId)).toHaveLength(1)
    expect((await pinOf(paymentId))?.purchaseGroupId).toBeNull()
  })

  it('source 4 — a catalog country written between attempts: the retry replays the first bytes', async () => {
    const { userId, state, paymentId } = await lostAnswerThenRetry(async () => {
      await seedCatalogCountry('SE')
    })

    expect((await getSyncState(userId, 'accounted', paymentId))?.status).toBe('pushed')
    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].sha256).toBe(attempts[0].sha256)
    expect(underlagCreates(state, paymentId)).toHaveLength(1)
    expect((await pinOf(paymentId))?.merchantCountry).toBeNull()
  })

  it('CONTROL — a retry with nothing changed in between ends pushed with one document', async () => {
    const { userId, state, paymentId } = await lostAnswerThenRetry(async () => {})

    expect((await getSyncState(userId, 'accounted', paymentId))?.status).toBe('pushed')
    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].sha256).toBe(attempts[0].sha256)
    expect(underlagCreates(state, paymentId)).toHaveLength(1)
  })

  it('a first attempt that failed BEFORE any upload request writes no pin, so the retry renders the current sources', async () => {
    const { userId, agentId, state } = await connectedUser()
    const seeded = await seedSettled(userId, agentId)
    const paymentId = seeded.intentId

    // No company id: the connector returns before the render, so nothing is
    // uploaded and nothing is pinned.
    await db.query(`UPDATE accounting_connections SET external_company_id = NULL WHERE user_id = $1`, [userId])
    expect(await feedSettledPayment(userId, paymentId)).toMatchObject({ outcome: 'skipped' })
    expect((await getSyncState(userId, 'accounted', paymentId))?.status).toBe('skipped')
    expect(await pinOf(paymentId)).toBeNull()
    expect(state.attempts).toHaveLength(0)

    // The receipt arrives, the connection is repaired, and the retry uploads
    // ONCE with whatever the sources hold by then.
    await captureReceipt(seeded.evidenceId)
    await db.query(
      `UPDATE accounting_connections SET external_company_id = '732b80b7-d0f7-45b9-8083-571f8d28d001' WHERE user_id = $1`,
      [userId],
    )
    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })

    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].bytes.toString('latin1')).toContain('Haven Demo AB')
    expect((await pinOf(paymentId))?.merchantReceipt).not.toBeNull()
    expect((await getSyncState(userId, 'accounted', paymentId))?.external_ref).toBe(DOC_REF)
  })

  it('a row already skipped with IDEMPOTENCY_KEY_REUSE at deploy carries no pin and is left as it is', async () => {
    const { userId, agentId, state } = await connectedUser()
    const seeded = await seedSettled(userId, agentId)
    const paymentId = seeded.intentId

    // The pre-deploy shape: the document is at the provider, the row is
    // skipped with the refusal, and no pin exists.
    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })
    await captureReceipt(seeded.evidenceId)
    await db.query(
      `UPDATE payment_intents SET machine_metadata = machine_metadata - 'accounting_underlag_inputs' WHERE id = $1`,
      [paymentId],
    )
    await db.query(
      `UPDATE accounting_feed_syncs
         SET status = 'skipped', external_ref = NULL,
             error = 'IDEMPOTENCY_KEY_REUSE — the document already filed for this payment was uploaded with different bytes; not re-filed'
       WHERE user_id = $1 AND provider = 'accounted' AND payment_id = $2 AND document_kind = 'underlag'`,
      [userId, paymentId],
    )

    // Sync now re-claims it, renders live bytes (the receipt is now present)
    // and the provider refuses again — the row stays skipped.
    expect(await feedSettledPayment(userId, paymentId)).toMatchObject({ outcome: 'skipped' })
    const row = await getSyncState(userId, 'accounted', paymentId)
    expect(row?.status).toBe('skipped')
    expect(row?.error).toContain('IDEMPOTENCY_KEY_REUSE')
    expect(row?.external_ref).toBeNull()
    // Two underlag attempts with DIFFERENT bytes: the first create, then the
    // refused re-render.
    const attempts = underlagAttempts(state, paymentId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].sha256).not.toBe(attempts[0].sha256)
    expect(underlagCreates(state, paymentId)).toHaveLength(1)
  })

  it('REGRESSION (#3918) — a receipt captured BEFORE the first render still puts the seller block on the underlag', async () => {
    const { userId, agentId, state } = await connectedUser()
    const seeded = await seedSettled(userId, agentId)
    await captureReceipt(seeded.evidenceId)
    await seedCatalogCountry('SE')

    expect(await feedSettledPayment(userId, seeded.intentId)).toEqual({ outcome: 'pushed' })
    const attempts = underlagAttempts(state, seeded.intentId)
    expect(attempts).toHaveLength(1)
    const pdf = attempts[0].bytes.toString('latin1')
    expect(pdf).toContain('Haven Demo AB')
    expect(pdf).toContain('VAT reg no     SE559412345601')
    expect(pdf).toContain('Org no         559412-3456')
    expect(pdf).toContain('Country        SE')
    // The receipt also decides the kind (rung 3): an invoice-shaped document
    // is a purchase.
    expect(pdf).toContain('Transaction    purchase')
  })
})
