/**
 * The sales ingest on the REAL Postgres harness (#4897, epic #4885).
 *
 * `POST /merchant/sales` stores a merchant's sale record only against a
 * transfer Haven read from the chain. Only the chain read is mocked (it is the
 * collaborator this suite does not own); the route, the request-validation
 * plugin, the auth middleware, the repositories and every table are real.
 *
 * Each test is named for the acceptance criterion it proves:
 *
 *   - stored once, an identical resend writes nothing, a different record is 409;
 *   - a hash that paid another Haven account and one that paid nobody get the
 *     SAME answer (no oracle);
 *   - a caller-supplied inbound row is never the basis of a sale;
 *   - the record's amount and payer are ignored; the chain's are stored;
 *   - several legs: the amount is the sum of the non-own legs, the payer the
 *     single sender or "several payers"; own-sender legs are left out;
 *   - the retry answer (425) is distinct, with Retry-After;
 *   - an unreadable chain is 503; an unknown version 400; a wrong chain 422;
 *   - merchant services off is refused; the key is rate limited;
 *   - a sale is not a match kind and never moves the receive balance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const mocks = vi.hoisted(() => ({ read: vi.fn(), hideWinner: { on: false } }))

vi.mock('../../modules/transactions/chain-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/transactions/chain-read.js')>()
  return {
    ...actual,
    readInboundTransactionByTxHash: (...a: unknown[]) => mocks.read(...a),
  }
})

vi.mock('../../infra/repositories/merchant-sales.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/merchant-sales.js')>()
  return {
    ...actual,
    // Stages "the winner's row is gone again" for the lost-race fallback.
    findMerchantSale: (...a: Parameters<typeof actual.findMerchantSale>) =>
      mocks.hideWinner.on ? Promise.resolve(null) : actual.findMerchantSale(...a),
  }
})

const merchantSalesRoutes = (await import('../merchant-sales.js')).default
const { installRequestValidation } = await import('../../openapi/request-validation.js')
const { generateMerchantKey } = await import('../../domain/merchant-keys.js')
const { insertMerchantKey } = await import('../../infra/repositories/merchant-keys.js')
const { rateLimitKeyFor } = await import('../../middleware/rate-limit.js')
const { inboundReceiveBalanceAtomic, insertInboundTransfer } = await import(
  '../../infra/repositories/inbound-transfers.js'
)
const { insertMerchantSale, findMerchantSale } = await import(
  '../../infra/repositories/merchant-sales.js'
)

const CHAIN = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TX = '0x' + '1a'.repeat(32)
const PAYER = '0x' + 'bb'.repeat(20)
const PAYER_2 = '0x' + 'cc'.repeat(20)
const BLOCK_TIME = new Date('2026-11-17T10:00:00Z')

function addr(): string {
  return '0x' + randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40)
}

interface Merchant {
  userId: string
  accountId: string
  address: string
  secret: string
}

async function seedMerchant(opts: { enabled?: boolean } = {}): Promise<Merchant> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sales-${randomUUID()}@test.example`],
  )
  const userId = user.rows[0].id
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
  const key = generateMerchantKey()
  await insertMerchantKey({
    userId,
    accountId: account.rows[0].id,
    keyHash: key.hash,
    keyPrefix: key.prefix,
    createdBy: userId,
  })
  return { userId, accountId: account.rows[0].id, address, secret: key.secret }
}

function leg(payer: string, amountRaw: string, logIndex: number) {
  return {
    txHash: TX,
    logIndex,
    payerAddress: payer,
    tokenAddress: USDC,
    amountRaw,
    blockNumber: 100,
    blockTime: BLOCK_TIME,
  }
}

/** A mined, confirmed receipt carrying `legs` (three confirmations by default). */
function chainShows(legs: ReturnType<typeof leg>[], over: { latestBlock?: number } = {}) {
  mocks.read.mockResolvedValue({
    ok: true,
    receiptFound: true,
    blockNumber: 100,
    latestBlock: over.latestBlock ?? 102,
    legs,
  })
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    tx_hash: TX,
    chain: `eip155:${CHAIN}`,
    product_id: 'opper-gpt-6-sol-1k',
    product_name: 'Opper GPT-6 Sol, 1,000 output tokens',
    amount: '1000000',
    payer: PAYER,
    merchant_reference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
    receipt_number: 'FAK-5552735618149454',
    vat_treatment: 'SE_25',
    ...over,
  }
}

