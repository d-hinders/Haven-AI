/**
 * Passive erc7710 settlement observation (#2117), end to end over the real
 * pipeline.
 *
 * Real Postgres (the #1220 harness), because everything asserted here is
 * database behaviour: the intent transition, the `machine_payment_evidence`
 * row, the fee-ledger row, the replay/ambiguity guards, and idempotency against
 * a concurrent agent report. The CHAIN is a collaborator this suite does not
 * own, so the provider is mocked — per `docs/contributing/testing-strategy.md`.
 *
 * The load-bearing cases, and what each one would let through if it broke:
 *
 * - **AC 2 / positive control.** A payment whose hash nobody ever reported is
 *   completed by the sweep and reaches an evidence row. This is also the proof
 *   that the rig can say YES, so a suite that "confirms nothing, ever" cannot
 *   pass by refusing everything.
 * - **The constraint.** A match that is shape-perfect but that the pinned
 *   DelegationManager did not name is NOT confirmed. Without this the sweep
 *   falls back to transfer shape, and an accounting feed gains a confidently
 *   wrong row — the failure this whole design exists to avoid.
 * - **Pre-#2094 look-alikes.** Two intents sharing one child hash stay refused,
 *   exactly as #2096 refuses them. The sweep must not be the thing that finally
 *   guesses.
 * - **Idempotency / concurrency.** A second sweep, and a sweep racing an agent
 *   report, produce one confirm and one evidence row — never two.
 * - **RPC failure.** An outage confirms nothing and rejects nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const feedSettledPaymentBestEffort = vi.fn()
const getTransactionReceipt = vi.fn()
const getBlock = vi.fn()
const getLogs = vi.fn()

vi.mock('../../reporting/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../reporting/index.js')>()),
  feedSettledPaymentBestEffort: (...args: unknown[]) => feedSettledPaymentBestEffort(...args),
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
import { buildSettlementDelegation } from '../x402-delegation.js'
import { buildBudgetDelegation } from '../../../rails/delegation-policy.js'
import { getDelegationContracts } from '../../../rails/delegation-contracts.js'
import {
  findEvidenceOrphanedErc7710Intents,
  findSweepableErc7710Intents,
} from '../../../infra/repositories/x402-authorizations.js'
import {
  runSettlementSweepTick,
  resetSettlementSweepBackoff,
  SWEEP_MAX_CANDIDATES_PER_TICK,
  SWEEP_MIN_AGE_SECONDS,
  SWEEP_RECOVERY_HORIZON_SECONDS,
  UNRESOLVED_REMEDY,
} from '../settlement-sweeper.js'
import { openapiSpec } from '../../../openapi/spec.js'
import { observeErc7710Settlement } from '../settlement-observed.js'
import { attachMachinePaymentEvidence } from '../../mpp/evidence.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const AMOUNT_RAW = '100000'
const RESOURCE = 'https://merchant.example/paid'
const MANAGER = getDelegationContracts(CHAIN).delegationManager
const SWEEP_TX = `0x${'5e'.repeat(32)}`

const SIGNED_BUDGET = {
  ...buildBudgetDelegation({
    agentId: 'sweep', chainId: CHAIN,
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
  const encoded = TRANSFER_IFACE.encodeEventLog('Transfer', [PAYER, MERCHANT, BigInt(AMOUNT_RAW)])
  return { address: TOKEN, topics: encoded.topics, data: encoded.data }
}

function redeemedLog(child: Record<string, unknown>, address = MANAGER) {
  const c = child as unknown as {
    delegate: string; delegator: string; authority: string
    caveats: Array<{ enforcer: string; terms: string; args: string }>; salt: string
  }
  const encoded = DELEGATION_IFACE.encodeEventLog('RedeemedDelegation', [
    PAYER, MERCHANT,
    [c.delegate, c.delegator, c.authority, c.caveats.map((x) => [x.enforcer, x.terms, x.args]), c.salt, `0x${'99'.repeat(65)}`],
  ])
  return { address, topics: encoded.topics, data: encoded.data }
}

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sweep-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'sweep agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

/**
 * One authorization that the agent never completed: a `submitted` erc7710
 * intent, aged past the sweep's grace, with the REAL settlement child salted
 * from its own id. `ageSec` is how long ago it was authorized.
 */
