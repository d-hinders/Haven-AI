/**
 * Real-DB route tests for #3824 — grouped dashboard activity and serve-time
 * ("at today's rate") approx amounts on the wire.
 *
 * Money-path rule: real DB, zero handler mocks. The seeded surface is the
 * #1220 harness (schema at head); the STUBS are collaborators only:
 *
 * - `infra/explorer-api.js` — the three explorer legs. The dashboard feed's
 *   explorer half is stubbed at exactly the boundary the route already owns
 *   (`fetchAccountTransactions` → these fetchers), so `aggregate.ts` runs
 *   real. The sweep case feeds a native row through the REAL normalizer to
 *   prove the sweep reaches its group through enrichment, not a shortcut.
 * - `modules/accounts/index.js` — the portfolio read (chain-backed; no chain
 *   here). `combineBalanceFreshness` stays real, as in `dashboard.test.ts`.
 * - `rails/delegation-budget-view.js` — no delegations in this fixture.
 * - `infra/prices.js` — `getTokenPrice` IS the collaborator the acceptance
 *   criteria name ("the stub is a collaborator, so mocking it is allowed");
 *   `getServeTimeFiatValues` and every route run real through it.
 *
 * Everything else is the real thing: `mergeX402Transactions` synthesizes from
 * real seeded `payment_intents`, `enrichTransactionsWithAgents` attributes
 * from real rows, the grouped activity is built by the route over that feed.
 *
 * Outcome mapping pinned here (stated in the PR): an x402 row with a
 * terminal `payment_proof_status` (`protocol_receipt_attached`) groups as
 * `confirmed`; one whose evidence is absent (`payment_proof_status` null →
 * lifecycle `confirming_merchant`) groups as `pending`.
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
    fetchPortfolioForAccount: vi.fn(async () => ({
      totalUsd: 1,
      totalEur: 1,
      totalSek: 1,
      breakdown: [],
    })),
    isPortfolioUnpriceable: vi.fn(() => false),
  },
}))

vi.mock('../../infra/explorer-api.js', () => explorerMocks)
vi.mock('../../infra/prices.js', () => ({ getTokenPrice: priceMocks.getTokenPrice }))
vi.mock('../../rails/delegation-budget-view.js', () => ({
  deriveDelegationAllowances: async () => new Map(),
}))
import { combineBalanceFreshness } from '../../modules/accounts/balance-freshness.js'
vi.mock('../../modules/accounts/index.js', () => ({
  ...portfolioMocks,
  combineBalanceFreshness,
}))

import db from '../../db.js'
import dashboardRoutes from '../dashboard.js'
import transactionRoutes from '../transactions.js'
import { transactionsToCsv } from '../../modules/transactions/index.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../infra/__tests__/helpers/db-harness.js'

const CHAIN = 84532 // Base Sepolia — the registry names USDC there
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const MERCHANT = '0x' + 'ee'.repeat(20)
const RESOURCE_URL = 'https://merchant.example/3824'
const TZ = 'Europe/Stockholm'

let seq = 0

/**
 * A unix-seconds timestamp guaranteed inside the user-local day
 * `dayOffsetBack` days before today IN `tz` — robust at any wall-clock time
 * (a fixed `now - N h` offset can straddle midnight).
 */
function tsInLocalDay(tz: string, dayOffsetBack: number): number {
  const dayKey = (ms: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms))
  let ms = Date.now()
  const today = dayKey(ms)
  let target = today
  for (let i = 0; i < dayOffsetBack; i += 1) {
    while (dayKey(ms) === target) ms -= 3_600_000
    target = dayKey(ms)
  }
  while (dayKey(ms) !== target) ms -= 3_600_000
  return Math.floor(ms / 1000)
}

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`a3824-${++seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

/** A delegator_hybrid smart account with a distinct address (per-test cache isolation). */
async function seedAccount(userId: string): Promise<{ id: string; address: string }> {
  const address = `0x${String(++seq).padStart(4, '0').repeat(2)}${'cd'.repeat(16)}`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, name)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', 'Activity account') RETURNING id`,
    [userId, address, CHAIN],
  )
  return { id: rows[0].id, address }
}

