/**
 * Real-DB proofs for the #3803 overview statements.
 *
 * The ACs are claims about what POSTGRES returns — per-group netting,
 * refusal buckets, distinct-merchant counting, the pending_approval preview —
 * so they belong on the #1220 harness, not on the vi.mock('db.js')
 * dispatcher the characterization suite uses (which proves only what the
 * CALLER does with the rows). Zero mocks.
 *
 * Fixture (the one #3803 prescribes): gross 10.00 USDC confirmed, 4.00
 * swept — the spend triple gross 10.00 / swept 4.00 / net 6.00 AND pace
 * 6_000_000 atomic off the SAME dataset.
 *
 * The EXPLAIN proof at the bottom is the PR artifact: with 5 agents × 300
 * payments the plan must stay a single legs scan over payment_intents —
 * never a per-agent loop. Set EXPLAIN_OUT=<path> to also write the plan to
 * disk for the PR description.
 */
import fs from 'node:fs'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  countFailedIntents7d,
  DASHBOARD_SPEND_GROUPS_SQL,
  listAgentLastPayments,
  listDashboardAgents,
  listDashboardMerchants,
  listDashboardSpendGroups,
  listPendingAgentSetupStatuses,
  listReceivedSubBudgetsForAgents,
  listRefusalBucketsByAgent,
} from '../dashboard.js'

const USDC_84532 = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
let seq = 0

interface Seed {
  userId: string
  accountId: string
  agentId: string
}

async function seedUser(): Promise<string> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`dash-3803-${n}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

async function seedAccountAndAgent(
  userId: string,
  options: { status?: string; chainId?: number } = {},
): Promise<Seed> {
  const n = ++seq
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`, options.chainId ?? 84532],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      userId,
      account.rows[0].id,
      `3803 agent ${n}`,
      `0x${String(n).padStart(40, 'b')}`,
      options.status ?? 'active',
    ],
  )
  return { userId, accountId: account.rows[0].id, agentId: agent.rows[0].id }
}

/** A confirmed payment intent. `usd`/`eur`/`sek` NULL = not booked. */
async function confirmedIntent(
  seed: Seed,
  opts: {
    amountAtomic: string
    amountHuman: string
    usd?: string | null
    eur?: string | null
    sek?: string | null
    chainId?: number
    tokenAddress?: string
    host?: string | null
  },
): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail, machine_metadata,
       usd_value, eur_value, sek_value, x402_resource_url
     ) VALUES (
       $1, $2, $3, 'USDC', $10,
       '0x00000000000000000000000000000000000000aa', $4, $5,
       '0x00000000000000000000000000000000000000d1', 1, $6,
       'confirmed', NOW(), NOW() + INTERVAL '10 minutes', $7,
       'x402', 'x402', 'delegation',
       '{"settlement_scheme":"erc7710"}'::jsonb, $8, $9, $12, $11
     )`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(1e12 + n).padStart(40, '0').slice(-40)}`,
      opts.amountAtomic,
      opts.amountHuman,
      `0x${String(n).padStart(64, 'a')}`,
      opts.chainId ?? 84532,
      opts.usd ?? null,
      opts.eur ?? null,
      opts.tokenAddress ?? USDC_84532,
      opts.host ?? null,
      opts.sek ?? null,
    ],
  )
}

async function seedSweep(seed: Seed, valueAtomic: string): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO delegate_sweeps
       (agent_id, user_id, chain_id, token_address, from_address, to_address,
        value_atomic, valid_after, valid_before, nonce, status, tx_hash, submitted_at, created_at)
     VALUES ($1, $2, 84532, $3, $4, $5, $6, 0, 9999999999, $7, 'submitted', $8, NOW(), NOW())`,
    [
      seed.agentId,
      seed.userId,
      USDC_84532,
      `0x${String(n).padStart(40, 'c')}`,
      `0x${String(n).padStart(40, 'd')}`,
      valueAtomic,
      n,
      `0x${String(n).padStart(64, 'e')}`,
    ],
  )
}

async function seedRefusal(seed: Seed, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO payment_refusals (user_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source)
     VALUES ($1, $2, 84532, 'USDC', '1000000', $3, 'payment')`,
    [seed.userId, seed.agentId, reason],
  )
}