async function unreportedPayment(
  agentId: string,
  userId: string,
  opts: { ageSec?: number; id?: string; delegationHash?: string; resourceUrl?: string | null } = {},
) {
  const id = opts.id ?? randomUUID()
  const built = buildSettlementDelegation({
    chainId: CHAIN,
    intentId: id,
    delegateAccountAddress: PAYER as `0x${string}`,
    budgetDelegation: SIGNED_BUDGET,
    asset: TOKEN as `0x${string}`,
    amountAtomic: BigInt(AMOUNT_RAW),
    payTo: MERCHANT as `0x${string}`,
    maxTimeoutSeconds: 120,
  })
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, execution_rail, machine_metadata,
        x402_resource_url, payment_resource_url, merchant_address, x402_merchant_address,
        delegation_hash, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, $7, '0.10',
             '0x00000000000000000000000000000000000000d1', 0, $8,
             'submitted', NOW() + interval '10 minutes', 'x402', 'x402', 'delegation', $9::jsonb,
             $10, $10, $6, $6, $11, NOW() - ($12 * interval '1 second'))`,
    [
      id, agentId, userId, PAYER, TOKEN, MERCHANT, AMOUNT_RAW,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      JSON.stringify({ settlement_scheme: 'erc7710' }),
      opts.resourceUrl === undefined ? RESOURCE : opts.resourceUrl,
      opts.delegationHash ?? built.childHash,
      opts.ageSec ?? 120,
    ],
  )
  return { id, built }
}

const readIntent = async (id: string) =>
  (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0]
const readEvidence = async (id: string) =>
  (await db.query(`SELECT * FROM machine_payment_evidence WHERE payment_intent_id = $1`, [id])).rows
const readFees = async (id: string) =>
  (await db.query(`SELECT * FROM payment_fees WHERE payment_id = $1`, [id])).rows

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }

/**
 * The two working sets a production tick reads, under the bounds it actually
 * passes. #2213 asserts membership of these directly, because "recoverable"
 * is a property of the queries, not of a counter.
 */
const PROD_BOUNDS = [
  SWEEP_MIN_AGE_SECONDS,
  SWEEP_RECOVERY_HORIZON_SECONDS,
  SWEEP_MAX_CANDIDATES_PER_TICK,
] as const
const sweepableIds = async () =>
  (await findSweepableErc7710Intents(...PROD_BOUNDS)).map((r) => r.id)
const orphanIds = async () =>
  (await findEvidenceOrphanedErc7710Intents(...PROD_BOUNDS)).map((r) => r.id)

/**
 * Point the mocked chain at one settlement transaction: the manager's log makes
 * it discoverable by the sweep's scan, and the receipt is what the verifier
 * re-checks. `bound: false` drops the manager log from the RECEIPT only — the
 * scan still finds the transaction, so this is precisely the "the sweep found
 * something of the right shape but nothing named this payment" case.
 */
function chainCarries(children: Array<Record<string, unknown>>, opts: { bound?: boolean; txHash?: string } = {}) {
  const tx = opts.txHash ?? SWEEP_TX
  const bound = opts.bound !== false
  getLogs.mockResolvedValue(
    children.map((child) => ({ ...redeemedLog(child), transactionHash: tx })),
  )
  getTransactionReceipt.mockResolvedValue({
    status: 1,
    blockNumber: 900_000,
    logs: bound ? [transferLog(), ...children.map((c) => redeemedLog(c))] : [transferLog()],
  })
}

describeDb('passive erc7710 settlement sweep (#2117)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    resetSettlementSweepBackoff()
    feedSettledPaymentBestEffort.mockReset()
    getTransactionReceipt.mockReset()
    getLogs.mockReset().mockResolvedValue([])
    silentLog.debug.mockReset(); silentLog.info.mockReset(); silentLog.warn.mockReset()
    // A chain head, and a sample block 5000 back at ~2s/block.
    getBlock.mockReset().mockImplementation(async (which: string | number) => {
      const nowSec = Math.floor(Date.now() / 1000)
      if (which === 'latest') return { number: 1_000_000, timestamp: nowSec }
      // Any numbered block: the settlement's own block, inside every window here.
      if (which === 995_000) return { number: 995_000, timestamp: nowSec - 10_000 }
      return { number: which as number, timestamp: nowSec - 30 }
    })
  })

  // ── AC 2, and the positive control ──────────────────────────────────────

  it('AC 2 / POSITIVE CONTROL: a 7710 payment with NO reported hash is completed by the sweep and reaches an evidence row', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    chainCarries([p.built.child as never])

    const result = await runSettlementSweepTick(silentLog)

    expect(result).toMatchObject({
      candidates: 1, confirmed: 1, evidencePushed: 1, evidenceFailed: 0, refused: 0, chainsUnavailable: 0,
    })

    const intent = await readIntent(p.id)
    expect(intent.status).toBe('confirmed')
    expect(intent.tx_hash).toBe(SWEEP_TX)
    expect(intent.confirmed_at).not.toBeNull()

    // The whole point: it is in the books now.
    const evidence = await readEvidence(p.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].tx_hash).toBe(SWEEP_TX)
    expect(evidence[0].rail).toBe('x402')
    expect(Number(evidence[0].amount_sek)).toBeCloseTo(1.0) // book-time FX captured
    expect(await readFees(p.id)).toHaveLength(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledWith(userId, p.id)
  })

  // ── The constraint: no transfer-shape fallback ──────────────────────────

  it('THE CONSTRAINT: an UNBOUND match is not confirmed — the sweep never attributes on transfer shape', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    // Discoverable, and a perfect transfer match inside the window — but the
    // transaction carries no DelegationManager log naming this payment's child.
    chainCarries([p.built.child as never], { bound: false })

    const result = await runSettlementSweepTick(silentLog)

    expect(result.confirmed).toBe(0)
    expect(result.refused).toBe(1)
    const intent = await readIntent(p.id)
    expect(intent.status).toBe('submitted')
    expect(intent.tx_hash).toBeNull()
    expect(await readEvidence(p.id)).toHaveLength(0)
    expect(await readFees(p.id)).toHaveLength(0)
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  it('the seam itself refuses an unbound settlement when requireDelegationBound is set', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    chainCarries([p.built.child as never], { bound: false })
    const row = (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [p.id])).rows[0]

    // Same row, same hash, one flag apart — the flag is the whole guard.
    await expect(
      observeErc7710Settlement(row as never, SWEEP_TX, undefined, { requireDelegationBound: true }),
    ).resolves.toMatchObject({ outcome: 'unverified' })
    await expect(
      observeErc7710Settlement(row as never, SWEEP_TX),
    ).resolves.toMatchObject({ outcome: 'confirmed', delegationBound: false })
  })

  // ── Pre-#2094 look-alikes stay refused ──────────────────────────────────

  it('a PRE-#2094 look-alike pair stays refused — the sweep does not become the thing that guesses', async () => {
    const { agentId, userId } = await seedAgent()
    // The in-flight population: two authorizations that predate the salt, so
    // their children are byte-identical and share ONE hash.
    const shared = await unreportedPayment(agentId, userId, { ageSec: 120 })
    const sharedHash = shared.built.childHash
    const twin = await unreportedPayment(agentId, userId, { ageSec: 100, delegationHash: sharedHash })
    // One transaction, one child, two candidates claiming it.
    chainCarries([shared.built.child as never])

    const result = await runSettlementSweepTick(silentLog)

    expect(result.candidates).toBe(2)
    expect(result.confirmed).toBe(0)
    for (const id of [shared.id, twin.id]) {
      const intent = await readIntent(id)
      expect(intent.status).toBe('submitted')
      expect(intent.tx_hash).toBeNull()
      expect(await readEvidence(id)).toHaveLength(0)
    }
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  it('refuses a child the manager reports redeemed by TWO different transactions', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    // One child, two redemptions. Impossible under the exact-amount caveat, so
    // it is a fact we do not understand — and an unexplained fact must not be
    // resolved by picking one of the two.
    getLogs.mockResolvedValue([
      { ...redeemedLog(p.built.child as never), transactionHash: SWEEP_TX },
      { ...redeemedLog(p.built.child as never), transactionHash: `0x${'6f'.repeat(32)}` },
    ])
    getTransactionReceipt.mockResolvedValue({
      status: 1, blockNumber: 900_000,
      logs: [transferLog(), redeemedLog(p.built.child as never)],
    })

    const result = await runSettlementSweepTick(silentLog)

    expect(result.confirmed).toBe(0)
    expect((await readIntent(p.id)).status).toBe('submitted')
    expect(await readEvidence(p.id)).toHaveLength(0)
  })

  // ── The residue is surfaced, not silent ─────────────────────────────────

  it('SURFACES an unattributable payment once its settlement window has closed', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId, { ageSec: 3600 })
    getLogs.mockResolvedValue([]) // a route that names nothing

    const result = await runSettlementSweepTick(silentLog)

    expect(result.unresolved).toBe(1)
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: p.id,
        reason: 'no_manager_log',
        // #2214: and it says what to DO. Surfacing residue is only half of
        // "log the rest loudly as it ages out" — an alert naming a dead end is
        // an alert operators learn to scroll past, and this one is not a dead
        // end: the agent-reported completion path runs the same verifier with
        // `requireDelegationBound` OFF, so it does not need the manager log
        // this scan could not find. Asserted on the exported constant so the
        // promise and the log are one string.
        remedy: UNRESOLVED_REMEDY,
      }),
      expect.stringContaining('cannot attribute'),
    )
    // The remedy has to be actionable, not reassuring: it must name a route the
    // API actually SERVES. Checked against `openapiSpec.paths` rather than
    // against the constant's own text — the reviewer's finding — so renaming or
    // removing the route turns this red while the constant is untouched, which
    // is the only thing that makes naming a route in an alert worth anything.
    const named = Object.keys(openapiSpec.paths).filter((p) => UNRESOLVED_REMEDY.includes(p))
    expect(named, 'the remedy must name a route the API actually serves').toEqual([
      '/machine-payments/evidence',
    ])
  })

  it('does NOT surface a payment whose settlement window is still open — it is not late yet', async () => {
    const { agentId, userId } = await seedAgent()
    await unreportedPayment(agentId, userId, { ageSec: 120 }) // window is 600s
    getLogs.mockResolvedValue([])

    const result = await runSettlementSweepTick(silentLog)

    expect(result.candidates).toBe(1)
    expect(result.unresolved).toBe(0)
  })

  // ── Idempotency and concurrency ─────────────────────────────────────────

  it('is idempotent: sweeping twice confirms once and writes exactly one evidence row', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    chainCarries([p.built.child as never])

    await runSettlementSweepTick(silentLog)
    const second = await runSettlementSweepTick(silentLog)

    // The confirmed intent is no longer a candidate at all.
    expect(second.candidates).toBe(0)
    expect(second.confirmed).toBe(0)
    expect(await readEvidence(p.id)).toHaveLength(1)
    expect(await readFees(p.id)).toHaveLength(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledTimes(1)
  })

  it('is safe against an agent reporting the SAME hash concurrently — one confirm, one evidence row', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    chainCarries([p.built.child as never])

    // The agent's REAL report path and the sweep, in flight at the same moment,
    // naming the same transaction. Whoever loses the CAS must add nothing.
    const agentReport = attachMachinePaymentEvidence({
      agentId, paymentId: p.id, rail: 'x402', txHash: SWEEP_TX,
      resourceUrl: RESOURCE, merchantStatus: 200,
    }).catch((err: Error) => err)
    const [agentSide] = await Promise.all([agentReport, runSettlementSweepTick(silentLog)])

    const intent = await readIntent(p.id)
    expect(intent.status).toBe('confirmed')
    expect(intent.tx_hash).toBe(SWEEP_TX)
    // Either the agent's report succeeded, or it lost the race and refused —
    // never a second confirm and never a second row.
    expect(agentSide === null || agentSide instanceof Error || typeof agentSide === 'object').toBe(true)
    expect(await readEvidence(p.id)).toHaveLength(1)
    expect(await readFees(p.id)).toHaveLength(1)
  })

  // ── RPC failure never decides anything ──────────────────────────────────

  it('an RPC outage confirms nothing and rejects nothing', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    getLogs.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await runSettlementSweepTick(silentLog)

    expect(result.confirmed).toBe(0)
    expect(result.chainsUnavailable).toBe(1)
    const intent = await readIntent(p.id)
    expect(intent.status).toBe('submitted')
    expect(intent.tx_hash).toBeNull()
    expect(await readEvidence(p.id)).toHaveLength(0)
  })

  it('a chain head that cannot be read aborts the tick for that chain without touching a row', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    getBlock.mockRejectedValue(new Error('provider down'))

    const result = await runSettlementSweepTick(silentLog)

    expect(result.chainsUnavailable).toBe(1)
    expect(result.confirmed).toBe(0)
    expect((await readIntent(p.id)).status).toBe('submitted')
  })

  // ── Starvation: one stuck candidate must not blind the sweep ────────────

  it('STARVATION: a permanently unattributable OLD payment does not stop a fresh one being found in the same tick', async () => {
    const { agentId, userId } = await seedAgent()
    // The residue this module documents as expected: eight hours old, on a
    // route that names nothing, and a candidate for the full 24-hour horizon.
    const stuck = await unreportedPayment(agentId, userId, { ageSec: 8 * 60 * 60 })
    // A perfectly ordinary payment authorized two minutes ago, settled, and
    // never reported. Its transaction is near the chain head.
    const fresh = await unreportedPayment(agentId, userId, { ageSec: 120 })

    const nowSec = Math.floor(Date.now() / 1000)
    getBlock.mockImplementation(async (which: string | number) => {
      if (which === 'latest') return { number: 1_000_000, timestamp: nowSec }
      if (which === 995_000) return { number: 995_000, timestamp: nowSec - 10_000 }
      return { number: which as number, timestamp: nowSec - 60 }
    })
    // The manager names ONLY the fresh payment's child, and only in the blocks
    // near the head — the stuck one is genuinely absent everywhere.
    getLogs.mockImplementation(async (filter: { fromBlock: number; toBlock: number }) =>
      filter.toBlock >= 999_000
        ? [{ ...redeemedLog(fresh.built.child as never), transactionHash: SWEEP_TX }]
        : [],
    )
    getTransactionReceipt.mockResolvedValue({
      status: 1, blockNumber: 999_900,
      logs: [transferLog(), redeemedLog(fresh.built.child as never)],
    })

    const result = await runSettlementSweepTick(silentLog)

    expect(result.candidates).toBe(2)
    // The whole point: the stuck row did not blind the sweep to the fresh one.
    expect(result.confirmed).toBe(1)
    expect((await readIntent(fresh.id)).status).toBe('confirmed')
    expect((await readIntent(fresh.id)).tx_hash).toBe(SWEEP_TX)
    // …and the stuck one is still fail-closed, not guessed at.
    expect((await readIntent(stuck.id)).status).toBe('submitted')
    expect(await readEvidence(stuck.id)).toHaveLength(0)
  })

  it('backs a fruitlessly-scanned candidate off, so the residue cannot spend the budget every tick', async () => {
    const { agentId, userId } = await seedAgent()
    await unreportedPayment(agentId, userId, { ageSec: 3600 })
    getLogs.mockResolvedValue([])

    const first = await runSettlementSweepTick(silentLog)
    expect(first.suppressed).toBe(0)
    expect(getLogs).toHaveBeenCalled()

    getLogs.mockClear()
    const second = await runSettlementSweepTick(silentLog)

    expect(second.suppressed).toBe(1)
    expect(getLogs).not.toHaveBeenCalled() // no RPC spent on it at all
  })

  // ── "Not scanned" is not "not found" ────────────────────────────────────

  it('BUDGET: a candidate the batch budget did not reach is left UNTOUCHED, not judged as not-found', async () => {
    const { agentId, userId } = await seedAgent()
    // A 22-hour-old candidate: far from the head, so its estimated window plus
    // drift slack spans ~19 of the 20 batches this chain gets per tick.
    const old = await unreportedPayment(agentId, userId, { ageSec: 22 * 60 * 60 })
    // A fresh one whose settlement IS on chain and IS findable — but whose
    // range does not fit in what the budget has left this tick.
    const fresh = await unreportedPayment(agentId, userId, { ageSec: 120 })

    const nowSec = Math.floor(Date.now() / 1000)
    getBlock.mockImplementation(async (which: string | number) => {
      if (which === 'latest') return { number: 1_000_000, timestamp: nowSec }
      if (which === 995_000) return { number: 995_000, timestamp: nowSec - 10_000 }
      return { number: which as number, timestamp: nowSec - 60 }
    })
    getLogs.mockImplementation(async (filter: { toBlock: number }) =>
      filter.toBlock >= 999_000
        ? [{ ...redeemedLog(fresh.built.child as never), transactionHash: SWEEP_TX }]
        : [],
    )
    getTransactionReceipt.mockResolvedValue({
      status: 1, blockNumber: 999_900,
      logs: [transferLog(), redeemedLog(fresh.built.child as never)],
    })

    // Tick 1: the old candidate eats the budget; the fresh one is never scanned.
    const first = await runSettlementSweepTick(silentLog)
    expect(first.suppressed).toBeGreaterThanOrEqual(1)
    expect(first.confirmed).toBe(0)
    expect((await readIntent(fresh.id)).status).toBe('submitted')

    // Tick 2 is the whole point. The old candidate was genuinely scanned and
    // found nothing, so it is now backed off and the budget is free. The fresh
    // one must NOT have been backed off — it was never scanned, and "we did not
    // look" must never be recorded as "it is not there".
    const second = await runSettlementSweepTick(silentLog)
    expect(second.confirmed).toBe(1)
    expect((await readIntent(fresh.id)).status).toBe('confirmed')
    expect((await readIntent(fresh.id)).tx_hash).toBe(SWEEP_TX)
    expect((await readIntent(old.id)).status).toBe('submitted')
  })

  // ── Ambiguity survives the merge of separately-scanned ranges ───────────

  it('CROSS-RANGE AMBIGUITY: one child redeemed by two different transactions in two separately-scanned ranges confirms NEITHER', async () => {
    const { agentId, userId } = await seedAgent()
    // Five hours apart, so their windows never coalesce into one scan AND they
    // are far outside the DB ambiguity guard's reach — this guard is the only
    // thing standing between them and a misattribution.
    const older = await unreportedPayment(agentId, userId, { ageSec: 5 * 60 * 60 })
    const newer = await unreportedPayment(agentId, userId, {
      ageSec: 30 * 60,
      delegationHash: older.built.childHash,
    })
    const OTHER_TX = `0x${'9c'.repeat(32)}`
    const olderAuthorizeSec = Math.floor(Date.now() / 1000) - 5 * 60 * 60
    const newerAuthorizeSec = Math.floor(Date.now() / 1000) - 30 * 60
    const nowSec = Math.floor(Date.now() / 1000)

    // Each transaction is mined INSIDE its own candidate's settlement window,
    // so check 7 cannot be what refuses them. Without this the test would pass
    // for the wrong reason — verified by mutation: with the block timestamps
    // outside both windows, removing the ambiguity promotion left the suite
    // green.
    getBlock.mockImplementation(async (which: string | number) => {
      if (which === 'latest') return { number: 1_000_000, timestamp: nowSec }
      if (which === 995_000) return { number: 995_000, timestamp: nowSec - 10_000 }
      if (which === 999_000) return { number: 999_000, timestamp: newerAuthorizeSec + 60 }
      return { number: 900_000, timestamp: olderAuthorizeSec + 60 }
    })
    // The same child hash appears in BOTH ranges, named by DIFFERENT
    // transactions. Which range is scanned first must not decide the answer.
    getLogs.mockImplementation(async (filter: { toBlock: number }) =>
      filter.toBlock >= 998_000
        ? [{ ...redeemedLog(older.built.child as never), transactionHash: OTHER_TX }]
        : [{ ...redeemedLog(older.built.child as never), transactionHash: SWEEP_TX }],
    )
    getTransactionReceipt.mockImplementation(async (hash: string) => ({
      status: 1,
      blockNumber: hash === OTHER_TX ? 999_000 : 900_000,
      logs: [transferLog(), redeemedLog(older.built.child as never)],
    }))

    const result = await runSettlementSweepTick(silentLog)

    // Either transaction would pass checks 1-8 for its own candidate on its
    // own. That is exactly why the ambiguity has to be caught at the index:
    // one child cannot have been redeemed twice, so we do not know what
    // happened, and an unexplained fact must not become a row in the books.
    expect(result.confirmed).toBe(0)
    for (const id of [older.id, newer.id]) {
      expect((await readIntent(id)).status).toBe('submitted')
      expect((await readIntent(id)).tx_hash).toBeNull()
      expect(await readEvidence(id)).toHaveLength(0)
    }
  })

  it('AMBIGUITY WITHIN one range survives the merge with a later range that names the child once', async () => {
    const { agentId, userId } = await seedAgent()
    // Same shared child again, but this time the OLDER candidate's range is the
    // one that is internally ambiguous, and the NEWER range names the child
    // exactly once. A merge that let the single sighting overwrite the poison
    // would resurrect the guess the first range already refused.
    const older = await unreportedPayment(agentId, userId, { ageSec: 5 * 60 * 60 })
    const newer = await unreportedPayment(agentId, userId, {
      ageSec: 30 * 60,
      delegationHash: older.built.childHash,
    })
    const OTHER_TX = `0x${'9c'.repeat(32)}`
    const THIRD_TX = `0x${'3d'.repeat(32)}`
    const olderAuthorizeSec = Math.floor(Date.now() / 1000) - 5 * 60 * 60
    const newerAuthorizeSec = Math.floor(Date.now() / 1000) - 30 * 60
    const nowSec = Math.floor(Date.now() / 1000)

    getBlock.mockImplementation(async (which: string | number) => {
      if (which === 'latest') return { number: 1_000_000, timestamp: nowSec }
      if (which === 995_000) return { number: 995_000, timestamp: nowSec - 10_000 }
      if (which === 999_000) return { number: 999_000, timestamp: newerAuthorizeSec + 60 }
      return { number: 900_000, timestamp: olderAuthorizeSec + 60 }
    })
    getLogs.mockImplementation(async (filter: { toBlock: number }) =>
      filter.toBlock >= 998_000
        ? // the newer range: ONE sighting
          [{ ...redeemedLog(older.built.child as never), transactionHash: OTHER_TX }]
        : // the older range: TWO different transactions redeeming one child
          [
            { ...redeemedLog(older.built.child as never), transactionHash: SWEEP_TX },
            { ...redeemedLog(older.built.child as never), transactionHash: THIRD_TX },
          ],
    )
    getTransactionReceipt.mockImplementation(async (hash: string) => ({
      status: 1,
      blockNumber: hash === OTHER_TX ? 999_000 : 900_000,
      logs: [transferLog(), redeemedLog(older.built.child as never)],
    }))

    const result = await runSettlementSweepTick(silentLog)

    expect(result.confirmed).toBe(0)
    for (const id of [older.id, newer.id]) {
      expect((await readIntent(id)).status).toBe('submitted')
      expect(await readEvidence(id)).toHaveLength(0)
    }
  })

  // ── Scope: nothing else can enter the sweep ─────────────────────────────

  it('does not sweep a payment younger than the grace period', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId, { ageSec: 5 })
    chainCarries([p.built.child as never])

    const result = await runSettlementSweepTick(silentLog)

    expect(result.candidates).toBe(0)
    expect((await readIntent(p.id)).status).toBe('submitted')
  })

  it('does not sweep a payment older than the recovery horizon', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId, { ageSec: 25 * 60 * 60 })
    chainCarries([p.built.child as never])

    const result = await runSettlementSweepTick(silentLog)

    expect(result.candidates).toBe(0)
    expect((await readIntent(p.id)).status).toBe('submitted')
  })

  it('RECOVERY: a payment whose settlement window closed hours ago is still completed — an RPC outage is not permanent invisibility', async () => {
    const { agentId, userId } = await seedAgent()
    // Six hours old: the settlement window shut long ago, and the transaction
    // is still exactly where it was mined.
    const p = await unreportedPayment(agentId, userId, { ageSec: 6 * 60 * 60 })
    chainCarries([p.built.child as never])
    // Its block sits inside its own window, six hours back — check 7 is what
    // makes the wider scan safe, and it still runs.
    const authorizeSec = Math.floor(Date.now() / 1000) - 6 * 60 * 60
    getBlock.mockImplementation(async (which: string | number) => {
      if (which === 'latest') return { number: 1_000_000, timestamp: Math.floor(Date.now() / 1000) }
      if (which === 995_000) return { number: 995_000, timestamp: Math.floor(Date.now() / 1000) - 10_000 }
      return { number: which as number, timestamp: authorizeSec + 60 }
    })

    const result = await runSettlementSweepTick(silentLog)

    expect(result.confirmed).toBe(1)
    expect((await readIntent(p.id)).status).toBe('confirmed')
    expect(await readEvidence(p.id)).toHaveLength(1)
  })

  it('leaves an eip3009 payment and a non-delegation intent entirely alone', async () => {
    const { agentId, userId } = await seedAgent()
    await db.query(
      `INSERT INTO payment_intents
         (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
          amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
          status, expires_at, source, payment_rail, execution_rail, machine_metadata,
          x402_resource_url, delegation_hash, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, ${CHAIN}, 'USDC', $4, $5, $6, '0.10',
               '0x00000000000000000000000000000000000000d1', 0, $7,
               'submitted', NOW() + interval '10 minutes', 'x402', 'x402', 'delegation', $8::jsonb,
               $9, $10, NOW() - interval '200 seconds')`,
      [agentId, userId, PAYER, TOKEN, MERCHANT, AMOUNT_RAW,
       `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
       JSON.stringify({ settlement_scheme: 'eip3009' }), RESOURCE, `0x${'7'.repeat(64)}`],
    )

    const result = await runSettlementSweepTick(silentLog)
    expect(result.candidates).toBe(0)
  })
  // ── #2213: the confirm landed, the evidence row did not ─────────────────
  //
  // The defect this fixes: `sweepOne` called the evidence seam, could not see
  // whether a row landed, and incremented `confirmed` + logged "completed an
  // unreported erc7710 payment" either way. Because the confirm has already
  // flipped `submitted → confirmed`, the intent leaves
  // `FIND_SWEEPABLE_ERC7710_INTENTS_SQL` permanently, `observeErc7710Settlement`
  // answers `not_applicable` to any later agent report, and the Fortnox
  // backfill enumerates evidence ROWS — so the payment was settled, unbooked,
  // unreachable, and reported as a success. #2117's own failure mode,
  // re-created by #2117's fix, and silenced.
  //
  // The trigger used here is the one PR #2134 (PhilipEriksson) identified as
  // the only reachable silent no-op after a successful confirm: a settled x402
  // intent with no `resource_url`, which `machine_payment_evidence` requires
  // NOT NULL and therefore can never be booked.

  it('THE DEFECT: a confirm whose evidence write fails is NOT reported as completed, and stays recoverable', async () => {
    const { agentId, userId } = await seedAgent()
    // Everything the sweep needs to confirm, and nothing it needs to book.
    const p = await unreportedPayment(agentId, userId, { resourceUrl: null })
    chainCarries([p.built.child as never])

    const result = await runSettlementSweepTick(silentLog)

    // The state transition is real and is still counted as one...
    expect(result.confirmed).toBe(1)
    const intent = await readIntent(p.id)
    expect(intent.status).toBe('confirmed')
    expect(intent.tx_hash).toBe(SWEEP_TX)
    // ...but it is NOT a completion, and must not be counted or logged as one.
    expect(result.evidencePushed).toBe(0)
    expect(result.evidenceFailed).toBe(1)
    expect(await readEvidence(p.id)).toHaveLength(0)
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
    expect(silentLog.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Settlement sweep completed an unreported erc7710 payment',
    )
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: p.id, reason: 'missing_resource_url' }),
      expect.stringContaining('no evidence row landed'),
    )

    // THE LOAD-BEARING ASSERTION, and the reason a louder log is not the fix:
    // the payment is still inside a retry path. It has left the forward sweep
    // for good — assert that too, so this is not mistaken for the old
    // behaviour — and it is now reachable by the recovery pass instead.
    expect(await sweepableIds()).not.toContain(p.id)
    expect(await orphanIds()).toContain(p.id)
  })

  it('RECOVERY: the next tick writes the missing row once it can be written — no chain call needed', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId, { resourceUrl: null })
    chainCarries([p.built.child as never])
    await runSettlementSweepTick(silentLog)
    expect(await readEvidence(p.id)).toHaveLength(0)

    // It is now an orphan. A tick that CANNOT yet write the row must say so
    // every time — a permanently unwritable payment is retried until the
    // horizon and warns on each attempt, which is the whole difference between
    // a missing row that announces itself and one that reports success.
    silentLog.warn.mockReset()
    const stillStuck = await runSettlementSweepTick(silentLog)
    expect(stillStuck.evidenceOrphaned).toBe(1)
    expect(stillStuck.evidenceRecovered).toBe(0)
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: p.id, reason: 'missing_resource_url' }),
      expect.stringContaining('could not be written'),
    )

    // The operator (or a backfill) supplies what was missing.
    await db.query(
      `UPDATE payment_intents SET payment_resource_url = $2, x402_resource_url = $2 WHERE id = $1`,
      [p.id, RESOURCE],
    )
    // The chain goes dark: the recovery pass must not need it. This payment is
    // already attributed, so there is nothing left to scan or verify.
    // …and having failed once, it is BACKED OFF, exactly as a fruitlessly
    // scanned forward candidate is. Without this the recovery pass would
    // re-attempt an unwritable payment on every tick for the full 24-hour
    // horizon (~720 times), which is the cost schedule the forward sweep
    // already refuses to pay.
    const suppressed = await runSettlementSweepTick(silentLog)
    expect(suppressed.evidenceOrphaned).toBe(0)
    expect(suppressed.evidenceRecovered).toBe(0)
    expect(suppressed.suppressed).toBeGreaterThanOrEqual(1)

    // The backoff would otherwise hold this candidate back for a tick;
    // production simply waits, the test does not.
    resetSettlementSweepBackoff()
    getLogs.mockReset().mockRejectedValue(new Error('rpc down'))
    getBlock.mockReset().mockRejectedValue(new Error('rpc down'))
    getTransactionReceipt.mockReset().mockRejectedValue(new Error('rpc down'))
    feedSettledPaymentBestEffort.mockReset()

    const result = await runSettlementSweepTick(silentLog)

    expect(result.evidenceRecovered).toBe(1)
    expect(result.evidenceOrphaned).toBe(0)
    const evidence = await readEvidence(p.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].tx_hash).toBe(SWEEP_TX)
    expect(await readFees(p.id)).toHaveLength(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledWith(userId, p.id)
    // The hole is gone, so it is no longer a recovery candidate.
    expect(await orphanIds()).not.toContain(p.id)
  })

  it('the recovery pass leaves a completed payment alone and never writes a second row', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await unreportedPayment(agentId, userId)
    chainCarries([p.built.child as never])

    const first = await runSettlementSweepTick(silentLog)
    expect(first).toMatchObject({ confirmed: 1, evidencePushed: 1, evidenceRecovered: 0 })

    // A second tick sees a confirmed intent that already HAS its row. It must
    // not be an orphan, or every completed payment would be re-fed forever.
    expect(await orphanIds()).not.toContain(p.id)
    feedSettledPaymentBestEffort.mockReset()
    const second = await runSettlementSweepTick(silentLog)

    expect(second).toMatchObject({
      candidates: 0, confirmed: 0, evidencePushed: 0, evidenceFailed: 0,
      evidenceRecovered: 0, evidenceOrphaned: 0,
    })
    expect(await readEvidence(p.id)).toHaveLength(1)
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })
})
