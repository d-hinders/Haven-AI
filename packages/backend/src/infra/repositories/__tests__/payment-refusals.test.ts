/**
 * Real-Postgres proof for the payment_refusals repository (#2945, slice A of
 * epic #2944). No db.js mocks — the ratchet pushes data-layer behaviour onto
 * this harness, and the growth bound (the dedupe) is exactly the kind of
 * thing only a real database can prove: one CTE, one statement, row-locked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  recordPaymentRefusal,
  listRefusalsForUser,
  aggregateRefusalsForUserByAgent,
  firstRefusalDayForUser,
  REFUSAL_DEDUPE_WINDOW_SECONDS,
  type RecordRefusalInput,
} from '../payment-refusals.js'

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`refusalsrepo-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, `refusals-repo-agent-${seq}`],
  )
  return rows[0].id
}

/** Address must be unique per row: `(user_id, account_address, chain_id)` is UNIQUE. */
function fakeAddress(n: number): string {
  return `0x${String(n).padStart(40, '0')}`
}

async function seedAccount(userId: string, addrSeed: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id)
     VALUES ($1, $2, 84532) RETURNING id`,
    [userId, fakeAddress(addrSeed)],
  )
  return rows[0].id
}

interface Fixtures {
  userId: string
  agentId: string
}

async function seedFixtures(): Promise<Fixtures> {
  const userId = await seedUser()
  const agentId = await seedAgent(userId)
  return { userId, agentId }
}

function refusalInput(fix: Fixtures, overrides: Partial<RecordRefusalInput> = {}): RecordRefusalInput {
  return {
    userId: fix.userId,
    accountId: null,
    agentId: fix.agentId,
    chainId: 84532,
    tokenSymbol: 'USDC',
    amountAtomic: '10000',
    usdValue: 0.1,
    eurValue: 0.092,
    merchantTo: '0x' + 'cc'.repeat(20),
    resourceUrl: `https://merchant.example/r-${seq}`,
    reason: 'delegation_budget_exceeded',
    source: 'x402_authorize',
    detail: { error_code: 'delegation_budget_exceeded', remaining_atomic: '40000' },
    ...overrides,
  }
}