describeDb('POST /merchant/sales on the real database (#4897)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(rateLimit, {
      global: false,
      keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request),
    })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/merchant-sales.ts'] })
    await app.register(merchantSalesRoutes, { prefix: '/merchant' })
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await resetDb()
    vi.clearAllMocks()
    mocks.hideWinner.on = false
  })

  function post(secret: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/merchant/sales',
      headers: { authorization: `Bearer ${secret}` },
      payload: body,
    })
  }

  const salesFor = (accountId: string) =>
    db.query<Record<string, unknown>>(
      `SELECT *, amount_raw::text AS amount_text FROM merchant_sales WHERE account_id = $1`,
      [accountId],
    )

  const inboundFor = (accountId: string) =>
    db.query<Record<string, unknown>>(
      `SELECT * FROM inbound_transfers WHERE account_id = $1 ORDER BY log_index NULLS FIRST`,
      [accountId],
    )

  describe('stored once, and one record per transaction', () => {
    it('stores a new sale (201) from the chain read, and an identical resend answers 200 and writes nothing', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])

      const first = await post(m.secret, record())
      expect(first.statusCode, first.body).toBe(201)
      expect(first.json()).toMatchObject({
        tx_hash: TX,
        chain: `eip155:${CHAIN}`,
        product_id: 'opper-gpt-6-sol-1k',
        merchant_reference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
        receipt_number: 'FAK-5552735618149454',
        vat_treatment: 'SE_25',
        amount_raw: '1000000',
        payer_address: PAYER,
        several_payers: false,
        token_address: USDC,
        block_number: 100,
      })
      const stored = await salesFor(m.accountId)
      expect(stored.rows).toHaveLength(1)
      expect(stored.rows[0].held_by).toBe('account')
      expect(stored.rows[0].receiving_address).toBeNull()
      // The transfers were indexed too (the by-hash read feeds the index).
      expect(await inboundFor(m.accountId).then((r) => r.rows)).toHaveLength(1)

      mocks.read.mockClear()
      const again = await post(m.secret, record())
      expect(again.statusCode).toBe(200)
      expect(again.json()).toEqual(first.json())
      expect(mocks.read).not.toHaveBeenCalled()
      const after = await salesFor(m.accountId)
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].created_at).toEqual(stored.rows[0].created_at)
    })

    it('treats a hash in different case as the same transaction', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      const mixed = '0x' + '1A'.repeat(32)
      expect((await post(m.secret, record({ tx_hash: mixed }))).statusCode).toBe(201)
      expect((await post(m.secret, record())).statusCode).toBe(200)
      expect((await salesFor(m.accountId)).rows).toHaveLength(1)
    })

    it('refuses a different record for the same transaction (409) and the first stands', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      expect((await post(m.secret, record())).statusCode).toBe(201)

      for (const different of [
        { product_id: 'another-product' },
        { merchant_reference: 'sale_OTHER' },
        { product_name: 'Another name' },
        { receipt_number: 'FAK-1' },
        { vat_treatment: 'REVERSE_CHARGE' },
      ]) {
        const res = await post(m.secret, record(different))
        expect(res.statusCode, JSON.stringify(different)).toBe(409)
        expect(res.json()).toMatchObject({ error: 'sale_record_conflict', error_code: 'sale_record_conflict' })
      }
      const rows = (await salesFor(m.accountId)).rows
      expect(rows).toHaveLength(1)
      expect(rows[0].product_id).toBe('opper-gpt-6-sol-1k')
      expect(rows[0].merchant_reference).toBe('sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W')
    })

    it('holds the one-record rule in the table itself: a second insert for the same transaction, in any case, is refused', async () => {
      const m = await seedMerchant()
      const base = {
        accountId: m.accountId,
        userId: m.userId,
        chainId: CHAIN,
        recordVersion: 1,
        productId: 'p',
        productName: null,
        merchantReference: 'r',
        receiptNumber: null,
        vatTreatment: null,
        amountRaw: '1',
        tokenAddress: USDC,
        payerAddress: PAYER,
        severalPayers: false,
        senderIsOwnAddress: false,
        blockNumber: 1,
        blockTime: BLOCK_TIME,
      }
      expect(await insertMerchantSale({ ...base, txHash: TX })).not.toBeNull()
      expect(await insertMerchantSale({ ...base, txHash: TX.toUpperCase().replace('0X', '0x') })).toBeNull()
      expect((await salesFor(m.accountId)).rows).toHaveLength(1)
    })

    it('keeps accounts apart: two accounts can each hold a record for one transaction', async () => {
      const a = await seedMerchant()
      const b = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      expect((await post(a.secret, record())).statusCode).toBe(201)
      expect((await post(b.secret, record())).statusCode).toBe(201)
      expect(await findMerchantSale(a.accountId, CHAIN, TX)).not.toBeNull()
      expect(await findMerchantSale(b.accountId, CHAIN, TX)).not.toBeNull()
    })
  })

  describe('only the chain is the basis', () => {
    it('answers a hash that paid another Haven account exactly as a hash that paid nobody (no oracle)', async () => {
      const m = await seedMerchant()
      const other = await seedMerchant()
      const PAID_OTHER = '0x' + '2b'.repeat(32)
      const PAID_NOBODY = '0x' + '3c'.repeat(32)
      // The other account really has this transfer in its own index.
      await insertInboundTransfer({
        accountId: other.accountId,
        userId: other.userId,
        chainId: CHAIN,
        txHash: PAID_OTHER,
        logIndex: 1,
        payerAddress: PAYER,
        tokenAddress: USDC,
        amountRaw: '5000000',
        blockNumber: 100,
        blockTime: BLOCK_TIME,
      })
      // The chain read is scoped to the key's own account: for both hashes it
      // finds a confirmed receipt with no leg into it.
      mocks.read.mockResolvedValue({ ok: true, receiptFound: true, blockNumber: 100, latestBlock: 102, legs: [] })

      const a = await post(m.secret, record({ tx_hash: PAID_OTHER }))
      const b = await post(m.secret, record({ tx_hash: PAID_NOBODY }))
      expect(a.statusCode).toBe(422)
      expect(b.statusCode).toBe(a.statusCode)
      expect(b.json()).toEqual(a.json())
      expect(a.json().error).toBe('no_payment_to_account')
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
      expect((await salesFor(other.accountId)).rows).toHaveLength(0)
    })

    it('never takes a caller-supplied inbound row as the basis of a sale', async () => {
      const m = await seedMerchant()
      // A row planted through the old caller-supplied route: log_index NULL.
      await insertInboundTransfer({
        accountId: m.accountId,
        userId: m.userId,
        chainId: CHAIN,
        txHash: TX,
        logIndex: null,
        payerAddress: PAYER,
        tokenAddress: USDC,
        amountRaw: '9000000',
        blockTime: BLOCK_TIME,
      })
      mocks.read.mockResolvedValue({ ok: true, receiptFound: true, blockNumber: 100, latestBlock: 102, legs: [] })

      const res = await post(m.secret, record({ amount: '9000000' }))
      expect(res.statusCode).toBe(422)
      expect(res.json().error).toBe('no_payment_to_account')
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
    })

    it('stores the chain\'s amount and payer when the record states different ones', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      const res = await post(m.secret, record({ amount: '999999999', payer: PAYER_2 }))
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ amount_raw: '1000000', payer_address: PAYER })
      const rows = (await salesFor(m.accountId)).rows
      expect(rows[0].amount_text).toBe('1000000')
      expect(rows[0].payer_address).toBe(PAYER)
    })

    it('refuses a field outside the record (the account is the key\'s, never the body\'s)', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      const res = await post(m.secret, record({ account_id: randomUUID() }))
      expect(res.statusCode).toBe(400)
      expect(mocks.read).not.toHaveBeenCalled()
    })

    it('refuses a record missing a required field, and a malformed hash', async () => {
      const m = await seedMerchant()
      const { merchant_reference: _omit, ...missing } = record()
      void _omit
      expect((await post(m.secret, missing)).statusCode).toBe(400)
      expect((await post(m.secret, record({ tx_hash: '0x1234' }))).statusCode).toBe(400)
      expect(mocks.read).not.toHaveBeenCalled()
    })
  })

  describe('several transfers in one transaction', () => {
    it('sums the legs and shows several payers when the senders differ', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 1), leg(PAYER_2, '2500000', 2)])
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ amount_raw: '3500000', payer_address: null, several_payers: true })
      expect((await salesFor(m.accountId)).rows).toHaveLength(1)
      expect((await inboundFor(m.accountId)).rows).toHaveLength(2)
    })

    it('names the single sender when every leg shares it', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 1), leg(PAYER, '2000000', 2)])
      const res = await post(m.secret, record())
      expect(res.json()).toMatchObject({ amount_raw: '3000000', payer_address: PAYER, several_payers: false })
    })

    it('leaves the owner\'s own addresses out of the amount: an agent delegate, a rotated delegate and a smart account', async () => {
      const m = await seedMerchant()
      const delegate = addr()
      const rotatedOld = addr()
      const ownAccount = addr()
      const agent = await db.query<{ id: string }>(
        `INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'a', $2, 'revoked') RETURNING id`,
        [m.userId, delegate],
      )
      await db.query(
        `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address)
         VALUES ($1, $2, $3, $4)`,
        [agent.rows[0].id, m.userId, rotatedOld, delegate],
      )
      await db.query(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
         VALUES ($1, $2, 8453, 'delegation', 'delegator_hybrid', false)`,
        [m.userId, ownAccount],
      )
      chainShows([
        leg(PAYER, '1000000', 1),
        leg(delegate, '7000000', 2),
        leg(rotatedOld, '11000000', 3),
        leg(ownAccount, '13000000', 4),
      ])
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({
        amount_raw: '1000000',
        // The payer is read over the legs that count as revenue: the customer's.
        payer_address: PAYER,
        several_payers: false,
        sender_is_own_address: false,
      })
      // The index flags the own legs by the same set.
      const flags = (await inboundFor(m.accountId)).rows.map((r) => [r.log_index, r.sender_is_own_address])
      expect(flags).toEqual([[1, false], [2, true], [3, true], [4, true]])
    })

    it('attributes a transaction with one own leg and one customer leg to the customer, not "several payers"', async () => {
      const m = await seedMerchant()
      const delegate = addr()
      await db.query(`INSERT INTO agents (user_id, name, delegate_address) VALUES ($1, 'a', $2)`, [m.userId, delegate])
      chainShows([leg(delegate, '4000000', 1), leg(PAYER, '1000000', 2)])
      const res = await post(m.secret, record())
      expect(res.json()).toMatchObject({
        amount_raw: '1000000',
        payer_address: PAYER,
        several_payers: false,
        sender_is_own_address: false,
      })
    })

    it('reads an own-only transaction over all its legs: two own senders are "several payers"', async () => {
      const m = await seedMerchant()
      const d1 = addr()
      const d2 = addr()
      await db.query(`INSERT INTO agents (user_id, name, delegate_address) VALUES ($1, 'a', $2), ($1, 'b', $3)`, [m.userId, d1, d2])
      chainShows([leg(d1, '4000000', 1), leg(d2, '5000000', 2)])
      const res = await post(m.secret, record())
      expect(res.json()).toMatchObject({
        amount_raw: '0',
        payer_address: null,
        several_payers: true,
        sender_is_own_address: true,
      })
    })

    it('records a transaction paid only from own addresses with no revenue, flagged', async () => {
      const m = await seedMerchant()
      const delegate = addr()
      await db.query(`INSERT INTO agents (user_id, name, delegate_address) VALUES ($1, 'a', $2)`, [m.userId, delegate])
      chainShows([leg(delegate, '4000000', 1)])
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ amount_raw: '0', sender_is_own_address: true, payer_address: delegate })
    })

    it('never makes a sale of a transaction with no non-zero leg (zero legs are dropped by the read)', async () => {
      const m = await seedMerchant()
      // The chain read drops zero-value legs, so an all-zero transaction is a confirmed receipt with no leg.
      mocks.read.mockResolvedValue({ ok: true, receiptFound: true, blockNumber: 100, latestBlock: 102, legs: [] })
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(422)
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
    })
  })

  describe('visibility, confirmations and the chain', () => {
    it('answers the retry (425, Retry-After) when the receipt is not found yet, and stores nothing', async () => {
      const m = await seedMerchant()
      mocks.read.mockResolvedValue({ ok: true, receiptFound: false, legs: [] })
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(425)
      expect(res.headers['retry-after']).toBe('10')
      expect(res.json()).toMatchObject({
        error: 'transaction_not_visible',
        error_code: 'transaction_not_visible',
        retry_after_seconds: 10,
      })
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
      expect((await inboundFor(m.accountId)).rows).toHaveLength(0)
    })

    it('answers the retry with fewer than 3 confirmations, and accepts at exactly 3', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)], { latestBlock: 101 }) // 2 confirmations
      const early = await post(m.secret, record())
      expect(early.statusCode).toBe(425)
      expect(early.headers['retry-after']).toBe('10')
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
      expect((await inboundFor(m.accountId)).rows).toHaveLength(0)

      chainShows([leg(PAYER, '1000000', 4)], { latestBlock: 102 }) // 3 confirmations
      expect((await post(m.secret, record())).statusCode).toBe(201)
    })

    it('keeps the retry answer distinct from every refusal', async () => {
      const m = await seedMerchant()
      const seen = new Map<string, number>()
      const note = (res: { statusCode: number; json: () => { error: string } }) =>
        seen.set(res.json().error, res.statusCode)

      mocks.read.mockResolvedValue({ ok: true, receiptFound: false, legs: [] })
      note(await post(m.secret, record()))
      mocks.read.mockResolvedValue({ ok: true, receiptFound: true, blockNumber: 100, latestBlock: 102, legs: [] })
      note(await post(m.secret, record()))
      note(await post(m.secret, record({ chain: 'eip155:8453' })))
      note(await post(m.secret, record({ version: 2 })))
      mocks.read.mockResolvedValue({ ok: false, reason: 'rpc_unavailable' })
      note(await post(m.secret, record()))

      expect(seen.get('transaction_not_visible')).toBe(425)
      const others = [...seen.entries()].filter(([code]) => code !== 'transaction_not_visible')
      expect(others.length).toBe(4)
      for (const [, status] of others) expect(status).not.toBe(425)
    })

    it('answers 503 when the chain cannot be read, and stores nothing', async () => {
      const m = await seedMerchant()
      mocks.read.mockResolvedValue({ ok: false, reason: 'rpc_unavailable' })
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('chain_unavailable')
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
      expect((await inboundFor(m.accountId)).rows).toHaveLength(0)
    })
  })

  describe('two records racing for one transaction', () => {
    /** Both requests reach the chain read before either writes, so both try to insert. */
    function holdUntilBoth(legs: ReturnType<typeof leg>[]) {
      let arrived = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      mocks.read.mockImplementation(async () => {
        arrived += 1
        if (arrived >= 2) release()
        await gate
        return { ok: true, receiptFound: true, blockNumber: 100, latestBlock: 102, legs }
      })
    }

    it('two different records: one is stored (201), the other is refused (409), and one row remains', async () => {
      const m = await seedMerchant()
      holdUntilBoth([leg(PAYER, '1000000', 4)])
      const [a, b] = await Promise.all([
        post(m.secret, record({ merchant_reference: 'sale_A' })),
        post(m.secret, record({ merchant_reference: 'sale_B' })),
      ])
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
      const loser = a.statusCode === 409 ? a : b
      expect(loser.json().error).toBe('sale_record_conflict')
      const rows = (await salesFor(m.accountId)).rows
      expect(rows).toHaveLength(1)
      const winnerRef = (a.statusCode === 201 ? a : b).json().merchant_reference
      expect(rows[0].merchant_reference).toBe(winnerRef)
    })

    it('two identical records: 201 and 200, and one row remains', async () => {
      const m = await seedMerchant()
      holdUntilBoth([leg(PAYER, '1000000', 4)])
      const [a, b] = await Promise.all([post(m.secret, record()), post(m.secret, record())])
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
      expect(a.json().id).toBe(b.json().id)
      expect((await salesFor(m.accountId)).rows).toHaveLength(1)
    })

    it('answers 409 saying the record changed when the winner\'s row is gone again', async () => {
      const m = await seedMerchant()
      holdUntilBoth([leg(PAYER, '1000000', 4)])
      mocks.hideWinner.on = true
      const [a, b] = await Promise.all([post(m.secret, record()), post(m.secret, record())])
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
      const loser = a.statusCode === 409 ? a : b
      expect(loser.json()).toMatchObject({ error: 'sale_record_conflict' })
      expect(loser.json().message).toMatch(/changed while it was being written/)
    })
  })

  describe('the record\'s own checks', () => {
    it('refuses an unknown version (400) and says version 1 is the only one; version 1 and no version pass', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      const bad = await post(m.secret, record({ version: 2 }))
      expect(bad.statusCode).toBe(400)
      expect(bad.json().error).toBe('unsupported_record_version')
      expect(bad.json().message).toMatch(/version 1 is the only version/)
      expect(mocks.read).not.toHaveBeenCalled()
      expect((await post(m.secret, record({ version: 0 }))).statusCode).toBe(400)

      const { version: _v, ...noVersion } = record()
      void _v
      const ok = await post(m.secret, noVersion)
      expect(ok.statusCode).toBe(201)
      expect(ok.json().record_version).toBe(1)
    })

    it('refuses a chain other than the key account\'s network (422 chain_mismatch)', async () => {
      const m = await seedMerchant()
      chainShows([leg(PAYER, '1000000', 4)])
      for (const chain of ['eip155:8453', 'eip155:1', 'solana:1']) {
        const res = await post(m.secret, record({ chain }))
        expect(res.statusCode, chain).toBe(422)
        expect(res.json().error).toBe('chain_mismatch')
      }
      expect(mocks.read).not.toHaveBeenCalled()
    })
  })

  describe('the door', () => {
    it('refuses a missing or unknown key (401) and a key whose services are off (403 MERCHANT_SERVICES_OFF)', async () => {
      const off = await seedMerchant({ enabled: false })
      const missing = await app.inject({ method: 'POST', url: '/merchant/sales', payload: record() })
      expect(missing.statusCode).toBe(401)
      expect((await post('sk_merchant_' + '0'.repeat(48), record())).statusCode).toBe(401)

      const res = await post(off.secret, record())
      expect(res.statusCode).toBe(403)
      expect(res.json().error_code).toBe('MERCHANT_SERVICES_OFF')
      expect(mocks.read).not.toHaveBeenCalled()
      expect((await salesFor(off.accountId)).rows).toHaveLength(0)
    })

    it('rate limits per key: 120 a minute, then 429 for that key only', async () => {
      const m = await seedMerchant()
      const other = await seedMerchant()
      const noop = record({ version: 2 }) // answered before any read
      let last = 0
      for (let i = 0; i < 121; i += 1) {
        last = (await post(m.secret, noop)).statusCode
        if (i < 120) expect(last).toBe(400)
      }
      expect(last).toBe(429)
      expect((await post(other.secret, noop)).statusCode).toBe(400)
    }, 60_000)

    it('does not let a junk Authorization header open a new bucket beside a valid X-API-Key', async () => {
      const m = await seedMerchant()
      const noop = record({ version: 2 })
      let last = 0
      for (let i = 0; i < 121; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/merchant/sales',
          headers: { authorization: `Bearer junk-${i}`, 'x-api-key': m.secret },
          payload: noop,
        })
        last = res.statusCode
        if (i < 120) expect(last).toBe(400)
      }
      expect(last).toBe(429)
    }, 60_000)

    it('shares one bucket when the same key arrives through both headers', async () => {
      const m = await seedMerchant()
      const noop = record({ version: 2 })
      let last = 0
      for (let i = 0; i < 121; i += 1) {
        const headers: Record<string, string> =
          i % 2 === 0 ? { authorization: `Bearer ${m.secret}` } : { 'x-api-key': m.secret }
        last = (await app.inject({ method: 'POST', url: '/merchant/sales', headers, payload: noop })).statusCode
        if (i < 120) expect(last).toBe(400)
      }
      expect(last).toBe(429)
    }, 60_000)
  })

  describe('a sale is not a match kind', () => {
    it('leaves match_kind, balance_consumed and the receive balance as they were', async () => {
      const m = await seedMerchant()
      // A matched, consumed row of another transaction: the balance the sale must not move.
      const earned = await insertInboundTransfer({
        accountId: m.accountId,
        userId: m.userId,
        chainId: CHAIN,
        txHash: '0x' + '4d'.repeat(32),
        logIndex: 0,
        payerAddress: PAYER,
        tokenAddress: USDC,
        amountRaw: '2000000',
        blockNumber: 90,
        blockTime: BLOCK_TIME,
      })
      await db.query(
        `UPDATE inbound_transfers SET match_kind = 'receipt', balance_consumed = true WHERE id = $1`,
        [earned],
      )
      const before = await inboundReceiveBalanceAtomic(m.accountId, m.userId)
      expect(before).toBe('2000000')

      chainShows([leg(PAYER, '1000000', 4)])
      expect((await post(m.secret, record())).statusCode).toBe(201)

      expect(await inboundReceiveBalanceAtomic(m.accountId, m.userId)).toBe(before)
      const sold = await db.query<{ match_kind: string | null; balance_consumed: boolean }>(
        `SELECT match_kind, balance_consumed FROM inbound_transfers WHERE account_id = $1 AND tx_hash = $2`,
        [m.accountId, TX],
      )
      expect(sold.rows).toEqual([{ match_kind: null, balance_consumed: false }])
      const kept = await db.query<{ match_kind: string | null; balance_consumed: boolean }>(
        `SELECT match_kind, balance_consumed FROM inbound_transfers WHERE id = $1`,
        [earned],
      )
      expect(kept.rows[0]).toEqual({ match_kind: 'receipt', balance_consumed: true })
    })
  })
})
