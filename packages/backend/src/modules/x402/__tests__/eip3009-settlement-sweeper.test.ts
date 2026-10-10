/**
 * Passive eip3009 settlement observation (#3888), end to end over the real
 * pipeline — the #3475 twin of the erc7710 sweep suite.
 *
 * Real Postgres (the #1220 harness), because everything asserted here is
 * database behaviour: the recorded hash beside the funding hash, the
 * `machine_payment_evidence` row, the feed fire, the compare-and-set and
 * hash-taken guards. The CHAIN is a collaborator this suite does not own, so
 * the provider is mocked — per `docs/contributing/testing-strategy.md` — with
 * one fixture transaction carrying a real `AuthorizationUsed` log for the
 * DERIVED nonce, verified through the real `verifySettlementTransferTx`.
 *
 * The load-bearing cases, and what each one would let through if it broke:
 *
 * - **AC 1 / positive control.** A payment whose settlement nobody ever
 *   reported is recorded by the tick alone: verified hash beside the funding
 *   hash, base evidence row, ONE feed fire — in that order (feed suppressed
 *   during the base write).
 * - **AC 2 / status read.** After the tick, the payment no longer satisfies
 *   `isFundedX402AwaitingMerchantLeg` (no more "the merchant has likely not
 *   been paid"), while a genuinely-unsettled sibling still does.
 * - **AC 3 / attribution rule.** A pre-#3888 signer's RANDOM nonce is never
 *   attributed, and `authorizationState == true` alone records nothing.
 * - **Open question 2 (conservative default).** A nonce-proven attribution
 *   colliding with an earlier agent-reported hash is LOGGED, never recorded.
 * - **AC 5 / fail closed.** An RPC failure anywhere leaves every candidate
 *   untouched; block ranges are bounded.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const feedSettledPaymentBestEffort = vi.fn()
const getTransactionReceipt = vi.fn()
const getBlock = vi.fn()
const getBlockNumber = vi.fn()
const getLogs = vi.fn()

vi.mock('../../accounting/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../accounting/index.js')>()),
  feedSettledPaymentBestEffort: (...args: unknown[]) => feedSettledPaymentBestEffort(...args),
}))

vi.mock('../../../infra/chain/relayer-reads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/chain/relayer-reads.js')>()),
  getProvider: () => ({ getTransactionReceipt, getBlock, getBlockNumber, getLogs }),
}))

vi.mock('../../../infra/prices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/prices.js')>()),
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10 }),
}))

import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  findSweepableEip3009Intents,
  recordEip3009MerchantSettlement,
} from '../../../infra/repositories/x402-authorizations.js'
import {
  runEip3009SettlementSweepTick,
  resetEip3009SettlementSweepState,
  EIP3009_SWEEP_MIN_AGE_SECONDS,
  EIP3009_SWEEP_RECOVERY_HORIZON_SECONDS,
  EIP3009_SWEEP_MAX_CANDIDATES_PER_TICK,
  EIP3009_UNRESOLVED_AFTER_SECONDS,
  EIP3009_UNRESOLVED_REMEDY,
  type Eip3009ChainDeps,
} from '../eip3009-settlement-sweeper.js'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'
import { isFundedX402AwaitingMerchantLeg } from '../../payments/agent-payment-status.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const AMOUNT_RAW = '100000'
const RESOURCE = 'https://merchant.example/paid'
const FUNDING_TX = `0x${'d1'.repeat(32)}`
const SWEEP_TX = `0x${'5e'.repeat(32)}`
const FUNDING_BLOCK = 900_000
const SETTLE_BLOCK = 900_500
const HEAD_BLOCK = 901_000

const AUTHORIZATION_USED_IFACE = new ethers.Interface([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])
const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

function authorizationUsedLog(authorizer: string, nonce: string, txHash: string) {
  const encoded = AUTHORIZATION_USED_IFACE.encodeEventLog('AuthorizationUsed', [authorizer, nonce])
  return { address: TOKEN, topics: encoded.topics, data: encoded.data, transactionHash: txHash }
}

function transferLog() {
  const encoded = TRANSFER_IFACE.encodeEventLog('Transfer', [PAYER, MERCHANT, BigInt(AMOUNT_RAW)])
  return { address: TOKEN, topics: encoded.topics, data: encoded.data }
}

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`eip3009-sweep-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'eip3009 sweep agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

/**
 * One FUNDING-confirmed eip3009 payment whose merchant settlement nobody ever
 * reported. `ageSec` is how long ago the funding confirmed — the tick's
 * candidate anchor, deliberately NOT the report grace.
 */