// Window bounds are computed PER TEST, not at module load — and `to` carries
// a 1-minute slack: the fixture inserts land milliseconds AFTER the window is
// taken, and a `to` equal to "now" would exclude the very row under test.
const window = () => {
  const now = new Date()
  return {
    from7: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    from30: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    to: new Date(now.getTime() + 60_000).toISOString(),
  }
}

describeDb('#3803 overview statements', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('the preview returns EVERY delegation-rail agent, including pending_approval', async () => {
    // Six active first, then a paused and two pending_approval — order must
    // not gate the count (the old LIMIT 6 preview cut pending agents off).
    const userId = await seedUser()
    const { from7, from30, to } = window()
    for (let i = 0; i < 6; i++) await seedAccountAndAgent(userId)
    await seedAccountAndAgent(userId, { status: 'paused' })
    await seedAccountAndAgent(userId, { status: 'pending_approval' })
    await seedAccountAndAgent(userId, { status: 'pending_approval' })

    const rows = await listDashboardAgents(userId)
    expect(rows).toHaveLength(9)
    const statuses = rows.map((row) => row.status)
    expect(statuses.filter((status) => status === 'pending_approval')).toHaveLength(2)
    expect(statuses).toContain('paused')
    expect(statuses).toContain('active')
  })

  it('the fixed DateRange fixture: gross 10.00, swept 4.00, net 6.00 — and pace 6_000_000 atomic', async () => {
    const userId = await seedUser()
    const { from7, from30, to } = window()
    const seed = await seedAccountAndAgent(userId)
    await confirmedIntent(seed, {
      amountAtomic: '10000000',
      amountHuman: '10.00',
      usd: '10',
      eur: '9',
      sek: '100',
    })
    await seedSweep(seed, '4000000')

    const groups = await listDashboardSpendGroups(userId, [84532], from30, from7, to)
    expect(groups).toHaveLength(1)
    const group = groups[0]
    expect(group.gross_usd_7).toBe('10.000000')
    expect(group.net_usd_7).toBe('6.000000')
    expect(group.gross_sek_7).toBe('100.000000')
    expect(group.net_sek_7).toBe('60.000000')
    expect(group.payments_7).toBe('1')
    expect(group.payments_30).toBe('1')
    // pace: Σ confirmed − min(swept, confirmed) = 10_000_000 − 4_000_000
    expect(group.pace_atomic).toBe('6000000')
  })

  it("an account's USDC pace counts only that account's agents and chain", async () => {
    const userId = await seedUser()
    const { from7, from30, to } = window()
    const accountA = await seedAccountAndAgent(userId)
    const accountB = await seedAccountAndAgent(userId)
    // Account A's agent pays on 84532 (registry USDC) — counted.
    await confirmedIntent(accountA, { amountAtomic: '3000000', amountHuman: '3.00', usd: '3' })
    // Account A's agent ALSO pays on 8453 — a different chain, outside scope.
    await confirmedIntent(accountA, {
      amountAtomic: '7000000',
      amountHuman: '7.00',
      usd: '7',
      chainId: 8453,
      tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    })
    // Account B's agent pays the same chain — a different account, excluded.
    await confirmedIntent(accountB, { amountAtomic: '5000000', amountHuman: '5.00', usd: '5' })

    const groups = await listDashboardSpendGroups(userId, [84532], from30, from7, to)
    // Two groups under the user (one per agent on 84532); the 8453 payment
    // is chain-filtered OUT of the statement entirely — the route pairs
    // groups with accounts by agent.account_id + chain before summing pace.
    expect(groups).toHaveLength(2)
    const groupA = groups.find((g) => g.agent_id === accountA.agentId)
    expect(groupA?.chain_key).toBe(84532)
    expect(groupA?.pace_atomic).toBe('3000000')
    const groupB = groups.find((g) => g.agent_id === accountB.agentId)
    expect(groupB?.pace_atomic).toBe('5000000')
  })

  it('refusal buckets: two of one reason count 2; onchain_revert → failed; relayer_budget → haven', async () => {
    const userId = await seedUser()
    const { from7, from30, to } = window()
    const seed = await seedAccountAndAgent(userId)
    await seedRefusal(seed, 'delegation_budget_exceeded')
    await seedRefusal(seed, 'delegation_budget_exceeded')
    await seedRefusal(seed, 'onchain_revert')
    await seedRefusal(seed, 'relayer_budget')

    const rows = await listRefusalBucketsByAgent(userId, [84532], from30, from7, to)
    expect(rows).toHaveLength(1)
    expect(rows[0].budget_7).toBe('2')
    expect(rows[0].failed_7).toBe('1')
    expect(rows[0].haven_7).toBe('1')
    expect(rows[0].scope_7).toBe('0')
  })

  it('distinct merchants over two agents paying the SAME merchant count 1 — not a sum of per-agent counts', async () => {
    const userId = await seedUser()
    const { from7, from30, to } = window()
    const agentA = await seedAccountAndAgent(userId)
    const agentB = await seedAccountAndAgent(userId)
    await confirmedIntent(agentA, {
      amountAtomic: '1000000',
      amountHuman: '1.00',
      usd: '1',
      host: 'https://shop.example/pick',
    })
    await confirmedIntent(agentB, {
      amountAtomic: '2000000',
      amountHuman: '2.00',
      usd: '2',
      host: 'https://shop.example/other',
    })
    // A direct (non-x402) payment to a different recipient — a second
    // merchant, with LESS usd than the shop so the shop wins the top slot.
    await confirmedIntent(agentB, { amountAtomic: '3000000', amountHuman: '3.00', usd: '0.5', host: null })

    const merchants = await listDashboardMerchants(userId, [84532], from30, from7, to)
    expect(merchants.distinct_merchants_7).toBe('2')
    expect(merchants.top_merchant_key).toBe('shop.example')

    // One merchant only when both agents pay the same host.
    await resetDb()
    const userId2 = await seedUser()
    const againA = await seedAccountAndAgent(userId2)
    const againB = await seedAccountAndAgent(userId2)
    await confirmedIntent(againA, { amountAtomic: '1000000', amountHuman: '1.00', usd: '1', host: 'https://shop.example/x' })
    await confirmedIntent(againB, { amountAtomic: '2000000', amountHuman: '2.00', usd: '2', host: 'https://shop.example/x' })
    const same = await listDashboardMerchants(userId2, [84532], from30, from7, to)
    expect(same.distinct_merchants_7).toBe('1')
  })

  it('the last-payment lookup and failed-intent / setup / sub-budget reads answer their shapes', async () => {
    const userId = await seedUser()
    const { from7, from30, to } = window()
    const seed = await seedAccountAndAgent(userId)
    await confirmedIntent(seed, { amountAtomic: '1000000', amountHuman: '1.00', usd: '1', host: 'https://api.example/v1/weather' })

    const last = await listAgentLastPayments(userId)
    expect(last).toHaveLength(1)
    expect(last[0].source).toBe('x402')
    expect(last[0].x402_resource_url).toContain('api.example')
    expect(last[0].merchant_address).toBe('0x00000000000000000000000000000000000000aa')

    expect(await countFailedIntents7d(userId, [84532], from7, to)).toBe(0)
    expect(await listPendingAgentSetupStatuses(userId, [seed.agentId])).toEqual(new Map())
    expect(await listReceivedSubBudgetsForAgents(userId, [seed.agentId])).toEqual([])
  })
})