async function refusalRows(userId: string): Promise<Array<{ attempts: number; reason: string; resource_url: string | null }>> {
  const { rows } = await db.query<{ attempts: number; reason: string; resource_url: string | null }>(
    `SELECT attempts, reason, resource_url FROM payment_refusals WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  )
  return rows
}

describeDb('payment_refusals repository (#2945)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('recordPaymentRefusal inserts a full row and reports it as inserted', async () => {
    const fix = await seedFixtures()
    const accountId = await seedAccount(fix.userId, 600)

    const result = await recordPaymentRefusal(refusalInput(fix, { accountId }))

    expect(result.inserted).toBe(true)
    expect(result.attempts).toBe(1)
    const rows = await refusalRows(fix.userId)
    expect(rows).toHaveLength(1)
    const { rows: full } = await db.query<{
      account_id: string | null
      usd_value: string | null
      eur_value: string | null
      detail: Record<string, string> | null
      merchant_to: string | null
      token_symbol: string
      amount_atomic: string
      chain_id: number
      source: string
    }>(`SELECT account_id, usd_value, eur_value, detail, merchant_to, token_symbol, amount_atomic, chain_id, source
         FROM payment_refusals WHERE user_id = $1`, [fix.userId])
    expect(full[0].account_id).toBe(accountId)
    // NUMERIC(20,6) round-trips as a string; the value is what was booked.
    expect(Number(full[0].usd_value)).toBeCloseTo(0.1, 6)
    expect(Number(full[0].eur_value)).toBeCloseTo(0.092, 6)
    expect(full[0].detail).toMatchObject({ error_code: 'delegation_budget_exceeded', remaining_atomic: '40000' })
    expect(full[0].merchant_to).toBe('0x' + 'cc'.repeat(20))
    expect(full[0].token_symbol).toBe('USDC')
    expect(full[0].amount_atomic).toBe('10000')
    expect(full[0].chain_id).toBe(84532)
    expect(full[0].source).toBe('x402_authorize')
  })

  // ── The growth bound (#2945 acceptance) ─────────────────────────────────
  //
  // Two refusals of the same (agent_id, reason, resource_url) within the
  // window → ONE row with attempts = 2. Past the window → TWO rows.

  it('two refusals of the same triple inside 60s fold into ONE row with attempts = 2', async () => {
    const fix = await seedFixtures()
    const input = refusalInput(fix)

    const first = await recordPaymentRefusal(input)
    const second = await recordPaymentRefusal(input)

    expect(first.inserted).toBe(true)
    expect(first.attempts).toBe(1)
    expect(second.inserted).toBe(false)
    expect(second.attempts).toBe(2)
    expect(second.id).toBe(first.id)

    const rows = await refusalRows(fix.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(2)
  })

  it('the same triple 61s apart produces TWO rows (the window is real)', async () => {
    const fix = await seedFixtures()
    const input = refusalInput(fix)

    const first = await recordPaymentRefusal(input)
    // Age the first row past the window, directly — the only way a real-DB
    // test can place a refusal 61 seconds ago without sleeping.
    await db.query(`UPDATE payment_refusals SET created_at = NOW() - interval '61 seconds' WHERE id = $1`, [first.id])

    const second = await recordPaymentRefusal(input)

    expect(second.inserted).toBe(true)
    expect(second.attempts).toBe(1)
    const rows = await refusalRows(fix.userId)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.attempts === 1)).toBe(true)
  })

  it('the same agent+reason with a DIFFERENT resource_url is a separate row', async () => {
    const fix = await seedFixtures()

    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/x' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/y' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/x' }))

    const rows = await refusalRows(fix.userId)
    expect(rows).toHaveLength(2)
    const xRow = rows.find((r) => r.resource_url === 'https://a.example/x')
    expect(xRow?.attempts).toBe(2)
    expect(rows.find((r) => r.resource_url === 'https://a.example/y')?.attempts).toBe(1)
  })

  it('NULL resource_url dedupes as a VALUE (IS NOT DISTINCT FROM), not as SQL NULL', async () => {
    const fix = await seedFixtures()
    const input = refusalInput(fix, { resourceUrl: null, reason: 'no_delegation_for_target' })

    await recordPaymentRefusal(input)
    const second = await recordPaymentRefusal(input)

    expect(second.inserted).toBe(false)
    expect(second.attempts).toBe(2)
    const rows = await refusalRows(fix.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(2)
  })

  it('a different agent or reason never folds into another row', async () => {
    const fix = await seedFixtures()
    const otherAgent = await seedAgent(fix.userId)

    await recordPaymentRefusal(refusalInput(fix))
    await recordPaymentRefusal(refusalInput(fix, { reason: 'onchain_revert' }))
    await recordPaymentRefusal(refusalInput(fix, { agentId: otherAgent }))

    const rows = await refusalRows(fix.userId)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.attempts === 1)).toBe(true)
  })

  it('attempts keeps counting across folds (3 refusals, 1 row, attempts = 3)', async () => {
    const fix = await seedFixtures()
    const input = refusalInput(fix)

    await recordPaymentRefusal(input)
    await recordPaymentRefusal(input)
    const third = await recordPaymentRefusal(input)

    expect(third.attempts).toBe(3)
  })

  it(`the dedupe window constant is ${REFUSAL_DEDUPE_WINDOW_SECONDS}s (the SQL interpolates it)`, () => {
    expect(REFUSAL_DEDUPE_WINDOW_SECONDS).toBe(60)
  })

  // ── The reads the analytics API serves ──────────────────────────────────

  it('listRefusalsForUser returns the user range newest-first and excludes other users', async () => {
    const fix = await seedFixtures()
    const other = await seedFixtures()

    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/1' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/2' }))
    await recordPaymentRefusal(refusalInput(other, { resourceUrl: 'https://a.example/3' }))
    // Pin explicit second-precision timestamps: NOW() carries microseconds,
    // which do not survive the round-trip through a JS ISO string when the
    // range is fed back in — the range test below would flake on that alone.
    await db.query(
      `UPDATE payment_refusals SET created_at = '2030-01-01T00:00:00Z'
        WHERE user_id = $1 AND resource_url = 'https://a.example/1'`,
      [fix.userId],
    )
    await db.query(
      `UPDATE payment_refusals SET created_at = '2030-01-01T00:01:00Z'
        WHERE user_id = $1 AND resource_url = 'https://a.example/2'`,
      [fix.userId],
    )

    const all = await listRefusalsForUser(fix.userId, {
      fromExclusive: '1970-01-01T00:00:00Z',
      toInclusive: '2999-01-01T00:00:00Z',
    })
    expect(all).toHaveLength(2)
    expect(all.every((r) => r.user_id === fix.userId)).toBe(true)

    // Newest first.
    expect(all[0].resource_url).toBe('https://a.example/2')
    expect(all[1].resource_url).toBe('https://a.example/1')

    // The range bound is exclusive below / inclusive above, at exact stamps.
    const bounded = await listRefusalsForUser(fix.userId, {
      fromExclusive: '2030-01-01T00:00:00Z',
      toInclusive: '2030-01-01T00:01:00Z',
    })
    expect(bounded).toHaveLength(1)
    expect(bounded[0].resource_url).toBe('https://a.example/2')
  })

  it('aggregateRefusalsForUserByAgent folds rows and attempts per agent and per reason', async () => {
    const fix = await seedFixtures()
    const otherAgent = await seedAgent(fix.userId)

    // Agent A: one budget triple folded to a single row at attempts 3, plus
    // one revert row → 2 refusals, 4 attempts. Agent B: 1 row, 1 attempt.
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/1' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/1' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/1' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/2', reason: 'onchain_revert' }))
    await recordPaymentRefusal(refusalInput(fix, { agentId: otherAgent, resourceUrl: 'https://a.example/3' }))

    const aggregates = await aggregateRefusalsForUserByAgent(fix.userId, {
      fromExclusive: '1970-01-01T00:00:00Z',
      toInclusive: '2999-01-01T00:00:00Z',
    })

    expect(aggregates).toHaveLength(2)
    // Ordered by attempts desc: the folded agent first.
    const folded = aggregates.find((a) => a.agent_id === fix.agentId)
    const other = aggregates.find((a) => a.agent_id === otherAgent)
    expect(folded).toMatchObject({ refusals: 2, attempts: 4 })
    expect(folded?.by_reason).toMatchObject({ delegation_budget_exceeded: 1, onchain_revert: 1 })
    expect(other).toMatchObject({ refusals: 1, attempts: 1 })

    // The aggregate honours the same range contract as the list read.
    const empty = await aggregateRefusalsForUserByAgent(fix.userId, {
      fromExclusive: '2999-01-01T00:00:00Z',
      toInclusive: '2999-01-01T00:01:00Z',
    })
    expect(empty).toEqual([])
  })

  // ── The ledger floor (#3013) ────────────────────────────────────────────
  //
  // `refusals_recorded_from` on the overview response is a trust claim: the
  // day emitted is the day the ledger actually has rows. Proven against real
  // Postgres because only a real database owns "what the earliest row is" —
  // a mock would just restate the fixture.

  it('firstRefusalDayForUser is null on an empty ledger and the earliest UTC day once rows exist', async () => {
    const fix = await seedFixtures()

    // Empty ledger → null (MIN over an empty set returns one NULL row).
    expect(await firstRefusalDayForUser(fix.userId)).toBeNull()

    // Two rows, deliberately out of insertion order, spanning a UTC midnight:
    // the floor must be the EARLIEST row's day, not the first written one.
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/late' }))
    await recordPaymentRefusal(refusalInput(fix, { resourceUrl: 'https://a.example/early' }))
    await db.query(
      `UPDATE payment_refusals SET created_at = '2030-05-30T23:59:59Z'
        WHERE user_id = $1 AND resource_url = 'https://a.example/early'`,
      [fix.userId],
    )
    await db.query(
      `UPDATE payment_refusals SET created_at = '2030-06-01T00:00:01Z'
        WHERE user_id = $1 AND resource_url = 'https://a.example/late'`,
      [fix.userId],
    )

    expect(await firstRefusalDayForUser(fix.userId)).toBe('2030-05-30')
  })

  it('firstRefusalDayForUser is tenant-scoped and honours NO window bound — it is a ledger property, not a range one', async () => {
    const fix = await seedFixtures()
    const other = await seedFixtures()

    await recordPaymentRefusal(refusalInput(fix))
    await recordPaymentRefusal(refusalInput(other))
    // fix's only row is ancient; other's row is recent. If the read were
    // range-scoped like the analytics aggregates, a modern window would
    // return null for fix — it must still return fix's floor day.
    await db.query(
      `UPDATE payment_refusals SET created_at = '2030-01-15T12:00:00Z' WHERE user_id = $1`,
      [fix.userId],
    )
    // Leave `other`'s row at NOW().

    expect(await firstRefusalDayForUser(fix.userId)).toBe('2030-01-15')

    // Tenant isolation: fix's floor never leaks into other's read, even
    // though other's ledger also has a row.
    expect(await firstRefusalDayForUser(other.userId)).not.toBe('2030-01-15')

    // A user with NO rows at all stays null while a seeded sibling has rows.
    const third = await seedFixtures()
    expect(await firstRefusalDayForUser(third.userId)).toBeNull()
  })
})