async function fundedPayment(
  agentId: string,
  userId: string,
  opts: { ageSec?: number; id?: string; resourceUrl?: string | null; nonceSeed?: string } = {},
) {
  const id = opts.id ?? randomUUID()
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, source, payment_rail, execution_rail, machine_metadata,
        x402_resource_url, payment_resource_url, merchant_address, x402_merchant_address,
        created_at, confirmed_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $13, $7, '0.10',
             $13, 0, $8,
             'confirmed', $9, NOW() + interval '10 minutes', 'x402', 'x402', 'delegation', $10::jsonb,
             $11, $11, $6, $6,
             NOW() - ($12 * interval '1 second'), NOW() - ($12 * interval '1 second'))`,
    [
      id, agentId, userId, PAYER, TOKEN, MERCHANT, AMOUNT_RAW,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      FUNDING_TX,
      JSON.stringify({ settlement_scheme: 'eip3009' }),
      opts.resourceUrl === undefined ? RESOURCE : opts.resourceUrl,
      opts.ageSec ?? 120,
      // The delegate EOA: production stores it in `to_address` (it is the
      // funding recipient), and it is the AUTHORIZER the settlement's
      // AuthorizationUsed log names. `merchant_address` stays the merchant.
      PAYER,
    ],
  )
  return { id, nonce: deriveX402PaymentNonce(opts.nonceSeed ?? id) }
}

const readIntent = async (id: string) =>
  (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0]
const readEvidence = async (id: string) =>
  (await db.query(`SELECT * FROM machine_payment_evidence WHERE payment_intent_id = $1`, [id])).rows
const readFees = async (id: string) =>
  (await db.query(`SELECT * FROM payment_fees WHERE payment_id = $1`, [id])).rows

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }

const PROD_BOUNDS = [
  EIP3009_SWEEP_MIN_AGE_SECONDS,
  EIP3009_SWEEP_RECOVERY_HORIZON_SECONDS,
  EIP3009_SWEEP_MAX_CANDIDATES_PER_TICK,
] as const
const sweepableIds = async () =>
  (await findSweepableEip3009Intents(...PROD_BOUNDS)).map((r) => r.id)

/**
 * Point the mocked chain at one settlement transaction: the token's
 * `AuthorizationUsed` log makes it discoverable by the derived nonce, and the
 * receipt is what the real verifier re-checks (status 1, a Transfer of the
 * payment's amount, delegate → merchant, mined after the funding confirm).
 */
function chainCarries(opts: { authorizer?: string; nonce?: string; txHash?: string } = {}) {
  const authorizer = opts.authorizer ?? PAYER
  const nonce = opts.nonce ?? '0x' + '00'.repeat(32)
  const txHash = opts.txHash ?? SWEEP_TX
  getLogs.mockResolvedValue([authorizationUsedLog(authorizer, nonce, txHash)])
  getTransactionReceipt.mockImplementation(async (hash: string) => {
    if (hash.toLowerCase() === FUNDING_TX.toLowerCase()) return { blockNumber: FUNDING_BLOCK }
    if (hash.toLowerCase() === txHash.toLowerCase()) {
      return {
        status: 1,
        blockNumber: SETTLE_BLOCK,
        logs: [transferLog()],
      }
    }
    return null
  })
  getBlock.mockImplementation(async (which: string | number) => {
    if (which === SETTLE_BLOCK) return { number: SETTLE_BLOCK, timestamp: Math.floor(Date.now() / 1000) - 60 }
    if (which === FUNDING_BLOCK) return { number: FUNDING_BLOCK, timestamp: Math.floor(Date.now() / 1000) - 600 }
    return { number: which, timestamp: Math.floor(Date.now() / 1000) - 30 }
  })
  getBlockNumber.mockResolvedValue(HEAD_BLOCK)
}

const alwaysTrue = async () => true as const

function chainDeps(overrides: Partial<Eip3009ChainDeps> = {}): Partial<Eip3009ChainDeps> {
  return { readAuthState: alwaysTrue, ...overrides }
}

describeDb('passive eip3009 settlement sweep (#3888)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    resetEip3009SettlementSweepState()
    feedSettledPaymentBestEffort.mockReset()
    getTransactionReceipt.mockReset()
    getBlock.mockReset()
    getBlockNumber.mockReset().mockResolvedValue(HEAD_BLOCK)
    getLogs.mockReset().mockResolvedValue([])
    silentLog.debug.mockReset(); silentLog.info.mockReset(); silentLog.warn.mockReset()
  })

  // ── AC 1, and the positive control ───────────────────────────────────────

  it('AC 1 / POSITIVE CONTROL: an unreported settlement is recorded by the tick alone — hash, base row, ONE feed fire', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    chainCarries({ nonce: p.nonce })

    const result = await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    expect(result).toMatchObject({
      candidates: 1, recorded: 1, evidencePushed: 1, refused: 0, hashTaken: 0, chainsUnavailable: 0,
    })

    const intent = await readIntent(p.id)
    // The FUNDING hash stays; the settlement hash lands beside it.
    expect(intent.tx_hash).toBe(FUNDING_TX)
    expect(intent.machine_metadata.merchant_settlement_tx_hash).toBe(SWEEP_TX)

    // The base evidence row, and exactly one feed fire — the reported path's
    // order (base with feed suppressed, hash, then ONE fire).
    const evidence = await readEvidence(p.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].tx_hash).toBe(FUNDING_TX)
    expect(evidence[0].rail).toBe('x402')
    expect(Number(evidence[0].amount_sek)).toBeCloseTo(1.0) // book-time FX captured
    expect(await readFees(p.id)).toHaveLength(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledTimes(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledWith(userId, p.id)
  })

  it('is idempotent — a second tick records nothing more (the CAS takes the payment out of the candidate set)', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    chainCarries({ nonce: p.nonce })

    await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })
    const second = await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    expect(second.candidates).toBe(0)
    expect(await readEvidence(p.id)).toHaveLength(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledTimes(1)
  })

  // ── AC 2: the status read ────────────────────────────────────────────────

  it('AC 2: past grace the payment no longer reads "merchant likely not paid"; an unsettled sibling still does', async () => {
    const { agentId, userId } = await seedAgent()
    const detected = await fundedPayment(agentId, userId, { ageSec: 3600 })
    const unsettled = await fundedPayment(agentId, userId, { ageSec: 3600, id: randomUUID() })
    chainCarries({ nonce: detected.nonce })

    await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    const detectedRow = await readIntent(detected.id)
    expect(isFundedX402AwaitingMerchantLeg(detectedRow as never)).toBe(false)
    // A genuinely unsettled payment — no recorded hash — still gets the retry
    // remedy past grace (regression: the sweep must not silence it either).
    const unsettledRow = await readIntent(unsettled.id)
    expect(unsettledRow.machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    expect(isFundedX402AwaitingMerchantLeg(unsettledRow as never)).toBe(true)
  })

  // ── AC 3: attribution is ONLY the derived nonce ──────────────────────────

  it('AC 3: a pre-#3888 signer with a RANDOM nonce is never attributed', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    // The token burned an authorization — but for a DIFFERENT (random) nonce,
    // which is exactly what a pre-#3888 header carries. The sweep must not
    // fall back to transfer shape.
    chainCarries({ nonce: `0x${'77'.repeat(32)}` })

    const result = await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    expect(result.recorded).toBe(0)
    const intent = await readIntent(p.id)
    expect(intent.machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    expect(await readEvidence(p.id)).toHaveLength(0)
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  it('AC 3: authorizationState == true alone records nothing (cancelAuthorization sets it too)', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    // The state call says "used" but NO AuthorizationUsed log exists for the
    // derived nonce in the scanned range — the cancelAuthorization shape.
    chainCarries({ nonce: `0x${'77'.repeat(32)}` })

    const result = await runEip3009SettlementSweepTick(silentLog, {
      chain: chainDeps(),
    })

    expect(result.recorded).toBe(0)
    expect((await readIntent(p.id)).machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  it('AC 3: the getLogs filter names the token and the authorizer (the two served indexed topics)', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    chainCarries({ nonce: p.nonce })
    await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })
    expect(getLogs).toHaveBeenCalled()
    const filter = getLogs.mock.calls[0][0] as { address: string; topics: string[] }
    expect(filter.address.toLowerCase()).toBe(TOKEN.toLowerCase())
    // topics[0] = event signature; topics[1] = the authorizer (indexed
    // address, left-padded). The nonce is matched against the DECODED logs —
    // the provider cannot filter a bytes32 indexed topic efficiently on all
    // backends, so the scanner narrows only by the authorizer.
    expect(filter.topics).toHaveLength(2)
    expect(filter.topics[0]).toBe(AUTHORIZATION_USED_IFACE.getEvent('AuthorizationUsed')!.topicHash)
    expect(filter.topics[1]).toBe(ethers.zeroPadValue(ethers.getAddress(PAYER.toLowerCase()), 32))
  })

  // ── Open question 2: the conservative default ────────────────────────────

  it('a nonce-proven attribution against an earlier agent-reported hash is LOGGED, never recorded', async () => {
    const { agentId, userId } = await seedAgent()
    // Two same-shaped siblings; the agent reported SWEEP_TX against the FIRST
    // (shape-verified, so it succeeded). The sweep then proves the same tx
    // nonce-wise for the SECOND.
    const reported = await fundedPayment(agentId, userId, { ageSec: 300 })
    const sibling = await fundedPayment(agentId, userId, { ageSec: 120 })
    chainCarries({ nonce: sibling.nonce })
    const recordedFirst = await recordEip3009MerchantSettlement({
      txHash: SWEEP_TX, intentId: reported.id, agentId,
    })
    expect(recordedFirst).toBe('recorded')

    const result = await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    expect(result.hashTaken).toBe(1)
    expect(result.recorded).toBe(0)
    const intent = await readIntent(sibling.id)
    expect(intent.machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    // The agent-reported record is untouched.
    expect((await readIntent(reported.id)).machine_metadata.merchant_settlement_tx_hash).toBe(SWEEP_TX)
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: sibling.id, reason: 'settlement_hash_taken' }),
      expect.any(String),
    )
  })

  // ── AC 5: fail closed ────────────────────────────────────────────────────

  it('AC 5: an unreadable funding receipt leaves the candidate untouched', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    getTransactionReceipt.mockResolvedValue(null)
    getBlockNumber.mockResolvedValue(HEAD_BLOCK)

    const result = await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    expect(result.recorded).toBe(0)
    expect(result.chainsUnavailable).toBe(1)
    expect((await readIntent(p.id)).machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  it('AC 5: a failing log scan is "not known yet" — nothing written, nothing backoff-penalised', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    getBlockNumber.mockResolvedValue(HEAD_BLOCK)
    getTransactionReceipt.mockResolvedValue({ blockNumber: FUNDING_BLOCK })

    const result = await runEip3009SettlementSweepTick(silentLog, {
      chain: chainDeps({
        findUsed: async () => ({ status: 'unavailable' as const }),
      }),
    })

    expect(result.recorded).toBe(0)
    expect(result.chainsUnavailable).toBe(1)
    expect((await readIntent(p.id)).machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
  })

  it('AC 5: block ranges are bounded to the span past the funding block', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId)
    chainCarries({ nonce: p.nonce })
    await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })
    const filter = getLogs.mock.calls[0][0] as { fromBlock: number; toBlock: number }
    expect(filter.fromBlock).toBe(FUNDING_BLOCK)
    expect(filter.toBlock).toBeLessThanOrEqual(HEAD_BLOCK)
    expect(filter.toBlock - filter.fromBlock + 1).toBeLessThanOrEqual(500 * 20)
  })

  // ── The evidence-order guard ─────────────────────────────────────────────

  it('an unwritable evidence base (no resource URL) refuses BEFORE the hash is recorded', async () => {
    const { agentId, userId } = await seedAgent()
    const p = await fundedPayment(agentId, userId, { resourceUrl: null })
    chainCarries({ nonce: p.nonce })

    const result = await runEip3009SettlementSweepTick(silentLog, { chain: chainDeps() })

    expect(result.recorded).toBe(0)
    expect((await readIntent(p.id)).machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    expect(feedSettledPaymentBestEffort).not.toHaveBeenCalled()
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: p.id, reason: 'missing_resource_url' }),
      expect.any(String),
    )
  })

  it('a fruitlessly-scanned candidate past the unresolved threshold is logged loudly, with the remedy', async () => {
    const { agentId, userId } = await seedAgent()
    // 6h + 120s past the funding confirm: inside the 24h look horizon (still a
    // candidate), past the builder-decided threshold (now counted unresolved).
    const p = await fundedPayment(agentId, userId, {
      ageSec: EIP3009_UNRESOLVED_AFTER_SECONDS + 120,
    })
    getBlockNumber.mockResolvedValue(HEAD_BLOCK)
    getTransactionReceipt.mockResolvedValue({ blockNumber: FUNDING_BLOCK })

    const result = await runEip3009SettlementSweepTick(silentLog, {
      chain: chainDeps({ readAuthState: async () => true, findUsed: async () => ({ status: 'none' as const }) }),
    })

    expect(result.recorded).toBe(0)
    expect(result.unresolved).toBe(1)
    expect((await readIntent(p.id)).machine_metadata.merchant_settlement_tx_hash ?? null).toBeNull()
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: p.id, reason: 'no_matching_authorization_used' }),
      expect.any(String),
    )
    // The remedy constant is the alert's content — pinned so the log and the
    // docs cannot drift apart.
    expect(EIP3009_UNRESOLVED_REMEDY).toContain('POST /machine-payments/evidence')
  })

  it('a fruitlessly-scanned candidate still INSIDE the threshold stays silent (the ordinary not-yet case)', async () => {
    const { agentId, userId } = await seedAgent()
    await fundedPayment(agentId, userId, { ageSec: 120 })
    getBlockNumber.mockResolvedValue(HEAD_BLOCK)
    getTransactionReceipt.mockResolvedValue({ blockNumber: FUNDING_BLOCK })

    const result = await runEip3009SettlementSweepTick(silentLog, {
      chain: chainDeps({ findUsed: async () => ({ status: 'none' as const }) }),
    })

    expect(result.recorded).toBe(0)
    expect(result.unresolved).toBe(0)
    expect(silentLog.warn).not.toHaveBeenCalled()
  })
})