async function seedAgent(userId: string, accountId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, account_id, status)
     VALUES ($1, 'Activity agent', $2, $3, 'hvn_tst', $4, 'active') RETURNING id`,
    [
      userId,
      '0x' + 'ab'.repeat(20),
      createHash('sha256').update(`key-${seq}`).digest('hex'),
      accountId,
    ],
  )
  return rows[0].id
}

/**
 * A stored x402 payment intent — the shape `findConfirmedX402PaymentIntents`
 * and the agent-attribution join both read. `confirmedAt` is an ISO string
 * (null → the column default), the timestamp the synthesized row carries.
 */
async function seedX402Payment(input: {
  userId: string
  agentId: string
  accountId: string
  accountAddress: string
  amountHuman?: string
  confirmedAt?: string | null
  proofStatus?: string | null
  resourceUrl?: string
}): Promise<string> {
  const txHash = `0x${String(++seq).padStart(4, '0').repeat(2)}${'9'.repeat(28)}`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, chain_id, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata,
        x402_idempotency_key, machine_idempotency_key, send_idempotency_key,
        confirmed_at, created_at)
     VALUES ($1, $2, $3, 'USDC', $4, $5,
             '1000000', $6, '0x' || repeat('ab', 20), 0, $7,
             'confirmed', $8, NOW() + interval '10 minutes', 'delegation', $9, 'x402', 'x402',
             $10, $5, $11,
             $12, $12, $12,
             COALESCE($13::timestamptz, NOW()), COALESCE($13::timestamptz, NOW()))
     RETURNING id`,
    [
      input.agentId,
      input.userId,
      input.accountAddress,
      USDC,
      MERCHANT,
      input.amountHuman ?? '1.0',
      `0x${String(seq).padStart(64, '7')}`,
      txHash,
      CHAIN,
      input.resourceUrl ?? RESOURCE_URL,
      JSON.stringify({ network: `eip155:${CHAIN}`, settlement_scheme: 'erc7710' }),
      `idem-${seq}`,
      input.confirmedAt ?? null,
    ],
  )
  const intentId = rows[0].id
  if (input.proofStatus) {
    await db.query(
      `INSERT INTO machine_payment_evidence
         (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
          resource_url, payer_address, settlement_address, token_symbol, token_address,
          amount_raw, amount_human)
       VALUES ($1, $2, $3, 'x402', $4, $5, $6, $7, '0x' || repeat('ab', 20), $8,
               'USDC', $9, '1000000', $10)`,
      [
        intentId,
        input.agentId,
        input.userId,
        input.proofStatus,
        txHash,
        CHAIN,
        input.resourceUrl ?? RESOURCE_URL,
        MERCHANT,
        USDC,
        input.amountHuman ?? '1.0',
      ],
    )
  }
  return intentId
}

/** A submitted delegate sweep matched to an explorer row by tx_hash + account. */
async function seedSweep(input: {
  userId: string
  agentId: string
  accountAddress: string
  txHash: string
  valueAtomic: string
}): Promise<void> {
  await db.query(
    `INSERT INTO delegate_sweeps
       (agent_id, user_id, chain_id, token_address, from_address, to_address,
        value_atomic, valid_after, valid_before, nonce, status, tx_hash, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, '0x' || repeat('c', 20), $5, $6, 0, 9999999999, $7,
             'submitted', $8, NOW(), NOW())`,
    [input.agentId, input.userId, CHAIN, USDC, input.accountAddress, input.valueAtomic, `0x${String(++seq).padStart(64, '1')}`, input.txHash],
  )
}

