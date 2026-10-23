/**
 * The #4319 proof ladder, end to end over the real evidence pipeline.
 *
 * Real Postgres (the #1220 harness) — what is asserted is database behaviour:
 * which intent carries the verified hash, the receipt label WITHOUT nonce
 * flags, the persisted verdict, and that a refused or wrongly-matched sibling
 * writes nothing (so the re-sign gate cannot be unlocked by it). The CHAIN is
 * a collaborator this test does not own, so it is mocked, per
 * docs/contributing/testing-strategy.md — the same shape
 * eip3009-settlement-evidence.test.ts uses.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const getTransactionReceipt = vi.fn()
const getBlock = vi.fn()
const getLogs = vi.fn()

vi.mock('../../../infra/chain/relayer-reads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/chain/relayer-reads.js')>()),
  getProvider: () => ({
    getTransactionReceipt,
    getBlock,
    getLogs,
    // authorizationState(authorizer, nonce) → bool: encoded FALSE, so the
    // limit-6 pre-check answers "the derived nonce is unburned" unless a
    // test injects its own readAuthState.
    call: async () => '0x' + '0'.repeat(64),
  }),
  getTokenBalance: async () => 0n,
}))

vi.mock('../../../infra/prices.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/prices.js')>()),
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10 }),
}))

vi.mock('../../accounting/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../accounting/index.js')>()),
  feedSettledPaymentBestEffort: vi.fn(),
}))

// The attach path reads the flag from config; this suite exercises Tier 2 ON.
vi.mock('../../../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../config.js')>()
  return { ...original, config: { ...original.config, eip3009ReceiptAttribution: true } }
})

// Static imports are safe below the mocks: vitest hoists `vi.mock` above them.
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { attachMachinePaymentEvidence, recordMachinePaymentEvidenceBase, type MachinePaymentEvidenceSource } from '../evidence.js'
import { observeEip3009ReceiptSettlement } from '../../x402/eip3009-receipt-settlement.js'
import { feedSettledPaymentBestEffort } from '../../accounting/index.js'
import { recordEip3009MerchantSettlement } from '../../../infra/repositories/x402-authorizations.js'
import { isFundedX402AwaitingMerchantLeg } from '../../payments/agent-payment-status.js'
import type { PaymentIntentStatusRow } from '../../../infra/repositories/payment-intents.js'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'

const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TREASURY = '0x00000000000000000000000000000000000000b1'
// The delegate is a REAL key — Tier 1's stored header must carry an
// authorization signed by it (the same fixture shape
// eip3009-settlement-evidence.test.ts pins).
const DELEGATE_WALLET = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const DELEGATE = DELEGATE_WALLET.address
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const AMOUNT_RAW = '1000'
const RESOURCE = 'http://merchant.example/api/joke'
const FUNDING_BLOCK = 42
const CANDIDATE_BLOCK = 60

const AUTHORIZATION_USED_IFACE = new ethers.Interface([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])
const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

function authorizationUsedLog(authorizer: string, nonce: string, txHash: string) {
  const encoded = AUTHORIZATION_USED_IFACE.encodeEventLog('AuthorizationUsed', [authorizer, nonce])
  return { address: TOKEN, topics: encoded.topics as string[], data: encoded.data, transactionHash: txHash }
}

function transferLog(txHash: string, overrides: { value?: string; to?: string } = {}) {
  const encoded = TRANSFER_IFACE.encodeEventLog('Transfer', [
    DELEGATE,
    overrides.to ?? MERCHANT,
    BigInt(overrides.value ?? AMOUNT_RAW),
  ])
  return { address: TOKEN, topics: encoded.topics as string[], data: encoded.data, transactionHash: txHash }
}

/** The receipt the verifier reads: #4061 order — the burn, then its transfer. */
function settleReceipt(txHash: string, opts: { burns: string[]; value?: string; to?: string; blockNumber?: number; reverted?: boolean }) {
  return {
    status: opts.reverted ? 0 : 1,
    blockNumber: opts.blockNumber ?? CANDIDATE_BLOCK,
    logs: [
      ...opts.burns.map((nonce) => authorizationUsedLog(DELEGATE, nonce, txHash)),
      transferLog(txHash, { value: opts.value, to: opts.to }),
    ],
  }
}

