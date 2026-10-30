/**
 * #4533: a settled DIRECT payment produces an accounting underlag — and only
 * when it leaves the user's own Haven footprint.
 *
 * The bug this pins is a source gap, not a feed bug: the feed has only ever
 * enumerated `machine_payment_evidence`, and a direct payment (`haven_send`,
 * the delegation-redemption rail behind `POST /payments`) never gets an
 * evidence row — `recordMachinePaymentEvidenceBase` refuses it on the rail
 * gate and, past that, on `resource_url NOT NULL`. So the one route that
 * rescues a broken x402 merchant left no accounting record at all.
 *
 * Real Postgres and the REAL feed path: the real `buildAccountingEntryForPayment`
 * (both sources), the real `claimSync`/`markPushed` dedup ledger, the real
 * backfill selection, and the real receipt-underlag loader. Only two things are
 * stubbed — the hosted entitlement gate (a config surface, not behaviour under
 * test) and the accounting connector (an external system this suite does not
 * own).
 *
 * The owner decision (Daniel, 2026-10-29) is asserted as a NEGATIVE CONTROL:
 * a transfer to the user's own smart account, and one to their agent's
 * delegate address, must produce no sync row and no document. Without that
 * half, a filter that fed everything would pass every positive case here.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const { accountingFeedAvailable } = vi.hoisted(() => ({
  accountingFeedAvailable: vi.fn(async () => true),
}))

vi.mock('../../agents/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/index.js')>()),
  accountingFeedAvailable,
}))

// The evidence writer captures book-time FX through the price source. Stub it
// (the same seam `feed-rail-parity.test.ts` stubs) so the x402 half of this
// suite never dials CoinGecko — and so its evidence row is FX-ready.
vi.mock('../../../infra/prices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/prices.js')>()),
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10 }),
}))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { clearConnectors, InMemoryConnector, registerConnector } from '../connector.js'
import { feedSettledPayment, feedSettledPaymentBestEffort, syncUser } from '../feed-orchestrator.js'
import { buildAccountingEntryForPayment } from '../entry.js'
import { loadReceiptUnderlag } from '../receipt-underlag.js'
import { listUnpushedPaymentIds } from '../../../infra/repositories/accounting-feed-syncs.js'
import { recordMachinePaymentEvidenceBaseById } from '../../mpp/evidence.js'

const CHAIN = 8453
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** The user's own smart account — a transfer here is an internal move. */
const OWN_ACCOUNT = '0x135a9215604711AC70d970e12Caa812c53537EF4'
/** The user's agent's delegate address — a sweep back here is an internal move. */
const OWN_DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
/** A third-party address (a contact, a merchant's deposit address). */
const OUTSIDE = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const RESOURCE = 'https://merchant.example/paid'
const TX_HASH = `0x${'cd'.repeat(32)}`
const SIGN_HASH = `0x${'11'.repeat(32)}`
const SIGNATURE = `0x${'ab'.repeat(65)}`

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`direct-feed-${++seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address) VALUES ($1, 'direct agent', $2) RETURNING id`,
    [userId, OWN_DELEGATE],
  )
  return rows[0].id
}

async function seedOwnAccount(userId: string): Promise<void> {
  await db.query(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid')`,
    [userId, OWN_ACCOUNT, CHAIN],
  )
}

interface SeedIntentOptions {
  userId: string
  agentId: string
  to: string
  /** `direct` leaves `payment_rail` NULL, exactly as `insertDelegationIntent` does. */
  rail?: 'direct' | 'x402'
  status?: string
  txHash?: string | null
  confirmedAt?: string | null
  sekValue?: string | null
  usdValue?: string | null
  eurValue?: string | null
}

