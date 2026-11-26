/**
 * #5000 (epic #4885): a sale reads as a sale outside the Sales page.
 *
 * Real DB, real routes. `inbound_transfers` and `merchant_sales` are seeded on
 * the harness; the stubs are collaborators only, exactly as in
 * `dashboard-activity.test.ts`: the three explorer legs (so `aggregate.ts`
 * runs real over them), the portfolio read, the delegation-budget view and the
 * price read. The Sales relation, the merchant setting, the fold, the search
 * and the CSV run real. The feed read's own fire-and-forget ingest into
 * `inbound_transfers` (`aggregate.ts`, #3333) is a no-op here: each test seeds
 * the index itself, so "indexed" and "not indexed yet" are the fixture's
 * choice, never a race with that pass.
 *
 * The four rows of the issue's mapping table, each a test:
 *
 *   | Sales relation `kind` | Feed row                                      |
 *   |-----------------------|-----------------------------------------------|
 *   | `sale`                | sale, with product, receipt number, reference |
 *   | `no_product`          | sale, every record field null                 |
 *   | `own_move`            | not a sale                                    |
 *   | no `pay` row          | not a sale (not indexed yet)                  |
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { createHash } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { explorerMocks, priceMocks, portfolioMocks } = vi.hoisted(() => ({
  explorerMocks: {
    fetchNormalTransactions: vi.fn(async () => ({ rows: [] as unknown[], hasMore: false })),
    fetchInternalTransactions: vi.fn(async () => ({ rows: [] as unknown[], hasMore: false })),
    fetchERC20Transfers: vi.fn(async () => ({ rows: [] as unknown[], hasMore: false })),
  },
  priceMocks: {
    getTokenPrice: vi.fn(async () => ({ usd: 1, eur: 0.9, sek: 10.76 })),
  },
  portfolioMocks: {
    fetchPortfolioForAccount: vi.fn(async () => ({ totalUsd: 1, totalEur: 1, totalSek: 1, breakdown: [] })),
    isPortfolioUnpriceable: vi.fn(() => false),
  },
}))

vi.mock('../../infra/explorer-api.js', () => explorerMocks)
vi.mock('../../infra/prices.js', () => ({ getTokenPrice: priceMocks.getTokenPrice }))
vi.mock('../../rails/delegation-budget-view.js', () => ({
  deriveDelegationAllowances: async () => new Map(),
  deriveDelegationBudgets: async () => new Map(),
}))
vi.mock('../../modules/transactions/receive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/transactions/receive.js')>()
  return { ...actual, ingestInboundTransfers: vi.fn(async () => undefined) }
})
import { combineBalanceFreshness } from '../../modules/accounts/balance-freshness.js'
import { needsBackupSignerRecommendation } from '../../modules/accounts/mainnet-gate.js'
vi.mock('../../modules/accounts/index.js', () => ({
  ...portfolioMocks,
  combineBalanceFreshness,
  needsBackupSignerRecommendation,
}))

import db from '../../db.js'
import dashboardRoutes from '../dashboard.js'
import transactionRoutes from '../transactions.js'
import { FOLDED_TRANSACTION_CSV_COLUMNS, TRANSACTION_CSV_COLUMNS } from '../../modules/transactions/csv-export.js'
import { insertMerchantSale } from '../../infra/repositories/merchant-sales.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const CHAIN = 84532 // Base Sepolia — the registry names USDC there
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TZ = 'UTC'
/** #5000: the folded export's header as it stands today, literally. */
const FOLDED_HEADER =
  'settled_at,type,status,direction,counterparty_name,counterparty_address,token_symbol,token_address,amount,amount_sek,fx_rate,fx_source,fee_sek,chain_id,tx_hash,payment_id,agent_name,initiator,account_address,reporting_currency,converted_currency,settlement_tx_hash,to_account_name'

