/**
 * One sync row per settled payment, whatever rail settled it (#2117, AC 4).
 *
 * The bug this pins is a rail asymmetry, not a feed bug: the feed has never had
 * a scheme filter, but on erc7710 nothing ever produced the
 * `machine_payment_evidence` row the feed enumerates, so an entire settlement
 * scheme was silently absent from the user's books while EIP-3009 sailed
 * through. Asserting the two schemes SIDE BY SIDE is the point — a test of
 * either alone stays green through exactly that asymmetry.
 *
 * Real Postgres and the REAL feed path: the real evidence writer, the real
 * `buildAccountingEntryForPayment`, the real `claimSync`/`markPushed` dedup
 * ledger, and the real backfill selection. Only two things are stubbed — the
 * hosted entitlement gate (a config surface, not behaviour under test) and the
 * accounting connector (an external system this suite does not own).
 *
 * Both payments arrive by the route they actually arrive by in production: the
 * 3009 one is confirmed by Haven's own funding transaction, and the erc7710 one
 * is completed by the #2117 passive sweep, having had no hash reported ever.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const { reportingFeedAvailable } = vi.hoisted(() => ({
  reportingFeedAvailable: vi.fn(async () => true),
}))
const getTransactionReceipt = vi.fn()
const getBlock = vi.fn()
const getLogs = vi.fn()

vi.mock('../../agents/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agents/index.js')>()),
  reportingFeedAvailable,
}))

vi.mock('../../../rails/allowance-module.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../rails/allowance-module.js')>()),
  getProvider: () => ({ getTransactionReceipt, getBlock, getLogs }),
}))

vi.mock('../../../infra/prices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/prices.js')>()),
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10 }),
}))

import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { registerConnector, clearConnectors, InMemoryConnector } from '../connector.js'
import { syncUser } from '../feed-orchestrator.js'
import { recordMachinePaymentEvidenceBaseById } from '../../mpp/evidence.js'
import { runSettlementSweepTick, resetSettlementSweepBackoff } from '../../x402/index.js'
import { buildSettlementDelegation } from '../../x402/x402-delegation.js'
import { buildBudgetDelegation } from '../../../rails/delegation-policy.js'
import { getDelegationContracts } from '../../../rails/delegation-contracts.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const AMOUNT_RAW = '100000'
const RESOURCE = 'https://merchant.example/paid'
const MANAGER = getDelegationContracts(CHAIN).delegationManager
const FUNDING_TX = `0x${'30'.repeat(32)}`
const SETTLEMENT_TX = `0x${'77'.repeat(32)}`

const SIGNED_BUDGET = {
  ...buildBudgetDelegation({
    agentId: 'parity', chainId: CHAIN,
    treasuryAddress: '0x00000000000000000000000000000000000000b1',
    delegateAccountAddress: PAYER as `0x${string}`,
    tokenAddress: TOKEN as `0x${string}`,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400,
    startDate: Math.floor(Date.now() / 1000) - 60,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    version: 1,
  }),
  signature: `0x${'ab'.repeat(65)}`,
} as never

const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const DELEGATION_IFACE = new ethers.Interface([
  'event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, ' +
    '(address delegate,address delegator,bytes32 authority,' +
    '(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) delegation)',
])

function transferLog() {
  const e = TRANSFER_IFACE.encodeEventLog('Transfer', [PAYER, MERCHANT, BigInt(AMOUNT_RAW)])
  return { address: TOKEN, topics: e.topics, data: e.data }
}

function redeemedLog(child: Record<string, unknown>) {
  const c = child as unknown as {
    delegate: string; delegator: string; authority: string
    caveats: Array<{ enforcer: string; terms: string; args: string }>; salt: string
  }
  const e = DELEGATION_IFACE.encodeEventLog('RedeemedDelegation', [
    PAYER, MERCHANT,
    [c.delegate, c.delegator, c.authority, c.caveats.map((x) => [x.enforcer, x.terms, x.args]), c.salt, `0x${'99'.repeat(65)}`],
  ])
  return { address: MANAGER, topics: e.topics, data: e.data }
}

let seq = 0

const INSERT_INTENT = `INSERT INTO payment_intents
   (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
    amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
    status, tx_hash, confirmed_at, expires_at, source, payment_rail, execution_rail,
    machine_metadata, x402_resource_url, payment_resource_url, merchant_address,
    x402_merchant_address, delegation_hash, created_at)
 VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, $7, '0.10',
         '0x00000000000000000000000000000000000000d1', 0, $8,
         $9, $10, $11, NOW() + interval '10 minutes', 'x402', 'x402', $12, $13::jsonb,
         $14, $14, $6, $6, $15, NOW() - ($16 * interval '1 second'))`

async function seedAgent() {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`parity-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'parity agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

/** The EIP-3009 half: Haven submitted the funding tx, so it already has a hash. */
async function settledEip3009(agentId: string, userId: string) {
  const id = randomUUID()
  await db.query(INSERT_INTENT, [
    id, agentId, userId, PAYER, TOKEN, MERCHANT, AMOUNT_RAW,
    `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
    'confirmed', FUNDING_TX, new Date().toISOString(), 'allowance',
    JSON.stringify({ settlement_scheme: 'eip3009' }), RESOURCE, null, 200,
  ])
  await recordMachinePaymentEvidenceBaseById(id, agentId)
  return id
}

/**
 * The erc7710 half: the merchant redeemed the chain, nobody ever reported a
 * hash, and the payment is completed only because the sweep found it.
 */
async function sweptErc7710(agentId: string, userId: string) {
  const id = randomUUID()
  const built = buildSettlementDelegation({
    chainId: CHAIN, intentId: id,
    delegateAccountAddress: PAYER as `0x${string}`,
    budgetDelegation: SIGNED_BUDGET,
    asset: TOKEN as `0x${string}`,
    amountAtomic: BigInt(AMOUNT_RAW),
    payTo: MERCHANT as `0x${string}`,
    maxTimeoutSeconds: 120,
  })
  await db.query(INSERT_INTENT, [
    id, agentId, userId, PAYER, TOKEN, MERCHANT, AMOUNT_RAW,
    `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
    'submitted', null, null, 'delegation',
    JSON.stringify({ settlement_scheme: 'erc7710' }), RESOURCE, built.childHash, 200,
  ])

  getLogs.mockResolvedValue([{ ...redeemedLog(built.child as never), transactionHash: SETTLEMENT_TX }])
  getTransactionReceipt.mockResolvedValue({
    status: 1, blockNumber: 900_000, logs: [transferLog(), redeemedLog(built.child as never)],
  })
  const tick = await runSettlementSweepTick({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() })
  // Guard the guard: if the sweep silently did nothing, the parity assertion
  // below would still pass by both rails being absent.
  expect(tick.confirmed).toBe(1)
  return id
}

