/**
 * Real-DB proofs for the #3837 sponsored-gas ledger (`#1220` harness — zero
 * mocks): every outcome a payment path can produce lands in
 * `sponsored_userop_gas_events` with the right cost shape, the
 * per-merchant-per-day aggregate is ONE query over the live join, and the
 * new rows NEVER reach `relayer_gas_events` — so `gas_sponsored_ops`
 * (`GAS_EVENTS_BY_CHAIN_SQL`) and `relayerSpendSummary` keep their exact
 * meaning (acceptance criterion: "do not change meaning by accident").
 *
 * Cost basis under test: `actual_gas_cost_wei` = EntryPoint `actualGasCost`
 * (includes preVerificationGas/L1 data fee; no `l1Fee` added on top).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { insertSponsoredUserOpGas, sponsoredGasByMerchantDay } from '../sponsored-userop-gas.js'
import { listGasEventsByChainForUser } from '../analytics.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'

let seq = 0

const USDC_84532 = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

async function seedAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sponsored-gas-3837-${n}-${Date.now()}@test.example`],
  )
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [user.rows[0].id, `0x${String(n).padStart(40, 'a')}`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [user.rows[0].id, account.rows[0].id, `3837 agent ${n}`, `0x${String(n).padStart(40, 'b')}`],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/**
 * A payment intent to attribute legs to. `host` seeds payment_resource_url
 * (migration 012) — the LIVE source of the merchant host; `status`/`usd`
 * drive the value-moved filter.
 */
async function seedIntent(
  agent: { userId: string; agentId: string },
  opts: { status: string; host: string | null; usd?: string | null },
): Promise<string> {
  const n = ++seq
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, expires_at,
       chain_id, source, payment_rail, execution_rail, payment_resource_url, usd_value
     ) VALUES (
       $1, $2, $3, 'USDC', $4,
       '0x00000000000000000000000000000000000000aa', '100000', '0.10',
       '0x00000000000000000000000000000000000000d1', 1, $5,
       $6, NOW() + INTERVAL '10 minutes', 84532, $7, $7, 'delegation', $8, $9
     ) RETURNING id`,
    [
      agent.agentId,
      agent.userId,
      `0x${String(1e12 + n).padStart(40, '0').slice(-40)}`,
      USDC_84532,
      `0x${String(n).padStart(64, 'c')}`,
      opts.status,
      opts.host == null ? 'direct' : 'x402',
      opts.host,
      opts.usd ?? null,
    ],
  )
  return intent.rows[0].id
}

const todayUtc = () => new Date().toISOString().slice(0, 10)
// A minute of slack so rows inserted "now" fall inside the window.
const window = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) })

describeDb('#3837 sponsored-gas ledger', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('every outcome lands: confirmed with cost, reverted with cost, receipt-unconfirmed cost-NULL — all counted', async () => {
    const agent = await seedAgent()
    const intent = await seedIntent(agent, { status: 'confirmed', host: 'https://merchant.example/pay', usd: '10.00' })

    await insertSponsoredUserOpGas({
      paymentIntentId: intent, agentId: agent.agentId, userId: agent.userId, chainId: 84532,
      leg: 'x402_funding', outcome: 'confirmed', userOpHash: '0xuop1', txHash: '0xtx1',
      actualGasUsed: 3000000n, actualGasCost: 3_000_000_000_000_000n,
    })
    await insertSponsoredUserOpGas({
      paymentIntentId: intent, agentId: agent.agentId, userId: agent.userId, chainId: 84532,
      leg: 'x402_funding', outcome: 'included_reverted', userOpHash: '0xuop2',
      actualGasCost: 100_000_000_000_000n,
    })
    await insertSponsoredUserOpGas({
      paymentIntentId: intent, agentId: agent.agentId, userId: agent.userId, chainId: 84532,
      leg: 'x402_funding', outcome: 'receipt_unconfirmed', userOpHash: '0xuop3',
      actualGasCost: null,
    })

    const { from, to } = window()
    const rows = await sponsoredGasByMerchantDay(from, to)

    const merchant = rows.filter((r) => r.leg === 'x402_funding' && r.merchant_host === 'merchant.example')
    expect(merchant).toHaveLength(1)
    expect(merchant[0].day).toBe(todayUtc())
    // All THREE legs count, including the cost-null one.
    expect(merchant[0].funding_legs).toBe('3')
    // Only the cost-known legs sum: 3.1e15 wei = 0.0031 ETH.
    expect(merchant[0].gas_cost_wei).toBe('3100000000000000')
    // Value moved comes from the LIVE join: the CONFIRMED intent's usd_value.
    expect(merchant[0].value_moved_usd).toBe('10.000000')
  })

  it('a reverted leg on a failed intent moves nothing, and direct legs are their own NULL-host bucket', async () => {
    const agent = await seedAgent()
    const failedIntent = await seedIntent(agent, { status: 'failed', host: 'https://other.example/x' })
    const directIntent = await seedIntent(agent, { status: 'confirmed', host: null, usd: '5.00' })

    await insertSponsoredUserOpGas({
      paymentIntentId: failedIntent, agentId: agent.agentId, userId: agent.userId, chainId: 84532,
      leg: 'x402_funding', outcome: 'included_reverted', userOpHash: '0xuop4', actualGasCost: 42n,
    })
    await insertSponsoredUserOpGas({
      paymentIntentId: directIntent, agentId: agent.agentId, userId: agent.userId, chainId: 84532,
      leg: 'direct', outcome: 'confirmed', userOpHash: '0xuop5', txHash: '0xtx5', actualGasCost: 50n,
    })

    const { from, to } = window()
    const rows = await sponsoredGasByMerchantDay(from, to)

    const otherHost = rows.find((r) => r.merchant_host === 'other.example')
    expect(otherHost).toBeDefined()
    expect(otherHost!.funding_legs).toBe('1')
    expect(otherHost!.gas_cost_wei).toBe('42')
    // The intent FAILED — its usd_value moved nothing, whatever it carried.
    expect(otherHost!.value_moved_usd).toBe('0')

    const direct = rows.find((r) => r.leg === 'direct')
    expect(direct).toBeDefined()
    // Direct payments have no merchant: their own bucket, host NULL even
    // though the intent row itself could carry a resource URL.
    expect(direct!.merchant_host).toBeNull()
    expect(direct!.gas_cost_wei).toBe('50')
    expect(direct!.value_moved_usd).toBe('5.000000')
  })

  it('the ledger is separate from relayer_gas_events: gas_sponsored_ops never sees sponsored-UserOp rows', async () => {
    const agent = await seedAgent()
    const intent = await seedIntent(agent, { status: 'confirmed', host: 'https://merchant.example/pay', usd: '1.00' })
    await insertSponsoredUserOpGas({
      paymentIntentId: intent, agentId: agent.agentId, userId: agent.userId, chainId: 84532,
      leg: 'x402_funding', outcome: 'confirmed', userOpHash: '0xuop', actualGasCost: 999n,
    })

    // GAS_EVENTS_BY_CHAIN_SQL reads relayer_gas_events only — a table the
    // sponsored-gas writer never touches, so the user-facing figure and
    // relayerSpendSummary keep their #717 meaning exactly.
    const gasByChain = await listGasEventsByChainForUser(agent.userId, {
      from: window().from.toISOString(),
      to: window().to.toISOString(),
    })
    expect(gasByChain).toEqual([])

    const relayerRows = await db.query(`SELECT COUNT(*)::int AS n FROM relayer_gas_events`)
    expect(relayerRows.rows[0].n).toBe(0)
  })
})