let seq = 0
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const wallet = (n: number) => `0x${n.toString(16).padStart(4, '0').repeat(10)}`
/** A per-test account address, so the feed's 30 s explorer cache never serves another test's rows. */
const accountAddress = (tag: number) => `0x${tag.toString(16).padStart(2, '0')}${seq.toString(16).padStart(6, '0')}${'0'.repeat(32)}`

interface Fixture {
  userId: string
  sales: { id: string; address: string }
  main: { id: string; address: string }
  delegate: string
}

interface ExplorerRow {
  hash: string
  from: string
  to: string
  value: string
  ts: number
  /** `native` is an ETH leg; everything else is USDC. */
  native?: boolean
}

describeDb('#5000 — a sale reads as a sale on the transaction reads', () => {
  let app: FastifyInstance
  let token: string
  let f: Fixture
  let rows: ExplorerRow[]
  // A few minutes ago: inside today's window, never in the future.
  const now = () => Math.floor(Date.now() / 1000) - 300

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    await resetDb()
    rows = []
    const select = (address: string, native: boolean) =>
      rows.filter(
        (r) =>
          Boolean(r.native) === native &&
          (r.from.toLowerCase() === address.toLowerCase() || r.to.toLowerCase() === address.toLowerCase()),
      )
    explorerMocks.fetchNormalTransactions.mockReset()
    explorerMocks.fetchInternalTransactions.mockReset()
    explorerMocks.fetchERC20Transfers.mockReset()
    explorerMocks.fetchInternalTransactions.mockResolvedValue({ rows: [], hasMore: false })
    explorerMocks.fetchNormalTransactions.mockImplementation((async (_chainId: number, address: string) => ({
      rows: select(address, true).map((r, i) => ({
        blockNumber: String(45_000_000 + i),
        timeStamp: String(r.ts),
        hash: r.hash,
        from: r.from,
        to: r.to,
        value: r.value,
        gas: '21000',
        gasUsed: '21000',
        isError: '0',
        functionName: '',
      })),
      hasMore: false,
    })) as never)
    explorerMocks.fetchERC20Transfers.mockImplementation((async (_chainId: number, address: string) => ({
      rows: select(address, false).map((r, i) => ({
        blockNumber: String(46_000_000 + i),
        timeStamp: String(r.ts),
        hash: r.hash,
        from: r.from,
        to: r.to,
        value: r.value,
        contractAddress: USDC,
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimal: '6',
      })),
      hasMore: false,
    })) as never)
    priceMocks.getTokenPrice.mockReset()
    priceMocks.getTokenPrice.mockResolvedValue({ usd: 1, eur: 0.9, sek: 10.76 })

    f = await seedFixture()
    token = app.jwt.sign({ sub: f.userId, email: 'a5000@test.example' })
  })

  async function seedFixture(): Promise<Fixture> {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`a5000-${++seq}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const account = async (name: string, address: string, merchant: boolean) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, name, is_merchant_account)
         VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', $4, $5) RETURNING id`,
        [userId, address, CHAIN, name, merchant],
      )
      return { id: res.rows[0].id, address }
    }
    const sales = await account('Sales', accountAddress(0x5a), true)
    const main = await account('Main', accountAddress(0x3a), false)
    const delegate = `0x${'ab'.repeat(20)}`
    await db.query(
      `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
       VALUES ($1, 'Shop agent', $2, $3, 'hvn_tst', $4, 'active')`,
      [userId, delegate, createHash('sha256').update(`key-${seq}`).digest('hex'), main.id],
    )
    await setSales(userId, true)
    return { userId, sales, main, delegate }
  }

  async function setSales(userId: string, enabled: boolean): Promise<void> {
    await db.query(
      `INSERT INTO merchant_service_settings (user_id, enabled, enabled_at)
       VALUES ($1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END)
       ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [userId, enabled],
    )
  }

  /** One indexed USDC leg into the Sales account, with its RECORDED own flag. */
  async function indexLeg(tx: string, payer: string, amount: string, ts: number, own = false, logIndex = 0): Promise<void> {
    await db.query(
      `INSERT INTO inbound_transfers
         (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
          amount_raw, block_number, block_time, sender_is_own_address)
       VALUES ($1, $2, $3, $4, $10, $5, $6, $7, 100, to_timestamp($8), $9)`,
      [f.sales.id, f.userId, CHAIN, tx, payer, USDC, amount, ts, own, logIndex],
    )
  }

  async function recordSale(
    tx: string,
    s: { productId: string; productName: string; amount: string; payer: string; ts: number; receipt?: string | null; heldBy?: 'account' | 'stripe' },
  ): Promise<void> {
    await insertMerchantSale({
      accountId: f.sales.id,
      userId: f.userId,
      chainId: CHAIN,
      txHash: tx,
      recordVersion: 1,
      productId: s.productId,
      productName: s.productName,
      merchantReference: `ref-${tx.slice(-4)}`,
      receiptNumber: s.receipt === undefined ? `R-${tx.slice(-4)}` : s.receipt,
      vatTreatment: null,
      amountRaw: s.amount,
      tokenAddress: USDC,
      payerAddress: s.payer,
      severalPayers: false,
      senderIsOwnAddress: false,
      blockNumber: 100,
      blockTime: new Date(s.ts * 1000),
      heldBy: s.heldBy ?? 'account',
      receivingAddress: s.heldBy === 'stripe' ? `0x${'57'.repeat(20)}` : null,
    })
  }

  /** A recorded sale: an explorer row, its indexed leg and its record. */
  async function sale(n: number, productId: string, productName: string, amount = '2500'): Promise<string> {
    const tx = hash(n)
    const buyer = wallet(n)
    rows.push({ hash: tx, from: buyer, to: f.sales.address, value: amount, ts: now() - n })
    await indexLeg(tx, buyer, amount, now() - n)
    await recordSale(tx, { productId, productName, amount, payer: buyer, ts: now() - n })
    return tx
  }

  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    return res
  }
  const list = async (query = '') => {
    const res = await get(`/transactions?fresh=1&limit=100${query}`)
    expect(res.statusCode).toBe(200)
    return res.json() as { transactions: Array<Record<string, unknown>>; total: number; hasMore: boolean }
  }
  const row = (body: { transactions: Array<Record<string, unknown>> }, tx: string, direction = 'in') =>
    body.transactions.find((t) => String(t.hash).toLowerCase() === tx && t.direction === direction)
  const activity = async () => {
    const res = await get(`/dashboard/overview?tz=${TZ}`)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { activity: Array<Record<string, unknown>> }
    expectMatchesSpec('GET', '/dashboard/overview', body)
    return body.activity
  }

  describe('GET /transactions — the four rows of the mapping table', () => {
    it('`sale`: the row carries the product label, receipt number and merchant reference', async () => {
      const tx = await sale(1, 'field-notes', 'Haven Field Notes')
      for (const query of ['', '&foldOwnTransfers=1']) {
        const body = await list(query)
        expectMatchesSpec('GET', '/transactions', body)
        expect(row(body, tx)?.sale).toEqual({
          productName: 'Haven Field Notes',
          receiptNumber: `R-${tx.slice(-4)}`,
          merchantReference: `ref-${tx.slice(-4)}`,
        })
      }
      // Scoped to the Sales account too (the account page's read).
      const scoped = await list(`&accountId=${f.sales.id}`)
      expect(row(scoped, tx)?.sale).toMatchObject({ productName: 'Haven Field Notes' })
      // The product id never leaves the server.
      expect(row(scoped, tx)?.sale).not.toHaveProperty('productId')
    })

    it('`no_product`: a non-own payment with no record is a sale with every record field null', async () => {
      const tx = hash(2)
      rows.push({ hash: tx, from: wallet(2), to: f.sales.address, value: '1999', ts: now() })
      await indexLeg(tx, wallet(2), '1999', now())

      const body = await list()
      expect(row(body, tx)?.sale).toEqual({ productName: null, receiptNumber: null, merchantReference: null })
    })

    it('`own_move`: a payment from the owner\'s own agent (recorded own) is not a sale', async () => {
      const tx = hash(3)
      rows.push({ hash: tx, from: f.delegate, to: f.sales.address, value: '5000', ts: now() })
      await indexLeg(tx, f.delegate, '5000', now(), true)

      const body = await list()
      expect(row(body, tx)).toBeDefined()
      expect(row(body, tx)).not.toHaveProperty('sale')
      // …on the account page's read (`?accountId=`) …
      const scoped = await list(`&accountId=${f.sales.id}`)
      expect(row(scoped, tx)).toBeDefined()
      expect(row(scoped, tx)).not.toHaveProperty('sale')
      // …on the dashboard too: a plain deposit, not a sale group.
      const groups = await activity()
      expect(groups).toHaveLength(1)
      expect(groups[0]).not.toHaveProperty('sale')
    })

    it('no `pay` row: a transfer the merchant index has not written yet is not a sale', async () => {
      const tx = hash(4)
      rows.push({ hash: tx, from: wallet(4), to: f.sales.address, value: '7000', ts: now() })

      const body = await list()
      expect(row(body, tx)).toBeDefined()
      expect(row(body, tx)).not.toHaveProperty('sale')
    })
  })

  describe('precedence and scope', () => {
    it('own money stays own: a transfer from another own account is never a sale, folded or not, even if the recorded flag says otherwise', async () => {
      const tx = hash(5)
      rows.push({ hash: tx, from: f.main.address, to: f.sales.address, value: '9000', ts: now() })
      // The recorded flag disagrees with the live own-account lookup.
      await indexLeg(tx, f.main.address, '9000', now(), false)

      const unfolded = await list()
      expect(row(unfolded, tx, 'in')).toBeDefined()
      expect(row(unfolded, tx, 'in')).not.toHaveProperty('sale')

      const folded = await list('&foldOwnTransfers=1')
      expect(folded.transactions.filter((t) => String(t.hash).toLowerCase() === tx)).toHaveLength(1)
      expect(row(folded, tx, 'out')).toMatchObject({ ownTransfer: { toAccountId: f.sales.id } })
      expect(row(folded, tx, 'out')).not.toHaveProperty('sale')

      // The dashboard folds it into one move, never a sale group.
      const groups = await activity()
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ ownTransfer: { toAccountName: 'Sales' } })
      expect(groups[0]).not.toHaveProperty('sale')
    })

    it('a transaction mixing an own agent\'s leg with a customer\'s: only the customer\'s leg is a sale', async () => {
      // The Sales page reads it as one `no_product` payment (the customer's leg
      // is revenue); on the feed each leg is a row, and own money is never a sale.
      const tx = hash(23)
      rows.push({ hash: tx, from: f.delegate, to: f.sales.address, value: '3000', ts: now() })
      rows.push({ hash: tx, from: wallet(23), to: f.sales.address, value: '7000', ts: now() })
      await indexLeg(tx, f.delegate, '3000', now(), true, 0)
      await indexLeg(tx, wallet(23), '7000', now(), false, 1)

      const body = await list()
      const legs = body.transactions.filter((t) => String(t.hash).toLowerCase() === tx)
      expect(legs).toHaveLength(2)
      const agentLeg = legs.find((t) => String(t.from).toLowerCase() === f.delegate)
      const customerLeg = legs.find((t) => String(t.from).toLowerCase() === wallet(23))
      expect(agentLeg).not.toHaveProperty('sale')
      expect(customerLeg?.sale).toEqual({ productName: null, receiptNumber: null, merchantReference: null })

      // The dashboard: one sale (the customer's) and one deposit (the agent's).
      const groups = await activity()
      expect(groups).toHaveLength(2)
      expect(groups.find((g) => g.sale !== undefined)).toMatchObject({ count: 1, sumAtomic: '7000' })
      expect(groups.find((g) => g.sale === undefined)).toMatchObject({ count: 1, sumAtomic: '3000' })
    })

    it('a Stripe-held sale sharing a hash with a feed row never lends that row its record', async () => {
      const tx = hash(6)
      rows.push({ hash: tx, from: wallet(6), to: f.sales.address, value: '4000', ts: now() })
      await indexLeg(tx, wallet(6), '4000', now())
      await recordSale(tx, { productId: 'stripe-only', productName: 'Stripe product', amount: '4000', payer: wallet(6), ts: now(), heldBy: 'stripe' })

      const body = await list()
      // The account arm says `no_product`; the Stripe arm is never read here.
      expect(body.transactions.filter((t) => String(t.hash).toLowerCase() === tx)).toHaveLength(1)
      expect(row(body, tx)?.sale).toEqual({ productName: null, receiptNumber: null, merchantReference: null })
      const csv = (await get('/transactions/export.csv?fresh=1')).body
      expect(csv).not.toContain('Stripe product')
      const groups = await activity()
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ count: 1, sale: { productName: null } })
    })

    it('another token in the same transaction is never marked', async () => {
      const tx = await sale(7, 'field-notes', 'Haven Field Notes')
      rows.push({ hash: tx, from: wallet(7), to: f.sales.address, value: '1000000000000000', ts: now() - 7, native: true })

      const body = await list()
      const legs = body.transactions.filter((t) => String(t.hash).toLowerCase() === tx)
      expect(legs).toHaveLength(2)
      expect(legs.filter((t) => t.sale !== undefined)).toHaveLength(1)
      expect(String(legs.find((t) => t.sale !== undefined)?.tokenAddress).toLowerCase()).toBe(USDC)
    })

    it('with merchant services off (the account keeps is_merchant_account), no row is marked', async () => {
      const tx = await sale(8, 'field-notes', 'Haven Field Notes')
      await setSales(f.userId, false)

      const body = await list()
      expect(row(body, tx)).toBeDefined()
      expect(row(body, tx)).not.toHaveProperty('sale')
      const groups = await activity()
      expect(groups[0]).not.toHaveProperty('sale')
    })

    it('search matches what the row shows: a recorded sale is found by its product label', async () => {
      const tx = await sale(9, 'field-notes', 'Haven Field Notes')
      rows.push({ hash: hash(10), from: wallet(10), to: f.main.address, value: '19990000', ts: now() })

      const body = await list('&search=field%20notes')
      expect(body.transactions.map((t) => String(t.hash).toLowerCase())).toEqual([tx])
    })
  })

  describe('GET /dashboard/overview activity groups', () => {
    it('the demo: a sub-cent sale into Sales and a $19.99 top-up into another account are two groups, "Sale" and "Deposit"', async () => {
      await sale(11, 'field-notes', 'Haven Field Notes', '2500')
      rows.push({ hash: hash(12), from: wallet(12), to: f.main.address, value: '19990000', ts: now() })

      const groups = await activity()
      expect(groups).toHaveLength(2)
      const saleGroup = groups.find((g) => g.sale !== undefined)
      const deposit = groups.find((g) => g.sale === undefined)
      expect(saleGroup).toMatchObject({ count: 1, sumAtomic: '2500', direction: 'in', sale: { productName: 'Haven Field Notes' } })
      expect(deposit).toMatchObject({ count: 1, sumAtomic: '19990000', direction: 'in' })
    })

    it('two sales of different products on one day are one group with a null product name', async () => {
      await sale(13, 'field-notes', 'Haven Field Notes')
      await sale(14, 'pocket-guide', 'Pocket Guide')

      const groups = await activity()
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ count: 2, sumAtomic: '5000', sale: { productName: null } })
    })

    it('two sales of the same product are one group that carries the product name', async () => {
      await sale(15, 'field-notes', 'Haven Field Notes')
      await sale(16, 'field-notes', 'Haven Field Notes')

      const groups = await activity()
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ count: 2, sale: { productName: 'Haven Field Notes' } })
    })

    it('a top-up into the Sales account itself from a non-own address is a sale without a product', async () => {
      rows.push({ hash: hash(17), from: wallet(17), to: f.sales.address, value: '19990000', ts: now() })
      await indexLeg(hash(17), wallet(17), '19990000', now())

      const groups = await activity()
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ count: 1, sale: { productName: null } })
    })
  })

  describe('GET /transactions/export.csv — unchanged', () => {
    it('is byte-identical with Sales on and off, the sale row is still `receive`, and both column lists are unchanged', async () => {
      await sale(18, 'field-notes', 'Haven Field Notes')
      rows.push({ hash: hash(19), from: wallet(19), to: f.main.address, value: '19990000', ts: now() })

      const on = await get('/transactions/export.csv?fresh=1')
      const onFolded = await get('/transactions/export.csv?fresh=1&foldOwnTransfers=1')
      await setSales(f.userId, false)
      const off = await get('/transactions/export.csv?fresh=1')
      const offFolded = await get('/transactions/export.csv?fresh=1&foldOwnTransfers=1')

      expect(on.statusCode).toBe(200)
      expect(on.body).toBe(off.body)
      expect(onFolded.body).toBe(offFolded.body)

      // The file is CRLF-delimited with a BOM (`domain/csv.ts`).
      const lines_ = (body: string) => body.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
      const [header, ...lines] = lines_(on.body)
      // Pinned as literals: comparing to the constants could not fail if a
      // column were added to them.
      expect(header).toBe(
        'settled_at,type,status,direction,counterparty_name,counterparty_address,token_symbol,token_address,amount,amount_sek,fx_rate,fx_source,fee_sek,chain_id,tx_hash,payment_id,agent_name,initiator,account_address,reporting_currency,converted_currency,settlement_tx_hash',
      )
      expect(header).toBe(TRANSACTION_CSV_COLUMNS.join(','))
      expect(lines_(onFolded.body)[0]).toBe(FOLDED_HEADER)
      expect(lines_(onFolded.body)[0]).toBe(FOLDED_TRANSACTION_CSV_COLUMNS.join(','))
      const typeIdx = TRANSACTION_CSV_COLUMNS.indexOf('type')
      const hashIdx = TRANSACTION_CSV_COLUMNS.indexOf('tx_hash')
      const saleLine = lines.find((line) => line.split(',')[hashIdx]?.replace(/"/g, '').toLowerCase() === hash(18))
      expect(saleLine?.split(',')[typeIdx]?.replace(/"/g, '')).toBe('receive')
    })
  })

  /**
   * #5001: `direction=sales` narrows Incoming to the rows #5000 marks as
   * sales. One of each row the filter must separate is seeded, so the test
   * fails if the filter keeps a non-sale or drops a sale.
   */
  describe('GET /transactions?direction=sales (#5001)', () => {
    interface Seeded {
      withProduct: string
      withoutProduct: string
      ownMove: string
      ownAgent: string
      stripeHeld: string
      outbound: string
    }

    /** Two sales (with and without a product) and four rows that are not sales. */
    async function seedOneOfEach(): Promise<Seeded> {
      // A recorded sale, with a product.
      const withProduct = await sale(30, 'field-notes', 'Haven Field Notes', '2500')
      // A sale without a product: a non-own payment into Sales, no record.
      const withoutProduct = hash(31)
      rows.push({ hash: withoutProduct, from: wallet(31), to: f.sales.address, value: '1999', ts: now() })
      await indexLeg(withoutProduct, wallet(31), '1999', now())
      // An own-account move (#4268): Main → Sales.
      const ownMove = hash(32)
      rows.push({ hash: ownMove, from: f.main.address, to: f.sales.address, value: '9000', ts: now() })
      await indexLeg(ownMove, f.main.address, '9000', now())
      // An own-agent payment (the index recorded the payer as the owner's own).
      const ownAgent = hash(33)
      rows.push({ hash: ownAgent, from: f.delegate, to: f.sales.address, value: '5000', ts: now() })
      await indexLeg(ownAgent, f.delegate, '5000', now(), true)
      // A Stripe-held sale: a record with no indexed transfer, so no feed row.
      const stripeHeld = hash(34)
      await recordSale(stripeHeld, {
        productId: 'stripe-only',
        productName: 'Stripe product',
        amount: '4000',
        payer: wallet(34),
        ts: now(),
        heldBy: 'stripe',
      })
      // An outbound row from the Sales account.
      const outbound = hash(35)
      rows.push({ hash: outbound, from: f.sales.address, to: wallet(35), value: '1200', ts: now() })
      return { withProduct, withoutProduct, ownMove, ownAgent, stripeHeld, outbound }
    }

    const hashesOf = (body: { transactions: Array<Record<string, unknown>> }) =>
      body.transactions.map((t) => String(t.hash).toLowerCase()).sort()

    it('returns exactly the sale rows — with and without a product — and nothing else', async () => {
      const h = await seedOneOfEach()

      const body = await list('&direction=sales')
      expectMatchesSpec('GET', '/transactions', body)
      expect(hashesOf(body)).toEqual([h.withProduct, h.withoutProduct].sort())
      expect(body.total).toBe(2)
      expect(body.hasMore).toBe(false)
      // Every returned row is inbound and carries the marker.
      for (const t of body.transactions) {
        expect(t.direction).toBe('in')
        expect(t.sale).toBeDefined()
      }

      // The excluded rows ARE in the unfiltered feed, so the filter is what
      // removed them — not a fixture that never produced them.
      const all = await list()
      const allHashes = hashesOf(all)
      for (const excluded of [h.ownMove, h.ownAgent, h.outbound]) expect(allHashes).toContain(excluded)
      // A Stripe-held sale is never a feed row at all (the non-goal).
      expect(allHashes).not.toContain(h.stripeHeld)
    })

    it('counts the same set in `total` and `hasMore`', async () => {
      await seedOneOfEach()

      const res = await get('/transactions?fresh=1&direction=sales&limit=1')
      expect(res.statusCode).toBe(200)
      const body = res.json() as { transactions: Array<Record<string, unknown>>; total: number; hasMore: boolean }
      expect(body.transactions).toHaveLength(1)
      expect(body.total).toBe(2)
      expect(body.hasMore).toBe(true)
    })

    it('exports the same rows on /transactions/export.csv, with the column list unchanged', async () => {
      const h = await seedOneOfEach()

      const res = await get('/transactions/export.csv?fresh=1&direction=sales')
      expect(res.statusCode).toBe(200)
      const lines = res.body.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
      const [header, ...data] = lines
      expect(header).toBe(TRANSACTION_CSV_COLUMNS.join(','))
      const hashIdx = TRANSACTION_CSV_COLUMNS.indexOf('tx_hash')
      const exported = data
        .map((line) => line.split(',')[hashIdx]?.replace(/"/g, '').toLowerCase())
        .sort()
      expect(exported).toEqual([h.withProduct, h.withoutProduct].sort())
    })

    it('with merchant services off, no row carries the marker, so the filter is empty', async () => {
      await seedOneOfEach()
      await setSales(f.userId, false)

      const body = await list('&direction=sales')
      expect(body.transactions).toHaveLength(0)
      expect(body.total).toBe(0)
    })
  })
})
