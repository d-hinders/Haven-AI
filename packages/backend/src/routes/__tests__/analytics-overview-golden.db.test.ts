/**
 * The `/analytics/overview` golden — REAL Postgres, faked clock (#4332).
 *
 * The issue's "identical when unfiltered" criterion is checked against a
 * golden response captured on the BASE SHA before the change and committed
 * FIRST, so the test can fail: if the `agentId` slice or the naming module
 * shifts any unfiltered figure — totals, buckets, agents, budgets, refusal
 * counts, balance — this suite goes red. What changes BY DESIGN is stripped
 * before the comparison (see `stableGolden` below); everything else must be
 * bit-identical.
 *
 * Clock: `vi.useFakeTimers({ toFake: ['Date'] })` fakes ONLY `Date` — timers
 * stay real, so the pg pool's socket I/O is untouched. The route reads
 * `new Date()` per request, so the windows are the fixed instants below.
 *
 * `readRemainingBudget` is mocked (it is an RPC; there is no chain in the
 * harness) and `config.feeEnabled` is pinned false so the golden does not
 * depend on the operator's env. Everything else — every SQL statement the
 * route runs — is the real thing against a real planner.
 *
 * Agent UUIDs are generated per run, so every uuid the seeds minted is
 * aliased back to a stable name (`aliasSeededUuids`) before the comparison;
 * the wire shapes themselves are untouched.
 *
 * Re-capture (only when the golden legitimately moves):
 *   UPDATE_ANALYTICS_GOLDEN=1 npx vitest run src/routes/__tests__/analytics-overview-golden.db.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import analyticsOverviewRoutes from '../analytics-overview.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import { config } from '../../config.js'

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'analytics-overview-golden.json')

/** The clock every window is derived from: 2030-06-10T12:00:00Z. */
const FIXED_NOW = new Date('2030-06-10T12:00:00.000Z')
/** The requested window: [2030-05-11T12:00Z, 2030-06-10T12:00Z). */
const W_FROM = '2030-05-11T12:00:00.000Z'

vi.mock('../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/delegation-budget-reader.js')>()
  return {
    ...actual,
    readRemainingBudget: vi.fn(async () => ({ remainingAtomic: '700000', fromChain: true })),
  }
})

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>()
  return { config: { ...actual.config, feeEnabled: false } }
})

// ── Seed constants — stable aliases for the uuids the seeds mint. ───────────

const MERCHANT_X402 = `0x${'11'.repeat(20)}` // x402-host label; also HAS a contact (order proof)
const MERCHANT_RECEIPT = `0x${'22'.repeat(20)}` // receipt label (analytics-only step)
const MERCHANT_OWN = `0x${'33'.repeat(20)}` // the user's own account, on TWO chains
const MERCHANT_CONTACT = `0x${'44'.repeat(20)}` // contact label
const MERCHANT_UNKNOWN = `0x${'55'.repeat(20)}` // nothing resolves → unknown

let seq = 0
const ALIASES = new Map<string, string>()

function alias(id: string, name: string): string {
  ALIASES.set(id, name)
  return id
}

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`analytics-golden-${++seq}-${randomUUID()}@test.example`],
  )
  return alias(rows[0].id, `user-${seq}`)
}

async function seedAccount(
  userId: string,
  address: string,
  opts: { chainId?: number; name?: string; createdAt?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type, name, created_at)
     VALUES ($1, $2, $3, 'delegator_hybrid', $4, COALESCE($5::timestamptz, NOW())) RETURNING id`,
    [userId, address, opts.chainId ?? 84532, opts.name ?? 'Vault', opts.createdAt ?? null],
  )
  return rows[0].id
}

async function seedAgent(
  userId: string,
  accountId: string,
  opts: { name?: string; status?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, status, account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, opts.name ?? `agent-${++seq}`, opts.status ?? 'active', accountId],
  )
  return alias(rows[0].id, opts.name ?? `agent-${seq}`)
}

/** A confirmed (or statused) payment with the naming-relevant columns. */
async function seedPayment(input: {
  agentId: string
  userId: string
  toAddress: string
  merchantAddress?: string | null
  x402MerchantAddress?: string | null
  resourceUrl?: string | null
  status?: string
  usdValue?: string
  eurValue?: string
  sekValue?: string | null
  confirmedAt?: string
  createdAt?: string
}): Promise<string> {
  const {
    agentId,
    userId,
    toAddress,
    merchantAddress = null,
    x402MerchantAddress = null,
    resourceUrl = null,
    status = 'confirmed',
    usdValue = '10.00',
    eurValue = '9.00',
    sekValue = null,
    confirmedAt = '2030-06-02T10:00:00.000Z',
    createdAt = confirmedAt,
  } = input
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address, to_address,
       amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
       status, usd_value, eur_value, sek_value, confirmed_at, created_at, expires_at,
       chain_id, merchant_address, x402_merchant_address, payment_resource_url
     ) VALUES (
       $1, $2, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), $3,
       '10000000', '10.00', '0x' || repeat('c', 40), 1, $4,
       $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, NOW() + interval '10 minutes',
       84532, $11, $12, $13
     ) RETURNING id`,
    [
      agentId,
      userId,
      toAddress,
      `0x${String(seq).padStart(64, 'd')}`.slice(0, 66),
      status,
      status === 'confirmed' ? usdValue : null,
      status === 'confirmed' ? eurValue : null,
      status === 'confirmed' ? sekValue : null,
      status === 'confirmed' ? confirmedAt : null,
      createdAt,
      merchantAddress,
      x402MerchantAddress,
      resourceUrl,
    ],
  )
  return rows[0].id
}

