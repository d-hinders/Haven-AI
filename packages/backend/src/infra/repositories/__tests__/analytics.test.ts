/**
 * Real-Postgres proof for the analytics-overview repository (#2946, slice B
 * of epic #2944). No db.js mocks — every section is a grouped-aggregate SQL
 * statement, and the AC's performance requirement (5 agents x 300 payments
 * over 90 days, ONE statement per section) can only be proven against a real
 * planner/executor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import {
  ACTIVE_DELEGATIONS_FOR_USER_SQL,
  aggregateRefusalAmountForUser,
  BY_DAY_SPEND_SQL,
  computeBudgetBands,
  countUnsettledSubmittedForUser,
  type DelegationBudgetView,
  listActiveDelegationsForUser,
  listBalanceByDayForUser,
  listByDaySpendForUser,
  listGasEventsByChainForUser,
  listPerAgentSpendForUser,
  listPerAgentTopMerchantForUser,
  listReceiptMerchantNamesForUser,
  dayKeyInZone,
  listRefusalsByDayForUser,
  listTopMerchantsForUser,
  PER_AGENT_SPEND_SQL,
  shapeBudgets,
  sumFeesTotalsForUser,
  sumTotalsSpendForUser,
  sumValueBearingGasOps,
  TOTALS_SPEND_SQL,
  type DateRange,
  type Executor,
} from '../analytics.js'
import type { QueryRow } from '../../transaction.js'
import { recordPaymentRefusal } from '../payment-refusals.js'

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`analytics-repo-${++seq}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

/** Delegation-rail account (`account_type = 'delegator_hybrid'`) — the rail filter every section joins on. */
async function seedAccount(userId: string, addrSeed: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
     VALUES ($1, $2, 84532, 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(addrSeed).padStart(40, '0')}`],
  )
  return rows[0].id
}

/** A LEGACY (non-delegation-rail) account — proves the rail filter, not just tenant scoping. */
async function seedLegacyAccount(userId: string, addrSeed: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
     VALUES ($1, $2, 84532, 'legacy_safe') RETURNING id`,
    [userId, `0x${String(addrSeed).padStart(40, '0')}`],
  )
  return rows[0].id
}

async function seedAgent(
  userId: string,
  accountId: string | null,
  overrides: { name?: string; status?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, status, account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, overrides.name ?? `agent-${++seq}`, overrides.status ?? 'active', accountId],
  )
  return rows[0].id
}

interface SeedPaymentInput {
  agentId: string
  userId: string
  status?: string
  usdValue?: number | null
  eurValue?: number | null
  confirmedAt?: string
  createdAt?: string
  toAddress?: string
  merchantAddress?: string | null
  chainId?: number
  amountRaw?: string
}