const blockAt = (blockNumber: number) => ({ number: blockNumber, timestamp: Math.floor(Date.now() / 1000) })

/**
 * Point the provider mock at a full scenario: what every getTransactionReceipt
 * answers, and the getLogs page the Tier 1 scan reads (the scan asks
 * fundingBlock..+span; one page with the burn logs suffices — the scanner
 * filters by address + topics itself).
 */
function mockChain(receipts: Record<string, ReturnType<typeof settleReceipt> | { funding: number } | null>, scanLogs: object[] = []) {
  getTransactionReceipt.mockImplementation(async (hash: string) => {
    const entry = receipts[hash.toLowerCase()]
    if (entry === undefined) return null
    if (entry === null) return null
    if ('funding' in entry) return { status: 1, blockNumber: entry.funding, logs: [] }
    return entry
  })
  getBlock.mockImplementation(async (blockNumber: number) => blockAt(blockNumber))
  getLogs.mockResolvedValue(scanLogs)
}

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ladder-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'ladder agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

function fundingHash(): string {
  return `0x${String(++seq).padStart(64, 'f')}`.slice(0, 66)
}

async function seedFunded(seed: {
  agentId: string
  userId: string
  amountRaw?: string
  merchant?: string
  txHash?: string
}): Promise<{ id: string; funding: string }> {
  const funding = seed.txHash ?? fundingHash()
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, confirmed_at, expires_at, source, payment_rail, execution_rail, machine_metadata,
        x402_resource_url, payment_resource_url, merchant_address, x402_merchant_address)
     VALUES ($1, $2, $3, 84532, 'USDC', $4, $5, $6, '0.001', $5, 0, $7,
             'confirmed', $8, NOW() - interval '1000 seconds', NOW() + interval '600 seconds',
             'x402', 'x402', 'delegation', '{"settlement_scheme": "eip3009"}'::jsonb,
             $9, $9, $10, $10)
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      TREASURY,
      TOKEN,
      DELEGATE,
      seed.amountRaw ?? AMOUNT_RAW,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      funding,
      RESOURCE,
      seed.merchant ?? MERCHANT,
    ],
  )
  return { id: result.rows[0].id, funding }
}

/** Seed the evidence row the ladder reads proofs from (the attach path's base). */
async function seedEvidenceBase(paymentId: string, agentId: string, proofs: { header?: string | null; receiptPayload?: unknown }) {
  // Use the production base writer — hand-INSERTing skips its NOT NULLs.
  const row = (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [paymentId])).rows[0]!
  await recordMachinePaymentEvidenceBase(row as unknown as MachinePaymentEvidenceSource, { suppressFeed: true })
  await db.query(
    `UPDATE machine_payment_evidence SET payment_proof_header = $3, protocol_receipt_payload = $4::jsonb
       WHERE payment_intent_id = $1 AND agent_id = $2`,
    [paymentId, agentId, proofs.header ?? null, proofs.receiptPayload === undefined ? null : JSON.stringify(proofs.receiptPayload)],
  )
}

async function readIntent(id: string) {
  return (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0]
}
async function recordedHash(id: string): Promise<string | null> {
  return (await readIntent(id)).machine_metadata?.merchant_settlement_tx_hash ?? null
}
async function receiptVerdict(id: string): Promise<string | null> {
  return (await readIntent(id)).machine_metadata?.merchant_settlement_receipt_verdict ?? null
}

/** The generic attach path's funding-hash report (the shape Lovable Dev's produce). */
const reportFunding = (agentId: string, paymentId: string, funding: string, extra: Record<string, unknown> = {}) =>
  attachMachinePaymentEvidence({ agentId, paymentId, rail: 'x402', txHash: funding, resourceUrl: RESOURCE, ...extra })