async function seedRefusal(input: {
  userId: string
  agentId: string
  createdAt: string
  usdValue?: string
}): Promise<void> {
  await db.query(
    `INSERT INTO payment_refusals (user_id, agent_id, chain_id, token_symbol, amount_atomic,
       usd_value, eur_value, merchant_to, reason, source, created_at)
     VALUES ($1, $2, 84532, 'USDC', '1000000', $3, $4, '0x' || repeat('8', 40),
       'delegation_budget_exceeded', 'payment', $5::timestamptz)`,
    [input.userId, input.agentId, input.usdValue ?? '1.50', input.usdValue ?? '1.50', input.createdAt],
  )
}

async function seedDelegation(agentId: string): Promise<void> {
  await db.query(
    `INSERT INTO agent_delegations (
       agent_id, chain_id, token_address, recipient_address, delegation_hash,
       delegation_json, version, status, budget_atomic, period_seconds, start_date, expires_at
     ) VALUES ($1, 84532, '0x' || repeat('a', 40), NULL, $2, '{}', 1, 'active', '1000000', 86400,
               1900000000, 9999999999)`,
    [agentId, `0x${String(++seq).padStart(64, '2')}`.slice(0, 66)],
  )
}

/**
 * Everything the response sections read, seeded at FIXED instants inside the
 * window. Two agents with activity (a1, the revoked a3), one active agent
 * with none (a4), five merchants covering the label resolutions, a contact,
 * a receipt, the user's own account on TWO chains, a fee, a submitted
 * (unsettled) intent, and balance snapshots.
 */