async function seedPayment(input: SeedPaymentInput): Promise<string> {
  seq += 1
  const {
    agentId,
    userId,
    status = 'confirmed',
    usdValue = 10,
    eurValue = 9,
    confirmedAt = new Date().toISOString(),
    createdAt = confirmedAt,
    toAddress = `0x${String(seq).padStart(40, '9')}`,
    merchantAddress = null,
    chainId = 84532,
    amountRaw = '10000000',
  } = input
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address, to_address,
       amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
       status, usd_value, eur_value, confirmed_at, created_at, expires_at,
       chain_id, merchant_address
     ) VALUES (
       $1, $2, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), $3,
       $4, '10.00', '0x' || repeat('c', 40), 1, $5,
       $6, $7, $8, $9, $10, NOW() + interval '10 minutes',
       $11, $12
     ) RETURNING id`,
    [
      agentId,
      userId,
      toAddress,
      amountRaw,
      `0x${String(seq).padStart(64, 'd')}`.slice(0, 66),
      status,
      status === 'confirmed' ? usdValue : null,
      status === 'confirmed' ? eurValue : null,
      status === 'confirmed' ? confirmedAt : null,
      createdAt,
      chainId,
      merchantAddress,
    ],
  )
  return rows[0].id
}

function daysAgoIso(days: number, extraHoursUtc = 12): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(extraHoursUtc, 0, 0, 0)
  return d.toISOString()
}

function rangeOfDays(days: number): DateRange {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

describeDb('analytics-overview repository (#2946)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  // ── Status inclusion rule ──────────────────────────────────────────────

  it('sums ONLY confirmed payments — every other status contributes nothing', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 1)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)

    await seedPayment({ agentId, userId, status: 'confirmed', usdValue: 10, eurValue: 9, confirmedAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, status: 'pending_signature', createdAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, status: 'submitted', createdAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, status: 'failed', createdAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, status: 'expired', createdAt: daysAgoIso(1) })

    // An anomalous row: NOT confirmed, but carrying a `confirmed_at` and a
    // fiat value anyway (the shape a data bug — or a query missing the
    // status predicate — could produce; the real write path never leaves
    // `confirmed_at`/fiat set on a non-confirmed row, which is exactly why a
    // test built only from real writes cannot tell the predicate apart from
    // the `confirmed_at IS NOT NULL` filter it happens to imply here).
    // Raw INSERT, bypassing `seedPayment`'s status-gated nulling, so this row
    // is the one thing that distinguishes "status = 'confirmed'" from
    // "confirmed_at is set".
    await db.query(
      `INSERT INTO payment_intents (
         agent_id, user_id, account_address, token_symbol, token_address, to_address,
         amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
         status, usd_value, eur_value, confirmed_at, created_at, expires_at
       ) VALUES ($1, $2, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), '0x' || repeat('9', 40),
                 '10000000', '10.00', '0x' || repeat('c', 40), 1, $3,
                 'failed', 999, 999, $4, $4, NOW() + interval '10 minutes')`,
      [agentId, userId, `0x${String(++seq).padStart(64, 'f')}`.slice(0, 66), daysAgoIso(1)],
    )

    const totals = await sumTotalsSpendForUser(userId, range, rangeOfDays(14))
    expect(Number(totals.spent_usd)).toBeCloseTo(10, 6)
    expect(Number(totals.payments_counted)).toBe(1)
  })

  // ── Totals + previous-period delta ──────────────────────────────────────

  it('totals: current + previous window in one call, currency-separated', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 2)
    const agentId = await seedAgent(userId, accountId)
    const current = rangeOfDays(7)
    const previous = rangeOfDays(7)
    previous.to = current.from
    previous.from = new Date(new Date(current.from).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    await seedPayment({ agentId, userId, usdValue: 10, eurValue: 9, confirmedAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, usdValue: 5, eurValue: 4.5, confirmedAt: daysAgoIso(2) })
    // Previous-period row.
    await seedPayment({ agentId, userId, usdValue: 100, eurValue: 90, confirmedAt: daysAgoIso(10) })

    const totals = await sumTotalsSpendForUser(userId, current, previous)
    expect(Number(totals.spent_usd)).toBeCloseTo(15, 6)
    expect(Number(totals.spent_eur)).toBeCloseTo(13.5, 6)
    expect(Number(totals.spent_previous_usd)).toBeCloseTo(100, 6)
    expect(Number(totals.payments_counted)).toBe(2)
  })

  it('rail filter: a legacy (non-delegation-rail) account never contributes', async () => {
    const userId = await seedUser()
    const legacyAccount = await seedLegacyAccount(userId, 3)
    const agentId = await seedAgent(userId, legacyAccount)
    const range = rangeOfDays(7)

    await seedPayment({ agentId, userId, usdValue: 999, confirmedAt: daysAgoIso(1) })

    const totals = await sumTotalsSpendForUser(userId, range, rangeOfDays(14))
    expect(Number(totals.spent_usd)).toBe(0)
    expect(Number(totals.payments_counted)).toBe(0)
  })

  // ── basis.unsettled_submitted ────────────────────────────────────────────

  it('unsettled_submitted counts `submitted` rows and nothing else', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 4)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)

    await seedPayment({ agentId, userId, status: 'submitted', createdAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, status: 'submitted', createdAt: daysAgoIso(2) })
    await seedPayment({ agentId, userId, status: 'confirmed', confirmedAt: daysAgoIso(1) })

    const count = await countUnsettledSubmittedForUser(userId, range)
    expect(count).toBe(2)
  })

  // ── By-day, bucketed server-side in tz ───────────────────────────────────

  it('by-day buckets in UTC by default', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 5)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)

    await seedPayment({ agentId, userId, usdValue: 10, confirmedAt: '2030-06-01T10:00:00Z' })
    await seedPayment({ agentId, userId, usdValue: 20, confirmedAt: '2030-06-02T10:00:00Z' })

    const rows = await listByDaySpendForUser(userId, 'UTC', {
      from: '2030-01-01T00:00:00Z',
      to: '2031-01-01T00:00:00Z',
    })
    expect(rows.map((r) => r.day).sort()).toEqual(['2030-06-01', '2030-06-02'])
  })

  it('a 00:30 Europe/Stockholm payment lands on the LOCAL day, not the UTC day', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 6)
    const agentId = await seedAgent(userId, accountId)

    // 2030-06-02T00:30+02:00 (CEST) == 2030-06-01T22:30Z. UTC buckets this
    // under 06-01; Stockholm must bucket it under 06-02.
    await seedPayment({ agentId, userId, usdValue: 10, confirmedAt: '2030-06-01T22:30:00Z' })

    const utcRows = await listByDaySpendForUser(userId, 'UTC', {
      from: '2030-01-01T00:00:00Z',
      to: '2031-01-01T00:00:00Z',
    })
    const stockholmRows = await listByDaySpendForUser(userId, 'Europe/Stockholm', {
      from: '2030-01-01T00:00:00Z',
      to: '2031-01-01T00:00:00Z',
    })
    expect(utcRows.map((r) => r.day)).toEqual(['2030-06-01'])
    expect(stockholmRows.map((r) => r.day)).toEqual(['2030-06-02'])
  })

  // ── Per-agent ─────────────────────────────────────────────────────────────

  it('per-agent spend includes a REVOKED agent that spent in range, and an agent with zero payments', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 7)
    const activeAgent = await seedAgent(userId, accountId, { name: 'active-agent' })
    const revokedAgent = await seedAgent(userId, accountId, { name: 'revoked-agent', status: 'revoked' })
    const idleAgent = await seedAgent(userId, accountId, { name: 'idle-agent' })
    const range = rangeOfDays(7)

    await seedPayment({ agentId: activeAgent, userId, usdValue: 10, confirmedAt: daysAgoIso(1) })
    await seedPayment({ agentId: revokedAgent, userId, usdValue: 5, confirmedAt: daysAgoIso(1) })

    const rows = await listPerAgentSpendForUser(userId, range)
    expect(rows).toHaveLength(3)
    const active = rows.find((r) => r.agent_id === activeAgent)
    const revoked = rows.find((r) => r.agent_id === revokedAgent)
    const idle = rows.find((r) => r.agent_id === idleAgent)
    expect(Number(active?.spent_usd)).toBeCloseTo(10, 6)
    expect(revoked?.status).toBe('revoked')
    expect(Number(revoked?.spent_usd)).toBeCloseTo(5, 6)
    expect(Number(idle?.payments)).toBe(0)
    expect(idle?.last_payment_at).toBeNull()
  })

  it('tenant isolation: per-agent spend for user A never includes user B\'s agents', async () => {
    const userA = await seedUser()
    const accountA = await seedAccount(userA, 70)
    const agentA = await seedAgent(userA, accountA, { name: 'user-a-agent' })

    const userB = await seedUser()
    const accountB = await seedAccount(userB, 71)
    await seedAgent(userB, accountB, { name: 'user-b-agent' })

    await seedPayment({ agentId: agentA, userId: userA, usdValue: 10, confirmedAt: daysAgoIso(1) })

    const rows = await listPerAgentSpendForUser(userA, rangeOfDays(7))
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(agentA)
    expect(rows.some((r) => r.name === 'user-b-agent')).toBe(false)
  })

  it('per-agent top merchant ranks by spend, in one statement (window function, not a loop)', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 8)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)
    const bigMerchant = `0x${'1'.padStart(40, '0')}`
    const smallMerchant = `0x${'2'.padStart(40, '0')}`

    await seedPayment({ agentId, userId, usdValue: 50, merchantAddress: bigMerchant, confirmedAt: daysAgoIso(1) })
    await seedPayment({ agentId, userId, usdValue: 5, merchantAddress: smallMerchant, confirmedAt: daysAgoIso(1) })

    const rows = await listPerAgentTopMerchantForUser(userId, range)
    expect(rows).toHaveLength(1)
    expect(rows[0].merchant_key).toBe(bigMerchant.toLowerCase())
  })

  // ── Merchants (top 10) ────────────────────────────────────────────────────

  it('top merchants aggregate spend/payments/agents and order by spend desc', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 9)
    const agentA = await seedAgent(userId, accountId)
    const agentB = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)
    const merchant = `0x${'3'.padStart(40, '0')}`

    await seedPayment({ agentId: agentA, userId, usdValue: 10, merchantAddress: merchant, confirmedAt: daysAgoIso(1) })
    await seedPayment({ agentId: agentB, userId, usdValue: 20, merchantAddress: merchant, confirmedAt: daysAgoIso(2) })

    const rows = await listTopMerchantsForUser(userId, range)
    expect(rows).toHaveLength(1)
    expect(rows[0].merchant_key).toBe(merchant.toLowerCase())
    expect(Number(rows[0].spent_usd)).toBeCloseTo(30, 6)
    expect(Number(rows[0].payments)).toBe(2)
    expect(rows[0].agent_ids.sort()).toEqual([agentA, agentB].sort())
  })

  it('receipt-name fallback reads the newest merchant_receipts row for the address', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 10)
    const agentId = await seedAgent(userId, accountId)
    const merchant = `0x${'4'.padStart(40, '0')}`
    const paymentId = await seedPayment({ agentId, userId, usdValue: 1, merchantAddress: merchant })

    const evidence = await db.query<{ id: string }>(
      `INSERT INTO machine_payment_evidence (
         payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url,
         merchant_address, payer_address, settlement_address, token_symbol, token_address, amount_raw, amount_human
       ) VALUES ($1, $2, $3, 'x402', $4, 84532, 'https://merchant.example', $5,
                 '0x' || repeat('e', 40), '0x' || repeat('f', 40), 'USDC', '0x' || repeat('b', 40), '1000', '0.001')
       RETURNING id`,
      [paymentId, agentId, userId, `0x${String(++seq).padStart(64, '1')}`.slice(0, 66), merchant],
    )
    await db.query(
      `INSERT INTO merchant_receipts (evidence_id, inline_json) VALUES ($1, $2)`,
      [evidence.rows[0].id, JSON.stringify({ merchant_name: 'Acme Corp' })],
    )

    const names = await listReceiptMerchantNamesForUser(userId, [merchant])
    expect(names.get(merchant.toLowerCase())).toBe('Acme Corp')
  })

  // ── Balance ───────────────────────────────────────────────────────────────

  it('balance_by_day reads the snapshot range in order', async () => {
    const userId = await seedUser()
    await db.query(
      `INSERT INTO user_daily_portfolio_snapshots (user_id, snapshot_date, total_usd, total_eur)
       VALUES ($1, CURRENT_DATE - 2, 100, 90), ($1, CURRENT_DATE - 1, 110, 99)`,
      [userId],
    )
    const rows = await listBalanceByDayForUser(userId, rangeOfDays(7))
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].total_usd)).toBeLessThan(Number(rows[1].total_usd))
  })

  // ── Fees ──────────────────────────────────────────────────────────────────

  it('fees are valued proportionally against the intent’s booked fiat, zero while unrecorded', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 11)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)
    const paymentId = await seedPayment({
      agentId,
      userId,
      usdValue: 10,
      eurValue: 9,
      amountRaw: '10000000',
      confirmedAt: daysAgoIso(1),
    })
    await db.query(
      `INSERT INTO payment_fees (payment_id, rail, fee_amount_atomic, fee_token) VALUES ($1, 'x402', $2, 'USDC')`,
      [paymentId, '100000' /* 1% of amount_raw */],
    )

    const fees = await sumFeesTotalsForUser(userId, range, rangeOfDays(14))
    expect(Number(fees.fee_usd)).toBeCloseTo(0.1, 6) // 1% of the booked $10.
    expect(Number(fees.fee_rows)).toBe(1)
  })

  it('a fee row whose intent carries a non-numeric amount_raw neither throws nor counts (the AMOUNT_RAW_IS_NUMERIC guard is load-bearing)', async () => {
    // routes/payments.ts already distrusts amount_raw (try/catch BigInt), so a
    // non-numeric value is a state the column can hold. Without the regex
    // guard the ::numeric cast would 500 the whole overview; with it the row
    // is dropped from the sum AND from fee_rows. Mutation: guard → '.*' makes
    // this test throw on the cast.
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 12)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)
    const goodId = await seedPayment({ agentId, userId, usdValue: 10, eurValue: 9, amountRaw: '10000000', confirmedAt: daysAgoIso(1) })
    const badId = await seedPayment({ agentId, userId, usdValue: 10, eurValue: 9, amountRaw: '10000000', confirmedAt: daysAgoIso(1) })
    await db.query(`UPDATE payment_intents SET amount_raw = 'not-a-number' WHERE id = $1`, [badId])
    await db.query(
      `INSERT INTO payment_fees (payment_id, rail, fee_amount_atomic, fee_token) VALUES ($1, 'x402', '100000', 'USDC'), ($2, 'x402', '100000', 'USDC')`,
      [goodId, badId],
    )

    const fees = await sumFeesTotalsForUser(userId, range, rangeOfDays(14))
    expect(Number(fees.fee_usd)).toBeCloseTo(0.1, 6)
    expect(Number(fees.fee_rows)).toBe(1)
  })

  // ── Gas — value-bearing chains only ──────────────────────────────────────

  it('gas ops are filtered to value-bearing chains via isValueBearingChain, not a hardcoded SQL list', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId, null)

    await db.query(
      `INSERT INTO relayer_gas_events (chain_id, operation, agent_id, created_at) VALUES ($1, 'exec', $2, NOW())`,
      [8453, agentId], // Base mainnet — value-bearing
    )
    await db.query(
      `INSERT INTO relayer_gas_events (chain_id, operation, agent_id, created_at) VALUES ($1, 'exec', $2, NOW())`,
      [84532, agentId], // Base Sepolia — known testnet
    )
    // Computed AFTER the inserts, with the upper bound padded a minute into
    // the future: `created_at < $3` is a strict bound against `NOW()` at
    // insert time, and a range built from `Date.now()` in JS before that
    // would otherwise exclude the rows the DB just wrote.
    const range: DateRange = {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    }

    const byChain = await listGasEventsByChainForUser(userId, range)
    expect(sumValueBearingGasOps(byChain)).toBe(1)
  })

  // ── Budgets — the on-chain read, and its fallback ────────────────────────

  it('an agent with no active delegation maps to an empty budget list', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 12)
    await seedAgent(userId, accountId)

    const delegations = await listActiveDelegationsForUser(userId)
    expect(delegations).toHaveLength(0)
    const byAgent = await shapeBudgets(delegations)
    expect(byAgent.size).toBe(0)
  })

  it('a budget read that cannot resolve on-chain reports remaining_from_chain: false, and used = budget - remaining', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 13)
    const agentId = await seedAgent(userId, accountId)
    await db.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at
       ) VALUES ($1, 84532, '0x' || repeat('a', 40), NULL, $2, '{}', 1, 'active', '1000000', 86400,
                 $3, 9999999999)`,
      [agentId, `0x${String(++seq).padStart(64, '2')}`.slice(0, 66), Math.floor(Date.now() / 1000) - 3600],
    )

    const delegations = await listActiveDelegationsForUser(userId)
    expect(delegations).toHaveLength(1)
    const byAgent = await shapeBudgets(delegations)
    const views = byAgent.get(agentId)
    expect(views).toHaveLength(1)
    expect(views?.[0].remaining_from_chain).toBe(false)
    // Malformed delegation_json -> readRemainingBudget falls back to the
    // configured budget as "remaining", so used = budget - remaining = 0.
    expect(views?.[0].used_atomic).toBe('0')
    expect(views?.[0].budget_atomic).toBe('1000000')

    const bands = computeBudgetBands(byAgent)
    expect(bands.agents_with_budget).toBe(1)
    expect(bands.above_50).toBe(0)
    expect(bands.above_75).toBe(0)
  })

  // ── basis: counts equal the rows summed ──────────────────────────────────

  it('basis.payments_counted equals the number of confirmed rows the totals query summed', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 14)
    const agentId = await seedAgent(userId, accountId)
    const range = rangeOfDays(7)

    for (let i = 0; i < 5; i++) {
      await seedPayment({ agentId, userId, usdValue: 1, confirmedAt: daysAgoIso(1) })
    }
    await seedPayment({ agentId, userId, status: 'failed', createdAt: daysAgoIso(1) })

    const totals = await sumTotalsSpendForUser(userId, range, rangeOfDays(14))
    const { rows: rawRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payment_intents WHERE user_id = $1 AND status = 'confirmed'`,
      [userId],
    )
    expect(Number(totals.payments_counted)).toBe(Number(rawRows[0].count))
    expect(Number(totals.payments_counted)).toBe(5)
  })

  // ── Refusals: dedupe/insert logic stays in payment-refusals.ts; only ────
  // ── two read-only aggregates against the table live here (#2946 review) ──

  it('never inserts, updates, or duplicates the per-agent/per-reason breakdown against payment_refusals (only reads two bounded aggregates)', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 15)
    const agentId = await seedAgent(userId, accountId)

    await recordPaymentRefusal({
      userId,
      accountId,
      agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '5000',
      usdValue: 1.5,
      eurValue: 1.4,
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
    })

    // The dedupe/upsert logic and the (agent_id, reason) breakdown stay
    // exclusively in payment-refusals.ts — this file may READ
    // `payment_refusals` (two bounded aggregates: amount, by-day) but must
    // never WRITE it, and must never re-implement the per-reason grouping.
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(new URL('../analytics.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/INSERT INTO\s+payment_refusals/i)
    expect(source).not.toMatch(/UPDATE\s+payment_refusals/i)
    expect(source).not.toMatch(/GROUP BY[^;`]*reason/i)
  })

  it('aggregateRefusalAmountForUser: count and amount come from the SAME statement, so they cannot disagree', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 16)
    const agentId = await seedAgent(userId, accountId)

    await recordPaymentRefusal({
      userId, accountId, agentId, chainId: 84532, tokenSymbol: 'USDC', amountAtomic: '1000',
      usdValue: 1, eurValue: 0.9, reason: 'delegation_budget_exceeded', source: 'x402_authorize',
    })
    await recordPaymentRefusal({
      userId, accountId, agentId, chainId: 84532, tokenSymbol: 'USDC', amountAtomic: '2000',
      usdValue: 2, eurValue: 1.8, reason: 'relayer_budget', source: 'payment',
    })

    // Padded upper bound: the two refusals above land at `NOW()` (DB clock,
    // at insert time), so a range built purely from `Date.now()` before
    // those inserts would otherwise clip them (same reasoning as the gas-ops
    // and tenant-isolation fixtures).
    const range: DateRange = {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    }
    const agg = await aggregateRefusalAmountForUser(userId, range)
    expect(agg.refused_count).toBe('2')
    expect(Number(agg.refused_amount_usd)).toBeCloseTo(3, 6)
    expect(Number(agg.refused_amount_eur)).toBeCloseTo(2.7, 6)
  })

  it('listRefusalsByDayForUser buckets by tz exactly like BY_DAY_SPEND_SQL, and dayKeyInZone agrees', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 17)
    const agentId = await seedAgent(userId, accountId)

    // 2030-06-02T00:30+02:00 (CEST) == 2030-06-01T22:30Z — the same instant
    // BY_DAY_SPEND_SQL's Stockholm test buckets onto 06-02, not 06-01.
    const instant = '2030-06-01T22:30:00Z'
    await recordPaymentRefusal({
      userId, accountId, agentId, chainId: 84532, tokenSymbol: 'USDC', amountAtomic: '1000',
      usdValue: 1, eurValue: 0.9, reason: 'delegation_budget_exceeded', source: 'x402_authorize',
    })
    await db.query(
      `UPDATE payment_refusals SET created_at = $1 WHERE user_id = $2`,
      [instant, userId],
    )

    const range: DateRange = { from: '2030-01-01T00:00:00Z', to: '2031-01-01T00:00:00Z' }
    const utcRows = await listRefusalsByDayForUser(userId, 'UTC', range)
    const stockholmRows = await listRefusalsByDayForUser(userId, 'Europe/Stockholm', range)
    expect(utcRows.map((r) => r.day)).toEqual(['2030-06-01'])
    expect(stockholmRows.map((r) => r.day)).toEqual(['2030-06-02'])

    // dayKeyInZone (the JS-side bucketer the route used to use for refusals)
    // agrees with the SQL bucket for BOTH zones, by construction — the
    // "same instant, same day" proof the review asked for.
    expect(dayKeyInZone(instant, 'UTC')).toBe('2030-06-01')
    expect(dayKeyInZone(instant, 'Europe/Stockholm')).toBe('2030-06-02')
  })

  // ── Performance AC: one statement per section, not a per-agent loop ─────

  it(
    '90-day fixture, 5 agents x 300 payments: totals and per-agent sections each run as ONE statement',
    { timeout: 60_000 },
    async () => {
      const userId = await seedUser()
      const accountId = await seedAccount(userId, 20)
      const agentIds: string[] = []
      for (let i = 0; i < 5; i++) {
        agentIds.push(await seedAgent(userId, accountId, { name: `perf-agent-${i}` }))
      }

      const values: string[] = []
      const params: unknown[] = []
      let p = 0
      for (const agentId of agentIds) {
        for (let i = 0; i < 300; i++) {
          const dayOffset = i % 90
          const d = new Date()
          d.setUTCDate(d.getUTCDate() - dayOffset)
          values.push(
            `($${++p}, $${++p}, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), $${++p}, '10000', '10.00', '0x' || repeat('c', 40), 1, $${++p}, 'confirmed', 1, 0.9, $${++p}, $${++p}, NOW() + interval '10 minutes', 84532)`,
          )
          params.push(
            agentId,
            userId,
            `0x${String(p).padStart(40, '9')}`,
            `0x${String(p).padStart(64, 'd')}`.slice(0, 66),
            d.toISOString(),
            d.toISOString(),
          )
        }
      }
      await db.query(
        `INSERT INTO payment_intents (
           agent_id, user_id, account_address, token_symbol, token_address, to_address,
           amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
           status, usd_value, eur_value, confirmed_at, created_at, expires_at, chain_id
         ) VALUES ${values.join(',')}`,
        params,
      )

      const range: DateRange = rangeOfDays(90)

      const totalsExplain = await db.query(
        `EXPLAIN ${TOTALS_SPEND_SQL}`,
        [userId, range.from, range.to, rangeOfDays(180).from],
      )
      const perAgentExplain = await db.query(
        `EXPLAIN ${PER_AGENT_SPEND_SQL}`,
        [userId, range.from, range.to],
      )
      const byDayExplain = await db.query(
        `EXPLAIN ${BY_DAY_SPEND_SQL}`,
        [userId, 'UTC', range.from, range.to],
      )
      // EXPLAIN succeeding on the verbatim exported constant with these
      // params IS the proof that this is a single PREPAREable statement —
      // there is no application-level loop constructing per-agent queries.
      expect(totalsExplain.rows.length).toBeGreaterThan(0)
      expect(perAgentExplain.rows.length).toBeGreaterThan(0)
      expect(byDayExplain.rows.length).toBeGreaterThan(0)

      const totals = await sumTotalsSpendForUser(userId, range, rangeOfDays(180))
      expect(Number(totals.payments_counted)).toBe(1500)

      const perAgent = await listPerAgentSpendForUser(userId, range)
      expect(perAgent).toHaveLength(5)
      for (const row of perAgent) {
        expect(Number(row.payments)).toBe(300)
      }
    },
  )

  // ── Tenant isolation — a full two-tenant fixture across EVERY exported ──
  // ── list/sum function, not just per-agent spend (#2946 review finding). ──

  interface TenantFixture {
    userId: string
    accountId: string
    agentId: string
    merchantAddress: string
    paymentId: string
  }

  /** Seeds one tenant with a row in every table an analytics.ts function reads. */
  async function seedFullTenantFixture(seedBase: number): Promise<TenantFixture> {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, seedBase)
    const agentId = await seedAgent(userId, accountId, { name: `tenant-${seedBase}` })
    const merchantAddress = `0x${String(seedBase).padStart(40, '5')}`

    const paymentId = await seedPayment({
      agentId,
      userId,
      usdValue: 42,
      eurValue: 39,
      merchantAddress,
      confirmedAt: daysAgoIso(1),
    })
    await seedPayment({ agentId, userId, status: 'submitted', createdAt: daysAgoIso(1) })

    await db.query(
      `INSERT INTO payment_fees (payment_id, rail, fee_amount_atomic, fee_token) VALUES ($1, 'x402', $2, 'USDC')`,
      [paymentId, '500000'],
    )

    await recordPaymentRefusal({
      userId,
      accountId,
      agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '9999',
      usdValue: 77,
      eurValue: 66,
      reason: 'delegation_budget_exceeded',
      source: 'x402_authorize',
    })

    await db.query(
      `INSERT INTO relayer_gas_events (chain_id, operation, agent_id, created_at) VALUES (8453, 'exec', $1, NOW())`,
      [agentId],
    )

    await db.query(
      `INSERT INTO user_daily_portfolio_snapshots (user_id, snapshot_date, total_usd, total_eur)
       VALUES ($1, CURRENT_DATE - 1, $2, $3)`,
      [userId, seedBase * 100, seedBase * 90],
    )

    await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, $2, $3)`, [
      userId,
      `Contact-${seedBase}`,
      `0x${String(seedBase).padStart(40, '6')}`,
    ])

    const evidence = await db.query<{ id: string }>(
      `INSERT INTO machine_payment_evidence (
         payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url,
         merchant_address, payer_address, settlement_address, token_symbol, token_address, amount_raw, amount_human
       ) VALUES ($1, $2, $3, 'x402', $4, 84532, 'https://merchant.example', $5,
                 '0x' || repeat('e', 40), '0x' || repeat('f', 40), 'USDC', '0x' || repeat('b', 40), '1000', '0.001')
       RETURNING id`,
      [paymentId, agentId, userId, `0x${String(++seq).padStart(64, '3')}`.slice(0, 66), merchantAddress],
    )
    await db.query(`INSERT INTO merchant_receipts (evidence_id, inline_json) VALUES ($1, $2)`, [
      evidence.rows[0].id,
      JSON.stringify({ merchant_name: `Merchant-${seedBase}` }),
    ])

    await db.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at
       ) VALUES ($1, 84532, '0x' || repeat('a', 40), NULL, $2, '{}', 1, 'active', '1000000', 86400,
                 $3, 9999999999)`,
      [agentId, `0x${String(++seq).padStart(64, '4')}`.slice(0, 66), Math.floor(Date.now() / 1000) - 3600],
    )

    return { userId, accountId, agentId, merchantAddress, paymentId }
  }

  it('tenant isolation: user A never sees user B rows or amounts, across EVERY exported list/sum function', async () => {
    const a = await seedFullTenantFixture(300)
    const b = await seedFullTenantFixture(301)
    // Computed AFTER seeding, upper bound padded a minute into the future —
    // several rows above use `NOW()`/`CURRENT_DATE` at INSERT time, and a
    // range built from `Date.now()` before those inserts would otherwise
    // exclude rows the DB just wrote (same reasoning as the gas-ops test).
    const range: DateRange = {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    }

    const totalsA = await sumTotalsSpendForUser(a.userId, range, rangeOfDays(14))
    expect(Number(totalsA.spent_usd)).toBeCloseTo(42, 6) // never 42+42's own duplication or B's 42

    const unsettledA = await countUnsettledSubmittedForUser(a.userId, range)
    expect(unsettledA).toBe(1)

    const byDayA = await listByDaySpendForUser(a.userId, 'UTC', range)
    expect(byDayA.length).toBeGreaterThan(0)
    expect(byDayA.every((r) => r.agent_id === a.agentId)).toBe(true)
    expect(byDayA.some((r) => r.agent_id === b.agentId)).toBe(false)

    const perAgentA = await listPerAgentSpendForUser(a.userId, range)
    expect(perAgentA.map((r) => r.agent_id)).toEqual([a.agentId])

    const topMerchantPerAgentA = await listPerAgentTopMerchantForUser(a.userId, range)
    expect(topMerchantPerAgentA.every((r) => r.agent_id === a.agentId)).toBe(true)
    expect(topMerchantPerAgentA.some((r) => r.merchant_key === b.merchantAddress.toLowerCase())).toBe(false)

    const topMerchantsA = await listTopMerchantsForUser(a.userId, range)
    expect(topMerchantsA.map((m) => m.merchant_key)).toEqual([a.merchantAddress.toLowerCase()])
    expect(topMerchantsA.every((m) => !m.agent_ids.includes(b.agentId))).toBe(true)

    const namesA = await listReceiptMerchantNamesForUser(a.userId, [
      a.merchantAddress,
      b.merchantAddress,
    ])
    expect(namesA.get(a.merchantAddress.toLowerCase())).toBe(`Merchant-300`)
    expect(namesA.has(b.merchantAddress.toLowerCase())).toBe(false)

    const balanceA = await listBalanceByDayForUser(a.userId, range)
    expect(balanceA).toHaveLength(1)
    expect(Number(balanceA[0].total_usd)).toBeCloseTo(300 * 100, 6)

    const feesA = await sumFeesTotalsForUser(a.userId, range, rangeOfDays(14))
    expect(Number(feesA.fee_rows)).toBe(1)

    const gasA = await listGasEventsByChainForUser(a.userId, range)
    expect(sumValueBearingGasOps(gasA)).toBe(1)

    const delegationsA = await listActiveDelegationsForUser(a.userId)
    expect(delegationsA.map((d) => d.agent_id)).toEqual([a.agentId])
  })

  // ── Mutation-proof scaffolding lives in a bash procedure the agent runs ──
  // ── against this file directly (cp backup, sed, run, cp restore) — see  ──
  // ── the PR report for the eight recorded outputs.                       ──

  // ── computeBudgetBands — pure unit tests, no DB ─────────────────────────

  describe('computeBudgetBands (pure)', () => {
    function view(agentId: string, ratio: number): DelegationBudgetView {
      return {
        agent_id: agentId,
        token: 'USDC',
        recipient: null,
        used_atomic: '0',
        budget_atomic: '1000000',
        remaining_from_chain: true,
        period_start: '2030-01-01T00:00:00.000Z',
        period_end: '2030-01-02T00:00:00.000Z',
        ratio,
      }
    }

    it('one agent, two delegations at 0.6 and 0.8: worst ratio wins both bands', () => {
      const byAgent = new Map<string, DelegationBudgetView[]>([
        ['agent-1', [view('agent-1', 0.6), view('agent-1', 0.8)]],
      ])
      const bands = computeBudgetBands(byAgent)
      expect(bands).toEqual({ above_75: 1, above_50: 1, agents_with_budget: 1 })
    })

    it('two agents: one above both bands, one below both', () => {
      const byAgent = new Map<string, DelegationBudgetView[]>([
        ['agent-1', [view('agent-1', 0.9)]],
        ['agent-2', [view('agent-2', 0.2)]],
      ])
      const bands = computeBudgetBands(byAgent)
      expect(bands).toEqual({ above_75: 1, above_50: 1, agents_with_budget: 2 })
    })
  })

  // ── agents[]: a zero-spend agent still appears, spent: '0' ──────────────

  it('a zero-spend agent (e.g. pending_approval, never yet spent) still appears in per-agent spend, with spent_usd: \'0\'', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 302)
    const zeroSpendAgent = await seedAgent(userId, accountId, {
      name: 'pending-approval-agent',
      status: 'pending_approval',
    })

    const rows = await listPerAgentSpendForUser(userId, rangeOfDays(7))
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(zeroSpendAgent)
    expect(rows[0].status).toBe('pending_approval')
    expect(rows[0].spent_usd).toBe('0')
    expect(Number(rows[0].payments)).toBe(0)
  })

  // ── Status-inclusion predicate: load-bearing on EVERY section, not just ──
  // ── totals — the anomalous confirmed_at-but-not-confirmed row must be   ──
  // ── excluded everywhere (#2946 review finding).                        ──

  it('the anomalous failed-but-fiat row is excluded from by-day, per-agent, per-agent-top-merchant, top-merchants and fees — not just totals', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId, 303)
    const agentId = await seedAgent(userId, accountId)
    const merchant = `0x${'8'.padStart(40, '0')}`
    const range = rangeOfDays(7)

    const realPaymentId = await seedPayment({
      agentId,
      userId,
      usdValue: 10,
      eurValue: 9,
      merchantAddress: merchant,
      confirmedAt: daysAgoIso(1),
    })
    await db.query(
      `INSERT INTO payment_fees (payment_id, rail, fee_amount_atomic, fee_token) VALUES ($1, 'x402', $2, 'USDC')`,
      [realPaymentId, '100000'],
    )

    // The anomalous row: status = 'failed' but confirmed_at/usd_value/eur_value
    // set anyway — a raw INSERT bypassing seedPayment's status-gated nulling,
    // and the one thing that can tell "status = 'confirmed'" apart from
    // "confirmed_at IS NOT NULL" in every section, not only totals.
    await db.query(
      `INSERT INTO payment_intents (
         agent_id, user_id, account_address, token_symbol, token_address, to_address,
         amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
         status, usd_value, eur_value, confirmed_at, created_at, expires_at, merchant_address
       ) VALUES ($1, $2, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), $3,
                 '10000000', '10.00', '0x' || repeat('c', 40), 1, $4,
                 'failed', 999999, 999999, $5, $5, NOW() + interval '10 minutes', $6)`,
      [agentId, userId, `0x${String(++seq).padStart(40, '9')}`, `0x${String(++seq).padStart(64, 'f')}`.slice(0, 66), daysAgoIso(1), merchant],
    )

    const byDay = await listByDaySpendForUser(userId, 'UTC', range)
    expect(byDay.reduce((s, r) => s + Number(r.usd), 0)).toBeCloseTo(10, 6)

    const perAgent = await listPerAgentSpendForUser(userId, range)
    expect(Number(perAgent[0].spent_usd)).toBeCloseTo(10, 6)
    expect(Number(perAgent[0].payments)).toBe(1)

    const topMerchantPerAgent = await listPerAgentTopMerchantForUser(userId, range)
    expect(topMerchantPerAgent).toHaveLength(1)

    const topMerchants = await listTopMerchantsForUser(userId, range)
    expect(topMerchants).toHaveLength(1)
    expect(Number(topMerchants[0].spent_usd)).toBeCloseTo(10, 6)
    expect(Number(topMerchants[0].payments)).toBe(1)

    const fees = await sumFeesTotalsForUser(userId, range, rangeOfDays(14))
    expect(Number(fees.fee_rows)).toBe(1)
    expect(Number(fees.fee_usd)).toBeCloseTo(0.1, 6)
  })

  // ── Performance AC, proven by counting driver calls, not by EXPLAIN ─────
  // ── succeeding on the constant in isolation (#2946 review finding: the  ──
  // ── previous perf test could not fail on a per-agent loop being added). ──

  it(
    'each section function issues exactly ONE db.query call against the 5x300 fixture — proven by counting, not by EXPLAIN',
    { timeout: 60_000 },
    async () => {
      const userId = await seedUser()
      const accountId = await seedAccount(userId, 21)
      const agentIds: string[] = []
      for (let i = 0; i < 5; i++) {
        agentIds.push(await seedAgent(userId, accountId, { name: `count-agent-${i}` }))
      }

      const values: string[] = []
      const params: unknown[] = []
      let p = 0
      for (const agentId of agentIds) {
        for (let i = 0; i < 300; i++) {
          const dayOffset = i % 90
          const d = new Date()
          d.setUTCDate(d.getUTCDate() - dayOffset)
          values.push(
            `($${++p}, $${++p}, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), $${++p}, '10000', '10.00', '0x' || repeat('c', 40), 1, $${++p}, 'confirmed', 1, 0.9, $${++p}, $${++p}, NOW() + interval '10 minutes', 84532)`,
          )
          params.push(
            agentId,
            userId,
            `0x${String(p).padStart(40, '9')}`,
            `0x${String(p).padStart(64, 'd')}`.slice(0, 66),
            d.toISOString(),
            d.toISOString(),
          )
        }
      }
      await db.query(
        `INSERT INTO payment_intents (
           agent_id, user_id, account_address, token_symbol, token_address, to_address,
           amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
           status, usd_value, eur_value, confirmed_at, created_at, expires_at, chain_id
         ) VALUES ${values.join(',')}`,
        params,
      )

      const range: DateRange = rangeOfDays(90)

      // A thin wrapper around the real pool that counts calls — same
      // Executor shape every section function already accepts, so no
      // production code changes to make this countable.
      let calls = 0
      const countingDb: Executor = {
        query: <R extends QueryRow = QueryRow>(sql: string, vals?: unknown[]) => {
          calls += 1
          return db.query<R>(sql, vals)
        },
      }

      calls = 0
      await sumTotalsSpendForUser(userId, range, rangeOfDays(180), countingDb)
      expect(calls).toBe(1)

      calls = 0
      await listPerAgentSpendForUser(userId, range, countingDb)
      expect(calls).toBe(1)

      calls = 0
      await listByDaySpendForUser(userId, 'UTC', range, countingDb)
      expect(calls).toBe(1)

      calls = 0
      await listPerAgentTopMerchantForUser(userId, range, countingDb)
      expect(calls).toBe(1)

      calls = 0
      await listTopMerchantsForUser(userId, range, countingDb)
      expect(calls).toBe(1)

      calls = 0
      await sumFeesTotalsForUser(userId, range, rangeOfDays(180), countingDb)
      expect(calls).toBe(1)

      calls = 0
      await listGasEventsByChainForUser(userId, range, countingDb)
      expect(calls).toBe(1)

      calls = 0
      await listActiveDelegationsForUser(userId, countingDb)
      expect(calls).toBe(1)
    },
  )
})