/**
 * The auto-feed (`feedSettledPaymentBestEffort`) is fire-and-forget BY DESIGN —
 * settlement must never wait on an accounting push — so a payment may already
 * be pushed by the time backfill looks, or land a moment later. Both are
 * correct, and the dedup ledger makes them converge on the same end state. The
 * assertion is therefore about that end state, reached by running the real
 * backfill and then waiting briefly for the real auto-feed, rather than about
 * which of the two got there first. Counting "how many did backfill feed" would
 * be asserting a race.
 */
async function syncedRows(userId: string, expected: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await syncUser(userId)
    const rows = await readSyncs(userId)
    if (rows.length >= expected && rows.every((r) => r.status === 'pushed')) return rows
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return readSyncs(userId)
}

const readSyncs = async (userId: string) =>
  (
    await db.query(
      `SELECT payment_id, status, external_ref FROM reporting_feed_syncs WHERE user_id = $1 ORDER BY payment_id`,
      [userId],
    )
  ).rows

describeDb('reporting feed: one sync row per settled payment, on every live rail (#2117 AC 4)', () => {
  let connector: InMemoryConnector

  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    resetSettlementSweepBackoff()
    clearConnectors()
    connector = new InMemoryConnector()
    registerConnector(connector)
    reportingFeedAvailable.mockReset().mockResolvedValue(true)
    getTransactionReceipt.mockReset()
    getLogs.mockReset().mockResolvedValue([])
    getBlock.mockReset().mockImplementation(async (which: string | number) => {
      const nowSec = Math.floor(Date.now() / 1000)
      if (which === 'latest') return { number: 1_000_000, timestamp: nowSec }
      if (which === 995_000) return { number: 995_000, timestamp: nowSec - 10_000 }
      return { number: which as number, timestamp: nowSec - 30 }
    })
  })

  it('AC 4: an eip3009 payment and a swept erc7710 payment each produce exactly ONE pushed sync row', async () => {
    const { agentId, userId } = await seedAgent()
    connector.connect(userId)

    const threeThousandNine = await settledEip3009(agentId, userId)
    const sevenSevenTen = await sweptErc7710(agentId, userId)

    const syncs = await syncedRows(userId, 2)
    expect(syncs).toHaveLength(2)
    expect(new Set(syncs.map((r) => r.payment_id))).toEqual(new Set([threeThousandNine, sevenSevenTen]))
    // Both DELIVERED, not merely enumerated — the rail is not a reason to be
    // absent, and it is not a reason to be skipped either.
    for (const row of syncs) {
      expect(row.status).toBe('pushed')
      expect(row.external_ref).not.toBeNull()
    }
    expect(connector.pushed.map((p) => p.tx.paymentId).sort()).toEqual(
      [threeThousandNine, sevenSevenTen].sort(),
    )
  })

  it('a re-sync of both rails still leaves exactly one row and one push each', async () => {
    const { agentId, userId } = await seedAgent()
    connector.connect(userId)
    await settledEip3009(agentId, userId)
    await sweptErc7710(agentId, userId)

    await syncedRows(userId, 2)
    await syncUser(userId) // "Sync now", pressed again

    expect(await readSyncs(userId)).toHaveLength(2)
    expect(connector.pushed).toHaveLength(2)
  })

  it('NEGATIVE CONTROL: an erc7710 payment the sweep could NOT attribute reaches neither rail of the feed', async () => {
    const { agentId, userId } = await seedAgent()
    connector.connect(userId)
    const id = randomUUID()
    const built = buildSettlementDelegation({
      chainId: CHAIN, intentId: id,
      delegateAccountAddress: PAYER as `0x${string}`,
      budgetDelegation: SIGNED_BUDGET,
      asset: TOKEN as `0x${string}`,
      amountAtomic: BigInt(AMOUNT_RAW),
      payTo: MERCHANT as `0x${string}`,
      maxTimeoutSeconds: 120,
    })
    await db.query(INSERT_INTENT, [
      id, agentId, userId, PAYER, TOKEN, MERCHANT, AMOUNT_RAW,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      'submitted', null, null, 'delegation',
      JSON.stringify({ settlement_scheme: 'erc7710' }), RESOURCE, built.childHash, 200,
    ])
    // A facilitator route that emits no decodable manager log: nothing names
    // this payment, so the sweep finds nothing. This is the residual, asserted
    // rather than assumed — and it must stay fail-CLOSED, not fail-wrong.
    getLogs.mockResolvedValue([])

    const tick = await runSettlementSweepTick({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() })
    expect(tick.confirmed).toBe(0)

    // Give the fire-and-forget auto-feed the same chance the positive cases got.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const { fed } = await syncUser(userId)
    expect(fed).toBe(0)
    expect(await readSyncs(userId)).toHaveLength(0)
    expect(connector.pushed).toHaveLength(0)
  })
})
