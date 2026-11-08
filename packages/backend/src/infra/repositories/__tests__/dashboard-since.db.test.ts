/**
 * Real-DB proofs for `DASHBOARD_SINCE_GROUPS_SQL` — the "Since your last visit"
 * figures (#4709, epic #4701 decision 4). Zero mocks: the ACs are claims about
 * what POSTGRES returns.
 *
 * The window is `(after, through]` — half-open on the left, CLOSED on the
 * right — so a payment confirmed exactly on a boundary is counted in exactly
 * one of two consecutive windows. The cases below pin that boundary rule, the
 * tenant scope, the testnet scope, the #3755 netting and the per-agent
 * grouping.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listDashboardSinceGroups } from '../dashboard.js'

const USDC_84532 = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const USDC_8453 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const MAINNET = 8453
const TESTNET = 84532

let seq = 0

interface Seed {
  userId: string
  accountId: string
  agentId: string
}

async function seedUser(): Promise<string> {
  const n = ++seq
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`since-4709-${n}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAccountAndAgent(
  userId: string,
  options: { name?: string; chainId?: number } = {},
): Promise<Seed> {
  const n = ++seq
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`, options.chainId ?? TESTNET],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [
      userId,
      account.rows[0].id,
      options.name ?? `since agent ${n}`,
      `0x${String(n).padStart(40, 'b')}`,
    ],
  )
  return { userId, accountId: account.rows[0].id, agentId: agent.rows[0].id }
}

/** A confirmed payment intent at an explicit instant. `usd` NULL = not booked. */
async function confirmedIntent(
  seed: Seed,
  opts: {
    confirmedAt: string
    amountAtomic?: string
    amountHuman?: string
    usd?: string | null
    chainId?: number
    tokenAddress?: string
  },
): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail, machine_metadata,
       usd_value
     ) VALUES (
       $1, $2, $3, 'USDC', $4,
       '0x00000000000000000000000000000000000000aa', $5, $6,
       '0x00000000000000000000000000000000000000d1', 1, $7,
       'confirmed', $8::timestamptz, $8::timestamptz + INTERVAL '10 minutes', $9,
       'x402', 'x402', 'delegation',
       '{"settlement_scheme":"erc7710"}'::jsonb, $10
     )`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(1e12 + n).padStart(40, '0').slice(-40)}`,
      opts.tokenAddress ?? USDC_84532,
      opts.amountAtomic ?? '1000000',
      opts.amountHuman ?? '1.00',
      `0x${String(n).padStart(64, 'a')}`,
      opts.confirmedAt,
      opts.chainId ?? TESTNET,
      opts.usd ?? null,
    ],
  )
}

