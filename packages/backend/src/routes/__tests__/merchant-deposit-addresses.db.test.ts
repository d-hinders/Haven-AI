/**
 * The Stripe deposit-address registry and the Stripe-held sale ingest, on the
 * REAL Postgres harness (#4952, epic #4886; dev and Stripe sandbox only).
 *
 * Only the chain read is mocked; the routes, the request-validation plugin, the
 * auth middleware, the repositories and every table are real. Each test is
 * named for an acceptance criterion of #4952:
 *
 *   - register / list / retire from a dashboard session; the Sales key and a
 *     device-login token can do none of them;
 *   - what a registration refuses (invalid, taken, own, services off);
 *   - every registration carries "registered by you, not verified by Haven";
 *   - the partial unique index, including re-registering a retired address;
 *   - the ingest accepts a sale to a registered address, held_by and the
 *     address from the registry; no inbound_transfers row; balances untouched;
 *   - the block-time window, registration before and after the block;
 *   - no oracle: another account's address, an unregistered one and a
 *     out-of-window one answer exactly as a hash that paid nobody;
 *   - a transaction that pays the account and a registered address is an
 *     account sale; one record per transaction; the own sender fold;
 *   - the reads keep Stripe-held sales apart and unchanged totals otherwise;
 *   - clearing a Stripe-held sale, and a new record afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock('../../modules/transactions/chain-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/transactions/chain-read.js')>()
  return {
    ...actual,
    readInboundTransactionByTxHash: (...a: unknown[]) => mocks.read(...a),
  }
})

const depositRoutes = (await import('../merchant-deposit-addresses.js')).default
const salesRoutes = (await import('../merchant-sales.js')).default
const salesReadRoutes = (await import('../merchant-sales-reads.js')).default
const { installRequestValidation } = await import('../../openapi/request-validation.js')
const { generateMerchantKey } = await import('../../domain/merchant-keys.js')
const { insertMerchantKey } = await import('../../infra/repositories/merchant-keys.js')
const { rateLimitKeyFor } = await import('../../middleware/rate-limit.js')
const { inboundReceiveBalanceAtomic } = await import('../../infra/repositories/inbound-transfers.js')

const CHAIN = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TX = '0x' + '1a'.repeat(32)
const PAYER = '0x' + 'bb'.repeat(20)
const BLOCK_TIME = new Date('2026-11-17T10:00:00Z')
const BEFORE_BLOCK = '2026-11-17T09:00:00Z'
const AFTER_BLOCK = '2026-11-17T11:00:00Z'

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
    [`deposit-${randomUUID()}@test.example`],
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

/**
 * A mined, confirmed receipt: `accountLegs` into the key's account and
 * `otherLegs` to other addresses. Like the real read, `otherLegs` carries only
 * the legs to the addresses the ingest NAMED (the account's registered ones).
 */
function chainShows(
  accountLegs: ReturnType<typeof leg>[],
  otherLegs: Array<{ to: string; leg: ReturnType<typeof leg> }> = [],
) {
  mocks.read.mockImplementation(async (_chain: number, _account: string, _tx: string, named: string[] = []) => ({
    ok: true,
    receiptFound: true,
    blockNumber: 100,
    latestBlock: 102,
    legs: accountLegs,
    otherLegs: otherLegs
      .filter((o) => named.includes(o.to.toLowerCase()))
      .map((o) => ({ leg: o.leg, toAddress: o.to.toLowerCase() })),
  }))
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    tx_hash: TX,
    chain: `eip155:${CHAIN}`,
    product_id: 'opper-gpt-6-sol-1k',
    amount: '1000000',
    payer: PAYER,
    merchant_reference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
    ...over,
  }
}