describeDb('eip3009 proof ladder (#4319)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    vi.mocked(feedSettledPaymentBestEffort).mockClear()
    getTransactionReceipt.mockClear()
    getBlock.mockClear()
    getLogs.mockClear()
    mockChain({})
  })

  it('Tier 1 on arrival: a stored header is recorded nonce-bound (not nonce-derived), feed fired once', async () => {
    const { agentId, userId } = await seedAgent()
    const { id, funding } = await seedFunded({ agentId, userId })
    const headerNonce = `0x${'9'.repeat(64)}`
    const settle = `0x${'a'.repeat(64)}`
    // Tier 1 scan: the header nonce burns in the settlement tx; the verifier
    // then reads that tx's receipt (burn + transfer) and the funding block.
    mockChain(
      {
        [funding.toLowerCase()]: { funding: FUNDING_BLOCK },
        [settle.toLowerCase()]: settleReceipt(settle, { burns: [headerNonce] }),
      },
      [authorizationUsedLog(DELEGATE, headerNonce, settle)],
    )
    // A delegate-SIGNED header (the #3925 proof): the seeded delegate's key
    // signs the authorization naming the header nonce.
    const wallet = DELEGATE_WALLET
    const authorization = { from: wallet.address, to: MERCHANT, value: AMOUNT_RAW, validAfter: '0', validBefore: '9999999999', nonce: headerNonce }
    const signature = await wallet.signTypedData(
      { name: 'USDC', version: '2', chainId: 84532, verifyingContract: TOKEN },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      { ...authorization, value: BigInt(AMOUNT_RAW), validAfter: 0n, validBefore: 9999999999n },
    )
    const header = Buffer.from(JSON.stringify({ payload: { signature, authorization } }), 'utf8').toString('base64')

    await reportFunding(agentId, id, funding, { paymentProofHeader: header })

    expect(await recordedHash(id)).toBe(settle)
    const metadata = (await readIntent(id)).machine_metadata
    expect(metadata.merchant_settlement_nonce_bound).toBe(true)
    expect(metadata.merchant_settlement_nonce_derived).toBeUndefined()
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledTimes(1)
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledWith(userId, id)
  })

  it('Tier 2 on arrival (flag on), no header: the receipt hash records labelled receipt, without nonce_bound', async () => {
    const { agentId, userId } = await seedAgent()
    const { id, funding } = await seedFunded({ agentId, userId })
    const settle = `0x${'b'.repeat(64)}`
    mockChain({
      [funding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'5'.repeat(64)}`] }),
    })

    await reportFunding(agentId, id, funding, {
      protocolReceiptPayload: JSON.stringify({ transaction: settle }),
    })

    expect(await recordedHash(id)).toBe(settle)
    const metadata = (await readIntent(id)).machine_metadata
    expect(metadata.merchant_settlement_proof).toBe('receipt')
    expect(metadata.merchant_settlement_nonce_bound).toBeUndefined()
    expect(metadata.merchant_settlement_nonce_derived).toBeUndefined()
    expect(await receiptVerdict(id)).toBe('recorded')
    expect(feedSettledPaymentBestEffort).toHaveBeenCalledTimes(1)
  })

  it('a final refused verdict is never re-checked on a later attach', async () => {
    const { agentId, userId } = await seedAgent()
    const { id, funding } = await seedFunded({ agentId, userId })
    await seedEvidenceBase(id, agentId, {
      receiptPayload: { transaction: `0x${'0'.repeat(64)}` }, // zero hash — permanent
    })
    // The refused verdict the earlier attach wrote:
    await db.query(
      `UPDATE payment_intents SET machine_metadata = COALESCE(machine_metadata,'{}'::jsonb) || '{"merchant_settlement_receipt_verdict":"refused_mismatch"}'::jsonb WHERE id = $1`,
      [id],
    )
    const settle = `0x${'b'.repeat(64)}`
    mockChain({ [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'5'.repeat(64)}`] }) })

    await reportFunding(agentId, id, funding, {
      protocolReceiptPayload: JSON.stringify({ transaction: settle }),
    })

    expect(await recordedHash(id)).toBeNull()
    expect(getTransactionReceipt).not.toHaveBeenCalledWith(settle)
  })

  it('a race — a record landing between selection and write — answers conflict and writes nothing', async () => {
    const { agentId, userId } = await seedAgent()
    const { id, funding } = await seedFunded({ agentId, userId })
    const settle = `0x${'c'.repeat(64)}`
    mockChain({
      [funding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'5'.repeat(64)}`] }),
    })
    // The "race": another writer already recorded a DIFFERENT hash for this
    // payment — the CAS pre-read (under the intent lock) must answer conflict.
    const other = `0x${'d'.repeat(64)}`
    await recordEip3009MerchantSettlement({ txHash: other, intentId: id, agentId, proof: { nonceBound: true, nonceDerived: true } })

    const outcome = await observeEip3009ReceiptSettlement(
      { id, agent_id: agentId, chain_id: 84532, token_address: TOKEN, to_address: DELEGATE, amount_raw: AMOUNT_RAW, status: 'confirmed', tx_hash: funding, source: 'x402', payment_rail: 'x402', execution_rail: 'delegation', x402_merchant_address: MERCHANT, machine_metadata: { settlement_scheme: 'eip3009' }, confirmed_at: new Date().toISOString() },
      settle,
      { flagEnabled: true },
    )
    expect(outcome.outcome).toBe('conflict')
    expect(await recordedHash(id)).toBe(other)
  })

  it('each refusal writes nothing and persists its verdict', async () => {
    const { agentId, userId } = await seedAgent()
    const { id: aId, funding: aFunding } = await seedFunded({ agentId, userId })
    const { id: bId, funding: bFunding } = await seedFunded({ agentId, userId })
    const settle = `0x${'e'.repeat(64)}`
    const aNonce = deriveX402PaymentNonce(aId)
    const bNonce = deriveX402PaymentNonce(bId)

    const intentOf = (pid: string, funding: string) => ({
      id: pid,
      agent_id: agentId,
      chain_id: 84532,
      token_address: TOKEN,
      to_address: DELEGATE,
      amount_raw: AMOUNT_RAW,
      status: 'confirmed',
      tx_hash: funding,
      source: 'x402',
      payment_rail: 'x402',
      execution_rail: 'delegation',
      x402_merchant_address: MERCHANT,
      machine_metadata: { settlement_scheme: 'eip3009' },
      confirmed_at: new Date().toISOString(),
    })

    // Several burns in one tx — a batch, ambiguous.
    mockChain({
      [aFunding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [bFunding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'5'.repeat(64)}`, `0x${'6'.repeat(64)}`] }),
    })
    let outcome = await observeEip3009ReceiptSettlement(intentOf(aId, aFunding), settle, { flagEnabled: true })
    expect(outcome.outcome).toBe('refused_ambiguous')
    expect(await recordedHash(aId)).toBeNull()

    // The burned nonce is a SIBLING's derived nonce — settles that sibling.
    mockChain({ [settle.toLowerCase()]: settleReceipt(settle, { burns: [bNonce] }) })
    outcome = await observeEip3009ReceiptSettlement(intentOf(aId, aFunding), settle, { flagEnabled: true })
    expect(outcome.outcome).toBe('refused_mismatch')
    expect(String((outcome as { reason: string }).reason)).toContain('another payment')

    // Zero hash and the FUNDING hash itself — refused without touching the chain.
    const beforeCalls = getTransactionReceipt.mock.calls.length
    outcome = await observeEip3009ReceiptSettlement(intentOf(aId, aFunding), `0x${'0'.repeat(64)}`, { flagEnabled: true })
    expect(outcome.outcome).toBe('refused_mismatch')
    outcome = await observeEip3009ReceiptSettlement(intentOf(aId, aFunding), aFunding, { flagEnabled: true })
    expect(outcome.outcome).toBe('not_applicable')
    expect(getTransactionReceipt.mock.calls.length).toBe(beforeCalls)

    // Wrong amount — the verifier's exact-amount check refuses.
    mockChain({ [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'7'.repeat(64)}`], value: '999' }) })
    outcome = await observeEip3009ReceiptSettlement(intentOf(aId, aFunding), settle, { flagEnabled: true })
    expect(outcome.outcome).toBe('refused_mismatch')
    expect(await recordedHash(aId)).toBeNull()
    expect(await receiptVerdict(aId)).toBe('refused_mismatch')

    // An RPC failure is retryable and records nothing — not even a final verdict.
    getTransactionReceipt.mockRejectedValue(new Error('rpc down'))
    outcome = await observeEip3009ReceiptSettlement(intentOf(aId, aFunding), settle, { flagEnabled: true })
    expect(outcome.outcome).toBe('retryable')
    expect(await recordedHash(aId)).toBeNull()
    expect(await receiptVerdict(aId)).toBe('retryable')
    expect(await receiptVerdict(bId)).toBeNull()
  })

  it('the block guards: an earlier unfunded-sibling pull and a burn after the next funding are both refused', async () => {
    const { agentId, userId } = await seedAgent()
    // A funded FIRST (block 50); sibling B funded later (block 60) — so the
    // candidate at block 70 is after A's funding but also after B's, and B
    // is not provably settled: limit 4 refuses the ambiguity.
    const { id: aId, funding: aFunding } = await seedFunded({ agentId, userId })
    const { id: bId, funding: bFunding } = await seedFunded({ agentId, userId })
    const settle = `0x${'1'.repeat(64)}`
    mockChain({
      [aFunding.toLowerCase()]: { funding: 50 },
      [bFunding.toLowerCase()]: { funding: 60 },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'8'.repeat(64)}`], blockNumber: 70 }),
    })
    let outcome = await observeEip3009ReceiptSettlement(
      { id: aId, agent_id: agentId, chain_id: 84532, token_address: TOKEN, to_address: DELEGATE, amount_raw: AMOUNT_RAW, status: 'confirmed', tx_hash: aFunding, source: 'x402', payment_rail: 'x402', execution_rail: 'delegation', x402_merchant_address: MERCHANT, machine_metadata: { settlement_scheme: 'eip3009' }, confirmed_at: new Date().toISOString() },
      settle,
      { flagEnabled: true },
    )
    expect(outcome.outcome).toBe('refused_ambiguous')
    expect(await recordedHash(aId)).toBeNull()

    // Limit 5: a sibling funded AFTER A but BEFORE the candidate's block — the
    // candidate burned after the delegate's next funding arrived. A is at 100,
    // B (provably settled at block 80, BEFORE A's funding) at 110, C at 110 —
    // so only limit 5 can refuse, and the candidate at 115 does.
    const { id: cId, funding: cFunding } = await seedFunded({ agentId, userId })
    const bSettled = `0x${'9'.repeat(64)}`
    await recordEip3009MerchantSettlement({ txHash: bSettled, intentId: bId, agentId, proof: { nonceBound: true, nonceDerived: true } })
    mockChain({
      [aFunding.toLowerCase()]: { funding: 100 },
      [bFunding.toLowerCase()]: { funding: 110 },
      [bSettled.toLowerCase()]: { blockNumber: 80, status: 1, logs: [] },
      [cFunding.toLowerCase()]: { funding: 110 },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'8'.repeat(64)}`], blockNumber: 115 }),
    })
    void cId
    outcome = await observeEip3009ReceiptSettlement(
      { id: aId, agent_id: agentId, chain_id: 84532, token_address: TOKEN, to_address: DELEGATE, amount_raw: AMOUNT_RAW, status: 'confirmed', tx_hash: aFunding, source: 'x402', payment_rail: 'x402', execution_rail: 'delegation', x402_merchant_address: MERCHANT, machine_metadata: { settlement_scheme: 'eip3009' }, confirmed_at: new Date().toISOString() },
      settle,
      { flagEnabled: true },
    )
    expect(outcome.outcome).toBe('refused_ambiguous')
  })

  it('the derived nonce burned elsewhere refuses the weaker proof (the sweep outranks it)', async () => {
    const { agentId, userId } = await seedAgent()
    const { id, funding } = await seedFunded({ agentId, userId })
    const settle = `0x${'2'.repeat(64)}`
    mockChain({
      [funding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'3'.repeat(64)}`] }),
    })
    const outcome = await observeEip3009ReceiptSettlement(
      { id, agent_id: agentId, chain_id: 84532, token_address: TOKEN, to_address: DELEGATE, amount_raw: AMOUNT_RAW, status: 'confirmed', tx_hash: funding, source: 'x402', payment_rail: 'x402', execution_rail: 'delegation', x402_merchant_address: MERCHANT, machine_metadata: { settlement_scheme: 'eip3009' }, confirmed_at: new Date().toISOString() },
      settle,
      { flagEnabled: true, deps: { readAuthState: async () => true } },
    )
    expect(outcome.outcome).toBe('refused_ambiguous')
    expect(await recordedHash(id)).toBeNull()
  })

  it('a refused or mismatched sibling cannot unlock a re-sign (#3475 hazard)', async () => {
    const { agentId, userId } = await seedAgent()
    const { id: aId, funding: aFunding } = await seedFunded({ agentId, userId })
    const { id: bId, funding: bFunding } = await seedFunded({ agentId, userId })
    const aNonce = deriveX402PaymentNonce(aId)
    const settle = `0x${'4'.repeat(64)}`
    // The tx really settled A (it burned A's derived nonce), reported through
    // B's receipt ladder: refused as a sibling-nonce theft — B takes nothing.
    mockChain({
      [aFunding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [bFunding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [aNonce] }),
    })
    const outcome = await observeEip3009ReceiptSettlement(
      { id: bId, agent_id: agentId, chain_id: 84532, token_address: TOKEN, to_address: DELEGATE, amount_raw: AMOUNT_RAW, status: 'confirmed', tx_hash: bFunding, source: 'x402', payment_rail: 'x402', execution_rail: 'delegation', x402_merchant_address: MERCHANT, machine_metadata: { settlement_scheme: 'eip3009' }, confirmed_at: new Date().toISOString() },
      settle,
      { flagEnabled: true },
    )
    expect(outcome.outcome).toBe('refused_mismatch')
    // Neither payment carries a hash, so the gate still treats both as
    // awaiting the merchant leg — a re-sign is offered by the SAME predicate
    // that would have been lied to had the theft recorded.
    const rows = await db.query(
      `SELECT id, status, tx_hash, machine_metadata, confirmed_at, payment_rail, source,
              false AS funded_but_unsettled, false AS merchant_leg_reported
         FROM payment_intents WHERE id = ANY($1)`,
      [[aId, bId]],
    )
    for (const row of rows.rows) {
      expect(isFundedX402AwaitingMerchantLeg(row as unknown as PaymentIntentStatusRow)).toBe(true)
    }
    // And once A's own ladder records it, the gate stops offering a re-sign.
    await recordEip3009MerchantSettlement({ txHash: settle, intentId: aId, agentId, proof: { nonceBound: true, nonceDerived: true } })
    const aRow = (await db.query(`SELECT id, status, tx_hash, machine_metadata, confirmed_at FROM payment_intents WHERE id = $1`, [aId])).rows[0]
    expect(
      isFundedX402AwaitingMerchantLeg({
        ...(aRow as unknown as PaymentIntentStatusRow),
        funded_but_unsettled: false,
        merchant_leg_reported: false,
      }),
    ).toBe(false)
  })

  it('the flag off records nothing on the arrival path (the kill switch holds)', async () => {
    const { agentId, userId } = await seedAgent()
    const { id, funding } = await seedFunded({ agentId, userId })
    const settle = `0x${'6'.repeat(64)}`
    mockChain({
      [funding.toLowerCase()]: { funding: FUNDING_BLOCK },
      [settle.toLowerCase()]: settleReceipt(settle, { burns: [`0x${'5'.repeat(64)}`] }),
    })
    const outcome = await observeEip3009ReceiptSettlement(
      { id, agent_id: agentId, chain_id: 84532, token_address: TOKEN, to_address: DELEGATE, amount_raw: AMOUNT_RAW, status: 'confirmed', tx_hash: funding, source: 'x402', payment_rail: 'x402', execution_rail: 'delegation', x402_merchant_address: MERCHANT, machine_metadata: { settlement_scheme: 'eip3009' }, confirmed_at: new Date().toISOString() },
      settle,
      { flagEnabled: false },
    )
    expect(outcome.outcome).toBe('disabled')
    expect(await recordedHash(id)).toBeNull()
  })
})