/** A submitted sweep at an explicit instant — the #3755 netting leg. */
async function seedSweep(seed: Seed, valueAtomic: string, submittedAt: string): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO delegate_sweeps
       (agent_id, user_id, chain_id, token_address, from_address, to_address,
        value_atomic, valid_after, valid_before, nonce, status, tx_hash, submitted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 9999999999, $8, 'submitted', $9, $10::timestamptz, $10::timestamptz)`,
    [
      seed.agentId,
      seed.userId,
      TESTNET,
      USDC_84532,
      `0x${String(n).padStart(40, 'c')}`,
      `0x${String(n).padStart(40, 'd')}`,
      valueAtomic,
      n,
      `0x${String(n).padStart(64, 'e')}`,
      submittedAt,
    ],
  )
}

const at = (iso: string) => new Date(iso).toISOString()

describeDb('DASHBOARD_SINCE_GROUPS_SQL — the visit window (#4709)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('a payment exactly on a boundary is counted in exactly one of two consecutive windows', async () => {
    const userId = await seedUser()
    const seed = await seedAccountAndAgent(userId)
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')
    const t2 = at('2026-11-03T10:00:00.000Z')

    // One payment exactly at the shared boundary t1, one strictly inside each
    // window.
    await confirmedIntent(seed, { confirmedAt: at('2026-11-01T12:00:00.000Z'), usd: '1' })
    await confirmedIntent(seed, { confirmedAt: t1, usd: '2' })
    await confirmedIntent(seed, { confirmedAt: at('2026-11-02T12:00:00.000Z'), usd: '4' })

    const first = await listDashboardSinceGroups(userId, [TESTNET], t0, t1)
    const second = await listDashboardSinceGroups(userId, [TESTNET], t1, t2)

    // `(t0, t1]` holds the 12:00 payment and the boundary payment; `(t1, t2]`
    // holds only the 12:00 payment — the boundary one is NOT counted twice.
    expect(first.reduce((sum, row) => sum + Number(row.payments), 0)).toBe(2)
    expect(second.reduce((sum, row) => sum + Number(row.payments), 0)).toBe(1)
    expect(first.reduce((sum, row) => sum + Number(row.net_usd), 0)).toBe(3)
    expect(second.reduce((sum, row) => sum + Number(row.net_usd), 0)).toBe(4)
  })

  it('a payment confirmed after `through` belongs to the next entry', async () => {
    const userId = await seedUser()
    const seed = await seedAccountAndAgent(userId)
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')

    await confirmedIntent(seed, { confirmedAt: at('2026-11-02T10:00:00.001Z'), usd: '9' })

    expect(await listDashboardSinceGroups(userId, [TESTNET], t0, t1)).toEqual([])
  })

  it('is tenant-scoped — another user’s payments are never counted', async () => {
    const mine = await seedUser()
    const theirs = await seedUser()
    const mySeed = await seedAccountAndAgent(mine)
    const theirSeed = await seedAccountAndAgent(theirs)
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')

    await confirmedIntent(mySeed, { confirmedAt: at('2026-11-01T12:00:00.000Z'), usd: '1' })
    await confirmedIntent(theirSeed, { confirmedAt: at('2026-11-01T12:00:00.000Z'), usd: '5' })

    const rows = await listDashboardSinceGroups(mine, [TESTNET], t0, t1)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(mySeed.agentId)
    expect(Number(rows[0].net_usd)).toBe(1)
  })

  it('a testnet row does not count under a mainnet scope', async () => {
    const userId = await seedUser()
    const mainnetSeed = await seedAccountAndAgent(userId, { chainId: MAINNET })
    const testnetSeed = await seedAccountAndAgent(userId, { chainId: TESTNET })
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')

    await confirmedIntent(mainnetSeed, {
      confirmedAt: at('2026-11-01T12:00:00.000Z'),
      usd: '2',
      chainId: MAINNET,
      tokenAddress: USDC_8453,
    })
    await confirmedIntent(testnetSeed, {
      confirmedAt: at('2026-11-01T12:00:00.000Z'),
      usd: '7',
      chainId: TESTNET,
    })

    const rows = await listDashboardSinceGroups(userId, [MAINNET], t0, t1)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(mainnetSeed.agentId)
    expect(Number(rows[0].net_usd)).toBe(2)
  })

  it('applies the #3755 netting against sweeps submitted in the same window', async () => {
    const userId = await seedUser()
    const seed = await seedAccountAndAgent(userId)
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')

    // 10.00 confirmed, 4.00 swept inside the window → net 6.00.
    await confirmedIntent(seed, {
      confirmedAt: at('2026-11-01T12:00:00.000Z'),
      amountAtomic: '10000000',
      amountHuman: '10.00',
      usd: '10',
    })
    await seedSweep(seed, '4000000', at('2026-11-01T13:00:00.000Z'))

    const rows = await listDashboardSinceGroups(userId, [TESTNET], t0, t1)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].gross_usd)).toBe(10)
    expect(Number(rows[0].net_usd)).toBe(6)
  })

  it('groups by agent and carries the agent’s name', async () => {
    const userId = await seedUser()
    const research = await seedAccountAndAgent(userId, { name: 'Research agent' })
    const helper = await seedAccountAndAgent(userId, { name: 'Helper' })
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')

    await confirmedIntent(research, { confirmedAt: at('2026-11-01T11:00:00.000Z'), usd: '1' })
    await confirmedIntent(research, { confirmedAt: at('2026-11-01T12:00:00.000Z'), usd: '2' })
    await confirmedIntent(helper, { confirmedAt: at('2026-11-01T13:00:00.000Z'), usd: '3' })

    const rows = await listDashboardSinceGroups(userId, [TESTNET], t0, t1)
    const byAgent = new Map(rows.map((row) => [row.agent_id, row]))
    expect(byAgent.get(research.agentId)?.agent_name).toBe('Research agent')
    expect(Number(byAgent.get(research.agentId)?.payments)).toBe(2)
    expect(Number(byAgent.get(research.agentId)?.net_usd)).toBe(3)
    expect(byAgent.get(helper.agentId)?.agent_name).toBe('Helper')
    expect(Number(byAgent.get(helper.agentId)?.payments)).toBe(1)
  })

  it('leaves a NULL-booked row in the fallback bucket for the route to price', async () => {
    const userId = await seedUser()
    const seed = await seedAccountAndAgent(userId)
    const t0 = at('2026-11-01T10:00:00.000Z')
    const t1 = at('2026-11-02T10:00:00.000Z')

    await confirmedIntent(seed, {
      confirmedAt: at('2026-11-01T12:00:00.000Z'),
      amountHuman: '2.50',
      usd: null,
    })

    const rows = await listDashboardSinceGroups(userId, [TESTNET], t0, t1)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].net_usd)).toBe(0)
    expect(Number(rows[0].fb_usd)).toBe(2.5)
  })
})