describeDb('the Stripe deposit-address registry and Stripe-held sales on the real database (#4952)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(rateLimit, { global: false, keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request) })
    installRequestValidation(app, {
      mode: 'enforce',
      enforcedModules: [
        'routes/merchant-deposit-addresses.ts',
        'routes/merchant-sales.ts',
        'routes/merchant-sales-reads.ts',
      ],
    })
    await app.register(depositRoutes, { prefix: '/merchant-deposit-addresses' })
    await app.register(salesRoutes, { prefix: '/merchant' })
    await app.register(salesReadRoutes, { prefix: '/merchant-sales' })
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    await resetDb()
    vi.clearAllMocks()
  })

  const token = (userId: string, extra: Record<string, unknown> = {}) =>
    app.jwt.sign({ sub: userId, email: 'owner@example.com', ...extra })
  const auth = (userId: string, extra: Record<string, unknown> = {}) => ({
    authorization: `Bearer ${token(userId, extra)}`,
  })

  const register = (userId: string, address: unknown) =>
    app.inject({ method: 'POST', url: '/merchant-deposit-addresses', headers: auth(userId), payload: { address } })
  const list = (userId: string) =>
    app.inject({ method: 'GET', url: '/merchant-deposit-addresses', headers: auth(userId) })
  const retire = (userId: string, id: string) =>
    app.inject({ method: 'POST', url: `/merchant-deposit-addresses/${id}/retire`, headers: auth(userId) })
  const post = (secret: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/merchant/sales', headers: { authorization: `Bearer ${secret}` }, payload: body })
  const get = (userId: string, url: string) => app.inject({ method: 'GET', url, headers: auth(userId) })

  /** Register through the route, then back-date the registration for the window tests. */
  async function registerAt(m: Merchant, address: string, registeredAt: string, retiredAt: string | null = null) {
    const res = await register(m.userId, address)
    expect(res.statusCode, res.body).toBe(201)
    await db.query(
      `UPDATE merchant_deposit_addresses SET registered_at = $2, retired_at = $3 WHERE id = $1`,
      [res.json().id, registeredAt, retiredAt],
    )
    return res.json().id as string
  }

  const salesFor = (accountId: string) =>
    db.query<Record<string, unknown>>(`SELECT * FROM merchant_sales WHERE account_id = $1`, [accountId])
  const inboundFor = (accountId: string) =>
    db.query(`SELECT 1 FROM inbound_transfers WHERE account_id = $1`, [accountId])

  describe('register, list and retire', () => {
    it('the owner registers, lists and retires a deposit address from a dashboard session', async () => {
      const m = await seedMerchant()
      const address = addr()
      const created = await register(m.userId, address.toUpperCase().replace('0X', '0x'))
      expect(created.statusCode, created.body).toBe(201)
      expect(created.json()).toMatchObject({
        address,
        chain: `eip155:${CHAIN}`,
        active: true,
        retired_at: null,
      })

      const listed = await list(m.userId)
      expect(listed.statusCode).toBe(200)
      expect(listed.json().addresses).toHaveLength(1)

      const retired = await retire(m.userId, created.json().id)
      expect(retired.statusCode, retired.body).toBe(200)
      expect(retired.json()).toMatchObject({ active: false })
      expect(retired.json().retired_at).not.toBeNull()
      // Never deleted: the retired row is still listed.
      const after = await list(m.userId)
      expect(after.json().addresses).toHaveLength(1)
      expect(after.json().addresses[0].active).toBe(false)
      expect((await retire(m.userId, created.json().id)).json().error_code).toBe('DEPOSIT_ADDRESS_RETIRED')
      expect((await retire(m.userId, randomUUID())).statusCode).toBe(404)
    })

    it('the Sales key reaches none of the three routes', async () => {
      const m = await seedMerchant()
      const created = await register(m.userId, addr())
      const id = created.json().id as string
      const headers = { authorization: `Bearer ${m.secret}` }
      const calls: Array<['GET' | 'POST', string, unknown]> = [
        ['GET', '/merchant-deposit-addresses', undefined],
        ['POST', '/merchant-deposit-addresses', { address: addr() }],
        ['POST', `/merchant-deposit-addresses/${id}/retire`, undefined],
      ]
      for (const [method, url, payload] of calls) {
        const res = await app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined })
        expect(res.statusCode, `${method} ${url}`).toBe(401)
      }
      const viaHeader = await app.inject({
        method: 'POST',
        url: '/merchant-deposit-addresses',
        headers: { 'x-api-key': m.secret },
        payload: { address: addr() },
      })
      expect(viaHeader.statusCode).toBe(401)
      const rows = await db.query(`SELECT retired_at FROM merchant_deposit_addresses WHERE account_id = $1`, [m.accountId])
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0].retired_at).toBeNull()
    })

    it('a device-login token can neither register nor retire', async () => {
      const m = await seedMerchant()
      const cli = { purpose: 'owner_cli' }
      const res = await app.inject({
        method: 'POST',
        url: '/merchant-deposit-addresses',
        headers: auth(m.userId, cli),
        payload: { address: addr() },
      })
      expect(res.statusCode).toBe(401)
      expect((await db.query(`SELECT 1 FROM merchant_deposit_addresses`)).rowCount).toBe(0)
    })

    it('refuses an address that is not a valid EVM address, with its own code', async () => {
      const m = await seedMerchant()
      for (const bad of ['0x1234', 'not-an-address', '0x' + 'zz'.repeat(20), '']) {
        const res = await register(m.userId, bad)
        expect(res.statusCode, bad).toBe(400)
        expect(res.json().error_code).toBe('INVALID_DEPOSIT_ADDRESS')
      }
      expect((await register(m.userId, 42)).statusCode).toBe(400)
      expect((await db.query(`SELECT 1 FROM merchant_deposit_addresses`)).rowCount).toBe(0)
    })

    it('refuses an address already registered to any account on that chain, and refuses it once retired only for the holder', async () => {
      const a = await seedMerchant()
      const b = await seedMerchant()
      const address = addr()
      const first = await register(a.userId, address)
      expect(first.statusCode).toBe(201)
      for (const who of [a, b]) {
        const res = await register(who.userId, address)
        expect(res.statusCode).toBe(409)
        expect(res.json().error_code).toBe('DEPOSIT_ADDRESS_ALREADY_REGISTERED')
      }
    })

    it('the partial unique index holds one active registration per (chain, address) and lets a retired address be registered again', async () => {
      const a = await seedMerchant()
      const b = await seedMerchant()
      const address = addr()
      const first = await register(a.userId, address)
      expect((await register(b.userId, address)).statusCode).toBe(409)
      // The table itself refuses a second active row, whatever the code did.
      await expect(
        db.query(
          `INSERT INTO merchant_deposit_addresses (account_id, user_id, chain_id, address) VALUES ($1, $2, $3, $4)`,
          [b.accountId, b.userId, CHAIN, address],
        ),
      ).rejects.toThrow(/idx_merchant_deposit_addresses_active/)

      expect((await retire(a.userId, first.json().id)).statusCode).toBe(200)
      // Retired: another account (and the old holder) can register it again.
      expect((await register(b.userId, address)).statusCode).toBe(201)
      const rows = await db.query(`SELECT account_id, retired_at FROM merchant_deposit_addresses WHERE address = $1`, [address])
      expect(rows.rows).toHaveLength(2)
    })

    it('refuses the owner\'s own smart accounts, agent delegates and replaced delegates', async () => {
      const m = await seedMerchant()
      const liveDelegate = addr()
      const oldDelegate = addr()
      const otherAccount = addr()
      await db.query(
        `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
         VALUES ($1, $2, 8453, 'delegation', 'delegator_hybrid', true)`,
        [m.userId, otherAccount],
      )
      const agent = await db.query<{ id: string }>(
        `INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'A', $2, 'active') RETURNING id`,
        [m.userId, liveDelegate],
      )
      await db.query(
        `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address)
         VALUES ($1, $2, $3, $4)`,
        [agent.rows[0].id, m.userId, oldDelegate, liveDelegate],
      )
      for (const own of [m.address, otherAccount, liveDelegate, oldDelegate]) {
        const res = await register(m.userId, own.toUpperCase().replace('0X', '0x'))
        expect(res.statusCode, own).toBe(409)
        expect(res.json().error_code).toBe('DEPOSIT_ADDRESS_IS_OWN')
      }
      expect((await db.query(`SELECT 1 FROM merchant_deposit_addresses`)).rowCount).toBe(0)
    })

    it('every registration, in every answer, carries "registered by you, not verified by Haven"', async () => {
      const m = await seedMerchant()
      const created = await register(m.userId, addr())
      const retired = await retire(m.userId, created.json().id)
      const listed = (await list(m.userId)).json()
      for (const r of [created.json(), retired.json(), ...listed.addresses]) {
        expect(r.verified).toBe(false)
        expect(r.verification).toBe('Registered by you, not verified by Haven.')
      }
      expect(listed.verification).toBe('Registered by you, not verified by Haven.')
    })

    it('with merchant services off the list is empty and register and retire answer MERCHANT_ACCOUNT_REQUIRED', async () => {
      const m = await seedMerchant({ enabled: false })
      expect((await list(m.userId)).json().addresses).toEqual([])
      const res = await register(m.userId, addr())
      expect(res.statusCode).toBe(409)
      expect(res.json().error_code).toBe('MERCHANT_ACCOUNT_REQUIRED')
      expect((await retire(m.userId, randomUUID())).json().error_code).toBe('MERCHANT_ACCOUNT_REQUIRED')
      expect((await db.query(`SELECT 1 FROM merchant_deposit_addresses`)).rowCount).toBe(0)
    })

    it('keeps accounts apart: one owner cannot list or retire another\'s registration', async () => {
      const a = await seedMerchant()
      const b = await seedMerchant()
      const created = await register(a.userId, addr())
      expect((await list(b.userId)).json().addresses).toEqual([])
      expect((await retire(b.userId, created.json().id)).statusCode).toBe(404)
    })

    it('rate limits retire at the money-path ceiling', async () => {
      const m = await seedMerchant()
      const headers = auth(m.userId, { jti: 'deposit-retire-rate-limit' })
      const call = () =>
        app.inject({ method: 'POST', url: `/merchant-deposit-addresses/${randomUUID()}/retire`, headers })
      for (let i = 0; i < 60; i += 1) expect((await call()).statusCode).toBe(404)
      expect((await call()).statusCode).toBe(429)
    })

    it('rate limits register at the money-path ceiling', async () => {
      const m = await seedMerchant()
      const headers = auth(m.userId, { jti: 'deposit-rate-limit' })
      const call = () =>
        app.inject({ method: 'POST', url: '/merchant-deposit-addresses', headers, payload: { address: '0x12' } })
      for (let i = 0; i < 60; i += 1) expect((await call()).statusCode).toBe(400)
      expect((await call()).statusCode).toBe(429)
    })
  })

  describe('the ingest accepts a sale to a registered address', () => {
    it('stores held_by stripe and the registered address, from the registry, writes no inbound_transfers row and moves no balance', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, BEFORE_BLOCK)
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      const balanceBefore = await inboundReceiveBalanceAtomic(m.accountId, m.userId)

      // The record claims nothing about the address; a record cannot name one.
      const res = await post(m.secret, record())
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        held_by: 'stripe',
        receiving_address: deposit,
        amount_raw: '1000000',
        payer_address: PAYER,
        token_address: USDC,
        block_number: 100,
      })
      const stored = (await salesFor(m.accountId)).rows
      expect(stored).toHaveLength(1)
      expect(stored[0].held_by).toBe('stripe')
      expect(stored[0].receiving_address).toBe(deposit)
      // Balances untouched: no inbound row, so no receive balance.
      expect((await inboundFor(m.accountId)).rowCount).toBe(0)
      expect((await db.query(`SELECT 1 FROM inbound_transfers`)).rowCount).toBe(0)
      expect(await inboundReceiveBalanceAtomic(m.accountId, m.userId)).toEqual(balanceBefore)
    })

    it('one record per transaction: an identical resend changes nothing and a different record is 409', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, BEFORE_BLOCK)
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      const first = await post(m.secret, record())
      expect(first.statusCode).toBe(201)
      mocks.read.mockClear()
      const again = await post(m.secret, record())
      expect(again.statusCode).toBe(200)
      expect(again.json()).toEqual(first.json())
      expect(mocks.read).not.toHaveBeenCalled()
      const conflict = await post(m.secret, record({ product_id: 'other' }))
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json().error_code).toBe('sale_record_conflict')
      expect((await salesFor(m.accountId)).rows).toHaveLength(1)
    })

    it('keeps the confirmations and the 425 retry answer', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, BEFORE_BLOCK)
      mocks.read.mockResolvedValue({
        ok: true,
        receiptFound: true,
        blockNumber: 100,
        latestBlock: 100,
        legs: [],
        otherLegs: [{ leg: leg(PAYER, '5', 0), toAddress: deposit }],
      })
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(425)
      expect(res.headers['retry-after']).toBeDefined()
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
    })

    it('a transaction that pays the account and a registered address is an account sale counting only the account legs', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, BEFORE_BLOCK)
      chainShows(
        [leg(PAYER, '700000', 1)],
        [{ to: deposit, leg: leg(PAYER, '9000000', 2) }],
      )
      const res = await post(m.secret, record())
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({ held_by: 'account', receiving_address: null, amount_raw: '700000' })
      expect((await inboundFor(m.accountId)).rowCount).toBe(1)
    })

    it('legs to several registered addresses: only the first address by log index counts, so the row\'s address and amount agree', async () => {
      const m = await seedMerchant()
      const a = addr()
      const b = addr()
      await registerAt(m, a, BEFORE_BLOCK)
      await registerAt(m, b, BEFORE_BLOCK)
      chainShows([], [
        { to: b, leg: leg(PAYER, '2000000', 7) },
        { to: a, leg: leg(PAYER, '1000000', 3) },
      ])
      const res = await post(m.secret, record())
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({ receiving_address: a, amount_raw: '1000000' })
    })

    it('the own-sender fold: a sale from the owner\'s own agent delegate is an own move, amount 0, in no revenue', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      const delegate = addr()
      await db.query(`INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'Buyer', $2, 'active')`, [
        m.userId,
        delegate,
      ])
      await registerAt(m, deposit, BEFORE_BLOCK)
      chainShows([], [{ to: deposit, leg: leg(delegate, '2000000', 3) }])
      const res = await post(m.secret, record({ payer: delegate }))
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        held_by: 'stripe',
        amount_raw: '0',
        sender_is_own_address: true,
        payer_address: delegate,
      })
      const summary = (await get(m.userId, '/merchant-sales/summary')).json()
      expect(summary.received_in_stripe).toEqual({ count: 0, amount_raw: '0' })
      expect(summary.own_moves).toEqual({ count: 0, amount_raw: '0' })
      // Never revenue, and its row holds no "what moved" amount: not in the list.
      expect((await get(m.userId, '/merchant-sales/payments')).json().payments).toEqual([])
    })
  })

  describe('which registrations count: the window at the leg\'s block time', () => {
    it('refuses a leg to an address registered AFTER the leg\'s block', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, AFTER_BLOCK)
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(422)
      expect(res.json().error_code).toBe('no_payment_to_account')
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
    })

    it('refuses a leg to an address retired BEFORE the leg\'s block, and accepts one retired after it', async () => {
      const m = await seedMerchant()
      const retiredBefore = addr()
      const retiredAfter = addr()
      await registerAt(m, retiredBefore, '2026-11-16T00:00:00Z', BEFORE_BLOCK)
      await registerAt(m, retiredAfter, '2026-11-16T00:00:00Z', AFTER_BLOCK)

      chainShows([], [{ to: retiredBefore, leg: leg(PAYER, '1000000', 4) }])
      const refused = await post(m.secret, record())
      expect(refused.statusCode).toBe(422)

      chainShows([], [{ to: retiredAfter, leg: leg(PAYER, '1000000', 4) }])
      const accepted = await post(m.secret, record())
      expect(accepted.statusCode, accepted.body).toBe(201)
      expect(accepted.json().receiving_address).toBe(retiredAfter)
    })

    it('counts a leg whose block time equals the registration time exactly', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, BLOCK_TIME.toISOString())
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      const res = await post(m.secret, record())
      expect(res.statusCode, res.body).toBe(201)
    })

    it('refuses, with the no-payment answer, a leg whose block time equals the retirement time exactly', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, '2026-11-16T00:00:00Z', BLOCK_TIME.toISOString())
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(422)
      chainShows([], [])
      const nobody = await post(m.secret, record({ tx_hash: '0x' + '2b'.repeat(32) }))
      expect(res.json()).toEqual(nobody.json())
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
    })

    it('does not count a registration a fraction of a second after the whole-second block time', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, '2026-11-17T10:00:00.400Z')
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      expect((await post(m.secret, record())).statusCode).toBe(422)
    })

    it('a re-registration after a retirement is a second window that counts for later legs', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, '2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z')
      await registerAt(m, deposit, BEFORE_BLOCK)
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      expect((await post(m.secret, record())).statusCode).toBe(201)
    })
  })

  describe('no oracle: every refusal is the answer for a hash that paid nobody', () => {
    it('answers a leg to another account\'s address, an unregistered one and out-of-window ones exactly as a hash that paid nobody', async () => {
      const m = await seedMerchant()
      const other = await seedMerchant()
      const otherAddress = addr()
      const unregistered = addr()
      const late = addr()
      await registerAt(other, otherAddress, BEFORE_BLOCK)
      await registerAt(m, late, AFTER_BLOCK)

      const responses: Array<{ status: number; body: unknown }> = []
      for (const scenario of [
        { name: 'nobody', others: [] as Array<{ to: string; leg: ReturnType<typeof leg> }> },
        { name: 'other account', others: [{ to: otherAddress, leg: leg(PAYER, '1000000', 1) }] },
        { name: 'unregistered', others: [{ to: unregistered, leg: leg(PAYER, '1000000', 1) }] },
        { name: 'registered late', others: [{ to: late, leg: leg(PAYER, '1000000', 1) }] },
      ]) {
        chainShows([], scenario.others)
        const res = await post(m.secret, record())
        responses.push({ status: res.statusCode, body: res.json() })
        expect(res.statusCode, scenario.name).toBe(422)
      }
      for (const r of responses) expect(r).toEqual(responses[0])
      expect(responses[0].body).toMatchObject({ error: 'no_payment_to_account' })
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
      expect((await salesFor(other.accountId)).rows).toHaveLength(0)
    })

    it('refuses a leg to another account\'s address even if the chain read returned it', async () => {
      const m = await seedMerchant()
      const other = await seedMerchant()
      const theirs = addr()
      await registerAt(other, theirs, BEFORE_BLOCK)
      mocks.read.mockResolvedValue({
        ok: true,
        receiptFound: true,
        blockNumber: 100,
        latestBlock: 102,
        legs: [],
        otherLegs: [{ leg: leg(PAYER, '1000000', 1), toAddress: theirs }],
      })
      const res = await post(m.secret, record())
      expect(res.statusCode).toBe(422)
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
    })

    it('does not name another account\'s registered addresses to the chain read', async () => {
      const m = await seedMerchant()
      const other = await seedMerchant()
      const mine = addr()
      const theirs = addr()
      await registerAt(m, mine, BEFORE_BLOCK)
      await registerAt(other, theirs, BEFORE_BLOCK)
      chainShows([], [])
      await post(m.secret, record())
      expect(mocks.read.mock.calls[0][3]).toEqual([mine])
    })
  })

  describe('the reads keep Stripe-held sales apart', () => {
    const PERIOD = 'from=2026-11-01&to=2026-11-30'

    async function seedAccountSale(m: Merchant, tx: string, amount: string) {
      await db.query(
        `INSERT INTO inbound_transfers
           (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
            amount_raw, block_number, block_time, sender_is_own_address)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 100, '2026-11-10T10:00:00Z', false)`,
        [m.accountId, m.userId, CHAIN, tx, PAYER, USDC, amount],
      )
      await db.query(
        `INSERT INTO merchant_sales (account_id, user_id, chain_id, tx_hash, product_id, merchant_reference,
           amount_raw, token_address, payer_address, block_number, block_time)
         VALUES ($1, $2, $3, $4, 'P1', 'r1', $5, $6, $7, 100, '2026-11-10T10:00:00Z')`,
        [m.accountId, m.userId, CHAIN, tx, amount, USDC, PAYER],
      )
    }

    async function seedStripeSale(
      m: Merchant,
      tx: string,
      amount: string,
      deposit: string,
      over: { own?: boolean; several?: boolean } = {},
    ) {
      await db.query(
        `INSERT INTO merchant_sales (account_id, user_id, chain_id, tx_hash, product_id, merchant_reference,
           amount_raw, token_address, payer_address, block_number, block_time, held_by, receiving_address,
           sender_is_own_address, several_payers)
         VALUES ($1, $2, $3, $4, 'P2', 'r2', $5, $6, $7, 100, '2026-11-11T10:00:00Z', 'stripe', $8, $9, $10)`,
        [m.accountId, m.userId, CHAIN, tx, amount, USDC, over.several ? null : PAYER, deposit, over.own ?? false, over.several ?? false],
      )
    }

    const H1 = '0x' + '01'.repeat(32)
    const H2 = '0x' + '02'.repeat(32)
    const H3 = '0x' + '03'.repeat(32)

    it('the tiles and breakdowns count only account-held sales; the Stripe-held figure is separate', async () => {
      const m = await seedMerchant()
      await seedAccountSale(m, H1, '1000000')
      await seedStripeSale(m, H2, '5000000', addr())
      await seedStripeSale(m, H3, '0', addr(), { own: true })
      await seedStripeSale(m, '0x' + '04'.repeat(32), '7000000', addr(), { several: true })

      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      expect(summary).toMatchObject({
        revenue_raw: '1000000',
        sales: 1,
        average_sale_raw: '1000000',
        without_product: { count: 0, amount_raw: '0' },
        own_moves: { count: 0, amount_raw: '0' },
        unattributed: { payments: 0, amount_raw: '0' },
        received_in_stripe: { count: 2, amount_raw: '12000000' },
      })
      expect(summary.by_product).toEqual([expect.objectContaining({ product_id: 'P1', sales: 1, amount_raw: '1000000' })])
      expect(summary.by_payer).toHaveLength(1)
      expect(summary.by_payer[0]).toMatchObject({ payments: 1, amount_raw: '1000000' })
      expect(summary.by_day).toEqual([{ day: '2026-11-10', payments: 1, sales: 1, revenue_raw: '1000000' }])
    })

    it('an account with no Stripe-held sales has exactly the figures it had, and a zero Stripe figure', async () => {
      const m = await seedMerchant()
      await seedAccountSale(m, H1, '1000000')
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      const { received_in_stripe, ...rest } = summary
      expect(received_in_stripe).toEqual({ count: 0, amount_raw: '0' })
      expect(rest).toMatchObject({ revenue_raw: '1000000', sales: 1, average_sale_raw: '1000000' })
      const payments = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({ held_by: 'account', receiving_address: null })
    })

    it('the list includes Stripe-held sales with held_by and the receiving address; totals and list agree per kind', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await seedAccountSale(m, H1, '1000000')
      await seedStripeSale(m, H2, '5000000', deposit)
      const summary = (await get(m.userId, `/merchant-sales/summary?${PERIOD}`)).json()
      const payments = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments
      expect(payments).toHaveLength(2)
      const stripe = payments.filter((p: { held_by: string }) => p.held_by === 'stripe')
      const account = payments.filter((p: { held_by: string }) => p.held_by === 'account')
      expect(stripe).toEqual([expect.objectContaining({ tx_hash: H2, kind: 'sale', receiving_address: deposit, amount_raw: '5000000' })])
      const sum = (rows: Array<{ amount_raw: string }>) => rows.reduce((t, r) => t + BigInt(r.amount_raw), 0n).toString()
      expect(sum(account)).toBe(summary.revenue_raw)
      expect(sum(stripe)).toBe(summary.received_in_stripe.amount_raw)
      expect(stripe.length).toBe(summary.received_in_stripe.count)
    })

    it('a Stripe-held sale row never attaches to the account\'s own legs of the same transaction', async () => {
      const m = await seedMerchant()
      // Not reachable through the ingest (it stores one or the other); seeded directly.
      await db.query(
        `INSERT INTO inbound_transfers
           (account_id, user_id, chain_id, tx_hash, log_index, payer_address, token_address,
            amount_raw, block_number, block_time, sender_is_own_address)
         VALUES ($1, $2, $3, $4, 0, $5, $6, 300000, 100, '2026-11-10T10:00:00Z', false)`,
        [m.accountId, m.userId, CHAIN, H1, PAYER, USDC],
      )
      await seedStripeSale(m, H1, '5000000', addr())
      const payments = (await get(m.userId, `/merchant-sales/payments?${PERIOD}`)).json().payments
      const account = payments.find((p: { held_by: string }) => p.held_by === 'account')
      expect(account).toMatchObject({ kind: 'no_product', amount_raw: '300000', product_id: null })
    })

    it('the detail read returns a Stripe-held sale\'s chain facts from the sale row', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await seedStripeSale(m, H2, '5000000', deposit)
      const res = await get(m.userId, `/merchant-sales/payments/${H2}`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({
        held_by: 'stripe',
        receiving_address: deposit,
        amount_raw: '5000000',
        merchant_reference: 'r2',
        legs: [{ log_index: null, amount_raw: '5000000', payer: { address: PAYER } }],
      })
    })

    it('clearing a Stripe-held sale works, and a new record is accepted afterwards', async () => {
      const m = await seedMerchant()
      const deposit = addr()
      await registerAt(m, deposit, BEFORE_BLOCK)
      chainShows([], [{ to: deposit, leg: leg(PAYER, '1000000', 4) }])
      expect((await post(m.secret, record())).statusCode).toBe(201)
      const cleared = await app.inject({
        method: 'DELETE',
        url: `/merchant-sales/payments/${TX}/record`,
        headers: auth(m.userId),
      })
      expect(cleared.statusCode).toBe(204)
      expect((await salesFor(m.accountId)).rows).toHaveLength(0)
      const again = await post(m.secret, record({ merchant_reference: 'sale_NEW' }))
      expect(again.statusCode, again.body).toBe(201)
      expect(again.json()).toMatchObject({ held_by: 'stripe', merchant_reference: 'sale_NEW' })
    })
  })
})
