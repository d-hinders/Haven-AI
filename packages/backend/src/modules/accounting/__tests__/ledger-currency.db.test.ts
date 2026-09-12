/**
 * Multi-currency ledgers, on the REAL database (#2877, epic #2858).
 *
 * The feed used to push SEK to every destination. It now pushes the currency
 * the connected company books in, converted with the rate frozen at
 * settlement. Four things have to hold, and all four are database behaviour —
 * a JSONB column, a `COALESCE` in an upsert, and a real `SELECT` mapping back
 * into the entry — so they are proven here rather than against mocks
 * (`CLAUDE.md`, data-layer rule; `testing-strategy.md`).
 *
 * 1. **CHARACTERISATION — a SEK ledger is fed exactly what it was fed before.**
 *    The amount comes from the `amount_sek` COLUMN, never re-derived from the
 *    new rate map. The fixture makes the two disagree on purpose (`amount_sek`
 *    = 10.42 while the map says SEK 99), so a regression that starts computing
 *    SEK from the map fails here instead of quietly re-pricing every Swedish
 *    ledger. This assertion holds on `origin/dev` too — it is the pre-#2877
 *    behaviour written down.
 * 2. A non-SEK destination is fed ITS currency and ITS amount, from the frozen
 *    rate.
 * 3. The rate is frozen: a second evidence write with different rates does not
 *    move the captured map, so a re-settlement can never re-price history.
 * 4. No rate for the destination's currency is *not ready*, not a fallback:
 *    nothing is pushed, no claim row is taken, the payment stays backfillable.
 *
 * MUTATION TARGETS are named at each site.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true) },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { upsertEvidenceBase } from '../../../infra/repositories/machine-payments.js'
import { getSyncState } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV } from '../../../infra/secrets.js'
import { connectWithApiKey } from '../api-key-flow.js'
import { clearConnectors, InMemoryConnector, registerConnector } from '../connector.js'
import { feedSettledPayment } from '../feed-orchestrator.js'
import type { AccountingProvider } from '../provider.js'
import { clearTestProviders, registerTestProvider } from '../registry.js'

const KEY = randomBytes(32).toString('base64')
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'

const MEMORY: AccountingProvider = {
  id: 'memory',
  displayName: 'Memory',
  authKind: 'api_key',
  capabilities: { attachments: true, verify: true, revoke: true, companyInfo: true },
  availability: 'live',
  requiredScopes: [],
}

let seq = 0

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ledger-currency-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'ledger currency agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/**
 * A settled payment of 1.0 USDC with book-time FX captured at settlement.
 *
 * `amountSek` and the SEK entry of `fxRates` deliberately DISAGREE: the SEK
 * path must answer from the column (10.42), never from the map (99).
 */
async function seedSettled(
  userId: string,
  agentId: string,
  opts: { fxRates: Record<string, number> | null; amountHuman?: string },
): Promise<string> {
  const amountHuman = opts.amountHuman ?? '1.0'
  const id = randomUUID()
  const txHash = `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66)
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash,
        confirmed_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, '1000000', '1.0',
             '0x00000000000000000000000000000000000000d1', 0, $7, 'confirmed', $8,
             NOW(), NOW() + interval '10 minutes', NOW())`,
    [id, agentId, userId, PAYER, TOKEN, MERCHANT, `0x${'11'.repeat(32)}`, txHash],
  )
  await upsertEvidenceBase({
    paymentIntentId: id,
    approvalRequestId: null,
    agentId,
    userId,
    rail: 'x402',
    txHash,
    chainId: CHAIN,
    resourceUrl: 'https://merchant.example/paid',
    merchantAddress: MERCHANT,
    payerAddress: PAYER,
    settlementAddress: MERCHANT,
    tokenSymbol: 'USDC',
    tokenAddress: TOKEN,
    amountRaw: '1000000',
    amountHuman,
    challengeId: null,
    idempotencyKey: null,
    challengePayload: null,
    confirmedAt: new Date().toISOString(),
    amountSek: 10.42,
    fxRateSek: 10.42,
    fxSource: 'coingecko_spot',
    fxAt: new Date().toISOString(),
    fxRates: opts.fxRates ? JSON.stringify(opts.fxRates) : null,
  })
  return id
}