async function seedIntent(opts: SeedIntentOptions): Promise<string> {
  const id = randomUUID()
  const rail = opts.rail ?? 'direct'
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, signature,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail, execution_rail,
        payment_resource_url, x402_resource_url, merchant_address,
        usd_value, eur_value, sek_value)
     VALUES ($1, $2, $3, $4, $5, 'USDC', $6, $7,
             '10000', '0.01', $8, 0, $9, $10,
             $11, $12, $13, NOW() + interval '10 minutes', $14, $15, 'delegation',
             $16, $16, $17,
             $18, $19, $20)`,
    [
      id,
      opts.agentId,
      opts.userId,
      OWN_ACCOUNT,
      CHAIN,
      TOKEN,
      opts.to,
      OWN_DELEGATE,
      SIGN_HASH,
      SIGNATURE,
      opts.status ?? 'confirmed',
      opts.txHash === undefined ? TX_HASH : opts.txHash,
      opts.confirmedAt === undefined ? new Date().toISOString() : opts.confirmedAt,
      rail,
      rail === 'x402' ? 'x402' : null,
      rail === 'x402' ? RESOURCE : null,
      rail === 'x402' ? MERCHANT : null,
      opts.usdValue === undefined ? '0.01' : opts.usdValue,
      opts.eurValue === undefined ? '0.0092' : opts.eurValue,
      opts.sekValue === undefined ? '0.1042' : opts.sekValue,
    ],
  )
  return id
}

const readSyncs = async (userId: string) =>
  (
    await db.query<{ payment_id: string; status: string; external_ref: string | null }>(
      `SELECT payment_id, status, external_ref FROM accounting_feed_syncs WHERE user_id = $1 ORDER BY payment_id`,
      [userId],
    )
  ).rows

describeDb('direct payments produce an accounting underlag (#4533)', () => {
  let connector: InMemoryConnector

  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    clearConnectors()
    connector = new InMemoryConnector()
    registerConnector(connector)
    accountingFeedAvailable.mockReset().mockResolvedValue(true)
  })

  it('AC 1: an outside direct payment settles → one sync row and one document', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    const id = await seedIntent({ userId, agentId, to: OUTSIDE })
    connector.connect(userId)

    // The entry is built from `payment_intents` — no evidence row exists.
    const entry = await buildAccountingEntryForPayment(userId, id)
    expect(entry).not.toBeNull()
    expect(entry!.paymentId).toBe(id)
    expect(entry!.txHash).toBe(TX_HASH)
    expect(entry!.counterparty.address).toBe(OUTSIDE)
    expect(entry!.resourceUrl).toBeNull()
    expect(entry!.amountSek).toBe('0.1042')
    // #4578: a direct payment is a transfer, labelled with its counterparty's
    // canonical address — not `Unknown merchant (unclassified)`.
    expect(entry!.transactionKind).toBe('transfer')
    expect(entry!.transactionDescription).toBe(`${OUTSIDE} (transfer)`)
    // The book-time capture on the intent is recovered as a rate map, so a
    // non-SEK ledger can book this payment exactly as it books an x402 one.
    expect(entry!.fxRates?.SEK).toBeCloseTo(10.42, 6)
    expect(entry!.fxRates?.USD).toBeCloseTo(1, 6)
    expect(entry!.fxRates?.EUR).toBeCloseTo(0.92, 6)

    expect(await feedSettledPayment(userId, id)).toEqual({ outcome: 'pushed' })

    const rows = await readSyncs(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ payment_id: id, status: 'pushed' })
    expect(rows[0].external_ref).not.toBeNull()

    expect(connector.pushed).toHaveLength(1)
    const tx = connector.pushed[0].tx
    expect(tx.paymentId).toBe(id)
    expect(tx.counterparty.address).toBe(OUTSIDE)
    expect(tx.resourceUrl).toBeNull()
    expect(tx.amountLedger).toBe('0.1042')
    // The feed payload carries the same two values as the document, so the
    // payload and the attachment cannot disagree (#4532/#4578).
    expect(tx.transactionKind).toBe('transfer')
    expect(tx.description).toBe(`${OUTSIDE} (transfer)`)

    // The receipt renders a TRANSFER: the recipient as counterparty, and no
    // Resource line at all (a direct payment buys no resource).
    const underlag = await loadReceiptUnderlag(userId, tx)
    expect(underlag).not.toBeNull()
    const pdf = underlag!.pdf.toString('latin1')
    expect(pdf).toContain(OUTSIDE)
    expect(pdf).toContain('Counterparty')
    // The PDF's own object dictionary carries `/Resources`; the assertion is
    // about the RENDERED line, which starts with `(Resource`.
    expect(pdf).not.toContain('(Resource')
    expect(pdf).toContain(TX_HASH)
    // #4578: the rendered document says WHAT it is. Before this the line read
    // `Transaction    unknown` / `Description    Unknown merchant
    // (unclassified)` for every direct payment. Parens are PDF-escaped in the
    // content stream (see pdfEscape), as at receipt-underlag.test.ts:158.
    expect(pdf).toContain('Transaction    transfer')
    expect(pdf).toContain(`Description    ${OUTSIDE} \\(transfer\\)`)
  })

  it('AC 4: firing the hook twice still leaves exactly one row and one document', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    const id = await seedIntent({ userId, agentId, to: OUTSIDE })
    connector.connect(userId)

    // The settlement path's own call — fire-and-forget, so wait for it.
    feedSettledPaymentBestEffort(userId, id)
    feedSettledPaymentBestEffort(userId, id)
    for (let attempt = 0; attempt < 40 && (await readSyncs(userId)).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // A retry-sweep / "Sync now" pass over the same payment.
    await syncUser(userId)

    const rows = await readSyncs(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pushed')
    expect(connector.pushed).toHaveLength(1)
  })

  it('AC 2: a direct payment to one of the user\'s OWN addresses is not fed — no row, no document', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    connector.connect(userId)

    const toOwnAccount = await seedIntent({ userId, agentId, to: OWN_ACCOUNT })
    const toOwnDelegate = await seedIntent({ userId, agentId, to: OWN_DELEGATE })
    // The intent stores the address as the caller sent it; the account row is
    // checksummed. The comparison must be case-insensitive or this internal
    // move would be fed as a purchase.
    const toOwnAccountLowercase = await seedIntent({ userId, agentId, to: OWN_ACCOUNT.toLowerCase() })

    for (const id of [toOwnAccount, toOwnDelegate, toOwnAccountLowercase]) {
      expect(await buildAccountingEntryForPayment(userId, id)).toBeNull()
      expect(await feedSettledPayment(userId, id)).toEqual({ outcome: 'not_fed' })
    }

    expect(await readSyncs(userId)).toHaveLength(0)
    expect(connector.pushed).toHaveLength(0)

    // The backfill must not even enumerate them: an internal move is not a
    // payment that is waiting to be fed.
    expect(await listUnpushedPaymentIds(userId, 'memory', 200, null)).toEqual([])
  })

  it('AC 2 CONTROL: the same user\'s outside payment IS enumerated and fed by the backfill', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    connector.connect(userId)

    const outside = await seedIntent({ userId, agentId, to: OUTSIDE })
    await seedIntent({ userId, agentId, to: OWN_ACCOUNT })

    expect(await listUnpushedPaymentIds(userId, 'memory', 200, null)).toEqual([outside])
    expect(await syncUser(userId)).toEqual({ fed: 1, total: 1 })
    expect(await readSyncs(userId)).toHaveLength(1)
  })

  it('AC 5: a direct payment settled BEFORE the fix is reachable by the backfill (second source, not evidence)', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    connector.connect(userId)

    // Settled yesterday, no evidence row, no sync row — the pre-fix shape.
    const id = await seedIntent({
      userId,
      agentId,
      to: OUTSIDE,
      confirmedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    })

    expect(await listUnpushedPaymentIds(userId, 'memory', 200, null)).toEqual([id])
    expect(await syncUser(userId)).toEqual({ fed: 1, total: 1 })
    expect((await readSyncs(userId))[0]).toMatchObject({ payment_id: id, status: 'pushed' })
  })

  it('AC 3: an x402 payment is unchanged — evidence source, resource URL, merchant counterparty', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    connector.connect(userId)

    const id = await seedIntent({ userId, agentId, to: MERCHANT, rail: 'x402' })
    // The evidence writer fires the feed itself (fire-and-forget) — that is
    // the pre-#4533 path, and it must still deliver.
    await recordMachinePaymentEvidenceBaseById(id, agentId)

    const entry = await buildAccountingEntryForPayment(userId, id)
    expect(entry).not.toBeNull()
    expect(entry!.resourceUrl).toBe(RESOURCE)
    // Canonicalised (EIP-55) by `toCanonicalAddress`, so compare case-insensitively.
    expect(entry!.counterparty.address?.toLowerCase()).toBe(MERCHANT.toLowerCase())
    // The evidence branch still answers from `fx_rates`/`amount_sek`, not from
    // the intent's fiat columns.
    expect(entry!.amountSek).not.toBeNull()
    // #4578 CONTROL: the evidence branch emits `FALSE::BOOLEAN` for the
    // direct-payment signal, so the new rung does not fire for a protocol
    // payment — its kind is unchanged.
    expect(entry!.transactionKind).not.toBe('transfer')

    for (let attempt = 0; attempt < 40 && (await readSyncs(userId)).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(await readSyncs(userId)).toHaveLength(1)
    expect(connector.pushed).toHaveLength(1)
    expect(connector.pushed[0].tx.resourceUrl).toBe(RESOURCE)
  })

  it('AC 3 CONTROL: an x402 intent with NO evidence row is not captured by the direct branch', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    connector.connect(userId)

    // Same shape as a direct payment except the rail: the direct branch must
    // refuse it, and with no evidence row there is no entry at all.
    const id = await seedIntent({ userId, agentId, to: OUTSIDE, rail: 'x402' })

    expect(await buildAccountingEntryForPayment(userId, id)).toBeNull()
    expect(await feedSettledPayment(userId, id)).toEqual({ outcome: 'not_fed' })
    expect(await readSyncs(userId)).toHaveLength(0)
  })

  it('a direct payment with no book-time capture is not fed (stays backfillable)', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await seedOwnAccount(userId)
    connector.connect(userId)

    const id = await seedIntent({
      userId,
      agentId,
      to: OUTSIDE,
      sekValue: null,
      usdValue: null,
      eurValue: null,
    })

    expect(await feedSettledPayment(userId, id)).toEqual({ outcome: 'not_fed' })
    expect(await readSyncs(userId)).toHaveLength(0)
    expect(await listUnpushedPaymentIds(userId, 'memory', 200, null)).toEqual([])
  })
})
