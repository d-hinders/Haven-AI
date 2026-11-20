/**
 * The owner's sales reads and the clear route on the REAL Postgres harness
 * (#4897, epic #4885).
 *
 * Only the chain read (used by the ingest in the round-trip test) is mocked;
 * the routes, the request-validation plugin, the auth middleware, the
 * repositories and every table are real.
 *
 * Each test is named for the criterion it proves:
 *
 *   - totals, breakdowns and the list agree for one fixture (one rule for every
 *     figure: indexed transfers, zero-value and own-sender excluded, a sale's
 *     legs not counted on top of its row);
 *   - a sale from several payers is not attributed by payer;
 *   - the product label falls back catalogue name, record name, product id;
 *   - a payer is a contact, an own address or a wallet, and another Haven
 *     user's agent is a wallet like any other;
 *   - keyset paging is stable and complete, including on equal block times;
 *   - every read is scoped to the caller's user and merchant account;
 *   - services off, or no merchant account, reads as the empty state;
 *   - a Sales key reaches none of the five routes, and a device-login token
 *     cannot clear a record;
 *   - clearing a record leaves the payment, and a new record is accepted;
 *   - every read carries today's USDC rate for the page to convert with
 *     (#4963): a rate, one null currency, a failed read, and Sales off;
 *   - the filters and the search (#4959): the summary is computed over the
 *     same filtered relation as the list (each filter alone, two combined, the
 *     search), a payment from several payers matches any of its payers, a
 *     malformed filter is the plugin's 400, the search never matches another
 *     Haven user's name, `last_paid_at` is the payer's newest payment, the
 *     facets name every product and payer, and `total` counts the filter set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const mocks = vi.hoisted(() => ({ read: vi.fn(), price: vi.fn(), refresh: vi.fn() }))

// #5012: the summary and payments reads ask for a background index refresh.
// It is recorded, never run, so the suite makes no RPC or index call; the
// refresh itself is proven in merchant-index.db.test.ts.
vi.mock('../../modules/transactions/merchant-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/transactions/merchant-index.js')>()
  return { ...actual, refreshMerchantAccountIndex: (...a: unknown[]) => mocks.refresh(...a) }
})

// #4963: the reads carry today's USDC rate. The price read is mocked, as the
// dashboard's test does, so the suite stays off CoinGecko.
vi.mock('../../infra/prices.js', () => ({
  getTokenPrice: (...a: unknown[]) => mocks.price(...a),
}))

vi.mock('../../modules/transactions/chain-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/transactions/chain-read.js')>()
  return {
    ...actual,
    readInboundTransactionByTxHash: (...a: unknown[]) => mocks.read(...a),
  }
})

const merchantSalesReadRoutes = (await import('../merchant-sales-reads.js')).default
const merchantSalesRoutes = (await import('../merchant-sales.js')).default
const { installRequestValidation } = await import('../../openapi/request-validation.js')
const { generateMerchantKey } = await import('../../domain/merchant-keys.js')
const { insertMerchantKey } = await import('../../infra/repositories/merchant-keys.js')
const { insertMerchantSale } = await import('../../infra/repositories/merchant-sales.js')
const { rateLimitKeyFor } = await import('../../middleware/rate-limit.js')
const { up: backfillOwnFlag } = await import('../../db/migrations/133_inbound_transfers_own_flag_backfill.js')

const CHAIN = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

function addr(): string {
  return '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)
}
function hash(n: number): string {
  return '0x' + n.toString(16).padStart(64, '0')
}

interface Merchant {
  userId: string
  accountId: string
  address: string
}

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`reads-${randomUUID()}@test.example`],
  )
  return user.rows[0].id
}

async function seedMerchant(opts: { enabled?: boolean } = {}): Promise<Merchant> {
  const userId = await seedUser()
  const address = addr()
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, is_merchant_account)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', false, true) RETURNING id`,
    [userId, address, CHAIN],
  )
  await db.query(
    `INSERT INTO merchant_service_settings (user_id, enabled, enabled_at)
     VALUES ($1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END)`,
    [userId, opts.enabled ?? true],
  )
  return { userId, accountId: account.rows[0].id, address }
}

interface LegSeed {
  tx: string
  payer: string
  amount: string
  logIndex?: number
  own?: boolean
  time: string
}

async function seedLeg(m: Merchant, leg: LegSeed): Promise<void> {
  await db.query(
    `INSERT INTO inbound_transfers
       (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
        amount_raw, block_number, block_time, sender_is_own_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 100, $9, $10)`,
    [m.accountId, m.userId, CHAIN, leg.tx, leg.logIndex ?? 0, leg.payer, USDC, leg.amount, leg.time, leg.own ?? false],
  )
}

async function seedSale(
  m: Merchant,
  s: {
    tx: string
    productId: string
    productName?: string | null
    amount: string
    payer: string | null
    several?: boolean
    own?: boolean
    time: string
    receipt?: string | null
    vat?: 'SE_25' | 'REVERSE_CHARGE' | null
  },
): Promise<void> {
  await insertMerchantSale({
    accountId: m.accountId,
    userId: m.userId,
    chainId: CHAIN,
    txHash: s.tx,
    recordVersion: 1,
    productId: s.productId,
    productName: s.productName ?? null,
    merchantReference: `ref-${s.tx.slice(-6)}`,
    receiptNumber: s.receipt ?? null,
    vatTreatment: s.vat ?? null,
    amountRaw: s.amount,
    tokenAddress: USDC,
    payerAddress: s.payer,
    severalPayers: s.several ?? false,
    senderIsOwnAddress: s.own ?? false,
    blockNumber: 100,
    blockTime: new Date(s.time),
  })
}

describeDb('the owner sales reads on the real database (#4897)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(rateLimit, { global: false, keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request) })
    installRequestValidation(app, {
      mode: 'enforce',
      enforcedModules: ['routes/merchant-sales-reads.ts', 'routes/merchant-sales.ts'],
    })
    await app.register(merchantSalesReadRoutes, { prefix: '/merchant-sales' })
    await app.register(merchantSalesRoutes, { prefix: '/merchant' })
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await resetDb()
    vi.clearAllMocks()
    mocks.price.mockResolvedValue({ usd: 0.9998, eur: 0.92, sek: 10.4 })
  })

  const token = (userId: string, extra: Record<string, unknown> = {}) =>
    app.jwt.sign({ sub: userId, email: 'owner@example.com', ...extra })

  const get = (userId: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token(userId)}` } })

  const clear = (userId: string, tx: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'DELETE',
      url: `/merchant-sales/payments/${tx}/record`,
      headers: { authorization: `Bearer ${token(userId, extra)}` },
    })

  const PERIOD = 'from=2026-11-01&to=2026-11-30'

  it("asks for a refresh of the owner's own account on the summary and payments reads, never without one (#5012)", async () => {
    mocks.refresh.mockResolvedValue({ status: 'throttled' })
    const m = await seedMerchant()

    expect((await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).statusCode).toBe(200)
    expect((await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).statusCode).toBe(200)
    expect(mocks.refresh.mock.calls.map((call) => call[0])).toEqual([m.accountId, m.accountId])

    // No Sales account in scope: nothing to refresh.
    mocks.refresh.mockClear()
    const off = await seedMerchant({ enabled: false })
    expect((await get(off.userId, `/merchant-sales/summary?${PERIOD}`)).statusCode).toBe(200)
    expect((await get(off.userId, `/merchant-sales/payments?${PERIOD}`)).statusCode).toBe(200)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  /**
   * The one fixture the agreement test reads. Revenue 2,350,000:
   *   A sale P1 1,000,000 from a contact           (one leg)
   *   B sale P2   500,000 from two payers          (several payers; legs 300k + 200k)
   *   C no sale   250,000 from the contact
   *   D no sale   200,000 from one wallet          (two legs, same payer: 150k + 50k)
   *   E no sale   100,000 from two wallets         (two legs: 60k + 40k)
   *   I sale P3   300,000 from the contact         (its legs: 100k from an own agent + 300k)
   * Not revenue:
   *   F own move  700,000 from the owner's other account (no sale row)
   *   G own move  400,000 from a REPLACED agent delegate (sale row, own)
   *   H zero-value transfer only
   *   and three transfers outside the period (one a second before, one at the
   *   first instant of December).
   */
  async function seedAgreementFixture() {
    const m = await seedMerchant()
    const contact = addr()
    const wallet4 = addr()
    const wallet5 = addr()
    const wallet6 = addr()
    const wallet2 = addr()
    const wallet3 = addr()
    const otherAccount = addr()
    const oldDelegate = addr()
    const liveDelegate = addr()

    await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Alice', $2)`, [m.userId, contact])
    await db.query(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, name)
       VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', true, 'Main')`,
      [m.userId, otherAccount, CHAIN],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Research agent', $2, 'active') RETURNING id`,
      [m.userId, liveDelegate],
    )
    await db.query(
      `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address)
       VALUES ($1, $2, $3, $4)`,
      [agent.rows[0].id, m.userId, oldDelegate, liveDelegate],
    )

    const t = (day: string, hh = '10:00:00') => `2026-11-${day}T${hh}Z`
    // A
    await seedLeg(m, { tx: hash(0xa), payer: contact, amount: '1000000', time: t('10') })
    await seedSale(m, { tx: hash(0xa), productId: 'P1', productName: 'Product one', amount: '1000000', payer: contact, time: t('10'), receipt: 'R-1', vat: 'SE_25' })
    // B
    await seedLeg(m, { tx: hash(0xb), payer: wallet2, amount: '300000', logIndex: 0, time: t('10', '11:00:00') })
    await seedLeg(m, { tx: hash(0xb), payer: wallet3, amount: '200000', logIndex: 1, time: t('10', '11:00:00') })
    await seedSale(m, { tx: hash(0xb), productId: 'P2', productName: 'Product two', amount: '500000', payer: null, several: true, time: t('10', '11:00:00') })
    // C
    await seedLeg(m, { tx: hash(0xc), payer: contact, amount: '250000', time: t('11') })
    // D
    await seedLeg(m, { tx: hash(0xd), payer: wallet4, amount: '150000', logIndex: 0, time: t('12') })
    await seedLeg(m, { tx: hash(0xd), payer: wallet4, amount: '50000', logIndex: 1, time: t('12') })
    // E
    await seedLeg(m, { tx: hash(0xe), payer: wallet5, amount: '60000', logIndex: 0, time: t('12', '11:00:00') })
    await seedLeg(m, { tx: hash(0xe), payer: wallet6, amount: '40000', logIndex: 1, time: t('12', '11:00:00') })
    // I: an own leg beside a customer leg; the sale row is the customer's 300k
    await seedLeg(m, { tx: hash(0x1), payer: liveDelegate, amount: '100000', logIndex: 0, own: true, time: t('13') })
    await seedLeg(m, { tx: hash(0x1), payer: contact, amount: '300000', logIndex: 1, time: t('13') })
    await seedSale(m, { tx: hash(0x1), productId: 'P3', productName: 'Product three', amount: '300000', payer: contact, time: t('13') })
    // F
    await seedLeg(m, { tx: hash(0xf), payer: otherAccount, amount: '700000', own: true, time: t('14') })
    // G: a sale row marked own, paid from a REPLACED delegate
    await seedLeg(m, { tx: hash(0x2), payer: oldDelegate, amount: '400000', own: true, time: t('15') })
    await seedSale(m, { tx: hash(0x2), productId: 'P9', amount: '0', payer: oldDelegate, own: true, time: t('15') })
    // H: zero-value only
    await seedLeg(m, { tx: hash(0x3), payer: wallet4, amount: '0', time: t('16') })
    // outside the period
    await seedLeg(m, { tx: hash(0x4), payer: wallet4, amount: '900000', time: '2026-10-31T23:59:59Z' })
    await seedLeg(m, { tx: hash(0x5), payer: wallet4, amount: '900000', time: '2026-12-01T00:00:00Z' })
    // the last second of the period IS in it
    await seedLeg(m, { tx: hash(0x6), payer: wallet4, amount: '10000', time: '2026-11-30T23:59:59Z' })
    return { m, contact, wallet4, otherAccount, oldDelegate, liveDelegate }
  }

  describe('one rule for every figure', () => {
    it('the totals, the breakdowns and the list agree for the same period', async () => {
      const { m, contact, wallet4, otherAccount, oldDelegate } = await seedAgreementFixture()

      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      // revenue = A + B + C + D + E + I + the last-second payment (10,000).
      expect(summary.revenue_raw).toBe('2360000')
      expect(summary.sales).toBe(3)
      // #4981: revenue over EVERY payment counted (3 sales + 4 without a product), rounded down.
      expect(summary.average_sale_raw).toBe('337142')
      expect(summary.revenue_in_account_raw).toBe('2360000')
      expect(summary.received_in_stripe).toEqual({ count: 0, amount_raw: '0' })
      expect(summary.without_product).toEqual({ count: 4, amount_raw: '560000' })
      expect(summary.own_moves).toEqual({ count: 2, amount_raw: '1100000' })

      // by product: sales only, and with without_product they add up to revenue.
      const byProduct = summary.by_product as Array<{ product_id: string; label: string; sales: number; amount_raw: string }>
      expect(byProduct.map((p) => [p.product_id, p.amount_raw])).toEqual([
        ['P1', '1000000'],
        ['P2', '500000'],
        ['P3', '300000'],
      ])
      const productSum = byProduct.reduce((s, p) => s + BigInt(p.amount_raw), 0n)
      expect(productSum + BigInt(summary.without_product.amount_raw)).toBe(BigInt(summary.revenue_raw))

      // by payer: the contact (A, C, I), wallet4 (D and the last-second one);
      // B and E are several payers and are not attributed.
      const byPayer = summary.by_payer as Array<{ payer: { kind: string; name: string | null; address: string }; payments: number; amount_raw: string }>
      expect(byPayer.map((p) => [p.payer.address, p.payments, p.amount_raw])).toEqual([
        [contact.toLowerCase(), 3, '1550000'],
        [wallet4.toLowerCase(), 2, '210000'],
      ])
      expect(summary.unattributed).toEqual({ payments: 2, amount_raw: '600000' })
      const payerSum =
        byPayer.reduce((s, p) => s + BigInt(p.amount_raw), 0n) +
        BigInt(summary.by_payer_other.amount_raw) +
        BigInt(summary.unattributed.amount_raw)
      expect(payerSum).toBe(BigInt(summary.revenue_raw))

      // by day: adds up too, and names only days with revenue, in UTC.
      const byDay = summary.by_day as Array<{ day: string; payments: number; revenue_raw: string }>
      expect(byDay.map((d) => d.day)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-30'])
      expect(byDay.reduce((s, d) => s + BigInt(d.revenue_raw), 0n)).toBe(BigInt(summary.revenue_raw))

      // the list: one row per transaction, newest first, own moves marked.
      const list = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json()
      const rows = list.payments as Array<{ tx_hash: string; kind: string; amount_raw: string; block_time: string }>
      expect(rows).toHaveLength(9)
      const times = rows.map((r) => Date.parse(r.block_time))
      expect(times).toEqual([...times].sort((a, b) => b - a)) // newest first
      const revenueRows = rows.filter((r) => r.kind !== 'own_move')
      expect(revenueRows.reduce((s, r) => s + BigInt(r.amount_raw), 0n)).toBe(BigInt(summary.revenue_raw))
      expect(rows.filter((r) => r.kind === 'sale')).toHaveLength(summary.sales)
      expect(rows.filter((r) => r.kind === 'no_product')).toHaveLength(summary.without_product.count)
      const ownRows = rows.filter((r) => r.kind === 'own_move')
      expect(ownRows).toHaveLength(summary.own_moves.count)
      expect(ownRows.reduce((s, r) => s + BigInt(r.amount_raw), 0n)).toBe(BigInt(summary.own_moves.amount_raw))
      expect(rows.map((r) => r.tx_hash)).not.toContain(hash(0x3)) // zero-value: nowhere
      expect(rows.map((r) => r.tx_hash)).not.toContain(hash(0x4))
      expect(rows.map((r) => r.tx_hash)).not.toContain(hash(0x5))
      expect(rows[0].tx_hash).toBe(hash(0x6))

      // the payer of an own move is one of the owner's own addresses.
      const f = list.payments.find((r: { tx_hash: string }) => r.tx_hash === hash(0xf))
      expect(f.payer).toMatchObject({ kind: 'own', name: 'Main', address: otherAccount.toLowerCase() })
      const g = list.payments.find((r: { tx_hash: string }) => r.tx_hash === hash(0x2))
      expect(g).toMatchObject({ kind: 'own_move', amount_raw: '400000' })
      expect(g.payer).toMatchObject({ kind: 'own', name: 'Research agent', address: oldDelegate.toLowerCase() })
    })

    it('a sale is counted once with its own amount: its legs are never added on top', async () => {
      const { m } = await seedAgreementFixture()
      const detail = (await get(m.userId, `/merchant-sales/payments/${hash(0x1)}`)).json()
      // two legs (100k own + 300k) and a sale row of 300k: the row says 300k.
      expect(detail.legs).toHaveLength(2)
      expect(detail.kind).toBe('sale')
      expect(detail.amount_raw).toBe('300000')
    })

    it('a zero-value transfer is never a sale, a payer or revenue', async () => {
      const m = await seedMerchant()
      const z = addr()
      await seedLeg(m, { tx: hash(0x77), payer: z, amount: '0', time: '2026-11-10T10:00:00Z' })
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('0')
      expect(summary.by_payer).toEqual([])
      expect(summary.without_product).toEqual({ count: 0, amount_raw: '0' })
      expect((await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments).toEqual([])
      expect((await get(m.userId, `/merchant-sales/payments/${hash(0x77)}`)).statusCode).toBe(404)
    })

    it('a transfer from the owner\'s own address is in no revenue figure, however it is recorded', async () => {
      const m = await seedMerchant()
      const own = addr()
      await db.query(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
         VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', true)`,
        [m.userId, own, CHAIN],
      )
      await seedLeg(m, { tx: hash(0x78), payer: own, amount: '5000000', own: true, time: '2026-11-10T10:00:00Z' })
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('0')
      expect(summary.by_payer).toEqual([])
      expect(summary.own_moves).toEqual({ count: 1, amount_raw: '5000000' })
    })

    it('a payment with no record and an own leg beside a customer leg counts only the customer\'s transfer', async () => {
      const m = await seedMerchant()
      const customer = addr()
      await seedLeg(m, { tx: hash(0x7a), payer: addr(), amount: '40', logIndex: 0, own: true, time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x7a), payer: customer, amount: '60', logIndex: 1, time: '2026-11-10T10:00:00Z' })
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('60')
      expect(summary.without_product).toEqual({ count: 1, amount_raw: '60' })
      expect(summary.own_moves.count).toBe(0)
      expect(summary.by_payer.map((p: { payer: { address: string } }) => p.payer.address)).toEqual([customer.toLowerCase()])
      const row = (await get(m.userId, `/merchant-sales/payments/${hash(0x7a)}`)).json()
      expect(row).toMatchObject({ kind: 'no_product', amount_raw: '60' })
    })

    it('a sale from several payers is not attributed by payer', async () => {
      const m = await seedMerchant()
      await seedLeg(m, { tx: hash(0x79), payer: addr(), amount: '10', logIndex: 0, time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x79), payer: addr(), amount: '20', logIndex: 1, time: '2026-11-10T10:00:00Z' })
      await seedSale(m, { tx: hash(0x79), productId: 'P', amount: '30', payer: null, several: true, time: '2026-11-10T10:00:00Z' })
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('30')
      expect(summary.by_payer).toEqual([])
      expect(summary.unattributed).toEqual({ payments: 1, amount_raw: '30' })
      const row = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments[0]
      expect(row).toMatchObject({ kind: 'sale', several_payers: true, payer: null })
    })
  })

  describe('Stripe-held sales count in revenue, split by where received (#4981)', () => {
    async function seedStripe(
      m: Merchant,
      s: { tx: string; productId: string; amount: string; payer: string | null; several?: boolean; own?: boolean; time: string },
    ): Promise<void> {
      await insertMerchantSale({
        accountId: m.accountId,
        userId: m.userId,
        chainId: CHAIN,
        txHash: s.tx,
        recordVersion: 1,
        productId: s.productId,
        productName: null,
        merchantReference: `ref-${s.tx.slice(-6)}`,
        receiptNumber: null,
        vatTreatment: null,
        amountRaw: s.amount,
        tokenAddress: USDC,
        payerAddress: s.payer,
        severalPayers: s.several ?? false,
        senderIsOwnAddress: s.own ?? false,
        blockNumber: 100,
        blockTime: new Date(s.time),
        heldBy: 'stripe',
        receivingAddress: addr(),
      })
    }

    it("the spec's worked example: 2500 in the account and 10000 in Stripe is revenue 12500, both in the breakdowns", async () => {
      const m = await seedMerchant()
      const payerA = addr()
      const payerB = addr()
      await seedLeg(m, { tx: hash(0x41), payer: payerA, amount: '2500', time: '2026-11-10T10:00:00Z' })
      await seedSale(m, { tx: hash(0x41), productId: 'P1', productName: 'Product one', amount: '2500', payer: payerA, time: '2026-11-10T10:00:00Z' })
      // a Stripe-only day: 11-11 has no account payment at all.
      await seedStripe(m, { tx: hash(0x42), productId: 'P2', amount: '10000', payer: payerB, time: '2026-11-11T10:00:00Z' })

      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary).toMatchObject({
        revenue_raw: '12500',
        revenue_in_account_raw: '2500',
        received_in_stripe: { count: 1, amount_raw: '10000' },
        sales: 2,
        average_sale_raw: '6250',
        without_product: { count: 0, amount_raw: '0' },
        own_moves: { count: 0, amount_raw: '0' },
        unattributed: { payments: 0, amount_raw: '0' },
      })
      expect(BigInt(summary.revenue_in_account_raw) + BigInt(summary.received_in_stripe.amount_raw)).toBe(12500n)
      expect(summary.by_product.map((p: { product_id: string; sales: number; amount_raw: string }) => [p.product_id, p.sales, p.amount_raw]))
        .toEqual([['P2', 1, '10000'], ['P1', 1, '2500']])
      expect(summary.by_payer.map((p: { payer: { address: string }; payments: number; amount_raw: string }) => [p.payer.address, p.payments, p.amount_raw]))
        .toEqual([[payerB.toLowerCase(), 1, '10000'], [payerA.toLowerCase(), 1, '2500']])
      // by day sums to revenue, carries in_stripe_raw, and the Stripe-only day is there.
      expect(summary.by_day).toEqual([
        { day: '2026-11-10', payments: 1, sales: 1, revenue_raw: '2500', without_product_raw: '0', in_stripe_raw: '0',
          by_product: [{ product_id: 'P1', amount_raw: '2500' }], other_products_raw: '0' },
        { day: '2026-11-11', payments: 1, sales: 1, revenue_raw: '10000', without_product_raw: '0', in_stripe_raw: '10000',
          by_product: [{ product_id: 'P2', amount_raw: '10000' }], other_products_raw: '0' },
      ])
      expect(summary.by_day.reduce((n: bigint, d: { revenue_raw: string }) => n + BigInt(d.revenue_raw), 0n)).toBe(12500n)
    })

    it('without_product and own_moves are unchanged by a Stripe-held sale, and the average counts both kinds of payment', async () => {
      const m = await seedMerchant()
      await seedLeg(m, { tx: hash(0x43), payer: addr(), amount: '600', time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x44), payer: addr(), amount: '700', own: true, time: '2026-11-10T11:00:00Z' })
      const before = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      await seedStripe(m, { tx: hash(0x45), productId: 'P2', amount: '1000', payer: addr(), time: '2026-11-11T10:00:00Z' })
      const after = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(after.without_product).toEqual(before.without_product)
      expect(after.without_product).toEqual({ count: 1, amount_raw: '600' })
      expect(after.own_moves).toEqual(before.own_moves)
      expect(after.own_moves).toEqual({ count: 1, amount_raw: '700' })
      expect(after.revenue_raw).toBe('1600')
      // 1600 over 1 sale + 1 payment without a product.
      expect(after.average_sale_raw).toBe('800')
    })

    it('an own-only Stripe row seeded directly stays out of every figure', async () => {
      const m = await seedMerchant()
      await seedStripe(m, { tx: hash(0x46), productId: 'P2', amount: '0', payer: addr(), own: true, time: '2026-11-11T10:00:00Z' })
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary).toMatchObject({
        revenue_raw: '0', revenue_in_account_raw: '0', sales: 0, average_sale_raw: '0',
        without_product: { count: 0 }, own_moves: { count: 0 },
        received_in_stripe: { count: 0, amount_raw: '0' },
        by_product: [], by_payer: [], by_day: [],
      })
      expect((await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments).toEqual([])
    })

    it('a several-payer Stripe sale counts in revenue and the product, and is unattributed by payer', async () => {
      const m = await seedMerchant()
      await seedStripe(m, { tx: hash(0x47), productId: 'P2', amount: '4000', payer: null, several: true, time: '2026-11-11T10:00:00Z' })
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('4000')
      expect(summary.by_product).toEqual([expect.objectContaining({ product_id: 'P2', amount_raw: '4000' })])
      expect(summary.by_payer).toEqual([])
      expect(summary.unattributed).toEqual({ payments: 1, amount_raw: '4000' })
    })

    it('under each list filter, revenue_raw is the list\'s non-own row sum and the split adds up', async () => {
      const m = await seedMerchant()
      const payer = addr()
      await seedLeg(m, { tx: hash(0x48), payer, amount: '2500', time: '2026-11-10T10:00:00Z' })
      await seedSale(m, { tx: hash(0x48), productId: 'P1', amount: '2500', payer, time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x49), payer, amount: '300', time: '2026-11-10T12:00:00Z' })
      await seedStripe(m, { tx: hash(0x4a), productId: 'P1', amount: '10000', payer, time: '2026-11-11T10:00:00Z' })
      await seedStripe(m, { tx: hash(0x4b), productId: 'P2', amount: '700', payer: addr(), time: '2026-11-12T10:00:00Z' })
      for (const filter of ['', '&kind=sale', '&kind=no_product', '&product_id=P1', '&product_id=P2', `&payer=${payer}`, '&q=ref-']) {
        const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}${filter}`)).json()
        const rows = (await get(m.userId, `/merchant-sales/payments?${PERIOD}&limit=200${filter}`)).json().payments as Array<{
          kind: string; amount_raw: string; held_by: string
        }>
        const sum = (rs: typeof rows) => rs.reduce((n, r) => n + BigInt(r.amount_raw), 0n)
        const nonOwn = rows.filter((r) => r.kind !== 'own_move')
        expect(sum(nonOwn).toString(), filter).toBe(summary.revenue_raw)
        expect(sum(nonOwn.filter((r) => r.held_by === 'account')).toString(), filter).toBe(summary.revenue_in_account_raw)
        expect(sum(nonOwn.filter((r) => r.held_by === 'stripe')).toString(), filter).toBe(summary.received_in_stripe.amount_raw)
        expect(summary.by_day.reduce((n: bigint, d: { revenue_raw: string }) => n + BigInt(d.revenue_raw), 0n).toString(), filter)
          .toBe(summary.revenue_raw)
      }
      // the filter reaches the split: product P2 is all Stripe.
      const p2 = (await get(m.userId, `/merchant-sales/summary?${PERIOD}&product_id=P2`)).json()
      expect(p2).toMatchObject({ revenue_raw: '700', revenue_in_account_raw: '0', received_in_stripe: { count: 1, amount_raw: '700' } })
    })
  })

  describe('filters and search (#4959)', () => {
    type Row = { tx_hash: string; kind: string; amount_raw: string; held_by: string; block_time: string }

    /**
     * The summary and the list for one filter set, and every agreement the
     * summary promises checked against the list's rows. Returns both.
     */
    async function agree(userId: string, filter: string) {
      const summaryRes = await get(userId, `/merchant-sales/summary?${PERIOD}${filter}`)
      expect(summaryRes.statusCode, summaryRes.body).toBe(200)
      const summary = summaryRes.json()
      const listRes = await get(userId, `/merchant-sales/payments?${PERIOD}&limit=200${filter}`)
      expect(listRes.statusCode, listRes.body).toBe(200)
      const list = listRes.json()
      const rows = list.payments as Row[]
      // #4981: every figure reads the list's rows wherever the money landed;
      // a Stripe-held sale is a sale, and the split is the one part of it.
      const acct = rows
      const sum = (rs: Row[]) => rs.reduce((n, r) => n + BigInt(r.amount_raw), 0n)

      expect(list.total).toBe(rows.length)
      expect(list.next_cursor).toBeNull()
      expect(sum(acct.filter((r) => r.kind !== 'own_move'))).toBe(BigInt(summary.revenue_raw))
      expect(acct.filter((r) => r.kind === 'sale')).toHaveLength(summary.sales)
      expect(acct.filter((r) => r.kind === 'no_product')).toHaveLength(summary.without_product.count)
      expect(sum(acct.filter((r) => r.kind === 'no_product'))).toBe(BigInt(summary.without_product.amount_raw))
      expect(acct.filter((r) => r.kind === 'own_move')).toHaveLength(summary.own_moves.count)
      const stripe = rows.filter((r) => r.held_by === 'stripe' && r.kind !== 'own_move')
      expect(summary.received_in_stripe).toEqual({ count: stripe.length, amount_raw: sum(stripe).toString() })
      const inAccount = rows.filter((r) => r.held_by === 'account' && r.kind !== 'own_move')
      expect(summary.revenue_in_account_raw).toBe(sum(inAccount).toString())
      expect(BigInt(summary.revenue_in_account_raw) + BigInt(summary.received_in_stripe.amount_raw))
        .toBe(BigInt(summary.revenue_raw))
      // average: the total over every payment counted, rounded down.
      const counted = summary.sales + summary.without_product.count
      expect(summary.average_sale_raw).toBe(counted === 0 ? '0' : (BigInt(summary.revenue_raw) / BigInt(counted)).toString())

      const productSum = (summary.by_product as Array<{ amount_raw: string }>).reduce((n, p) => n + BigInt(p.amount_raw), 0n)
      expect(productSum + BigInt(summary.by_product_other.amount_raw) + BigInt(summary.without_product.amount_raw))
        .toBe(BigInt(summary.revenue_raw))
      const payerSum = (summary.by_payer as Array<{ amount_raw: string }>).reduce((n, p) => n + BigInt(p.amount_raw), 0n)
      expect(payerSum + BigInt(summary.by_payer_other.amount_raw) + BigInt(summary.unattributed.amount_raw))
        .toBe(BigInt(summary.revenue_raw))
      for (const d of summary.by_day as Array<{
        day: string; revenue_raw: string; without_product_raw: string; other_products_raw: string; in_stripe_raw: string
        by_product: Array<{ amount_raw: string }>
      }>) {
        const parts = d.by_product.reduce((n, p) => n + BigInt(p.amount_raw), 0n) +
          BigInt(d.other_products_raw) + BigInt(d.without_product_raw)
        expect(parts, d.day).toBe(BigInt(d.revenue_raw))
        const dayRows = acct.filter((r) => r.kind !== 'own_move' && r.block_time.slice(0, 10) === d.day)
        expect(sum(dayRows), d.day).toBe(BigInt(d.revenue_raw))
        expect(sum(dayRows.filter((r) => r.held_by === 'stripe')), d.day).toBe(BigInt(d.in_stripe_raw))
      }
      return { summary, rows }
    }

    /** The agreement fixture, plus a Stripe-held sale of P1 from wallet4 with receipt "STR-77" (#4981: part of the revenue figures). */
    async function seedFilterFixture() {
      const f = await seedAgreementFixture()
      await insertMerchantSale({
        accountId: f.m.accountId,
        userId: f.m.userId,
        chainId: CHAIN,
        txHash: hash(0x8a),
        recordVersion: 1,
        productId: 'P1',
        productName: 'Product one',
        merchantReference: 'ref-stripe',
        receiptNumber: 'STR-77',
        vatTreatment: null,
        amountRaw: '70000',
        tokenAddress: USDC,
        payerAddress: f.wallet4,
        severalPayers: false,
        senderIsOwnAddress: false,
        blockNumber: 100,
        blockTime: new Date('2026-11-20T10:00:00Z'),
        heldBy: 'stripe',
        receivingAddress: addr(),
      })
      return f
    }

    const txs = (rows: Row[]) => rows.map((r) => r.tx_hash).sort()

    it('each filter alone, two combined and the search: the summary is cut from the same rows as the list', async () => {
      const { m, contact, wallet4 } = await seedFilterFixture()

      // no filter: everything, the Stripe-held sale included in revenue and split out.
      const all = await agree(m.userId, '')
      expect(all.rows).toHaveLength(10)
      expect(all.summary.received_in_stripe).toEqual({ count: 1, amount_raw: '70000' })

      // kind alone, repeated.
      const kinds = await agree(m.userId, '&kind=no_product&kind=own_move')
      expect(new Set(kinds.rows.map((r) => r.kind))).toEqual(new Set(['no_product', 'own_move']))
      expect(kinds.rows).toHaveLength(6)
      expect(kinds.summary.sales).toBe(0)
      expect(kinds.summary.by_product).toEqual([])

      // product alone: P1's sales only, the Stripe-held one too.
      const p1 = await agree(m.userId, '&product_id=P1')
      expect(txs(p1.rows)).toEqual([hash(0xa), hash(0x8a)].sort())
      expect(p1.summary.revenue_raw).toBe('1070000')
      expect(p1.summary.revenue_in_account_raw).toBe('1000000')
      expect(p1.summary.received_in_stripe).toEqual({ count: 1, amount_raw: '70000' })
      // a product id on an own move (G's P9) is not a sale and never matches.
      expect((await agree(m.userId, '&product_id=P9')).rows).toEqual([])

      // payer alone: the contact's three payments.
      const byContact = await agree(m.userId, `&payer=${contact.toUpperCase().replace('0X', '0x')}`)
      expect(txs(byContact.rows)).toEqual([hash(0xa), hash(0xc), hash(0x1)].sort())
      expect(byContact.summary.revenue_raw).toBe('1550000')

      // two combined: wallet4's payments without a product (D and the last-second one, not the Stripe sale).
      const combined = await agree(m.userId, `&payer=${wallet4}&kind=no_product`)
      expect(txs(combined.rows)).toEqual([hash(0xd), hash(0x6)].sort())
      expect(combined.summary.revenue_raw).toBe('210000')
      expect(combined.summary.received_in_stripe).toEqual({ count: 0, amount_raw: '0' })

      // the search, by the contact's name, case-folded.
      const alice = await agree(m.userId, '&q=aLiC')
      expect(txs(alice.rows)).toEqual(txs(byContact.rows))
      // by product label
      expect(txs((await agree(m.userId, '&q=product%20two')).rows)).toEqual([hash(0xb)])
      // by receipt number, substring, case-folded
      expect(txs((await agree(m.userId, '&q=str-7')).rows)).toEqual([hash(0x8a)])
      // by an own account's name: F, the own move from "Main"
      expect(txs((await agree(m.userId, '&q=main')).rows)).toEqual([hash(0xf)])
      // the merchant's reference is not searched
      expect((await agree(m.userId, '&q=ref-stripe')).rows).toEqual([])
      // LIKE wildcards in the term are literal: `__` and `%%` match no receipt
      // ("R-1", "STR-77"), where unescaped they would match every one.
      expect((await agree(m.userId, '&q=__')).rows).toEqual([])
      expect((await agree(m.userId, '&q=%25%25')).rows).toEqual([])
      expect(txs((await agree(m.userId, '&q=r-_')).rows)).toEqual([])
      // search and a filter combined
      expect(txs((await agree(m.userId, '&q=alice&kind=no_product')).rows)).toEqual([hash(0xc)])
    })

    it('a payment from several payers matches any of its payers, and stays unattributed by payer', async () => {
      const { m } = await seedFilterFixture()
      const legs = await db.query<{ payer_address: string }>(
        `SELECT LOWER(payer_address) AS payer_address FROM inbound_transfers WHERE LOWER(tx_hash) = $1 ORDER BY log_index`,
        [hash(0xe)],
      )
      const [wallet5, wallet6] = legs.rows.map((r) => r.payer_address)
      for (const payer of [wallet5, wallet6]) {
        const { summary, rows } = await agree(m.userId, `&payer=${payer}`)
        expect(txs(rows)).toEqual([hash(0xe)])
        expect(summary.by_payer).toEqual([])
        expect(summary.unattributed).toEqual({ payments: 1, amount_raw: '100000' })
      }
      // the search by an address prefix matches a leg too
      expect(txs((await agree(m.userId, `&q=${wallet6.slice(0, 12)}`)).rows)).toEqual([hash(0xe)])
      // the shortest prefix is `0x` and four hex digits; three are not an address
      expect(txs((await agree(m.userId, `&q=${wallet6.slice(0, 6)}`)).rows)).toContain(hash(0xe))
      expect((await agree(m.userId, `&q=${wallet6.slice(0, 5)}`)).rows).toEqual([])
    })

    it("never matches another Haven user's account or agent by name; that wallet is found by its address only", async () => {
      const m = await seedMerchant()
      const other = await seedUser()
      const strangersAgent = addr()
      const strangersAccount = addr()
      await db.query(`INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Zebra agent', $2, 'active')`, [other, strangersAgent])
      await db.query(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, name)
         VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', true, 'Zebra account')`,
        [other, strangersAccount, CHAIN],
      )
      // both of the other user's wallets pay this merchant
      await seedLeg(m, { tx: hash(0x8b), payer: strangersAgent, amount: '100', time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x8c), payer: strangersAccount, amount: '200', time: '2026-11-10T11:00:00Z' })
      expect(txs((await agree(m.userId, '')).rows)).toEqual([hash(0x8b), hash(0x8c)].sort())
      for (const term of ['zebra', 'zebra%20agent', 'zebra%20account']) {
        const { summary, rows } = await agree(m.userId, `&q=${term}`)
        expect(rows, term).toEqual([])
        expect(summary.revenue_raw, term).toBe('0')
      }
      for (const [wallet, tx] of [[strangersAgent, hash(0x8b)], [strangersAccount, hash(0x8c)]] as const) {
        expect(txs((await agree(m.userId, `&q=${wallet.slice(0, 10)}`)).rows)).toEqual([tx])
        expect(txs((await agree(m.userId, `&payer=${wallet}`)).rows)).toEqual([tx])
      }
    })

    it('a malformed filter is the plugin\'s 400 invalid_request; an unknown parameter is ignored', async () => {
      const m = await seedMerchant()
      for (const bad of ['kind=refund', 'payer=0x1234', 'q=a', 'q=%20%20%20', 'product_id=', `q=${'x'.repeat(101)}`]) {
        for (const path of ['summary', 'payments']) {
          const res = await get(m.userId, `/merchant-sales/${path}?${PERIOD}&${bad}`)
          expect(res.statusCode, `${path} ${bad}`).toBe(400)
          expect(res.json().error_code, `${path} ${bad}`).toBe('invalid_request')
        }
      }
      expect((await get(m.userId, `/merchant-sales/payments?${PERIOD}&colour=blue`)).statusCode).toBe(200)
    })

    it("last_paid_at is the newest of the payer's revenue payments in the period", async () => {
      const { m, contact, wallet4 } = await seedFilterFixture()
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      const lastOf = (a: string) =>
        (summary.by_payer as Array<{ payer: { address: string }; last_paid_at: string }>)
          .find((p) => p.payer.address === a.toLowerCase())?.last_paid_at
      expect(lastOf(contact)).toBe('2026-11-13T10:00:00.000Z') // I, not A or C
      // wallet4's newest payment is the last second of the period; its
      // Stripe-held sale (11-20) is in by_payer too (#4981) but is older.
      expect(lastOf(wallet4)).toBe('2026-11-30T23:59:59.000Z')
      // the out-of-period payment of 12-01 is not it either
      const november = (await get(m.userId, '/merchant-sales/summary?from=2026-11-01&to=2026-11-29')).json()
      expect(
        (november.by_payer as Array<{ payer: { address: string }; last_paid_at: string }>)
          .find((p) => p.payer.address === wallet4.toLowerCase())?.last_paid_at,
      ).toBe('2026-11-20T10:00:00.000Z') // the Stripe-held sale of 11-20 is the newest before 11-29
    })

    it('the facets name every product and payer of the period, unfiltered, and total counts the filter set', async () => {
      const { m, contact, wallet4, otherAccount, oldDelegate } = await seedFilterFixture()
      const legs = await db.query<{ payer_address: string }>(
        `SELECT DISTINCT LOWER(payer_address) AS payer_address FROM inbound_transfers WHERE LOWER(tx_hash) IN ($1, $2)`,
        [hash(0xb), hash(0xe)],
      )
      const res = await get(m.userId, `/merchant-sales/facets?${PERIOD}&kind=sale`)
      expect(res.statusCode).toBe(200)
      const facets = res.json()
      expect(facets.products).toEqual([
        { product_id: 'P1', label: 'Product one' },
        { product_id: 'P2', label: 'Product two' },
        { product_id: 'P3', label: 'Product three' },
      ])
      const payers = (facets.payers as Array<{ address: string; kind: string; name: string | null }>)
      expect(payers.map((p) => p.address).sort()).toEqual(
        [contact, wallet4, otherAccount, oldDelegate, ...legs.rows.map((r) => r.payer_address)].map((a) => a.toLowerCase()).sort(),
      )
      expect(payers.find((p) => p.address === contact.toLowerCase())).toEqual({ kind: 'contact', name: 'Alice', address: contact.toLowerCase() })

      const page = (await get(m.userId, `/merchant-sales/payments?${PERIOD}&limit=2&kind=no_product`)).json()
      expect(page.payments).toHaveLength(2)
      expect(page.next_cursor).not.toBeNull()
      expect(page.total).toBe(4)
    })
  })

  describe('the product label', () => {
    it('is the catalogue name, else the record name, else the product id', async () => {
      const m = await seedMerchant()
      await db.query(
        `INSERT INTO merchant_products (merchant_account_id, product_id, name, price_atomic, network)
         VALUES ($1, 'in-catalogue', 'Catalogue name', '1', 'eip155:84532'),
                ($1, 'catalogue-no-name', NULL, '1', 'eip155:84532')`,
        [m.accountId],
      )
      // #4959: a product no longer offered keeps its catalogue name on past sales.
      await db.query(
        `INSERT INTO merchant_products (merchant_account_id, product_id, name, price_atomic, network, offered)
         VALUES ($1, 'retired', 'Retired name', '1', 'eip155:84532', false)`,
        [m.accountId],
      )
      const sales: Array<[string, string, string | null, string]> = [
        [hash(0x91), 'in-catalogue', 'Record name', '2026-11-10T10:00:00Z'],
        [hash(0x92), 'only-in-record', 'Record name', '2026-11-10T11:00:00Z'],
        [hash(0x93), 'nowhere', null, '2026-11-10T12:00:00Z'],
        [hash(0x94), 'catalogue-no-name', 'Record name', '2026-11-10T13:00:00Z'],
        [hash(0x95), 'retired', 'Old record name', '2026-11-10T14:00:00Z'],
      ]
      for (const [tx, productId, name, time] of sales) {
        await seedLeg(m, { tx, payer: addr(), amount: '100', time })
        await seedSale(m, { tx, productId, productName: name, amount: '100', payer: addr(), time })
      }
      const rows = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments as Array<{
        product_id: string
        product_label: string
      }>
      const labelOf = (id: string) => rows.find((r) => r.product_id === id)?.product_label
      expect(labelOf('in-catalogue')).toBe('Catalogue name')
      expect(labelOf('only-in-record')).toBe('Record name')
      expect(labelOf('nowhere')).toBe('nowhere')
      expect(labelOf('catalogue-no-name')).toBe('Record name')
      expect(labelOf('retired')).toBe('Retired name')

      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      const byLabel = Object.fromEntries(
        (summary.by_product as Array<{ product_id: string; label: string }>).map((p) => [p.product_id, p.label]),
      )
      expect(byLabel).toMatchObject({ 'in-catalogue': 'Catalogue name', 'only-in-record': 'Record name', nowhere: 'nowhere' })
    })
  })

  describe('payer kinds', () => {
    it('is a contact, an own address or a wallet, and another Haven user\'s agent is a wallet', async () => {
      const m = await seedMerchant()
      const other = await seedUser()
      const contact = addr()
      const ownAgent = addr()
      const strangersAgent = addr()
      const strangersAccount = addr()
      await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Bob', $2)`, [m.userId, contact])
      await db.query(`INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Mine', $2, 'revoked')`, [m.userId, ownAgent])
      // another Haven user's agent and account — and a contact entry of THAT user
      await db.query(`INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Their agent', $2, 'active')`, [other, strangersAgent])
      await db.query(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, name)
         VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', true, 'Their account')`,
        [other, strangersAccount, CHAIN],
      )
      await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Not yours', $2)`, [other, addr()])
      let i = 0
      for (const payer of [contact, ownAgent, strangersAgent, strangersAccount]) {
        i += 1
        await seedLeg(m, { tx: hash(0xa0 + i), payer, amount: '100', own: payer === ownAgent, time: `2026-11-10T1${i}:00:00Z` })
      }
      const list = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments as Array<{
        tx_hash: string
        payer: { kind: string; name: string | null; address: string }
      }>
      const payerOf = (n: number) => list.find((r) => r.tx_hash === hash(0xa0 + n))!.payer
      expect(payerOf(1)).toEqual({ kind: 'contact', name: 'Bob', address: contact.toLowerCase() })
      expect(payerOf(2)).toEqual({ kind: 'own', name: 'Mine', address: ownAgent.toLowerCase() })
      expect(payerOf(3)).toEqual({ kind: 'wallet', name: null, address: strangersAgent.toLowerCase() })
      expect(payerOf(4)).toEqual({ kind: 'wallet', name: null, address: strangersAccount.toLowerCase() })
      // nothing in the body names the other user's agent, account or name.
      const body = JSON.stringify(list) + JSON.stringify((await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json())
      expect(body).not.toContain('Their agent')
      expect(body).not.toContain('Their account')
    })
  })

  describe('keyset paging', () => {
    it('walks every payment once, newest first, including payments in the same block', async () => {
      const m = await seedMerchant()
      const sameTime = '2026-11-10T10:00:00Z'
      for (let n = 1; n <= 7; n += 1) {
        await seedLeg(m, { tx: hash(0x500 + n), payer: addr(), amount: '1', time: n <= 4 ? sameTime : `2026-11-1${n}T10:00:00Z` })
      }
      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const url: string = `/merchant-sales/payments?limit=3${cursor ? `&cursor=${cursor}` : ''}`
        const page = (await get(m.userId, url)).json() as { payments: Array<{ tx_hash: string }>; next_cursor: string | null }
        seen.push(...page.payments.map((p) => p.tx_hash))
        cursor = page.next_cursor
        pages += 1
      } while (cursor !== null && pages < 10)
      expect(pages).toBe(3)
      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
      // (block_time DESC, tx_hash DESC): the three later blocks, then the four
      // payments of one block in descending hash order.
      expect(seen.slice(0, 3)).toEqual([hash(0x507), hash(0x506), hash(0x505)])
      expect(seen.slice(3)).toEqual([hash(0x504), hash(0x503), hash(0x502), hash(0x501)])
    })

    it('defaults to 50 rows, refuses a limit above 200 and a cursor this list did not issue', async () => {
      const m = await seedMerchant()
      await db.query(
        `INSERT INTO inbound_transfers (account_id, user_id, chain_id, tx_hash, log_index, payer_address,
                                        token_address, amount_raw, block_number, block_time)
         SELECT $1, $2, $3, '0x' || lpad(to_hex(g + 4096), 64, '0'), 0, '0x' || lpad(to_hex(g), 40, '0'),
                $4, '1', 100, TIMESTAMPTZ '2026-11-10T10:00:00Z' + (g || ' minutes')::interval
           FROM generate_series(1, 51) g`,
        [m.accountId, m.userId, CHAIN, USDC],
      )
      const first = (await get(m.userId, '/merchant-sales/payments')).json()
      expect(first.payments).toHaveLength(50)
      expect(first.next_cursor).not.toBeNull()
      const capped = (await get(m.userId, '/merchant-sales/payments?limit=200')).json()
      expect(capped.payments).toHaveLength(51)
      expect(capped.next_cursor).toBeNull()
      expect((await get(m.userId, '/merchant-sales/payments?limit=201')).statusCode).toBe(400)
      expect((await get(m.userId, '/merchant-sales/payments?limit=0')).statusCode).toBe(400)
      const bad = await get(m.userId, '/merchant-sales/payments?cursor=not-a-cursor')
      expect(bad.statusCode).toBe(400)
      expect(bad.json().error_code).toBe('INVALID_CURSOR')
      expect((await get(m.userId, '/merchant-sales/payments?from=2026-02-31')).json().error_code).toBe('INVALID_PERIOD')
      expect((await get(m.userId, '/merchant-sales/payments?from=2026-12-02&to=2026-12-01')).json().error_code).toBe('INVALID_PERIOD')
      expect((await get(m.userId, '/merchant-sales/payments?from=yesterday')).statusCode).toBe(400)
    })

    it('answers 400 INVALID_CURSOR, never 500, for a cursor whose timestamp is not a real one', async () => {
      const m = await seedMerchant()
      for (const time of ['2026-13-45 99:99:99+00', '2026-02-31 10:00:00+00', '2026-11-10 24:00:00+00', '2026-11-10 10:00:00+99']) {
        const cursor = Buffer.from(`${time}|${hash(1)}`, 'utf8').toString('base64url')
        const res = await get(m.userId, `/merchant-sales/payments?cursor=${cursor}`)
        expect(res.statusCode, time).toBe(400)
        expect(res.json().error_code).toBe('INVALID_CURSOR')
      }
    })
  })

  describe('breakdowns past the top 100', () => {
    it('names the top 100 products and payers, folds the rest, and counts the 100th exactly once', async () => {
      const m = await seedMerchant()
      // 101 sales, each its own product and its own payer, amounts 1000 .. 101000.
      await db.query(
        `INSERT INTO inbound_transfers (account_id, user_id, chain_id, tx_hash, log_index, payer_address,
                                        token_address, amount_raw, block_number, block_time)
         SELECT $1, $2, $3, '0x' || lpad(to_hex(g + 8192), 64, '0'), 0, '0x' || lpad(to_hex(g + 100000), 40, '0'),
                $4, (g * 1000)::text, 100, TIMESTAMPTZ '2026-11-10T10:00:00Z' + (g || ' minutes')::interval
           FROM generate_series(1, 101) g`,
        [m.accountId, m.userId, CHAIN, USDC],
      )
      await db.query(
        `INSERT INTO merchant_sales (account_id, user_id, chain_id, tx_hash, product_id, merchant_reference,
                                     amount_raw, token_address, payer_address, block_number, block_time)
         SELECT account_id, user_id, chain_id, tx_hash, 'product-' || lpad(amount_raw, 7, '0'), 'r-' || tx_hash,
                amount_raw::numeric, token_address, payer_address, 100, block_time
           FROM inbound_transfers WHERE account_id = $1`,
        [m.accountId],
      )
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      const revenue = 1000n * (101n * 102n) / 2n
      expect(BigInt(summary.revenue_raw)).toBe(revenue)

      expect(summary.by_product).toHaveLength(100)
      expect(summary.by_product_other).toEqual({ products: 1, sales: 1, amount_raw: '1000' })
      const productIds = summary.by_product.map((p: { product_id: string }) => p.product_id)
      expect(new Set(productIds).size).toBe(100)
      expect(productIds[99]).toBe('product-0002000') // the 100th, in the list and not in the fold
      expect(productIds).not.toContain('product-0001000')
      const productSum = summary.by_product.reduce((n: bigint, p: { amount_raw: string }) => n + BigInt(p.amount_raw), 0n)
      expect(productSum + BigInt(summary.by_product_other.amount_raw)).toBe(revenue)

      expect(summary.by_payer).toHaveLength(100)
      expect(summary.by_payer_other).toEqual({ payers: 1, payments: 1, amount_raw: '1000' })
      expect(summary.by_payer[99].amount_raw).toBe('2000')
      const payerSum = summary.by_payer.reduce((n: bigint, p: { amount_raw: string }) => n + BigInt(p.amount_raw), 0n)
      expect(payerSum + BigInt(summary.by_payer_other.amount_raw) + BigInt(summary.unattributed.amount_raw)).toBe(revenue)

      // #4959: the day's sales by product follow the same top 100 and fold the rest.
      expect(summary.by_day).toHaveLength(1)
      const [day] = summary.by_day
      expect(day.by_product).toHaveLength(100)
      expect(day.by_product.map((p: { product_id: string }) => p.product_id)).toEqual(productIds)
      expect(day.other_products_raw).toBe('1000')
      expect(day.without_product_raw).toBe('0')

      // #4959: the facets are not capped at 100.
      const facets = (await get(m.userId, `/merchant-sales/facets?${PERIOD}`)).json()
      expect(facets.products).toHaveLength(101)
      expect(facets.payers).toHaveLength(101)
    })
  })

  describe('the own-flag backfill (migration 133)', () => {
    it('turns rows stamped false from the owner\'s own account, agent delegate and rotated-out delegate into own moves, and another user\'s delegate stays a wallet', async () => {
      const m = await seedMerchant()
      const other = await seedUser()
      const delegate = addr()
      const rotated = addr()
      const strangers = addr()
      const secondAccount = addr()
      await db.query(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
         VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', true)`,
        [m.userId, secondAccount, CHAIN],
      )
      const agent = await db.query<{ id: string }>(
        `INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Research agent', $2, 'active') RETURNING id`,
        [m.userId, delegate],
      )
      await db.query(
        `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address) VALUES ($1, $2, $3, $4)`,
        [agent.rows[0].id, m.userId, rotated, delegate],
      )
      await db.query(`INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Theirs', $2, 'active')`, [other, strangers])
      await seedLeg(m, { tx: hash(0xb1), payer: delegate, amount: '700', own: false, time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0xb2), payer: rotated, amount: '300', own: false, time: '2026-11-10T11:00:00Z' })
      await seedLeg(m, { tx: hash(0xb3), payer: strangers, amount: '50', own: false, time: '2026-11-10T12:00:00Z' })
      await seedLeg(m, { tx: hash(0xb4), payer: secondAccount, amount: '2000', own: false, time: '2026-11-10T13:00:00Z' })

      // before: all four count as revenue, though three payers read `own`
      let summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('3050')

      const client = await db.connect()
      try {
        await backfillOwnFlag(client)
      } finally {
        client.release()
      }

      summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary.revenue_raw).toBe('50')
      expect(summary.own_moves).toEqual({ count: 3, amount_raw: '3000' })
      const rows = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments as Array<{
        tx_hash: string
        kind: string
        payer: { kind: string; name: string | null }
      }>
      const byTx = (n: number) => rows.find((r) => r.tx_hash === hash(n))!
      expect(byTx(0xb1)).toMatchObject({ kind: 'own_move', payer: { kind: 'own', name: 'Research agent' } })
      expect(byTx(0xb2)).toMatchObject({ kind: 'own_move', payer: { kind: 'own' } })
      expect(byTx(0xb3)).toMatchObject({ kind: 'no_product', payer: { kind: 'wallet' } })
      expect(byTx(0xb4)).toMatchObject({ kind: 'own_move', payer: { kind: 'own' } })
    })
  })

  describe('one payment', () => {
    it('carries its transfer legs and the merchant\'s own fields', async () => {
      const m = await seedMerchant()
      const p1 = addr()
      const p2 = addr()
      await seedLeg(m, { tx: hash(0x600), payer: p1, amount: '300', logIndex: 0, time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x600), payer: p2, amount: '200', logIndex: 1, time: '2026-11-10T10:00:00Z' })
      await seedLeg(m, { tx: hash(0x600), payer: p2, amount: '0', logIndex: 2, time: '2026-11-10T10:00:00Z' })
      await seedSale(m, {
        tx: hash(0x600), productId: 'P', productName: 'Thing', amount: '500', payer: null, several: true,
        time: '2026-11-10T10:00:00Z', receipt: 'FAK-1', vat: 'REVERSE_CHARGE',
      })
      const res = await get(m.userId, `/merchant-sales/payments/${hash(0x600).toUpperCase().replace('0X', '0x')}`)
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({
        tx_hash: hash(0x600),
        kind: 'sale',
        amount_raw: '500',
        product_label: 'Thing',
        receipt_number: 'FAK-1',
        vat_treatment: 'REVERSE_CHARGE',
        held_by: 'account',
        several_payers: true,
        payer: null,
        merchant_reference: `ref-${hash(0x600).slice(-6)}`,
      })
      expect(body.legs).toEqual([
        { log_index: 0, payer: { kind: 'wallet', name: null, address: p1.toLowerCase() }, amount_raw: '300' },
        { log_index: 1, payer: { kind: 'wallet', name: null, address: p2.toLowerCase() }, amount_raw: '200' },
      ])
    })
  })

  describe('scoping', () => {
    it('reads only the caller\'s merchant account: another user\'s payments, and the caller\'s other accounts, never appear', async () => {
      const a = await seedMerchant()
      const b = await seedMerchant()
      await seedLeg(a, { tx: hash(0x700), payer: addr(), amount: '111', time: '2026-11-10T10:00:00Z' })
      await seedLeg(b, { tx: hash(0x701), payer: addr(), amount: '222', time: '2026-11-10T10:00:00Z' })
      await seedSale(b, { tx: hash(0x701), productId: 'B-only', amount: '222', payer: addr(), time: '2026-11-10T10:00:00Z' })
      // a payment into a NON-merchant account of user A
      const plain = await db.query<{ id: string }>(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
         VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', true) RETURNING id`,
        [a.userId, addr(), CHAIN],
      )
      await seedLeg({ ...a, accountId: plain.rows[0].id }, { tx: hash(0x702), payer: addr(), amount: '333', time: '2026-11-10T10:00:00Z' })

      const summaryA = (await get(a.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summaryA.revenue_raw).toBe('111')
      expect(summaryA.by_product).toEqual([])
      const listA = (await get(a.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments
      expect(listA.map((r: { tx_hash: string }) => r.tx_hash)).toEqual([hash(0x700)])
      expect((await get(a.userId, `/merchant-sales/payments/${hash(0x701)}`)).statusCode).toBe(404)
      expect((await get(a.userId, `/merchant-sales/payments/${hash(0x702)}`)).statusCode).toBe(404)
    })

    it('another user cannot clear a record, and the record stands', async () => {
      const a = await seedMerchant()
      const b = await seedMerchant()
      await seedLeg(a, { tx: hash(0x710), payer: addr(), amount: '5', time: '2026-11-10T10:00:00Z' })
      await seedSale(a, { tx: hash(0x710), productId: 'P', amount: '5', payer: addr(), time: '2026-11-10T10:00:00Z' })
      const res = await clear(b.userId, hash(0x710))
      expect(res.statusCode).toBe(404)
      const count = await db.query(`SELECT 1 FROM merchant_sales WHERE account_id = $1`, [a.accountId])
      expect(count.rowCount).toBe(1)
    })
  })

  describe('merchant services off, or no merchant account', () => {
    it('reads as the empty state, and the clear answers 409', async () => {
      const off = await seedMerchant({ enabled: false })
      await seedLeg(off, { tx: hash(0x720), payer: addr(), amount: '5', time: '2026-11-10T10:00:00Z' })
      const none = await seedUser()
      for (const userId of [off.userId, none]) {
        const summary = (await get(userId, `/merchant-sales/summary?${PERIOD}`)).json()
        expect(summary).toMatchObject({ revenue_raw: '0', sales: 0, by_product: [], by_payer: [], by_day: [], usdc_rates: null })
        expect((await get(userId, `/merchant-sales/payments?${PERIOD}`)).json()).toEqual({ payments: [], next_cursor: null, total: 0, usdc_rates: null })
        expect((await get(userId, `/merchant-sales/facets?${PERIOD}`)).json()).toEqual({ products: [], payers: [] })
        expect((await get(userId, `/merchant-sales/payments/${hash(0x720)}`)).statusCode).toBe(404)
        const res = await clear(userId, hash(0x720))
        expect(res.statusCode).toBe(409)
        expect(res.json().error_code).toBe('MERCHANT_ACCOUNT_REQUIRED')
      }
    })
  })

  describe('the display rate (#4963)', () => {
    async function seedOneSale() {
      const m = await seedMerchant()
      await seedLeg(m, { tx: hash(0x800), payer: addr(), amount: '1000000', time: '2026-11-10T10:00:00Z' })
      await seedSale(m, { tx: hash(0x800), productId: 'P', amount: '1000000', payer: addr(), time: '2026-11-10T10:00:00Z' })
      return m
    }

    it('carries the USDC rate on the summary, the page and the detail, read for the chain\'s settlement token', async () => {
      const m = await seedOneSale()
      const rates = { usd: 0.9998, eur: 0.92, sek: 10.4 }
      expect((await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json().usdc_rates).toEqual(rates)
      expect((await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().usdc_rates).toEqual(rates)
      const detail = await get(m.userId, `/merchant-sales/payments/${hash(0x800)}`)
      expect(detail.statusCode, detail.body).toBe(200)
      expect(detail.json().usdc_rates).toEqual(rates)
      // the symbol is the registry's settlement token for the account's chain
      expect(mocks.price).toHaveBeenCalledWith('USDC')
    })

    it('puts the rate on the detail only once, never on each row of the page', async () => {
      const m = await seedOneSale()
      const page = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json()
      expect(page.payments[0]).not.toHaveProperty('usdc_rates')
    })

    it('nulls only the currency with no usable quote', async () => {
      const m = await seedOneSale()
      mocks.price.mockResolvedValue({ usd: 1, eur: 0, sek: 10.4 })
      const expected = { usd: 1, eur: null, sek: 10.4 }
      expect((await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json().usdc_rates).toEqual(expected)
      expect((await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().usdc_rates).toEqual(expected)
      expect((await get(m.userId, `/merchant-sales/payments/${hash(0x800)}`)).json().usdc_rates).toEqual(expected)
    })

    it('answers null for the rate, and still every figure, when the price read fails', async () => {
      const m = await seedOneSale()
      mocks.price.mockRejectedValue(new Error('CoinGecko down'))
      const summary = await get(m.userId, `/merchant-sales/summary?${PERIOD}`)
      expect(summary.statusCode, summary.body).toBe(200)
      expect(summary.json()).toMatchObject({ revenue_raw: '1000000', sales: 1, usdc_rates: null })
      const page = await get(m.userId, `/merchant-sales/payments?${PERIOD}`)
      expect(page.json().payments).toHaveLength(1)
      expect(page.json().usdc_rates).toBeNull()
      const detail = await get(m.userId, `/merchant-sales/payments/${hash(0x800)}`)
      expect(detail.statusCode).toBe(200)
      expect(detail.json().usdc_rates).toBeNull()
    })

    it('does not read a price for the Sales-off answers, which carry null', async () => {
      const off = await seedMerchant({ enabled: false })
      expect((await get(off.userId, `/merchant-sales/summary?${PERIOD}`)).json().usdc_rates).toBeNull()
      expect((await get(off.userId, `/merchant-sales/payments?${PERIOD}`)).json().usdc_rates).toBeNull()
      expect(mocks.price).not.toHaveBeenCalled()
    })
  })

  describe('who may call them', () => {
    it('a Sales key reaches none of the five routes', async () => {
      const m = await seedMerchant()
      await seedLeg(m, { tx: hash(0x730), payer: addr(), amount: '5', time: '2026-11-10T10:00:00Z' })
      await seedSale(m, { tx: hash(0x730), productId: 'P', amount: '5', payer: addr(), time: '2026-11-10T10:00:00Z' })
      const key = generateMerchantKey()
      await insertMerchantKey({
        userId: m.userId, accountId: m.accountId, keyHash: key.hash, keyPrefix: key.prefix, createdBy: m.userId,
      })
      const headers = { authorization: `Bearer ${key.secret}` }
      const calls: Array<[string, string]> = [
        ['GET', `/merchant-sales/summary?${PERIOD}`],
        ['GET', `/merchant-sales/payments?${PERIOD}`],
        ['GET', `/merchant-sales/facets?${PERIOD}`],
        ['GET', `/merchant-sales/payments/${hash(0x730)}`],
        ['DELETE', `/merchant-sales/payments/${hash(0x730)}/record`],
      ]
      for (const [method, url] of calls) {
        const res = await app.inject({ method: method as 'GET' | 'DELETE', url, headers })
        expect(res.statusCode, `${method} ${url}`).toBe(401)
      }
      const x = await app.inject({ method: 'DELETE', url: `/merchant-sales/payments/${hash(0x730)}/record`, headers: { 'x-api-key': key.secret } })
      expect(x.statusCode).toBe(401)
      expect((await db.query(`SELECT 1 FROM merchant_sales WHERE account_id = $1`, [m.accountId])).rowCount).toBe(1)
    })

    it('a device-login token cannot clear a record', async () => {
      const m = await seedMerchant()
      await seedLeg(m, { tx: hash(0x731), payer: addr(), amount: '5', time: '2026-11-10T10:00:00Z' })
      await seedSale(m, { tx: hash(0x731), productId: 'P', amount: '5', payer: addr(), time: '2026-11-10T10:00:00Z' })
      const res = await clear(m.userId, hash(0x731), { purpose: 'owner_cli' })
      expect(res.statusCode).toBe(401)
      expect((await db.query(`SELECT 1 FROM merchant_sales WHERE account_id = $1`, [m.accountId])).rowCount).toBe(1)
    })

    it('rate limits the clear route at the money-path ceiling (429 on the 61st call in a minute)', async () => {
      const m = await seedMerchant()
      const headers = { authorization: `Bearer ${token(m.userId, { jti: 'rate-limit-case' })}` }
      const call = () =>
        app.inject({ method: 'DELETE', url: `/merchant-sales/payments/${hash(0x740)}/record`, headers })
      for (let i = 0; i < 60; i += 1) expect((await call()).statusCode).toBe(404)
      expect((await call()).statusCode).toBe(429)
    })

    it('refuses a transaction hash that is not one, through the spec', async () => {
      const m = await seedMerchant()
      expect((await get(m.userId, '/merchant-sales/payments/not-a-hash')).statusCode).toBe(400)
      expect((await clear(m.userId, '0x12')).statusCode).toBe(400)
    })
  })

  describe('clearing a sale record', () => {
    it('deletes the record, keeps the payment with no product, and accepts a new record afterwards', async () => {
      const m = await seedMerchant()
      const key = generateMerchantKey()
      await insertMerchantKey({
        userId: m.userId, accountId: m.accountId, keyHash: key.hash, keyPrefix: key.prefix, createdBy: m.userId,
      })
      const TX = hash(0x800)
      const payer = addr()
      const BLOCK_TIME = new Date('2026-11-17T10:00:00Z')
      mocks.read.mockResolvedValue({
        ok: true,
        receiptFound: true,
        blockNumber: 100,
        latestBlock: 102,
        legs: [{ txHash: TX, logIndex: 4, payerAddress: payer, tokenAddress: USDC, amountRaw: '1000000', blockNumber: 100, blockTime: BLOCK_TIME }],
      })
      const post = (over: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/merchant/sales',
          headers: { authorization: `Bearer ${key.secret}` },
          payload: {
            version: 1, tx_hash: TX, chain: `eip155:${CHAIN}`, product_id: 'first', product_name: 'First',
            amount: '1000000', payer, merchant_reference: 'ref-1', ...over,
          },
        })
      const first = await post({})
      expect(first.statusCode, first.body).toBe(201)

      let row = (await get(m.userId, `/merchant-sales/payments/${TX}`)).json()
      expect(row).toMatchObject({ kind: 'sale', product_id: 'first', amount_raw: '1000000' })

      const cleared = await clear(m.userId, TX)
      expect(cleared.statusCode).toBe(204)
      expect((await db.query(`SELECT 1 FROM merchant_sales WHERE account_id = $1`, [m.accountId])).rowCount).toBe(0)

      // the payment stays, with no product, and still counts as revenue
      row = (await get(m.userId, `/merchant-sales/payments/${TX}`)).json()
      expect(row).toMatchObject({ kind: 'no_product', product_id: null, product_label: null, amount_raw: '1000000', receipt_number: null })
      expect(row.legs).toHaveLength(1)
      const summary = (await get(m.userId, '/merchant-sales/summary')).json()
      expect(summary).toMatchObject({ revenue_raw: '1000000', sales: 0 })
      expect(summary.without_product).toEqual({ count: 1, amount_raw: '1000000' })

      // nothing left to clear
      const again = await clear(m.userId, TX)
      expect(again.statusCode).toBe(404)
      expect(again.json().error_code).toBe('SALE_RECORD_NOT_FOUND')

      // a new record for the same transaction is accepted, and is the one shown
      const second = await post({ product_id: 'second', product_name: 'Second', merchant_reference: 'ref-2' })
      expect(second.statusCode, second.body).toBe(201)
      row = (await get(m.userId, `/merchant-sales/payments/${TX}`)).json()
      expect(row).toMatchObject({ kind: 'sale', product_id: 'second', product_label: 'Second', amount_raw: '1000000' })
    })
  })
})