/** A connected in-memory destination whose company books in `baseCurrency`. */
async function connectBooking(userId: string, baseCurrency: string): Promise<InMemoryConnector> {
  const connector = new InMemoryConnector()
  connector.companyInfo = { externalCompanyId: 'mem-1', name: 'Memory AB', baseCurrency }
  connector.connect(userId)
  registerConnector(connector)
  await connectWithApiKey({ provider: MEMORY, connector, userId, apiKey: 'memory-key' })
  // The connect stamps a feed-from floor; these fixtures settle around it.
  await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
  return connector
}

describeDb('multi-currency ledgers (#2877)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    process.env[SECRETS_KEY_ENV] = KEY
    clearConnectors()
    clearTestProviders()
    registerTestProvider(MEMORY)
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  it('CHARACTERISATION: a SEK ledger is fed the stored amount_sek — never a figure re-derived from the rate map', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'SEK')
    // The map says SEK 99; the column says 10.42. Pre-#2877 behaviour is the
    // column, and it stays the column.
    const paymentId = await seedSettled(userId, agentId, { fxRates: { SEK: 99, DKK: 6.87 } })

    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })

    const { tx } = connector.pushed[0]
    // MUTATION TARGET: answer SEK from `entry.fxRates.SEK` in `ledgerAmount`
    // and this reads 99 — every Swedish ledger silently re-priced.
    expect(tx.ledgerCurrency).toBe('SEK')
    // Asserted against the COLUMNS rather than against literals: NUMERIC
    // round-trips at the column's own scale, and the claim being made is
    // "this is the stored value", not "this is a particular spelling of it".
    const stored = await storedSek(paymentId)
    expect(tx.amountLedger).toBe(stored.amount_sek)
    expect(tx.amountSek).toBe(stored.amount_sek)
    expect(tx.fxRateLedger).toBe(stored.fx_rate_sek)
    expect(Number(tx.amountLedger)).toBe(10.42)
  })

  it('a DKK ledger is fed DKK, from the rate frozen at settlement', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'DKK')
    const paymentId = await seedSettled(userId, agentId, { fxRates: { SEK: 10.42, DKK: 6.87 } })

    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })

    const { tx } = connector.pushed[0]
    // 1.0 USDC × 6.87 DKK/USDC, the rate captured at settlement.
    // MUTATION TARGET: drop `ledgerCurrency` from the orchestrator's
    // `toFeedTransaction` call and a Danish ledger is fed Swedish kronor
    // labelled DKK.
    expect(tx.ledgerCurrency).toBe('DKK')
    // Fixed at the SEK column's own scale, so a computed amount is the same
    // shape as a stored one (migration 026: NUMERIC(38,4)).
    expect(tx.amountLedger).toBe('6.8700')
    expect(tx.fxRateLedger).toBe('6.8700')
    // The SEK capture rides along untouched — it is what the receipt underlag
    // and every pre-#2877 row carry.
    expect(Number(tx.amountSek)).toBe(10.42)
  })

  it('the captured rate map is FROZEN: a second evidence write with different rates does not re-price the payment', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'DKK')
    const paymentId = await seedSettled(userId, agentId, { fxRates: { SEK: 10.42, DKK: 6.87 } })

    // Re-settlement: the same evidence row written again while the market has
    // moved. MUTATION TARGET: drop the `fx_rates` COALESCE from
    // `evidenceBaseUpsertSql` and the stored map becomes the 9.99 one, so the
    // feed below pushes a rate that was never the book-time rate.
    await seedSettledAgain(userId, agentId, paymentId, { SEK: 20.84, DKK: 9.99 })

    const stored = await db.query<{ fx_rates: Record<string, number> }>(
      `SELECT fx_rates FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(stored.rows[0].fx_rates).toEqual({ SEK: 10.42, DKK: 6.87 })

    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })
    expect(connector.pushed[0].tx.amountLedger).toBe('6.8700')
  })

  it('no rate for the destination currency is NOT READY, not a SEK fallback: nothing pushed, no claim row, still backfillable', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'DKK')
    // A settlement-time pricing outage for this currency — SEK was captured,
    // DKK was not.
    const paymentId = await seedSettled(userId, agentId, { fxRates: { SEK: 10.42 } })

    // MUTATION TARGET: fall back to `entry.amountSek` in `ledgerAmount` and
    // this pushes 10.42 into a Danish ledger as though it were kroner.
    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'not_fed' })
    expect(connector.pushed).toHaveLength(0)
    // No claim row — but not, in this case, "until a rate exists": this row
    // captured SEK, so its fx_at is set and the map can never gain DKK. The
    // payment is unfeedable to a DKK ledger permanently, and is re-evaluated
    // (cheaply, without consuming an attempt) by every sweep. Only a row whose
    // whole capture failed — fx_at NULL — is genuinely backfillable.
    expect(await getSyncState(userId, 'memory', paymentId)).toBeNull()
  })

  it('a LATER evidence write can never add a rate map to a row that already captured: no feed-time rate under a settlement timestamp', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'DKK')
    // The shape every row settled before migration 082 is in, and the shape the
    // proof-attach path can produce: a capture exists (fx_at, amount_sek) but
    // the map does not. Found by review on #2877 — the per-column COALESCE let
    // a write weeks later fill fx_rates while fx_at kept its settlement value.
    const paymentId = await seedSettled(userId, agentId, { fxRates: null })
    await db.query(`UPDATE machine_payment_evidence SET fx_rates = NULL WHERE payment_intent_id = $1`, [paymentId])

    // A re-write long after settlement, carrying today's rates.
    await seedSettledAgain(userId, agentId, paymentId, { SEK: 20.84, DKK: 9.99 })

    // MUTATION TARGET: restore `fx_rates = COALESCE(…, EXCLUDED.fx_rates)` in
    // evidenceBaseUpsertSql and the row gains a map taken weeks after the
    // fx_at it sits next to — a feed-time rate wearing a book-time label.
    const stored = await db.query<{ fx_rates: unknown; fx_at: Date }>(
      `SELECT fx_rates, fx_at FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(stored.rows[0].fx_rates).toBeNull()
    // …and the honest consequence: that row is not feedable to a non-SEK
    // ledger at all, because its book-time rates are not knowable.
    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'not_fed' })
    expect(connector.pushed).toHaveLength(0)
  })

  it('a partial capture stays partial: a later write cannot fill amount_sek at a NEW rate under the OLD fx_at', async () => {
    const { userId, agentId } = await seedUser()
    await connectBooking(userId, 'SEK')
    // The state #2877's merged capture made reachable and the pre-#2877 one
    // could not: the price source quoted EUR but not SEK, so fx_at and the map
    // are set and amount_sek is NULL. Found by review — under the per-column
    // COALESCE the proof-attach path would later fill amount_sek with THAT
    // day's rate while fx_at still said settlement, re-pricing a Swedish
    // ledger on the path this change claims is untouched.
    const paymentId = await seedSettled(userId, agentId, { fxRates: { EUR: 0.92 } })
    await db.query(
      `UPDATE machine_payment_evidence SET amount_sek = NULL, fx_rate_sek = NULL WHERE payment_intent_id = $1`,
      [paymentId],
    )
    const before = await db.query<{ fx_at: Date }>(
      `SELECT fx_at FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )

    // A re-write long after settlement, with SEK quoting fine now.
    await seedSettledAgain(userId, agentId, paymentId, { SEK: 20.84, EUR: 0.99 })

    // MUTATION TARGET: restore `amount_sek = COALESCE(…, EXCLUDED.amount_sek)`
    // in evidenceBaseUpsertSql and amount_sek fills with 20.84 — a rate from
    // the day of the attach, stamped with the settlement fx_at above it.
    const after = await db.query<{ amount_sek: string | null; fx_rate_sek: string | null; fx_at: Date }>(
      `SELECT amount_sek, fx_rate_sek, fx_at FROM machine_payment_evidence WHERE payment_intent_id = $1`,
      [paymentId],
    )
    expect(after.rows[0].amount_sek).toBeNull()
    expect(after.rows[0].fx_rate_sek).toBeNull()
    expect(after.rows[0].fx_at.toISOString()).toBe(before.rows[0].fx_at.toISOString())
  })

  it('a zero-amount payment feeds to a non-SEK ledger, exactly as it does to a SEK one', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'DKK')
    const paymentId = await seedSettled(userId, agentId, { fxRates: { SEK: 10.42, DKK: 6.87 }, amountHuman: '0' })

    // MUTATION TARGET: restore `tokenAmount <= 0` in `ledgerAmount` and this
    // payment is not-ready forever — no claim row, re-evaluated by every sweep,
    // and no rate can ever make it ready.
    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })
    expect(connector.pushed[0].tx.amountLedger).toBe('0.0000')
  })

  it('a computed ledger amount is fixed-scale, never a raw float or exponent notation', async () => {
    const { userId, agentId } = await seedUser()
    const connector = await connectBooking(userId, 'EUR')
    // 1.1 × 10.42 = 11.462000000000002 in float; 0.000001 × 0.92 = 9.2e-7.
    const paymentId = await seedSettled(userId, agentId, { fxRates: { EUR: 10.42 }, amountHuman: '1.1' })

    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })
    const amount = connector.pushed[0].tx.amountLedger!
    // MUTATION TARGET: return `String(tokenAmount * rate)` from `ledgerAmount`
    // and this reads '11.462000000000002' — 15 junk decimals on a supplier
    // invoice, and exponent notation for a sub-microunit x402 payment.
    expect(amount).toBe('11.4620')
    expect(amount).not.toMatch(/e/i)
    expect(amount.split('.')[1]).toHaveLength(4)
  })

  it('a connection whose provider could not name a currency books in the default (SEK)', async () => {
    const { userId, agentId } = await seedUser()
    const connector = new InMemoryConnector()
    connector.companyInfo = { externalCompanyId: 'mem-1', name: 'Memory AB', baseCurrency: null }
    connector.connect(userId)
    registerConnector(connector)
    await connectWithApiKey({ provider: MEMORY, connector, userId, apiKey: 'memory-key' })
    await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
    const paymentId = await seedSettled(userId, agentId, { fxRates: { SEK: 10.42, DKK: 6.87 } })

    expect(await feedSettledPayment(userId, paymentId)).toEqual({ outcome: 'pushed' })
    expect(connector.pushed[0].tx.ledgerCurrency).toBe('SEK')
    expect(Number(connector.pushed[0].tx.amountLedger)).toBe(10.42)
  })
})

/** The SEK capture as Postgres stores it, for assertions that mean "the column". */
async function storedSek(paymentIntentId: string): Promise<{ amount_sek: string; fx_rate_sek: string }> {
  const { rows } = await db.query<{ amount_sek: string; fx_rate_sek: string }>(
    `SELECT amount_sek, fx_rate_sek FROM machine_payment_evidence WHERE payment_intent_id = $1`,
    [paymentIntentId],
  )
  return rows[0]
}

/** Re-write the same evidence row with a different rate map (a re-settlement). */
async function seedSettledAgain(
  userId: string,
  agentId: string,
  paymentIntentId: string,
  fxRates: Record<string, number>,
): Promise<void> {
  const row = await db.query<{ tx_hash: string }>(
    `SELECT tx_hash FROM machine_payment_evidence WHERE payment_intent_id = $1`,
    [paymentIntentId],
  )
  await upsertEvidenceBase({
    paymentIntentId,
    approvalRequestId: null,
    agentId,
    userId,
    rail: 'x402',
    txHash: row.rows[0].tx_hash,
    chainId: CHAIN,
    resourceUrl: 'https://merchant.example/paid',
    merchantAddress: MERCHANT,
    payerAddress: PAYER,
    settlementAddress: MERCHANT,
    tokenSymbol: 'USDC',
    tokenAddress: TOKEN,
    amountRaw: '1000000',
    amountHuman: '1.0',
    challengeId: null,
    idempotencyKey: null,
    challengePayload: null,
    confirmedAt: new Date().toISOString(),
    amountSek: 20.84,
    fxRateSek: 20.84,
    fxSource: 'coingecko_spot',
    fxAt: new Date().toISOString(),
    fxRates: JSON.stringify(fxRates),
  })
}