describeDb('#3803 EXPLAIN artifact (5 agents × 300 payments)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('plans the dataset as a single legs scan — no per-agent loop', async () => {
    const userId = await seedUser()
    const { from7, from30, to } = window()
    const agents = []
    for (let i = 0; i < 5; i++) agents.push(await seedAccountAndAgent(userId))
    let n = 0
    for (const agent of agents) {
      for (let i = 0; i < 300; i++) {
        n++
        await confirmedIntent(agent, {
          amountAtomic: '1000000',
          amountHuman: '1.00',
          usd: '1',
          host: n % 3 === 0 ? 'https://shop.example/pick' : null,
        })
      }
    }

    const result = await db.query<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (COSTS OFF) ${DASHBOARD_SPEND_GROUPS_SQL}`,
      [userId, from30, from7, to, [84532]],
    )
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n')
    // Any scan kind (Seq/Index/Bitmap) — the point is the COUNT: a per-agent
    // loop would re-plan payment_intents once per agent. One legs scan, and
    // everything else joins off it.
    const scans = (plan.match(/Scan on payment_intents/g) ?? []).length
    expect(scans).toBeLessThanOrEqual(2)

    const artifact = process.env.EXPLAIN_OUT
    if (artifact) fs.writeFileSync(artifact, plan + '\n')
  })
})