describeDb('#3824 — grouped activity + serve-time approx amounts on the wire', () => {
  let app: FastifyInstance
  let token: string
  let userId: string

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  beforeEach(async () => {
    await resetDb()
    explorerMocks.fetchNormalTransactions.mockReset()
    explorerMocks.fetchInternalTransactions.mockReset()
    explorerMocks.fetchERC20Transfers.mockReset()
    explorerMocks.fetchNormalTransactions.mockResolvedValue({ rows: [], hasMore: false })
    explorerMocks.fetchInternalTransactions.mockResolvedValue({ rows: [], hasMore: false })
    explorerMocks.fetchERC20Transfers.mockResolvedValue({ rows: [], hasMore: false })
    priceMocks.getTokenPrice.mockReset()
    priceMocks.getTokenPrice.mockResolvedValue({ usd: 1, eur: 0.9, sek: 10.76 })

    userId = await seedUser()
    token = app.jwt.sign({ sub: userId, email: 'a3824@test.example' })
  })

  const getOverview = async (query = '') => {
    const res = await app.inject({
      method: 'GET',
      url: `/dashboard/overview${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
    return { code: res.statusCode, body: res.json() as Record<string, unknown> }
  }

  it('40 same-day x402 payments from one agent to one merchant group into ONE row with count 40', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    const at = new Date(tsInLocalDay(TZ, 0) * 1000).toISOString()
    for (let i = 0; i < 40; i += 1) {
      await seedX402Payment({
        userId,
        agentId,
        accountId: account.id,
        accountAddress: account.address,
        confirmedAt: at,
        proofStatus: 'protocol_receipt_attached',
      })
    }
    // The merchant is in the address book — the group carries the label.
    await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Example Merchant', $2)`, [
      userId,
      MERCHANT,
    ])

    const { code, body } = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect(code).toBe(200)
    const activity = body.activity as Array<Record<string, unknown>>
    expect(activity).toHaveLength(1)
    expect(activity[0].count).toBe(40)
    // 40 × 1.0 USDC in atomic units; one token per group so the units agree.
    expect(activity[0].sumAtomic).toBe('40000000')
    expect(activity[0].tokenSymbol).toBe('USDC')
    expect(activity[0].decimals).toBe(6)
    expect(activity[0].agentId).toBe(agentId)
    // The wire carries the canonical (EIP-55) form; compare case-insensitively.
    expect(String(activity[0].to).toLowerCase()).toBe(MERCHANT)
    expect(activity[0].merchantName).toBe('Example Merchant')
    expect(activity[0].status).toBe('confirmed')
    // Every member lacked book-time fiat → the group carries the SERVE-TIME
    // sum at the stubbed price (40 × 10.76 SEK), never a convertedAmount.
    expect(activity[0].approxAmount).toBe('430.4000')
    expect(activity[0].approxCurrency).toBe('SEK')
    expect(activity[0].convertedAmount).toBeUndefined()
    expect(activity[0].countIsFloor).toBeUndefined()
    // The deprecated 5-row preview is untouched on the same response.
    expect((body.transactions as unknown[]).length).toBe(5)
  })

  it('the same payments split across the user-local midnight return two groups, newest first', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    const today = new Date(tsInLocalDay(TZ, 0) * 1000).toISOString()
    const yesterday = new Date(tsInLocalDay(TZ, 1) * 1000).toISOString()
    for (let i = 0; i < 20; i += 1) {
      await seedX402Payment({
        userId,
        agentId,
        accountId: account.id,
        accountAddress: account.address,
        confirmedAt: i < 10 ? today : yesterday,
        proofStatus: 'protocol_receipt_attached',
      })
    }

    const { code, body } = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect(code).toBe(200)
    const activity = body.activity as Array<Record<string, unknown>>
    expect(activity).toHaveLength(2)
    expect(activity.map((g) => g.count)).toEqual([10, 10])
    // Newest first: today's group leads.
    expect(new Date(activity[0].latestAt as string).getTime()).toBeGreaterThan(
      new Date(activity[1].latestAt as string).getTime(),
    )
    // The same day split in UTC proves the bucketing is the REQUESTED zone,
    // not the server's: 00:30 Stockholm is the previous UTC day.
    const utcBody = (await getOverview('?tz=UTC')).body
    const utcActivity = utcBody.activity as Array<Record<string, unknown>>
    expect(utcActivity).toHaveLength(2)
    expect(utcActivity.map((g) => g.count).sort((a, b) => (b as number) - (a as number))).toEqual([10, 10])
  })

  it('a delegate sweep returns its own group with activityType delegate_sweep', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    const txHash = `0x${'d1'.repeat(32)}`
    await seedSweep({ userId, agentId, accountAddress: account.address, txHash, valueAtomic: '2000000' })
    // The sweep IS an explorer row: the native leg returns it (Etherscan
    // `RawNormalTx` shape — the shape every provider normalizes to), the REAL
    // normalizer canonicalizes it, and the real sweep-attribution join names it.
    explorerMocks.fetchNormalTransactions.mockResolvedValue({
      rows: [
        {
          blockNumber: '45000001',
          timeStamp: String(tsInLocalDay(TZ, 0)),
          hash: txHash,
          from: '0x' + 'c'.repeat(40),
          to: account.address,
          value: '2000000',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        },
      ],
      hasMore: false,
    })

    const { code, body } = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect(code).toBe(200)
    const activity = body.activity as Array<Record<string, unknown>>
    expect(activity).toHaveLength(1)
    expect(activity[0].activityType).toBe('delegate_sweep')
    expect(activity[0].agentId).toBe(agentId)
    expect(activity[0].count).toBe(1)
    expect(activity[0].sumAtomic).toBe('2000000')
    expect(activity[0].status).toBe('confirmed')
  })

  it('a truncated explorer window marks every group countIsFloor: true', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    await seedX402Payment({
      userId,
      agentId,
      accountId: account.id,
      accountAddress: account.address,
      confirmedAt: new Date(tsInLocalDay(TZ, 0) * 1000).toISOString(),
      proofStatus: 'protocol_receipt_attached',
    })
    explorerMocks.fetchNormalTransactions.mockResolvedValue({
      rows: [
        {
          blockNumber: '45000002',
          timeStamp: String(tsInLocalDay(TZ, 0)),
          hash: `0x${'e2'.repeat(32)}`,
          from: '0x' + 'c'.repeat(40),
          to: account.address,
          value: '1000',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        },
      ],
      // The leg stopped at its budget with more offered upstream.
      hasMore: true,
    })

    const { code, body } = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect(code).toBe(200)
    const activity = body.activity as Array<Record<string, unknown>>
    expect(activity.length).toBeGreaterThan(0)
    for (const group of activity) expect(group.countIsFloor).toBe(true)
  })

  it('an invalid tz is refused with 400 before any read', async () => {
    const { code, body } = await getOverview('?tz=Not%2FA%20Zone')
    expect(code).toBe(400)
    // The raw value is never reflected into the body.
    expect(body.error).toBe('unsupported tz')
  })

  it('the outcome mapping: terminal proof groups confirmed, no evidence groups pending', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    const at = new Date(tsInLocalDay(TZ, 0) * 1000).toISOString()
    await seedX402Payment({
      userId,
      agentId,
      accountId: account.id,
      accountAddress: account.address,
      confirmedAt: at,
      proofStatus: 'protocol_receipt_attached',
    })
    await seedX402Payment({
      userId,
      agentId,
      accountId: account.id,
      accountAddress: account.address,
      confirmedAt: at,
      proofStatus: null,
    })

    const { code, body } = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect(code).toBe(200)
    const activity = body.activity as Array<Record<string, unknown>>
    expect(activity.map((g) => g.status).sort()).toEqual(['confirmed', 'pending'])
    expect(activity.every((g) => g.count === 1)).toBe(true)
  })

  it('an unpriceable token prices the group approx null — never 0', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    await seedX402Payment({
      userId,
      agentId,
      accountId: account.id,
      accountAddress: account.address,
      confirmedAt: new Date(tsInLocalDay(TZ, 0) * 1000).toISOString(),
      proofStatus: 'protocol_receipt_attached',
    })
    // The failing read (a price outage): persistent for the whole request —
    // the route's monthly-spend accumulator prices THROUGH the same read, so
    // a one-shot rejection would be consumed there first.
    priceMocks.getTokenPrice.mockRejectedValue(new Error('CoinGecko down'))
    const failed = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect((failed.body.activity as Array<Record<string, unknown>>)[0].approxAmount).toBeNull()
    expect((failed.body.activity as Array<Record<string, unknown>>)[0].approxCurrency).toBe('SEK')

    priceMocks.getTokenPrice.mockResolvedValue({ usd: 0, eur: 0, sek: 0 })
    const zero = await getOverview(`?tz=${encodeURIComponent(TZ)}`)
    expect((zero.body.activity as Array<Record<string, unknown>>)[0].approxAmount).toBeNull()
  })

  it('GET /transactions rows without book-time fiat carry approxAmount/approxCurrency in the preference', async () => {
    const account = await seedAccount(userId)
    const agentId = await seedAgent(userId, account.id)
    await seedX402Payment({
      userId,
      agentId,
      accountId: account.id,
      accountAddress: account.address,
      confirmedAt: new Date(tsInLocalDay(TZ, 0) * 1000).toISOString(),
      proofStatus: 'protocol_receipt_attached',
    })

    const res = await app.inject({
      method: 'GET',
      url: '/transactions',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { transactions: Array<Record<string, unknown>> }
    expect(body.transactions).toHaveLength(1)
    // No book-time fiat on this row → the serve-time pair, at the stubbed
    // 10.76 SEK/USDC. The user has no preference → the SEK default.
    expect(body.transactions[0].approxAmount).toBe('10.7600')
    expect(body.transactions[0].approxCurrency).toBe('SEK')
    expect(body.transactions[0].convertedAmount).toBeNull()
  })
})

describe('#3824 — the CSV export stays byte-identical (serve-time fields never reach it)', () => {
  const baseRow = {
    hash: `0x${'ab'.repeat(32)}`,
    type: 'erc20' as const,
    from: '0x' + 'c'.repeat(40),
    to: '0x' + 'ee'.repeat(20),
    value: '1000000',
    valueFormatted: '1.0',
    asset: 'USDC',
    decimals: 6,
    direction: 'out' as const,
    timestamp: 1_779_000_000,
    timestampSource: 'block' as const,
    blockNumber: 12_345,
    isError: false,
    chainId: 84532,
    accountId: 'acc-1',
    accountAddress: '0x' + 'c'.repeat(40),
    accountName: 'Activity account',
  }
  const lookups = { resolveName: () => null, reportingCurrency: 'SEK' as const }

  it('a row carrying the approx pair exports exactly like a row without it', () => {
    const withApprox = transactionsToCsv(
      [{ ...baseRow, approxAmount: '10.7600', approxCurrency: 'SEK' } as never],
      lookups,
    )
    const without = transactionsToCsv([baseRow as never], lookups)
    expect(withApprox).toBe(without)
  })
})