async function seedFixture(): Promise<string> {
  const userId = await seedUser()

  const mainAccount = await seedAccount(userId, `0x${'aa'.repeat(20)}`, { name: 'Main' })
  // The SAME counterfactual address on two chains — the address-only
  // own-account rule must name it from the OLDEST account regardless of chain.
  await seedAccount(userId, MERCHANT_OWN, { chainId: 1, name: 'Old Vault', createdAt: '2030-01-01T00:00:00.000Z' })
  await seedAccount(userId, MERCHANT_OWN, { chainId: 84532, name: 'New Vault', createdAt: '2030-02-01T00:00:00.000Z' })

  const a1 = await seedAgent(userId, mainAccount, { name: 'Research' })
  const a2 = await seedAgent(userId, mainAccount, { name: 'Ops' })
  const a3 = await seedAgent(userId, mainAccount, { name: 'Revoked', status: 'revoked' })
  await seedAgent(userId, mainAccount, { name: 'Idle' })

  // a1 → MERCHANT_X402 twice; the MOST RECENT payment in the window carries
  // the resource URL. The address also has a contact — the x402 host wins.
  await seedPayment({ agentId: a1, userId, toAddress: MERCHANT_X402, merchantAddress: MERCHANT_X402, confirmedAt: '2030-06-01T10:00:00.000Z', usdValue: '5.00', eurValue: '4.50', sekValue: '47.50' })
  const p1 = await seedPayment({ agentId: a1, userId, toAddress: MERCHANT_X402, merchantAddress: MERCHANT_X402, resourceUrl: 'https://api.nordshield.example/v1', confirmedAt: '2030-06-02T10:00:00.000Z', usdValue: '10.00', eurValue: '9.00', sekValue: '95.00' })
  await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'NordShield GmbH', $2)`, [userId, MERCHANT_X402])

  // a2 → contact merchant, unknown merchant, own account.
  await seedPayment({ agentId: a2, userId, toAddress: MERCHANT_CONTACT, merchantAddress: MERCHANT_CONTACT, confirmedAt: '2030-06-03T10:00:00.000Z', usdValue: '3.00' })
  await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Acme AB', $2)`, [userId, MERCHANT_CONTACT])
  await seedPayment({ agentId: a2, userId, toAddress: MERCHANT_UNKNOWN, merchantAddress: MERCHANT_UNKNOWN, confirmedAt: '2030-06-04T10:00:00.000Z', usdValue: '2.00' })
  await seedPayment({ agentId: a2, userId, toAddress: MERCHANT_OWN, merchantAddress: MERCHANT_OWN, confirmedAt: '2030-06-05T10:00:00.000Z', usdValue: '7.00' })

  // a2 → one submitted (unsettled) intent: basis.unsettled_submitted = 1.
  await seedPayment({ agentId: a2, userId, toAddress: MERCHANT_UNKNOWN, status: 'submitted', createdAt: '2030-06-05T11:00:00.000Z' })

  // The revoked agent's history: a confirmed payment + a refusal.
  await seedPayment({ agentId: a3, userId, toAddress: MERCHANT_RECEIPT, merchantAddress: MERCHANT_RECEIPT, confirmedAt: '2030-06-06T10:00:00.000Z', usdValue: '4.00' })
  await seedRefusal({ userId, agentId: a3, createdAt: '2030-06-06T11:00:00.000Z' })
  await seedRefusal({ userId, agentId: a1, createdAt: '2030-06-07T11:00:00.000Z' })

  // A fee on p1: 1% of its booked $10.
  await db.query(`INSERT INTO payment_fees (payment_id, rail, fee_amount_atomic, fee_token) VALUES ($1, 'x402', '100000', 'USDC')`, [p1])

  // Receipt name for MERCHANT_RECEIPT (the analytics-only step).
  const evidence = await db.query<{ id: string }>(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url,
       merchant_address, payer_address, settlement_address, token_symbol, token_address, amount_raw, amount_human
     ) VALUES ($1, $2, $3, 'x402', $4, 84532, 'https://klara.example', $5,
               '0x' || repeat('e', 40), '0x' || repeat('f', 40), 'USDC', '0x' || repeat('b', 40), '1000', '0.001')
     RETURNING id`,
    [p1, a3, userId, `0x${String(++seq).padStart(64, '1')}`.slice(0, 66), MERCHANT_RECEIPT],
  )
  await db.query(`INSERT INTO merchant_receipts (evidence_id, inline_json) VALUES ($1, $2)`, [
    evidence.rows[0].id,
    JSON.stringify({ merchant_name: 'Klara Data AB' }),
  ])

  await seedDelegation(a1)

  for (const [day, usd, eur, sek] of [
    ['2030-05-11', '100.00', '90.00', '950.00'],
    ['2030-05-20', '110.00', '99.00', '1045.00'],
    ['2030-06-09', '120.00', '108.00', '1140.00'],
  ] as const) {
    await db.query(
      `INSERT INTO user_daily_portfolio_snapshots (user_id, snapshot_date, total_usd, total_eur, total_sek)
       VALUES ($1, $2::date, $3, $4, $5)`,
      [userId, day, usd, eur, sek],
    )
  }

  return userId
}

/**
 * Strips what #4332 changes BY DESIGN, aliases every seeded uuid to a stable
 * name, and returns the comparable object. Label/kind/filter_address on
 * merchant rows, `top_merchant.label`, and `balance_scope` are the wire
 * changes; every other figure must be identical to the base SHA's.
 */
function stableGolden(body: Record<string, unknown>): unknown {
  const clone = structuredClone(body) as {
    balance_scope?: unknown
    merchants: Array<Record<string, unknown>>
    agents: Array<{ id: string; top_merchant: { label?: unknown } | null }>
    by_day: Array<{ spent_by_agent: Record<string, string> }>
  }
  delete clone.balance_scope
  for (const m of clone.merchants ?? []) {
    delete m.label
    delete m.kind
    delete m.filter_address
  }
  for (const a of clone.agents ?? []) {
    if (a.top_merchant) delete a.top_merchant.label
  }
  return aliasSeededUuids(clone)
}

function aliasSeededUuids(value: unknown): unknown {
  if (typeof value === 'string') {
    for (const [uuid, name] of ALIASES) if (value === uuid) return name
    // spent_by_agent keys and agent_ids arrays carry bare uuids inside
    // objects/arrays — handled by the walks below; here only exact matches.
    return value
  }
  if (Array.isArray(value)) return value.map(aliasSeededUuids)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const aliasedKey = ALIASES.get(k) ?? k
      out[aliasedKey] = aliasSeededUuids(v)
    }
    return out
  }
  return value
}

void readRemainingBudget
void config

describeDb('GET /analytics/overview — the golden (real DB, faked clock, #4332)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW })
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(analyticsOverviewRoutes, { prefix: '/analytics' })
  })

  afterAll(async () => {
    vi.useRealTimers()
    await app?.close()
  })

  beforeEach(async () => {
    await resetDb()
    ALIASES.clear()
  })

  async function getOverview(
    userId: string,
    query = 'range=30d&currency=usd&tz=UTC',
  ): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'GET',
      url: `/analytics/overview?${query}`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'user@example.com' })}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('the unfiltered response is identical to the base-SHA golden (by-design fields stripped)', async () => {
    const userId = await seedFixture()
    const golden = stableGolden(await getOverview(userId))

    if (process.env.UPDATE_ANALYTICS_GOLDEN) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`)
      expect(existsSync(GOLDEN_PATH)).toBe(true)
      return
    }

    expect(existsSync(GOLDEN_PATH)).toBe(true)
    const committed = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
    expect(golden).toEqual(committed)
  })
})
